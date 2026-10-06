import { randomUUID } from 'node:crypto';
import { runAttempt } from './run.js';
import { errorOf, iso } from './shared.js';

/** Admit a new Attempt for an existing logical Job and hand it to the native executor.
 * A failed admission restores the previous record (or fails it when nothing ran). */
export function attemptOps(k) {
  const begin = async entry => {
    const c = entry.job.contract;
    if (!k.live(entry)) throw errorOf('scope-unloaded');
    if (!entry.executor) throw errorOf('executor-unavailable');
    entry.executor.assertAvailable();
    if (c.runtime.activeAttemptId) throw errorOf('attempt-active');
    const before = structuredClone(c), previous = { handle: entry.handle, restored: entry.restored,
      witness: structuredClone(entry.durable?.metadata.executorWitness ?? null) };
    if (entry.durable) await entry.durable.preflight(entry.definition.version);
    if (!k.live(entry)) throw errorOf('scope-unloaded');
    if (c.runtime.activeAttemptId || c.status !== before.status) throw errorOf('attempt-active');
    const attempt = openAttempt(entry);
    const queueTimer = k.timer(entry, entry.policy.queueTimeoutMs, 'queue-timeout');
    let resolvePhysical, resolveNative, admitProducer;
    entry.physical = new Promise(resolve => { resolvePhysical = resolve; });
    // DSH calls run synchronously during native admission. Defer producer work
    // until its returned physical handle and the business record are installed.
    const admitted = new Promise(resolve => { admitProducer = resolve; });
    const execute = () => runAttempt(k, entry, attempt, { admitted, queueTimer, resolvePhysical });
    try {
      if (entry.durable) {
        entry.durable.metadata.executorWitness = entry.executor.witness(); await k.persist(entry);
        if (entry.controller.signal.aborted) return await cancelBeforeStart(entry, attempt, resolvePhysical);
      }
      entry.handle = entry.executor.start({ kind: c.kind, title: c.title,
        run: () => new Promise(resolve => {
          resolveNative = resolve;
          const dispatch = setTimeout(() => { entry.timers.delete(dispatch); resolve(execute()); }, 0);
          entry.timers.add(dispatch);
        }),
        cancel: reason => { k.stop(entry, reason || 'owner-disposed', true); } });
      attempt.executor = { service: 'dsh-jobs', handleId: entry.handle.id, ownerAgentId: entry.handle.ownerAgentId };
      await k.persist(entry); admitProducer(true);
    } catch (error) {
      admitProducer(false); try { entry.handle?.stop('store-admission-failed'); } catch { /* preserve admission error */ }
      k.clearTimers(entry); resolveNative?.({ status: 'failed' });
      await rollbackAdmission(entry, attempt, before, previous);
      resolvePhysical(); throw error;
    }
  };

  const openAttempt = entry => {
    const c = entry.job.contract;
    entry.restored = false; entry.recoveryBlocked = null; entry.handle = null;
    const attempt = { jobId: c.jobId, attemptId: randomUUID(), definitionVersion: entry.definition.version, status: 'queued',
      executor: null, policySnapshot: structuredClone(entry.policy) };
    c.runtime.attempts.push(attempt); c.attemptId = attempt.attemptId; c.runtime.activeAttemptId = attempt.attemptId;
    c.status = 'queued'; c.stage = { code: 'queued' };
    c.error = null; delete c.finishedAt; delete c.endReason;
    entry.commitsPending = new Set(); entry.commitErrors = []; entry.settling = false;
    entry.controller = new AbortController(); entry.pauseController = new AbortController(); entry.timers = new Set();
    entry.stopReason = null; entry.pauseRequested = false;
    return attempt;
  };

  const cancelBeforeStart = async (entry, attempt, resolvePhysical) => {
    const c = entry.job.contract;
    attempt.status = 'cancelled'; attempt.endReason = 'user-cancel'; attempt.finishedAt = iso();
    c.runtime.activeAttemptId = null; c.status = 'cancelled'; c.endReason = 'user-cancel'; c.stage = { code: 'cancelled' };
    k.clearTimers(entry); await k.finishLogical(entry); resolvePhysical();
  };

  const rollbackAdmission = async (entry, attempt, before, previous) => {
    const c = entry.job.contract, admittedHandle = entry.handle;
    if (entry.durable && admittedHandle) {
      attempt.status = 'failed'; attempt.finishedAt = iso(); c.runtime.activeAttemptId = null; c.status = 'failed';
      c.stage = { code: 'failed' }; c.error = { code: 'store-admission-failed', message: 'Native binding could not be saved before execution' };
    } else {
      for (const key of Object.keys(c)) delete c[key]; Object.assign(c, before);
      entry.handle = previous.handle; entry.restored = previous.restored;
      if (entry.durable) {
        entry.durable.metadata.executorWitness = previous.witness;
        if (!c.runtime.attempts.length) {
          c.status = 'failed'; c.stage = { code: 'failed' }; c.error = { code: 'job-admission-failed', message: 'Job admission failed before execution' };
        }
      }
    }
    if (entry.durable) try {
      if (admittedHandle || !c.runtime.attempts.length) await k.finishLogical(entry); else await k.persist(entry);
    } catch { entry.recoveryBlocked = 'store-write-failed'; }
  };

  return { begin };
}
