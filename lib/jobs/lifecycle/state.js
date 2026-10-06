import { errorOf, terminal } from './shared.js';

/** Shared kernel state. `work.jobs` stays the one public job table; the WeakMap
 * holds only private execution/input handles keyed by those records. */
export function createKernelState(root, work) {
  // `contracts`: the record's authoritative contract itself. `job.contract` is a presenting read for outside readers, too costly for internal checks.
  const k = { root, work, entries: new WeakMap(), contracts: new WeakMap(), revokedOwners: new Set(), revokedDomains: new Set(), disposed: false };
  k.all = () => [...work.jobs.values()].map(job => k.entries.get(job)).filter(Boolean);
  k.live = entry => !k.disposed && k.registry.has(entry.definition)
    && !k.revokedOwners.has(entry.owner) && !k.revokedDomains.has(entry.domain);
  k.assertCurrent = (entry, attempt) => {
    const c = k.contracts.get(entry.job);
    if (!k.live(entry) || c.runtime.activeAttemptId !== attempt.attemptId || entry.controller.signal.aborted || terminal(c.status))
      throw errorOf('stale-attempt', 'Stale or stopped Attempt cannot publish');
  };
  return k;
}
