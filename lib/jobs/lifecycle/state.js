import { errorOf, terminal } from './shared.js';

/** Shared kernel state. `work.jobs` stays the one public job table; the WeakMap
 * holds only private execution/input handles keyed by those records. */
export function createKernelState(root, work) {
  const k = { root, work, entries: new WeakMap(), revokedOwners: new Set(), revokedDomains: new Set(), disposed: false };
  k.all = () => [...work.jobs.values()].map(job => k.entries.get(job)).filter(Boolean);
  k.live = entry => !k.disposed && k.registry.has(entry.definition)
    && !k.revokedOwners.has(entry.owner) && !k.revokedDomains.has(entry.domain);
  k.assertCurrent = (entry, attempt) => {
    const c = entry.job.contract;
    if (!k.live(entry) || c.runtime.activeAttemptId !== attempt.attemptId || entry.controller.signal.aborted || terminal(c.status))
      throw errorOf('stale-attempt', 'Stale or stopped Attempt cannot publish');
  };
  return k;
}
