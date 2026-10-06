import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isEffortPreference, reasoningFor } from '../model-effort.js';
import { backgroundCapability, startBoundedChild, childError, abortable } from '../host-capabilities.js';
import { addUsage, totalTokens, foldSessionUsage } from '../token-usage.js';
import { withUsageSink } from '../usage-scope.js';

const failure = code => Object.assign(new Error(code), { code });
const iso = () => new Date().toISOString();
const sumTokens = (a, b) => { const { calls, ...tokens } = addUsage(a, b); return tokens; };
const modes = ['direct', 'agent-preferred', 'agent-required'];
function policyOf(value) {
  if (!value || Object.keys(value).some(key => !['purpose', 'feature', 'requestedEffort', 'executionMode', 'budget'].includes(key)) || !['purpose', 'feature'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 100) ||
      !isEffortPreference(value.requestedEffort) || !modes.includes(value.executionMode) || !Object.hasOwn(value, 'budget')) throw failure('invalid-gateway-policy');
  if (value.budget !== null && (!value.budget || typeof value.budget !== 'object' || Array.isArray(value.budget) ||
      Object.entries(value.budget).some(([key, count]) => !['timeoutMs', 'maxOutputTokens'].includes(key) || !Number.isSafeInteger(count) || count <= 0 || (key === 'timeoutMs' && count > 2 ** 31 - 1)))) throw failure('invalid-gateway-policy');
  return structuredClone(value);
}

/** Calls/Steps are appended to the existing canonical record. No model retry,
 * Job registry, provider queue, or parallel usage ledger lives in this adapter. */
