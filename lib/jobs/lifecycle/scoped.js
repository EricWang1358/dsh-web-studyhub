import { createDurability } from '../durability.js';
import { workOwnedBy } from '../../runtime/work-ownership.js';
import { newContract } from './job-record.js';
import { policyOf } from './control.js';
import { errorOf } from './shared.js';

/** The public job API for one owner/domain: submit, restore, recover, status, list,
 * wait, control, output. Nothing here branches on a job kind. */
export function scopedOps(k) {
  return ({ owner, domain, executor, resourceScope, modelHost, assertActive = () => {} }) => {
    const authorize = id => {
      if (owner === undefined || !domain) throw errorOf('scope-required');
      const entry = k.all().find(entry => (entry.job.contract.jobId === id || entry.job.id === id) && entry.domain === domain && workOwnedBy(entry.job, owner));
      if (!entry) throw errorOf('job-not-found', 'Job not found for this owner/domain');
      return entry;
    };
    const bindExecution = entry => {
      // A read-only restore has no producer. Only a later authorized request can
      // supply a real executor; live Attempts retain their admitted services.
      if (!executor || entry.settling || entry.admissionBusy || (!entry.restored && entry.job.contract.runtime.activeAttemptId)) return;
      entry.executor = executor; entry.resourceScope = resourceScope; entry.modelHost = modelHost;
    };
    const newEntry = (job, definition, fields) => {
      const entry = { job, owner, domain, definition, executor, resourceScope, modelHost, notified: false, ...fields };
      entry.logical = new Promise(resolve => { entry.resolveLogical = resolve; });
      k.entries.set(job, entry); return entry;
    };
    const rebindRestored = async (existing, adapter, bindings) => {
      authorize(existing.job.contract.jobId);
      if (existing.restored) { bindExecution(existing); await k.identifyRecovery(existing); }
      const c = existing.job.contract;
      if (bindings === undefined || existing.settling || existing.admissionBusy || c.runtime.activeAttemptId || c.status === 'complete') return;
      try {
        await existing.durable.drain();
        await existing.durable.preflight(existing.definition.version);
        existing.bindings = bindings;
        existing.durable = createDurability(adapter, c, { ...existing.durable.metadata, contract: c });
      } catch (error) { existing.recoveryBlocked = error.code || 'recovery-validation-failed'; }
    };

    return Object.freeze({
      async submit(kind, input, policy = {}, bindings) {
        assertActive();
        if (owner === undefined || !domain || k.disposed || k.revokedOwners.has(owner) || k.revokedDomains.has(domain)) throw errorOf('scope-unloaded');
        const definition = k.registry.get(domain, kind);
        executor?.assertAvailable(); if (!executor) throw errorOf('executor-unavailable');
        const options = policyOf(policy), contract = newContract(definition, kind, domain, input);
        const job = k.makeJob(contract, owner, definition);
        const entry = newEntry(job, definition, { input: structuredClone(input), policy: options, bindings });
        const adapter = definition.persistence ? await k.openPersistence(definition, input, bindings) : null;
        if (adapter) {
          if (await adapter.store.load()) throw errorOf('durable-job-exists');
          entry.input = structuredClone(adapter.input ?? input); entry.durable = createDurability(adapter, contract);
        }
        k.snapshot(entry); k.work.jobs.set(job.id, job); k.work.settled.set(job.id, entry.logical);
        try { await k.begin(entry); } catch (error) { k.work.jobs.delete(job.id); k.work.settled.delete(job.id); throw error; }
        return k.snapshot(entry);
      },
      async restore(kind, input, bindings) {
        assertActive();
        if (owner === undefined || !domain || k.disposed) throw errorOf('scope-unloaded');
        const definition = k.registry.get(domain, kind);
        if (!definition.persistence) throw errorOf('recovery-unsupported');
        const adapter = await k.openPersistence(definition, input, bindings);
        if (!adapter) throw errorOf('recovery-unsupported');
        const saved = await adapter.store.load();
        if (!saved) throw errorOf('legacy-record');
        const contract = saved.contract;
        if (contract.kind !== kind || contract.runtime.scopeId !== domain) throw errorOf('job-identity-conflict');
        const existing = k.all().find(entry => entry.job.contract.jobId === contract.jobId);
        if (existing) { await rebindRestored(existing, adapter, bindings); return k.snapshot(existing); }
        const job = k.makeJob(contract, owner, definition);
        const entry = newEntry(job, definition, { input: structuredClone(adapter.input ?? input), bindings,
          policy: structuredClone(contract.runtime.attempts.at(-1)?.policySnapshot || {}), timers: new Set(), physical: Promise.resolve(), restored: true });
        entry.durable = createDurability(adapter, contract, saved);
        entry.checkpointRef = saved.checkpoint?.ref;
        k.work.jobs.set(job.id, job);
        await k.identifyRecovery(entry);
        if (!entry.notified) entry.resolveLogical();
        return k.snapshot(entry);
      },
      async recover(id, action = 'retry') {
        const entry = authorize(id);
        if (!entry.durable || entry.definition.capabilities.recoveryMode === 'none') throw errorOf('recovery-unsupported');
        bindExecution(entry);
        if (entry.restored || entry.recoveryBlocked) await k.identifyRecovery(entry);
        return this.control(id, action);
      },
      status: id => k.snapshot(authorize(id)),
      list: () => k.all().filter(entry => owner !== undefined && entry.owner === owner && entry.domain === domain).map(k.snapshot),
      async wait(id, { timeoutMs } = {}) {
        const entry = authorize(id); let timeout;
        try {
          if (timeoutMs === undefined) await entry.logical;
          else await Promise.race([entry.logical, new Promise(resolve => { timeout = setTimeout(resolve, Math.max(0, timeoutMs)); })]);
          return k.snapshot(entry);
        } finally { clearTimeout(timeout); }
      },
      async control(id, action, patch) {
        const entry = authorize(id), c = entry.job.contract;
        if (entry.recoveryBlocked) throw errorOf(entry.recoveryBlocked);
        if (action === 'cancel') {
          if (!c.capabilities.cancel) throw errorOf('capability-unsupported');
          k.stop(entry); if (entry.durable && !entry.settling) await k.persist(entry); return k.snapshot(entry);
        }
        assertActive(); if (!k.live(entry)) throw errorOf('scope-unloaded');
        k.refresh(c, entry); const verdict = c.actions[action];
        if (!verdict?.available) throw errorOf(verdict?.reason?.code || 'unknown-action');
        if (action === 'set') await k.set(entry, patch);
        else if (action === 'pause') await k.pause(entry);
        else if (action === 'resume' || action === 'retry') { bindExecution(entry); await k.restart(entry, action); }
        return k.snapshot(entry);
      },
      output(id, { cursor = 0 } = {}) { return authorize(id).handle?.output(cursor); },
    });
  };
}
