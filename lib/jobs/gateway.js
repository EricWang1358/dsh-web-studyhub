import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { backgroundCapability, startBoundedChild, childError, abortable } from '../host-capabilities.js';
import { addUsage, totalTokens, foldSessionUsage } from '../token-usage.js';
import { withUsageSink } from '../usage-scope.js';
import { tapChildStream } from '../job-output.js';
import { LIMITS } from './limits.js';
import { MODEL_LANES, failure, labelValid, levelFor, lightRequest, policyOf } from './gateway-policy.js';

const iso = () => new Date().toISOString();
const sumTokens = (a, b) => { const { calls, ...tokens } = addUsage(a, b); return tokens; };
/** Calls/Steps are appended to the existing canonical record. No model retry,
 * Job registry, provider queue, or parallel usage ledger lives in this adapter. */
export function createModelGateway({ context, record, host, ledger, durability }) {
  if (record.jobId !== context.jobId || record.runtime.activeAttemptId !== context.attemptId) throw failure('attempt-mismatch');
  const scope = new AsyncLocalStorage(), pending = new Set();
  const refreshUsage = () => {
    const calls = record.calls.filter(call => call.modelRequest);
    const known = calls.filter(call => call.tokenUsage);
    const usage = known.length ? known.reduce((sum, call) => sumTokens(sum, call.tokenUsage), {}) : null;
    record.usage = { calls: calls.length, tokens: usage ? totalTokens(usage) : null, tokenUsage: usage };
    record.detail.usageIncomplete = known.length < calls.length;
    const runners = new Set(calls.map(call => call.runner));
    record.execution.mode = runners.size > 1 ? 'mixed' : [...runners][0] || null;
  };
  const observeInner = async (meta, operation) => {
    const entry = scope.getStore();
    if (!entry || entry.closed || entry.step.status !== 'running') throw failure('step-required');
    if (!meta.cleanup) { context.assertCurrent(); entry.signal.throwIfAborted(); }
    if (!['external-request', 'host-attempt', 'local-process', 'local-wait'].includes(meta.boundary)) throw failure('invalid-observation-boundary');
    if (meta.sideEffect !== undefined && typeof meta.sideEffect !== 'boolean') throw failure('invalid-observation-boundary');
    const call = { callId: randomUUID(), jobId: context.jobId, attemptId: context.attemptId,
      stepKey: entry.step.stepKey, stepRunId: entry.step.stepRunId, kind: meta.kind || entry.policy.purpose,
      ...entry.policy, ...entry.labels, runner: meta.runner || 'direct', status: 'running', startedAt: iso(), tokens: null, tokenUsage: null,
      appliedEffort: null, modelRequest: meta.modelRequest ?? meta.boundary === 'host-attempt',
      observation: { boundary: meta.boundary, requestCount: meta.boundary === 'external-request' ? 1 : meta.boundary === 'local-wait' ? 0 : null } };
    // A local wait (a back-off the provider's rate limit asked for) is a Call of kind 'wait' that says why.
    if (meta.boundary === 'local-wait') {
      if (meta.kind !== 'wait') throw failure('invalid-observation-boundary');
      if (typeof meta.reason === 'string') call.reason = meta.reason.slice(0, LIMITS.callLabelLength);
    }
    for (const key of ['tier', 'model', 'selectedEffort', 'fallbackReason']) if (typeof meta[key] === 'string') call[key] = meta[key].slice(0, LIMITS.callLabelLength);
    const run = (async () => {
      await durability?.intent(call);
      try { if (!meta.cleanup) { context.assertCurrent(); entry.signal.throwIfAborted(); } }
      catch (error) { await durability?.undispatched(call); throw error; }
      call.startedAt = iso(); record.calls.push(call);
      // An observed end is a known outcome; only a declared side-effecting operation that
      // failed (or reports an unknown remote result) keeps its intent pending for reconciliation.
      let outcomeKnown = meta.sideEffect !== true;
      try {
        const result = await operation(entry.signal, call);
        outcomeKnown = meta.sideEffect !== true || !result?.remoteResultUnknown;
        call.status = result?.status >= 400 ? 'failed' : 'ok';
        if (result?.tokenUsage) { call.tokenUsage = structuredClone(result.tokenUsage); call.tokens = totalTokens(call.tokenUsage); }
        for (const key of ['childId', 'parentId', 'appliedEffort']) if (typeof result?.[key] === 'string') call[key] = result[key];
        if (result?.ledgerEvent) {
          call.ledgerEvent = { ...structuredClone(result.ledgerEvent), callId: call.callId };
          call.accounting = 'pending';
        }
        if (!meta.cleanup) { context.assertCurrent(); entry.signal.throwIfAborted(); }
        return result?.value;
      } catch (error) {
        call.status = entry.signal.aborted && !meta.cleanup ? 'cancelled' : 'failed';
        // Keep only stable, locally meaningful diagnostics; provider bodies may contain input.
        call.reason = entry.signal.aborted ? 'aborted' : 'request-failed';
        throw error;
      } finally {
        call.endedAt = iso(); refreshUsage();
        if (durability) { if (outcomeKnown) await durability.completed(call); else await durability.persist(); }
        if (call.ledgerEvent) {
          try { await meta.recordUsage?.(call.ledgerEvent); call.accounting = meta.recordUsage ? 'recorded' : 'pending'; }
          catch { call.accounting = 'unrecorded'; }
        }
        if (call.observation.boundary === 'host-attempt' && call.tokenUsage && ledger) {
          try { await ledger(call); call.accounting = 'recorded'; } catch { call.accounting = 'unrecorded'; }
        }
        refreshUsage(); await durability?.persist();
      }
    })();
    pending.add(run); entry.pending.add(run);
    void run.then(() => {}, error => { entry.errors.push(error); }).finally(() => { pending.delete(run); entry.pending.delete(run); });
    return run;
  };
  const observe = (meta, operation) => { const result = observeInner(meta, operation); void result.catch(() => {}); return result; };
  const step = (stepKey, policy, options = {}) => {
    const labels = options.labels || {};
    if (Object.keys(options).some(key => !['labels', 'output', 'model', 'signal'].includes(key)) || !Object.entries(labels).every(labelValid)) throw failure('invalid-step-labels');
    if (options.model !== undefined && !MODEL_LANES.includes(options.model)) throw failure('invalid-model-lane');
    if (options.output && ['open', 'append', 'reasoning', 'close'].some(key => typeof options.output[key] !== 'function')) throw failure('invalid-output-adapter');
    context.assertCurrent();
    if (typeof stepKey !== 'string' || !stepKey || stepKey.length > LIMITS.stepKeyLength) throw failure('invalid-step-key');
    policy = policyOf(policy);
    const light = options.model === 'light';
    if (light && policy.executionMode && policy.executionMode !== 'direct') throw failure('invalid-model-lane');
    const state = { jobId: context.jobId, attemptId: context.attemptId, stepKey, stepRunId: randomUUID(), status: 'queued' };
    record.runtime.steps.push(state);
    const entry = { step: state, policy, labels: structuredClone(labels), pending: new Set(), errors: [], closed: false,
      // The Attempt's signal, the step's own time budget and, when the owner has a narrower scope (a round), that scope's signal.
      signal: AbortSignal.any([context.signal, ...(policy.budget?.timeoutMs ? [AbortSignal.timeout(policy.budget.timeoutMs)] : []), ...(options.signal ? [options.signal] : [])]) };
    const executeStep = async operation => {
      context.assertCurrent(); entry.signal.throwIfAborted();
      if (state.status !== 'queued') throw failure('step-already-started');
      state.status = 'running';
      try {
        const value = await scope.run(entry, operation);
        while (entry.pending.size) await Promise.allSettled([...entry.pending]);
        context.assertCurrent(); entry.signal.throwIfAborted(); state.status = 'complete'; return value;
      } catch (error) { state.status = entry.signal.aborted ? 'cancelled' : 'failed'; throw error; }
      finally { while (entry.pending.size) await Promise.allSettled([...entry.pending]); entry.closed = true; }
    };
    const run = operation => {
      const running = executeStep(operation); pending.add(running);
      void running.then(() => {}, () => {}).finally(() => pending.delete(running));
      return running;
    };
    const complete = (system, prompt) => run(async () => {
      if (!policy.executionMode) throw failure('model-policy-required');
      if (!host?.route) throw failure('model-unavailable');
      if (context.requiresExternalObservation) throw failure('capability-unverified');
      const route = typeof host.route === 'function' ? host.route() : host.route;
      const capability = backgroundCapability(host.ctx, host.sessionId, route);
      // S1 verifies live native parents only; do not silently manufacture a panel coordinator.
      const native = capability.native && !!capability.parent;
      if (policy.executionMode === 'agent-required' && !native) throw failure('agent-unavailable');
      const child = policy.executionMode !== 'direct' && native;
      if (!record.capabilities.executionModes.includes(child ? 'subagent' : 'direct')) throw failure('execution-mode-unsupported');
      if (!child && !(light ? host.light : host.complete)) throw failure('model-unavailable');
      const { selected, choice } = await levelFor(host.ctx, route, policy.requestedEffort, entry.signal);
      const meta = { boundary: 'host-attempt', runner: child ? 'subagent' : 'direct', selectedEffort: choice.id ?? 'default',
        ...(policy.executionMode === 'agent-preferred' && !child ? { fallbackReason: 'agent-unavailable' } : choice.reason ? { fallbackReason: choice.reason } : {}) };
      return observe(meta, async (signal, call) => {
        const output = options.output;
        const sink = { text: text => { call.firstOutputAt ??= iso(); output?.append(call.callId, text); }, reasoning: count => output?.reasoning(call.callId, count) };
        output?.open(call.callId);
        try {
        if (!child) {
          let usage = null;
          try {
            const value = await withUsageSink({ key: `gateway:${state.stepRunId}`, sink: reported => { usage = sumTokens(usage || {}, reported); } },
              () => {
                const request = { task: 'assist', signal, route: selected, maxTokens: policy.budget?.maxOutputTokens, onOutput: sink.text, onReasoning: sink.reasoning };
                return light ? host.light(system, prompt, lightRequest(request, policy)) : host.complete(system, prompt, request);
              }, { feature: policy.feature });
            return { value, tokenUsage: usage };
          } finally { if (usage) { call.tokenUsage = usage; call.tokens = totalTokens(usage); } }
        }
        let handle, untap;
        try {
          handle = await startBoundedChild(capability.subagents, { parent: capability.parent, label: `Study ${context.jobId.slice(0, 8)} · ${labels.stage || policy.purpose}`,
            signal, toolFilter: { allow: [] }, agentOptions: { ...selected, ...(policy.budget?.maxOutputTokens ? { maxTokens: policy.budget.maxOutputTokens } : {}) },
            prompt: [{ type: 'text', text: `${system}\n\n${prompt}` }] }, { ...capability, awaitAdmissionCleanup: true });
          call.childId = handle.id; call.parentId = capability.parent.id;
          untap = tapChildStream(host.ctx.root || host.ctx, handle.id, sink);
          const result = await abortable(handle.result, signal);
          if (result.stopReason !== 'completed') throw childError(handle, result);
          const value = result.output.filter(block => block.type === 'text').map(block => block.text).join('');
          if (!value.trim()) throw failure('empty-model-output');
          return { value, tokenUsage: foldSessionUsage(handle.localAgent?.session)?.usage ?? null,
            childId: handle.id, parentId: capability.parent.id, appliedEffort: choice.id ?? 'default' };
        } finally {
          const usage = foldSessionUsage(handle?.localAgent?.session)?.usage;
          if (usage) { call.tokenUsage = usage; call.tokens = totalTokens(usage); }
          untap?.(); await handle?.dispose();
        }
        } finally { output?.close(call.callId); }
      });
    });
    const reuse = reason => run(async () => {
      if (typeof reason !== 'string' || !reason || reason.length > LIMITS.reuseReasonLength) throw failure('invalid-reuse-reason');
      record.calls.push({ callId: randomUUID(), jobId: context.jobId, attemptId: context.attemptId,
        stepKey, stepRunId: state.stepRunId, kind: policy.purpose, ...policy, ...entry.labels,
        runner: 'saved', status: 'skipped', reason, reused: true, startedAt: null, endedAt: null,
        appliedEffort: null, tokens: null, tokenUsage: null, modelRequest: false, observation: { boundary: 'legacy', requestCount: null } });
      await durability?.persist();
    });
    return Object.freeze({ run, complete, reuse, observe: (meta, operation) => scope.run(entry, () => observe(meta, operation)) });
  };
  return Object.freeze({ step, observe, async drain() { while (pending.size) await Promise.allSettled([...pending]); } });
}