export function createModelGateway({ context, record, host, ledger }) {
  if (record.jobId !== context.jobId || record.runtime.activeAttemptId !== context.attemptId) throw failure('attempt-mismatch');
  const scope = new AsyncLocalStorage(), pending = new Set();
  const refreshUsage = () => {
    const calls = record.calls.filter(call => call.modelRequest);
    const known = calls.filter(call => call.tokenUsage);
    const usage = known.length ? known.reduce((sum, call) => sumTokens(sum, call.tokenUsage), {}) : null;
    record.usage = { calls: calls.length, tokens: usage ? totalTokens(usage) : null, tokenUsage: usage };
    record.detail.usageIncomplete = known.length < calls.length;
    const runners = new Set(record.calls.map(call => call.runner));
    record.execution.mode = runners.size > 1 ? 'mixed' : [...runners][0] || null;
  };
  const observeInner = async (meta, operation) => {
    const entry = scope.getStore();
    if (!entry || entry.closed || entry.step.status !== 'running') throw failure('step-required');
    if (!meta.cleanup) { context.assertCurrent(); entry.signal.throwIfAborted(); }
    if (!['external-request', 'host-attempt'].includes(meta.boundary)) throw failure('invalid-observation-boundary');
    const call = { callId: randomUUID(), jobId: context.jobId, attemptId: context.attemptId,
      stepKey: entry.step.stepKey, stepRunId: entry.step.stepRunId, kind: meta.kind || entry.policy.purpose,
      ...entry.policy, runner: meta.runner || 'direct', status: 'running', startedAt: iso(), tokens: null, tokenUsage: null,
      appliedEffort: null, modelRequest: meta.modelRequest ?? meta.boundary === 'host-attempt',
      observation: { boundary: meta.boundary, requestCount: meta.boundary === 'external-request' ? 1 : null } };
    for (const key of ['tier', 'model', 'selectedEffort', 'fallbackReason']) if (typeof meta[key] === 'string') call[key] = meta[key].slice(0, 160);
    record.calls.push(call);
    const run = (async () => {
      try {
        const result = await operation(entry.signal, call);
        call.status = result?.status >= 400 ? 'failed' : 'ok';
        if (result?.tokenUsage) { call.tokenUsage = structuredClone(result.tokenUsage); call.tokens = totalTokens(call.tokenUsage); }
        for (const key of ['childId', 'parentId', 'appliedEffort']) if (typeof result?.[key] === 'string') call[key] = result[key];
        if (result?.ledgerEvent) {
          call.ledgerEvent = { ...structuredClone(result.ledgerEvent), callId: call.callId };
          try { await meta.recordUsage?.(call.ledgerEvent); call.accounting = meta.recordUsage ? 'recorded' : 'pending'; }
          catch { call.accounting = 'unrecorded'; }
        }
        if (!meta.cleanup) { context.assertCurrent(); entry.signal.throwIfAborted(); }
        return result?.value;
      } catch (error) {
        call.status = entry.signal.aborted && !meta.cleanup ? 'cancelled' : 'failed';
        // Keep only stable, locally meaningful diagnostics; provider bodies may contain input.
        call.reason = entry.signal.aborted ? 'aborted' : 'request-failed';
        throw error;
      } finally {
        call.endedAt = iso();
        if (call.observation.boundary === 'host-attempt' && call.tokenUsage && ledger) {
          try { await ledger(call); call.accounting = 'recorded'; } catch { call.accounting = 'unrecorded'; }
        }
        refreshUsage();
      }
    })();
    pending.add(run); entry.pending.add(run);
    void run.then(() => {}, error => { entry.errors.push(error); }).finally(() => { pending.delete(run); entry.pending.delete(run); });
    return run;
  };
  const observe = (meta, operation) => { const result = observeInner(meta, operation); void result.catch(() => {}); return result; };
  const step = (stepKey, policy) => {
    context.assertCurrent();
    if (typeof stepKey !== 'string' || !stepKey || stepKey.length > 200) throw failure('invalid-step-key');
    policy = policyOf(policy);
    const state = { jobId: context.jobId, attemptId: context.attemptId, stepKey, stepRunId: randomUUID(), status: 'queued' };
    record.runtime.steps.push(state);
    const entry = { step: state, policy, pending: new Set(), errors: [], closed: false,
      signal: policy.budget?.timeoutMs ? AbortSignal.any([context.signal, AbortSignal.timeout(policy.budget.timeoutMs)]) : context.signal };
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
      if (!host?.route) throw failure('model-unavailable');
      if (context.requiresExternalObservation) throw failure('capability-unverified');
      const route = typeof host.route === 'function' ? host.route() : host.route;
      const capability = backgroundCapability(host.ctx, host.sessionId, route);
      // S1 verifies live native parents only; do not silently manufacture a panel coordinator.
      const native = capability.native && !!capability.parent;
      if (policy.executionMode === 'agent-required' && !native) throw failure('agent-unavailable');
      const child = policy.executionMode !== 'direct' && native;
      if (!record.capabilities.executionModes.includes(child ? 'subagent' : 'direct')) throw failure('execution-mode-unsupported');
      if (!child && !host.complete) throw failure('model-unavailable');
      const choice = await reasoningFor(host.ctx, route, policy.requestedEffort, entry.signal);
      const selected = { ...route, reasoningEffort: choice.id };
      const meta = { boundary: 'host-attempt', runner: child ? 'subagent' : 'direct', selectedEffort: choice.id ?? 'default',
        ...(policy.executionMode === 'agent-preferred' && !child ? { fallbackReason: 'agent-unavailable' } : choice.reason ? { fallbackReason: choice.reason } : {}) };
      return observe(meta, async (signal, call) => {
        if (!child) {
          let usage = null;
          try {
            const value = await withUsageSink({ key: `gateway:${state.stepRunId}`, sink: reported => { usage = sumTokens(usage || {}, reported); } },
              () => host.complete(system, prompt, { task: 'assist', signal, route: selected, maxTokens: policy.budget?.maxOutputTokens }), { feature: policy.feature });
            return { value, tokenUsage: usage };
          } finally { if (usage) { call.tokenUsage = usage; call.tokens = totalTokens(usage); } }
        }
        let handle;
        try {
          handle = await startBoundedChild(capability.subagents, { parent: capability.parent, label: `Study ${context.jobId.slice(0, 8)} · ${policy.purpose}`,
            signal, toolFilter: { allow: [] }, agentOptions: { ...selected, ...(policy.budget?.maxOutputTokens ? { maxTokens: policy.budget.maxOutputTokens } : {}) },
            prompt: [{ type: 'text', text: `${system}\n\n${prompt}` }] }, { ...capability, awaitAdmissionCleanup: true });
          call.childId = handle.id; call.parentId = capability.parent.id;
          const result = await abortable(handle.result, signal);
          if (result.stopReason !== 'completed') throw childError(handle, result);
          const value = result.output.filter(block => block.type === 'text').map(block => block.text).join('');
          if (!value.trim()) throw failure('empty-model-output');
          return { value, tokenUsage: foldSessionUsage(handle.localAgent?.session)?.usage ?? null,
            childId: handle.id, parentId: capability.parent.id, appliedEffort: choice.id ?? 'default' };
        } finally {
          const usage = foldSessionUsage(handle?.localAgent?.session)?.usage;
          if (usage) { call.tokenUsage = usage; call.tokens = totalTokens(usage); }
          await handle?.dispose();
        }
      });
    });
    return Object.freeze({ run, complete, observe: (meta, operation) => scope.run(entry, () => observe(meta, operation)) });
  };
  return Object.freeze({ step, observe, async drain() { while (pending.size) await Promise.allSettled([...pending]); } });
}
