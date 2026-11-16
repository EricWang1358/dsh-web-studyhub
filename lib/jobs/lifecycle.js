import { workOwnedBy } from '../runtime/work-ownership.js';
import { createJobRegistry } from './registry.js';
import { attemptOps } from './lifecycle/attempt.js';
import { controlOps } from './lifecycle/control.js';
import { jobRecordOps } from './lifecycle/job-record.js';
import { recoveryOps } from './lifecycle/recovery.js';
import { scopedOps } from './lifecycle/scoped.js';
import { settlementOps } from './lifecycle/settlement.js';
import { errorOf } from './lifecycle/shared.js';
import { createKernelState } from './lifecycle/state.js';
import { timerOps } from './lifecycle/timers.js';
import { viewOps } from './lifecycle/view.js';

/** The one business lifecycle over work.jobs. Each concern lives in ./lifecycle/;
 * this file only assembles them over one shared kernel state. */
export function createJobLifecycle(root, work) {
  const k = createKernelState(root, work);
  k.registry = createJobRegistry(definition => k.stopWhere(entry => entry.definition === definition));
  for (const ops of [viewOps, timerOps, settlementOps, attemptOps, recoveryOps, jobRecordOps, controlOps]) Object.assign(k, ops(k));
  const scoped = scopedOps(k);
  const find = id => k.all().find(entry => entry.job.id === id);
  return Object.freeze({
    register(ctx, domain, definition) { const remove = k.registry.register(ctx, domain, definition); k.revokedDomains.delete(domain); return remove; },
    scoped,
    visible(id, owner) { const entry = find(id); return !entry || (owner !== undefined && workOwnedBy(entry.job, owner)); },
    compatible(id, owner, services = {}) {
      const entry = find(id);
      if (!entry) return null;
      if (owner === undefined || !workOwnedBy(entry.job, owner)) throw errorOf('job-not-found', 'Job not found for this owner');
      return scoped({ owner, domain: entry.domain, executor: services.jobExecutor || entry.executor,
        resourceScope: services.providerResources?.forDomain(owner, entry.domain) || entry.resourceScope, modelHost: services.jobModelHost || entry.modelHost });
    },
    cancelOwner(owner) { k.revokedOwners.add(owner); return k.stopWhere(entry => entry.owner === owner); },
    cancelDomain(domain) { k.revokedDomains.add(domain); return k.registry.removeScope(domain); },
    diagnostics(owner) {
      const entries = k.all().filter(entry => owner === undefined || entry.owner === owner);
      let activeJobs = 0, queuedJobs = 0, cancellingJobs = 0, stopRefusedJobs = 0, activeTimers = 0;
      const jobs = entries.map(entry => {
        const c = k.contracts.get(entry.job) || entry.job.contract;
        const status = c.status;
        if (['queued', 'running', 'pausing', 'paused', 'cancelling'].includes(status)) activeJobs++;
        if (status === 'queued') queuedJobs++;
        if (status === 'cancelling') cancellingJobs++;
        if (c.detail?.stopConfirmation === 'unknown') stopRefusedJobs++;
        const timers = entry.timers?.size || 0;
        activeTimers += timers;
        return {
          jobId: c.jobId,
          legacyId: c.runtime.legacyId,
          kind: c.kind,
          status,
          stopConfirmation: c.detail?.stopConfirmation || null,
          cancelRequestedAt: entry.cancelRequestedIso || null,
          settledAt: entry.settledIso || c.finishedAt || null,
          cancelSettleMs: entry.cancelSettleMs ?? null,
          activeTimers: timers,
          retainedCalls: c.calls.length,
          archivedCalls: c.detail?.archivedCalls?.totalCalls || 0,
          retainedSteps: c.runtime.steps.length,
          archivedSteps: c.detail?.archivedSteps || 0,
        };
      });
      return {
        totalJobs: entries.length,
        activeJobs,
        queuedJobs,
        cancellingJobs,
        stopRefusedJobs,
        activeTimers,
        settledWaiters: k.work.settled.size,
        jobs,
      };
    },
    dispose() { k.disposed = true; return k.stopWhere(() => true); },
  });
}
