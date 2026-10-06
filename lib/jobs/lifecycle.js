import { randomUUID } from 'node:crypto';
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
  const refresh = contract => {
    const { status, capabilities: caps } = contract;
    const ended = terminal(status), stopping = status === 'cancelling';
    contract.actions = {
      cancel: !caps.cancel ? denied('capability-unsupported') : ended ? denied('job-ended') : stopping ? denied('already-cancelling') : { available: true },
      pause: { ...(!['queued', 'running'].includes(status) ? denied(ended ? 'job-ended' : 'not-running') : caps.pauseMode === 'unsupported' || (caps.pauseMode === 'queued-only' && status !== 'queued') ? denied('capability-unsupported') : { available: true }), mode: caps.pauseMode },
      resume: status === 'paused' ? { available: true } : denied('not-paused'),
      retry: !caps.retry ? denied('capability-unsupported') : ['failed', 'cancelled', 'interrupted'].includes(status) ? { available: true } : denied('not-retryable'),
      set: denied('capability-unsupported'),
    };
  };
  const snapshot = entry => { refresh(entry.job.contract); return validateRuntimeContract(entry.job.contract); };
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
  const finishLogical = entry => {
    const c = entry.job.contract;
    if (!terminal(c.status) || entry.notified) return;
    entry.notified = true; c.finishedAt = iso();
    c.events.push({ eventId: `${c.jobId}:${c.attemptId || 'unstarted'}:settled`, type: 'settled', at: c.finishedAt, status: c.status });
    work.settled.delete(entry.job.id);
    refresh(c); entry.resolveLogical();
  };
  const stop = (entry, reason = 'user-cancel', fromHost = false) => {
    const c = entry.job.contract;
    if (terminal(c.status) || c.status === 'cancelling') return snapshot(entry);
    entry.stopReason = reason;
    if (!c.runtime.activeAttemptId) { c.status = 'cancelled'; c.endReason = 'user-cancel'; finishLogical(entry); return snapshot(entry); }
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
  const begin = entry => {
    const c = entry.job.contract;
    if (!live(entry)) throw errorOf('scope-unloaded');
    entry.executor.assertAvailable();
    if (c.runtime.activeAttemptId) throw errorOf('attempt-active');
    const before = structuredClone(c);
    const attempt = { jobId: c.jobId, attemptId: randomUUID(), definitionVersion: entry.definition.version, status: 'queued', executor: null, policySnapshot: structuredClone(entry.policy) };
    c.runtime.attempts.push(attempt); c.attemptId = attempt.attemptId; c.runtime.activeAttemptId = attempt.attemptId; c.status = 'queued'; c.stage = { code: 'queued' };
    c.error = null; delete c.finishedAt; delete c.endReason;
    entry.controller = new AbortController(); entry.timers = new Set(); entry.stopReason = null; entry.pauseRequested = false;
    const queueTimer = timer(entry, entry.policy.queueTimeoutMs, 'queue-timeout');
    let resolvePhysical;
    entry.physical = new Promise(resolve => { resolvePhysical = resolve; });
    // DSH calls run synchronously during native admission. Defer producer work
    // until its returned physical handle and the business record are installed.
    const execute = async () => {
      let outcome = { status: 'failed' };
      try {
        assertCurrent(entry, attempt);
        if (entry.pauseRequested && c.capabilities.pauseMode === 'queued-only') throw checkpointPause;
        removeTimer(entry, queueTimer);
        c.status = 'running'; attempt.status = 'running'; attempt.startedAt = iso(); c.startedAt ??= attempt.startedAt; c.stage = { code: 'running' }; refresh(c);
        timer(entry, entry.policy.executionTimeoutMs, 'execution-timeout');
        const context = Object.freeze({ signal: entry.controller.signal, jobId: c.jobId, attemptId: attempt.attemptId, checkpointRef: entry.checkpointRef,
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
          checkpoint(ref) {
            assertCurrent(entry, attempt);
            if (!entry.pauseRequested) return false;
            if (typeof ref !== 'string' || !ref) throw errorOf('no-safe-checkpoint');
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
        assertCurrent(entry, attempt);
        const output = structuredClone(result || { refs: [], completeness: null });
        output.completeness ??= null;
        validateRuntimeContract({ ...snapshot(entry), result: output }); c.result = output;
        attempt.status = 'complete'; c.status = 'complete'; outcome = { status: 'completed' };
      } catch (error) {
        if (error === checkpointPause && !entry.controller.signal.aborted && live(entry)) {
          attempt.status = 'complete';
          if (c.capabilities.pauseMode === 'checkpoint') { attempt.endReason = 'checkpoint-pause'; attempt.checkpointRef = entry.checkpointRef; }
          c.status = 'paused'; outcome = { status: 'completed' };
          if (c.capabilities.pauseMode === 'queued-only') { attempt.status = 'cancelled'; outcome = { status: 'killed' }; }
        } else if (entry.controller.signal.aborted || !live(entry)) {
          attempt.status = 'cancelled'; attempt.endReason = 'user-cancel'; c.status = 'cancelled'; c.endReason = 'user-cancel'; outcome = { status: 'killed' };
          if (entry.stopReason && entry.stopReason !== 'user-cancel') c.detail.stopReason = entry.stopReason;
        } else {
          attempt.status = 'failed'; c.status = 'failed'; c.error = { message: String(error?.message || error), ...(error?.code ? { code: error.code } : {}) };
        }
      } finally {
        clearTimers(entry); attempt.finishedAt = iso(); c.runtime.activeAttemptId = null;
        c.stage = { code: c.status }; refresh(c); finishLogical(entry); resolvePhysical();
      }
      return outcome;
    };
    try {
      entry.handle = entry.executor.start({ kind: c.kind, title: c.title,
        run: () => new Promise(resolve => { const dispatch = setTimeout(() => { entry.timers.delete(dispatch); resolve(execute()); }, 0); entry.timers.add(dispatch); }), cancel: reason => { stop(entry, reason || 'owner-disposed', true); } });
      attempt.executor = { service: 'dsh-jobs', handleId: entry.handle.id, ownerAgentId: entry.handle.ownerAgentId };
    } catch (error) { clearTimers(entry); for (const key of Object.keys(c)) delete c[key]; Object.assign(c, before); resolvePhysical(); throw error; }
  };
  const scoped = ({ owner, domain, executor, assertActive = () => {} }) => {
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
        const job = ownWork({ root, contract }, owner);
        for (const [key, get] of Object.entries({ id: () => contract.runtime.legacyId, type: () => contract.kind, status: () => ['paused', 'pausing'].includes(contract.status) ? 'running' : contract.status === 'interrupted' ? 'failed' : contract.status,
          stage: () => contract.error?.message || contract.stage.text || contract.stage.code, startedAt: () => contract.startedAt, finishedAt: () => contract.finishedAt })) Object.defineProperty(job, key, { enumerable: true, get });
        const entry = { job, owner, domain, definition, executor, input: structuredClone(input), policy: options, notified: false };
        entry.logical = new Promise(resolve => { entry.resolveLogical = resolve; }); entries.set(job, entry);
        snapshot(entry); begin(entry); work.jobs.set(job.id, job); work.settled.set(job.id, entry.logical);
        return snapshot(entry);
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
        if (action === 'cancel') { if (!c.capabilities.cancel) throw errorOf('capability-unsupported'); return stop(entry); }
        assertActive(); if (!live(entry)) throw errorOf('scope-unloaded');
        refresh(c); const verdict = c.actions[action];
        if (!verdict?.available) throw errorOf(verdict?.reason?.code || 'unknown-action');
        if (action === 'pause') { entry.pauseRequested = true; c.status = 'pausing'; c.stage = { code: 'pausing' }; c.runtime.attempts.at(-1).status = 'pausing'; }
        else if (action === 'resume' || action === 'retry') {
          begin(entry);
          if (action === 'retry') {
            work.jobs.delete(entry.job.id); c.runtime.legacyId = randomUUID(); work.jobs.set(entry.job.id, entry.job);
            entry.notified = false; entry.logical = new Promise(resolve => { entry.resolveLogical = resolve; }); work.settled.set(entry.job.id, entry.logical);
          }
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
