import { legacyIdOf } from './job-record.js';
import { errorOf } from './shared.js';

const ADJUSTABLE_POLICY = ['queueTimeoutMs', 'executionTimeoutMs'];

/** Validated submission policy: only bounded timeouts may be adjusted per Job. */
export function policyOf(policy) {
  const options = structuredClone(policy);
  for (const key of Object.keys(options)) if (!ADJUSTABLE_POLICY.includes(key) || !Number.isFinite(options[key]) || options[key] < 0) throw errorOf('invalid-policy');
  return options;
}

/** job.control actions. Legality comes from the contract's actions, never the kind. */
export function controlOps(k) {
  const pause = async entry => {
    const c = entry.job.contract;
    entry.pauseRequested = true; entry.pauseController.abort();
    c.status = 'pausing'; c.stage = { code: 'pausing' }; c.runtime.attempts.at(-1).status = 'pausing';
    if (entry.durable) await k.persist(entry);
  };

  const set = async (entry, patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.hasOwn(patch, 'paused')) throw errorOf('unknown-setting');
    await entry.controls.patch(structuredClone(patch)); if (entry.durable) await k.persist(entry);
  };

  // Retry keeps the logical jobId but issues a new legacy id; both roll back if admission fails.
  const restart = async (entry, action) => {
    const c = entry.job.contract;
    if (entry.admissionBusy) throw errorOf('attempt-active');
    entry.admissionBusy = true;
    try {
      if (entry.restored && c.runtime.activeAttemptId) throw errorOf('executor-unknown');
      if (entry.durable) await entry.durable.preflight(entry.definition.version);
      const oldId = entry.job.id, previous = { logical: entry.logical, resolve: entry.resolveLogical, notified: entry.notified };
      const resetWait = action === 'retry' || entry.restored;
      if (action === 'retry') { k.work.jobs.delete(oldId); c.runtime.legacyId = legacyIdOf(entry.definition, entry.input); k.work.jobs.set(entry.job.id, entry.job); }
      if (resetWait) {
        entry.notified = false; entry.logical = new Promise(resolve => { entry.resolveLogical = resolve; });
        k.work.settled.set(entry.job.id, entry.logical);
      }
      try { await k.begin(entry); }
      catch (error) {
        if (resetWait) {
          k.work.settled.delete(entry.job.id); entry.resolveLogical();
          entry.notified = previous.notified; entry.logical = previous.logical; entry.resolveLogical = previous.resolve;
        }
        if (action === 'retry') {
          k.work.jobs.delete(entry.job.id); c.runtime.legacyId = oldId; k.work.jobs.set(oldId, entry.job);
          if (entry.durable) try { await k.persist(entry); } catch { entry.recoveryBlocked = 'store-write-failed'; }
        }
        throw error;
      }
    } finally { entry.admissionBusy = false; }
  };

  return { pause, set, restart };
}
