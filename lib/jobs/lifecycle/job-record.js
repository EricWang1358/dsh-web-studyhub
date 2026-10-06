import { randomUUID } from 'node:crypto';
import { ownWork } from '../../runtime/work-ownership.js';

/** A fresh v2 contract for a definition. Shape lives here only. */
export function newContract(definition, kind, domain) {
  return { contractVersion: 2, jobId: randomUUID(), kind, title: definition.title || kind, status: 'queued',
    stage: { code: 'queued' }, progress: { done: 0, total: null, unit: null, percent: null, segments: [] },
    result: { refs: [], completeness: null }, error: null, usage: { tokens: null, tokenUsage: null, calls: null }, execution: { mode: null },
    detail: {}, startedAt: null, calls: [], events: [], capabilities: structuredClone(definition.capabilities),
    runtime: { schemaVersion: 1, definitionVersion: definition.version, scopeId: domain, legacyId: randomUUID(), activeAttemptId: null, attempts: [], steps: [] } };
}

const legacyStatus = contract => ['paused', 'pausing'].includes(contract.status) ? 'running'
  : contract.status === 'interrupted' ? 'failed' : contract.status;

/** The work.jobs record: read-only getters over the authoritative contract, so
 * legacy readers and the console see one fact source. */
export function jobRecordOps(k) {
  const makeJob = (contract, owner, definition) => {
    const job = ownWork({ root: k.root }, owner);
    k.contracts.set(job, contract);
    // Reading the fields of a record one after the other (a spread, a scan of the table) is one read: a presentation validates the whole contract.
    const presented = () => {
      const entry = k.entries.get(job);
      if (entry?.presentedThisTurn) return contract;
      k.present(contract, entry);
      if (entry) { entry.presentedThisTurn = true; queueMicrotask(() => { entry.presentedThisTurn = false; }); }
      return contract;
    };
    Object.defineProperty(job, 'contract', { enumerable: true, get: presented });
    for (const key of definition.legacyFields || []) Object.defineProperty(job, key, { enumerable: true, get: () => presented().detail.legacy?.[key] });
    const getters = { id: () => contract.runtime.legacyId, type: () => contract.kind, status: () => legacyStatus(contract),
      stage: () => contract.error?.message || contract.stage.text || contract.stage.code, startedAt: () => contract.startedAt, finishedAt: () => contract.finishedAt };
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(job, key, { enumerable: true, get });
    return job;
  };
  return { makeJob };
}
