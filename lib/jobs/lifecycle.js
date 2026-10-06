import { randomUUID } from 'node:crypto';
import { usageLedger } from '../model-usage.js';
import { createDurability } from './durability.js';
import { createModelGateway } from './gateway.js';
import { createJobRegistry } from './registry.js';
import { validateRuntimeContract } from './contract.js';
import { ownWork, workOwnedBy } from '../runtime/work-ownership.js';

const terminal = status => ['complete', 'failed', 'cancelled', 'interrupted'].includes(status);
const errorOf = (code, message = code) => Object.assign(new Error(message), { code });
const checkpointPause = Symbol('checkpoint pause');
const iso = () => new Date().toISOString();
const denied = code => ({ available: false, reason: { code } });

/** The one business lifecycle over work.jobs. Weak entries contain only private
 * execution/input handles; the contract on each existing record is authoritative.
 */
export function createJobLifecycle(root, work) {
  const entries = new WeakMap(), revokedOwners = new Set(), revokedDomains = new Set();
  let disposed = false;
  const registry = createJobRegistry(definition => stopWhere(entry => entry.definition === definition));
  const refresh = (contract, entry) => {
    const { status, capabilities: caps } = contract;
    const ended = terminal(status), stopping = status === 'cancelling';
    contract.actions = {
      cancel: !caps.cancel ? denied('capability-unsupported') : ended ? denied('job-ended') : stopping ? denied('already-cancelling') : { available: true },
      pause: { ...(!['queued', 'running'].includes(status) ? denied(ended ? 'job-ended' : 'not-running') : caps.pauseMode === 'unsupported' || (caps.pauseMode === 'queued-only' && status !== 'queued') ? denied('capability-unsupported') : { available: true }), mode: caps.pauseMode },
      resume: status === 'paused' ? { available: true } : denied('not-paused'),
      retry: !caps.retry ? denied('capability-unsupported') : ['failed', 'cancelled', 'interrupted'].includes(status) ? { available: true } : denied('not-retryable'),
      set: denied('capability-unsupported'),
    };
    if (entry?.settling) for (const action of ['cancel', 'pause', 'resume', 'retry']) contract.actions[action] = { ...denied('job-settling'), ...(action === 'pause' ? { mode: caps.pauseMode } : {}) };
    if (entry?.recoveryBlocked) for (const action of ['cancel', 'pause', 'resume', 'retry']) contract.actions[action] = { ...denied(entry.recoveryBlocked), ...(action === 'pause' ? { mode: caps.pauseMode } : {}) };
    if (entry && !live(entry)) for (const action of Object.keys(contract.actions))
      contract.actions[action] = { ...denied('scope-unloaded'), ...(action === 'pause' ? { mode: caps.pauseMode } : {}) };
  };
  const snapshot = entry => { refresh(entry.job.contract, entry); return validateRuntimeContract(entry.job.contract); };
  const all = () => [...work.jobs.values()].map(job => entries.get(job)).filter(Boolean);
  const live = entry => !disposed && registry.has(entry.definition) && !revokedOwners.has(entry.owner) && !revokedDomains.has(entry.domain);
  const clearTimers = entry => { for (const timer of entry.timers) clearTimeout(timer); entry.timers.clear(); };
  const timer = (entry, ms, code) => {
    if (ms == null) return;
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid ${code} duration`);
    const token = setTimeout(() => { entry.timers.delete(token); stop(entry, code); }, ms);
    entry.timers.add(token); return token;
  };
  const removeTimer = (entry, token) => { clearTimeout(token); entry.timers.delete(token); };
  const assertCurrent = (entry, attempt) => {
    if (!live(entry) || entry.job.contract.runtime.activeAttemptId !== attempt.attemptId || entry.controller.signal.aborted || terminal(entry.job.contract.status)) throw errorOf('stale-attempt', 'Stale or stopped Attempt cannot publish');
  };
  const openPersistence = async (definition, input) => {
    const port = await definition.persistence.open(structuredClone(input));
    return { ...port,
      validateAccounting: async () => { await usageLedger(root).validate(); await port.validateAccounting?.(); },
      replayCall: async call => {
        if (call.observation.boundary === 'host-attempt' && call.tokenUsage) await usageLedger(root).record({ callId: call.callId, feature: call.feature, usage: call.tokenUsage, calls: 1, at: Date.parse(call.startedAt) });
        else if (port.replayCall) await port.replayCall(call);
        else throw errorOf('ledger-invalid');
      },
    };
  };
  const persist = entry => { refresh(entry.job.contract, entry); return entry.durable?.persist(); };
  const finishLogical = async entry => {
    const c = entry.job.contract;
    if (!terminal(c.status) || entry.notified) return;
    c.finishedAt ||= iso();
    const eventId = `${c.jobId}:${c.attemptId || 'unstarted'}:settled`;
    if (!c.events.some(event => event.eventId === eventId)) c.events.push({ eventId, type: 'settled', at: c.finishedAt, status: c.status });
    await persist(entry); entry.notified = true;
    work.settled.delete(entry.job.id);
    refresh(c, entry); void entry.durable?.deliver().catch(() => {}); entry.resolveLogical();
  };
  const stop = (entry, reason = 'user-cancel', fromHost = false) => {
    const c = entry.job.contract;
    if (entry.settling) return snapshot(entry);
    if (entry.restored && c.runtime.activeAttemptId) return snapshot(entry);
    if (terminal(c.status) || c.status === 'cancelling') return snapshot(entry);
    entry.stopReason = reason;
    if (!c.runtime.activeAttemptId) { c.status = 'cancelled'; c.endReason = 'user-cancel'; void finishLogical(entry).catch(error => { c.detail.durabilityError = error.code || 'store-write-failed'; entry.resolveLogical(); }); return snapshot(entry); }
    c.status = 'cancelling'; c.stage = { code: 'cancelling' }; c.runtime.attempts.at(-1).status = 'cancelling';
    entry.controller.abort(errorOf(reason));
    if (!fromHost) try { entry.handle?.stop(reason); } catch { c.detail.stopConfirmation = 'unknown'; }
    return snapshot(entry);
  };
  async function stopWhere(predicate) {
    const selected = all().filter(predicate);
    for (const entry of selected) stop(entry, 'scope-unloaded');
    await Promise.all(selected.map(entry => entry.physical));
  }
  const begin = async entry => {
    const c = entry.job.contract;
    if (!live(entry)) throw errorOf('scope-unloaded');
    entry.executor.assertAvailable();
    if (c.runtime.activeAttemptId) throw errorOf('attempt-active');
    const before = structuredClone(c), previousHandle = entry.handle, previousWitness = structuredClone(entry.durable?.metadata.executorWitness ?? null);
    if (entry.durable) await entry.durable.preflight(entry.definition.version);
    if (!live(entry)) throw errorOf('scope-unloaded');
    if (c.runtime.activeAttemptId || c.status !== before.status) throw errorOf('attempt-active');
    entry.restored = false; entry.recoveryBlocked = null; entry.handle = null;
    const attempt = { jobId: c.jobId, attemptId: randomUUID(), definitionVersion: entry.definition.version, status: 'queued', executor: null, policySnapshot: structuredClone(entry.policy) };
    c.runtime.attempts.push(attempt); c.attemptId = attempt.attemptId; c.runtime.activeAttemptId = attempt.attemptId; c.status = 'queued'; c.stage = { code: 'queued' };
    c.error = null; delete c.finishedAt; delete c.endReason;
    entry.commitsPending = new Set(); entry.commitErrors = []; entry.settling = false;
    entry.controller = new AbortController(); entry.timers = new Set(); entry.stopReason = null; entry.pauseRequested = false;
    const queueTimer = timer(entry, entry.policy.queueTimeoutMs, 'queue-timeout');
    let resolvePhysical;
    entry.physical = new Promise(resolve => { resolvePhysical = resolve; });
    // DSH calls run synchronously during native admission. Defer producer work
    // until its returned physical handle and the business record are installed.
    let resolveNative;
    let admitProducer; const admitted = new Promise(resolve => { admitProducer = resolve; });
    const execute = async () => {
      if (entry.durable && !await admitted) return { status: 'failed' };
      let outcome = { status: 'failed' }, finalState = { status: 'failed' };
      let resourceLease, gateway;
      try {
        assertCurrent(entry, attempt);
        if (entry.pauseRequested && c.capabilities.pauseMode === 'queued-only') throw checkpointPause;
        removeTimer(entry, queueTimer);
        c.status = 'running'; attempt.status = 'running'; attempt.startedAt = iso(); c.startedAt ??= attempt.startedAt; c.stage = { code: 'running' }; refresh(c, entry);
        if (entry.durable) await persist(entry);
        timer(entry, entry.policy.executionTimeoutMs, 'execution-timeout');
        resourceLease = entry.resourceScope?.open(entry.controller.signal);
        gateway = createModelGateway({ context: { jobId: c.jobId, attemptId: attempt.attemptId, signal: entry.controller.signal, requiresExternalObservation: !!resourceLease?.enabled, assertCurrent: () => assertCurrent(entry, attempt) }, record: c, host: entry.modelHost, durability: entry.durable,
          ledger: call => usageLedger(root).record({ callId: call.callId, feature: call.feature, usage: call.tokenUsage, calls: 1, at: Date.parse(call.startedAt) }) });
        const context = Object.freeze({ gateway, signal: entry.controller.signal, jobId: c.jobId, attemptId: attempt.attemptId, checkpointRef: entry.checkpointRef,
          ...(resourceLease ? { resources: resourceLease.resources } : {}),
          get pauseRequested() { return entry.pauseRequested; },
          output(text) { assertCurrent(entry, attempt); if (typeof text !== 'string') throw errorOf('invalid-output'); entry.handle.append(text); },
          progress(value) { assertCurrent(entry, attempt); const next = { ...c.progress, ...structuredClone(value) }; validateRuntimeContract({ ...snapshot(entry), progress: next }); c.progress = next; },
          // Async preparation may outlive cancellation; publication is a short,
          // synchronous domain commit, fenced again after preparation completes.
          async commit(prepare, publish) {
            assertCurrent(entry, attempt);
            if (typeof publish !== 'function' || publish.constructor.name === 'AsyncFunction') throw errorOf('async-publication-unsupported');
            const prepared = await prepare(); assertCurrent(entry, attempt);
            const result = publish(prepared);
            if (result?.then) throw errorOf('async-publication-unsupported');
            return result;
          },
          commitArtifact(stepKey, prepare, adapter) {
            assertCurrent(entry, attempt);
            if (!entry.durable || typeof adapter?.publish !== 'function' || typeof stepKey !== 'string' || !stepKey || stepKey.length > 200) throw errorOf('recovery-unsupported');
            const pending = (async () => {
              const existing = entry.durable.metadata.commits.find(item => item.stepKey === stepKey);
              if (existing) {
                const receipt = await entry.durable.port.reconcileCommit(structuredClone(existing));
                if (!receipt) throw errorOf('artifact-conflict');
                assertCurrent(entry, attempt); return receipt;
              }
              const prepared = await prepare(); assertCurrent(entry, attempt);
              const commit = { stepKey, attemptId: attempt.attemptId, status: 'pending', receipt: null };
              entry.durable.metadata.commits.push(commit); await persist(entry);
              try { assertCurrent(entry, attempt); }
              catch (error) { entry.durable.metadata.commits.splice(entry.durable.metadata.commits.indexOf(commit), 1); await persist(entry); throw error; }
              // Once admitted, publication may drain through cancellation. The
              // epoch remains exclusive until this physical Attempt settles.
              const assertPublication = () => { if (c.runtime.activeAttemptId !== attempt.attemptId || terminal(c.status)) throw errorOf('stale-attempt'); };
              commit.receipt = structuredClone(await adapter.publish(prepared, { assertCurrent: assertPublication }));
              commit.status = 'complete';
              if (Array.isArray(commit.receipt?.refs)) {
                const refs = [...c.result.refs];
                for (const ref of commit.receipt.refs) if (!refs.some(item => item.kind === ref.kind && item.id === ref.id)) refs.push(ref);
                c.result = validateRuntimeContract({ ...snapshot(entry), result: { refs, completeness: 'partial' } }).result;
              }
              await persist(entry); return structuredClone(commit.receipt);
            })();
            entry.commitsPending.add(pending);
            void pending.catch(error => { entry.commitErrors.push(error); }).finally(() => entry.commitsPending.delete(pending));
            return pending;
          },
          async saveCheckpoint(checkpoint) {
            assertCurrent(entry, attempt);
            if (!entry.durable) throw errorOf('recovery-unsupported');
            await entry.durable.port.validateCheckpoint(checkpoint); assertCurrent(entry, attempt);
            entry.durable.metadata.checkpoint = structuredClone(checkpoint); entry.checkpointRef = checkpoint.ref;
            attempt.checkpointRef = checkpoint.ref; await persist(entry);
            if (entry.pauseRequested) throw checkpointPause;
          },
          checkpoint(ref) {
            assertCurrent(entry, attempt);
            if (!entry.pauseRequested) return false;
            if (typeof ref !== 'string' || !ref || (entry.durable && entry.durable.metadata.checkpoint?.ref !== ref)) throw errorOf('no-safe-checkpoint');
            entry.checkpointRef = ref; throw checkpointPause;
          },
          async request(run, { timeoutMs } = {}) {
            assertCurrent(entry, attempt);
            const timeout = timer(entry, timeoutMs, 'request-timeout');
            try { const value = await run(entry.controller.signal); assertCurrent(entry, attempt); return value; }
            finally { removeTimer(entry, timeout); }
          },
        });
        const result = await entry.definition.run(context, structuredClone(entry.input));
        await gateway.drain();
        assertCurrent(entry, attempt);
        const output = structuredClone(result || { refs: [], completeness: null });
        output.completeness ??= null;
        validateRuntimeContract({ ...snapshot(entry), result: output });
        finalState = { status: 'complete', result: output }; outcome = { status: 'completed' };
      } catch (error) {
        if (error === checkpointPause && !entry.controller.signal.aborted && live(entry)) {
          finalState = { status: 'paused', attemptStatus: c.capabilities.pauseMode === 'queued-only' ? 'cancelled' : 'complete',
            ...(c.capabilities.pauseMode === 'checkpoint' ? { attemptEndReason: 'checkpoint-pause', checkpointRef: entry.checkpointRef } : {}) };
          outcome = { status: c.capabilities.pauseMode === 'queued-only' ? 'killed' : 'completed' };
        } else {
          finalState = { status: 'failed', error: { message: String(error?.message || error), ...(error?.code ? { code: error.code } : {}) } };
        }
      } finally {
        while (entry.commitsPending.size) await Promise.allSettled([...entry.commitsPending]);
        await gateway?.drain();
        await resourceLease?.finish();
        clearTimers(entry); entry.settling = true;
        if (entry.controller.signal.aborted || !live(entry)) {
          finalState = { status: 'cancelled', endReason: 'user-cancel', attemptEndReason: 'user-cancel' }; outcome = { status: 'killed' };
        } else if (entry.commitErrors.length && finalState.status === 'complete') {
          finalState = { status: 'failed', error: { code: 'artifact-commit-failed', message: 'An admitted artifact commit failed' } }; outcome = { status: 'failed' };
        }
        const next = structuredClone(c), nextAttempt = next.runtime.attempts.at(-1);
        next.status = finalState.status; next.stage = { code: next.status }; next.runtime.activeAttemptId = null;
        nextAttempt.status = finalState.attemptStatus || next.status; nextAttempt.finishedAt = iso();
        if (finalState.attemptEndReason) nextAttempt.endReason = finalState.attemptEndReason;
        if (finalState.checkpointRef) nextAttempt.checkpointRef = finalState.checkpointRef;
        for (const key of ['result', 'error', 'endReason']) if (finalState[key] !== undefined) next[key] = finalState[key];
        if (entry.stopReason && entry.stopReason !== 'user-cancel') next.detail.stopReason = entry.stopReason;
        if (terminal(next.status)) {
          next.finishedAt = iso(); const eventId = `${next.jobId}:${next.attemptId}:settled`;
          if (!next.events.some(event => event.eventId === eventId)) next.events.push({ eventId, type: 'settled', at: next.finishedAt, status: next.status });
        }
        refresh(next, { ...entry, settling: false });
        try {
          if (entry.durable) await entry.durable.persist(next);
          for (const key of Object.keys(c)) delete c[key]; Object.assign(c, next);
          if (terminal(c.status)) { entry.notified = true; work.settled.delete(entry.job.id); void entry.durable?.deliver().catch(() => {}); entry.resolveLogical(); }
        } catch (error) {
          Object.assign(c, next); c.detail.durabilityError = error.code || 'store-write-failed'; c.status = 'failed'; c.runtime.attempts.at(-1).status = 'failed';
          c.error = { code: 'store-write-failed', message: 'Job outcome could not be saved' }; entry.recoveryBlocked = 'store-write-failed'; work.settled.delete(entry.job.id); entry.resolveLogical();
        } finally { entry.settling = false; refresh(c, entry); resolvePhysical(); }
      }
      return outcome;
    };
    try {
      if (entry.durable) {
        entry.durable.metadata.executorWitness = entry.executor.witness(); await persist(entry);
        if (entry.controller.signal.aborted) {
          attempt.status = 'cancelled'; attempt.endReason = 'user-cancel'; attempt.finishedAt = iso();
          c.runtime.activeAttemptId = null; c.status = 'cancelled'; c.endReason = 'user-cancel'; c.stage = { code: 'cancelled' };
          clearTimers(entry); await finishLogical(entry); resolvePhysical(); return;
        }
      }
      entry.handle = entry.executor.start({ kind: c.kind, title: c.title,
        run: () => new Promise(resolve => { resolveNative = resolve; const dispatch = setTimeout(() => { entry.timers.delete(dispatch); resolve(execute()); }, 0); entry.timers.add(dispatch); }), cancel: reason => { stop(entry, reason || 'owner-disposed', true); } });
      attempt.executor = { service: 'dsh-jobs', handleId: entry.handle.id, ownerAgentId: entry.handle.ownerAgentId };
      await persist(entry); admitProducer(true);
    } catch (error) {
      admitProducer(false); try { entry.handle?.stop('store-admission-failed'); } catch { /* preserve admission error */ }
      clearTimers(entry); resolveNative?.({ status: 'failed' });
      const admittedHandle = entry.handle;
      if (entry.durable && admittedHandle) {
        attempt.status = 'failed'; attempt.finishedAt = iso(); c.runtime.activeAttemptId = null; c.status = 'failed';
        c.stage = { code: 'failed' }; c.error = { code: 'store-admission-failed', message: 'Native binding could not be saved before execution' };
      } else {
        for (const key of Object.keys(c)) delete c[key]; Object.assign(c, before); entry.handle = previousHandle;
        if (entry.durable) {
          entry.durable.metadata.executorWitness = previousWitness;
          if (!c.runtime.attempts.length) { c.status = 'failed'; c.stage = { code: 'failed' }; c.error = { code: 'job-admission-failed', message: 'Job admission failed before execution' }; }
        }
      }
      if (entry.durable) try {
        if (admittedHandle || !c.runtime.attempts.length) await finishLogical(entry); else await persist(entry);
      } catch { entry.recoveryBlocked = 'store-write-failed'; }
      resolvePhysical(); throw error;
    }
  };
  const identifyRecovery = async entry => {
    const contract = entry.job.contract; entry.recoveryBlocked = null;
    if (contract.runtime.activeAttemptId) {
      const attempt = contract.runtime.attempts.at(-1);
      const observation = entry.executor?.inspect?.(attempt.executor, entry.durable.metadata.executorWitness) || { state: 'unknown' };
      if (observation.state !== 'lost') entry.recoveryBlocked = observation.state === 'alive' ? 'executor-alive' : 'executor-unknown';
      else {
        attempt.status = 'interrupted'; attempt.endReason = 'executor-lost';
        contract.status = 'interrupted'; contract.runtime.activeAttemptId = null; contract.stage = { code: 'interrupted' };
        for (const step of contract.runtime.steps) if (step.attemptId === attempt.attemptId && ['queued', 'running'].includes(step.status)) step.status = 'interrupted';
        contract.detail.executorLoss = observation.reason || 'executor-lost';
      }
    }
    if (!entry.recoveryBlocked && entry.definition.capabilities.recoveryMode === 'none') entry.recoveryBlocked = 'recovery-unsupported';
    refresh(contract, entry);
    if (!entry.recoveryBlocked) {
      try { await entry.durable.preflight(entry.definition.version); }
      catch (error) { entry.recoveryBlocked = error.code || 'recovery-validation-failed'; }
    }
    if (terminal(contract.status)) {
      try { await finishLogical(entry); } catch (error) { entry.recoveryBlocked = error.code || 'store-write-failed'; }
    }
  };
  const makeJob = (contract, owner) => {
    const job = ownWork({ root, contract }, owner);
    for (const [key, get] of Object.entries({ id: () => contract.runtime.legacyId, type: () => contract.kind, status: () => ['paused', 'pausing'].includes(contract.status) ? 'running' : contract.status === 'interrupted' ? 'failed' : contract.status,
          stage: () => contract.error?.message || contract.stage.text || contract.stage.code, startedAt: () => contract.startedAt, finishedAt: () => contract.finishedAt })) Object.defineProperty(job, key, { enumerable: true, get });
    return job;
  };
  const scoped = ({ owner, domain, executor, resourceScope, modelHost, assertActive = () => {} }) => {
    const authorize = id => {
      if (owner === undefined || !domain) throw errorOf('scope-required');
      const entry = all().find(entry => (entry.job.contract.jobId === id || entry.job.id === id) && entry.domain === domain && workOwnedBy(entry.job, owner));
      if (!entry) throw errorOf('job-not-found', 'Job not found for this owner/domain');
      return entry;
    };
    return Object.freeze({
      async submit(kind, input, policy = {}) {
        assertActive(); if (owner === undefined || !domain || disposed || revokedOwners.has(owner) || revokedDomains.has(domain)) throw errorOf('scope-unloaded');
        const definition = registry.get(domain, kind);
        executor?.assertAvailable(); if (!executor) throw errorOf('executor-unavailable');
        const options = structuredClone(policy);
        for (const key of Object.keys(options)) if (!['queueTimeoutMs', 'executionTimeoutMs'].includes(key) || !Number.isFinite(options[key]) || options[key] < 0) throw errorOf('invalid-policy');
        const contract = { contractVersion: 2, jobId: randomUUID(), kind, title: definition.title || kind, status: 'queued',
          stage: { code: 'queued' }, progress: { done: 0, total: null, unit: null, percent: null, segments: [] },
          result: { refs: [], completeness: null }, error: null, usage: { tokens: null, tokenUsage: null, calls: null }, execution: { mode: null }, detail: {}, startedAt: null, calls: [], events: [],
          capabilities: structuredClone(definition.capabilities), runtime: { schemaVersion: 1, definitionVersion: definition.version, scopeId: domain, legacyId: randomUUID(), activeAttemptId: null, attempts: [], steps: [] } };
        const job = makeJob(contract, owner);
        const entry = { job, owner, domain, definition, executor, resourceScope, modelHost, input: structuredClone(input), policy: options, notified: false };
        entry.logical = new Promise(resolve => { entry.resolveLogical = resolve; }); entries.set(job, entry);
        if (definition.persistence) {
          const adapter = await openPersistence(definition, input);
          if (await adapter.store.load()) throw errorOf('durable-job-exists');
          entry.input = structuredClone(adapter.input ?? input); entry.durable = createDurability(adapter, contract);
        }
        snapshot(entry); work.jobs.set(job.id, job); work.settled.set(job.id, entry.logical);
        try { await begin(entry); } catch (error) { work.jobs.delete(job.id); work.settled.delete(job.id); throw error; }
        return snapshot(entry);
      },
      async restore(kind, input) {
        assertActive();
        if (owner === undefined || !domain || disposed) throw errorOf('scope-unloaded');
        const definition = registry.get(domain, kind);
        if (!definition.persistence) throw errorOf('recovery-unsupported');
        const adapter = await openPersistence(definition, input);
        const saved = await adapter.store.load();
        if (!saved) throw errorOf('legacy-record');
        const contract = saved.contract;
        if (contract.kind !== kind || contract.runtime.scopeId !== domain) throw errorOf('job-identity-conflict');
        const existing = all().find(entry => entry.job.contract.jobId === contract.jobId);
        if (existing) {
          authorize(contract.jobId);
          if (existing.restored) await identifyRecovery(existing);
          return snapshot(existing);
        }
        const job = makeJob(contract, owner);
        const entry = { job, owner, domain, definition, executor, resourceScope, modelHost, input: structuredClone(adapter.input ?? input),
          policy: structuredClone(contract.runtime.attempts.at(-1)?.policySnapshot || {}), timers: new Set(), physical: Promise.resolve(), restored: true, notified: false };
        entry.logical = new Promise(resolve => { entry.resolveLogical = resolve; });
        entry.durable = createDurability(adapter, contract, saved);
        entry.checkpointRef = saved.checkpoint?.ref;
        entries.set(job, entry); work.jobs.set(job.id, job);
        await identifyRecovery(entry);
        entry.resolveLogical();
        return snapshot(entry);
      },
      async recover(id, action = 'retry') {
        const entry = authorize(id);
        if (!entry.durable || entry.definition.capabilities.recoveryMode === 'none') throw errorOf('recovery-unsupported');
        if (entry.restored || entry.recoveryBlocked) await identifyRecovery(entry);
        return this.control(id, action);
      },
      status: id => snapshot(authorize(id)),
      list: () => all().filter(entry => owner !== undefined && entry.owner === owner && entry.domain === domain).map(snapshot),
      async wait(id, { timeoutMs } = {}) {
        const entry = authorize(id); let timeout;
        try { if (timeoutMs === undefined) await entry.logical;
          else await Promise.race([entry.logical, new Promise(resolve => { timeout = setTimeout(resolve, Math.max(0, timeoutMs)); })]);
          return snapshot(entry);
        } finally { clearTimeout(timeout); }
      },
      async control(id, action) {
        const entry = authorize(id), c = entry.job.contract;
        if (entry.recoveryBlocked) throw errorOf(entry.recoveryBlocked);
        if (action === 'cancel') { if (!c.capabilities.cancel) throw errorOf('capability-unsupported'); stop(entry); if (entry.durable && !entry.settling) await persist(entry); return snapshot(entry); }
        assertActive(); if (!live(entry)) throw errorOf('scope-unloaded');
        refresh(c, entry); const verdict = c.actions[action];
        if (!verdict?.available) throw errorOf(verdict?.reason?.code || 'unknown-action');
        if (action === 'pause') { entry.pauseRequested = true; c.status = 'pausing'; c.stage = { code: 'pausing' }; c.runtime.attempts.at(-1).status = 'pausing'; if (entry.durable) await persist(entry); }
        else if (action === 'resume' || action === 'retry') {
          if (entry.admissionBusy) throw errorOf('attempt-active');
          entry.admissionBusy = true;
          try {
            if (entry.restored && c.runtime.activeAttemptId) throw errorOf('executor-unknown');
            if (entry.durable) await entry.durable.preflight(entry.definition.version);
            const oldId = entry.job.id, previousLogical = entry.logical, previousResolve = entry.resolveLogical, previousNotified = entry.notified;
            if (action === 'retry') {
              work.jobs.delete(oldId); c.runtime.legacyId = randomUUID(); work.jobs.set(entry.job.id, entry.job);
              entry.notified = false; entry.logical = new Promise(resolve => { entry.resolveLogical = resolve; }); work.settled.set(entry.job.id, entry.logical);
            }
            try { await begin(entry); }
            catch (error) {
              if (action === 'retry') {
                work.settled.delete(entry.job.id); entry.resolveLogical();
                entry.notified = previousNotified; entry.logical = previousLogical; entry.resolveLogical = previousResolve;
                work.jobs.delete(entry.job.id); c.runtime.legacyId = oldId; work.jobs.set(oldId, entry.job);
                if (entry.durable) try { await persist(entry); } catch { entry.recoveryBlocked = 'store-write-failed'; }
              }
              throw error;
            }
          } finally { entry.admissionBusy = false; }
        }
        return snapshot(entry);
      },
      output(id, { cursor = 0 } = {}) { return authorize(id).handle?.output(cursor); },
    });
  };
  return Object.freeze({ register(ctx, domain, definition) { const remove = registry.register(ctx, domain, definition); revokedDomains.delete(domain); return remove; }, scoped,
    visible(id, owner) { const entry = all().find(entry => entry.job.id === id); return !entry || (owner !== undefined && workOwnedBy(entry.job, owner)); },
    compatible(id, owner) {
      const entry = all().find(entry => entry.job.id === id);
      if (!entry) return null;
      if (owner === undefined || !workOwnedBy(entry.job, owner)) throw errorOf('job-not-found', 'Job not found for this owner');
      return scoped({ owner, domain: entry.domain, executor: entry.executor });
    },
    cancelOwner(owner) { revokedOwners.add(owner); return stopWhere(entry => entry.owner === owner); },
    cancelDomain(domain) { revokedDomains.add(domain); return registry.removeScope(domain); },
    dispose() { disposed = true; return stopWhere(() => true); },
  });
}
