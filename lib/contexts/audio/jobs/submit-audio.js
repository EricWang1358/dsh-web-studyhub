import { AUDIO_TEXT, audioRefusal, quotaSingleOnly, savedAs } from '../../../audio-messages.js';

/** The audio jobs on the runtime: their definition kind, the switch that routes new submissions to it, the card field naming their folder, and their input. */
export const AUDIO_PATHS = Object.freeze({
  single: Object.freeze({ kind: 'audio-import', switchKey: 'audioSingle', lineage: 'singleId', sharedQuota: true, input: record => ({ singleId: record.id }) }),
  batch: Object.freeze({ kind: 'audio-batch', switchKey: 'audioBatch', lineage: 'batchId', sharedQuota: false, input: record => ({ batchId: record.id }) }),
});
/** The path a manifest record belongs to: a single recording or a batch. */
export const pathOf = record => record.kind === 'single' ? AUDIO_PATHS.single : AUDIO_PATHS.batch;

const receipt = (contract, queuedBehind, extra) => ({ jobId: contract.runtime.legacyId, status: contract.status, queuedBehind, next: AUDIO_TEXT.started, ...extra });

/** Whether a record the runtime saved can be brought back into it now (a rolled-back build, with no runtime, keeps it as read-only history). */
export const restorable = (service, record) => Object.hasOwn(record, 'runtimeJob') && record.runtimeJob?.contract?.runtime?.scopeId === 'audio.v1' && !!service.runtimeJobs;

/**
 * Whether another version finished the work this record's runtime job still calls unfinished: a build rolled back to 2.7.1 finishes an interrupted import by its own
 * path and writes only the facts it knows (the documents, every file complete), never the runtime record. The documents of the work are then in the library:
 * the record is shown as the finished work it is, not as an interrupted job. Nothing is written; the runtime record stays as it is.
 */
export function finishedElsewhere(record, state) {
  if (record.runtimeJob?.contract?.status === 'complete') return false;
  return (record.kind === 'single' || record.members.every(member => member.skipped || member.status === 'complete')) && documentsOf(record, state).length > 0;
}

/** The documents a single import or a batch made, as the library holds them. */
const documentsOf = (record, state) => (state.sources ?? []).filter(source => record.kind === 'single'
  ? source.audio?.hash === record.input?.hash && !source.audio.batch : source.audio?.batch?.id === record.id);

/** The card of work another version finished: complete, with the documents that are in the library, and nothing to retry. */
export function finishedFacts(record, state) {
  const ids = documentsOf(record, state).map(source => source.id);
  return { status: 'complete', phase: 'done', retryable: false, sourceIds: ids, stage: savedAs(ids.length) };
}

/** Whether this submission goes through the runtime: the switch of its path is on, or its record already belongs to the runtime. */
export const runsOnRuntime = (service, record) => Object.hasOwn(record, 'runtimeJob') || service.runtimePilot?.[pathOf(record).switchKey] === true;

/**
 * Submit, restore or retry one audio job on the runtime. Refusals come back in the learner's words.
 * `extra` is added to the receipt; `prepareRetry()` may change the record before a retry and returns how to put it back should the retry not start;
 * `explain(error)` may add what only the domain knows (which file changed) to a refusal.
 */
export async function startManagedAudio(service, record, { retry = false, cleanup, extra, prepareRetry, explain } = {}) {
  const path = pathOf(record), { kind, input } = path;
  if (!path.sharedQuota && service.providerResources?.enabled) throw quotaSingleOnly();
  const binding = { ...service.runtimeBinding(), cleanup }, jobs = service.runtimeJobs;
  const gate = binding.work.audioGate, queuedBehind = gate.active.size >= gate.limit ? gate.waiting.length + 1 : 0;
  const undo = retry ? await prepareRetry?.() : undefined;
  try {
    if (!Object.hasOwn(record, 'runtimeJob')) return receipt(await jobs.submit(kind, input(record), {}, binding), queuedBehind, extra);
    const restored = await jobs.restore(kind, input(record), binding);
    return retry ? receipt(await jobs.recover(restored.jobId, 'retry'), queuedBehind, extra) : receipt(restored, queuedBehind, extra);
  } catch (error) { await undo?.(); throw audioRefusal(await explain?.(error) ?? error); }
}

/** Bring a saved audio job back into the runtime after a restart (read-only until acted on). */
export const restoreManagedAudio = (service, record, cleanup) => {
  const { kind, input } = pathOf(record);
  return service.runtimeJobs.restore(kind, input(record), { ...service.runtimeBinding(), cleanup });
};
