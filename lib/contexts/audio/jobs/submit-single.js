import { AUDIO_TEXT, audioRefusal } from '../../../audio-messages.js';

const receipt = (contract, queuedBehind = 0) => ({ jobId: contract.runtime.legacyId, status: contract.status, queuedBehind, next: AUDIO_TEXT.started });

/** Submit, restore or retry one recording on the runtime. Refusals come back in the learner's words. */
export async function startManagedSingle(service, record, { retry = false, cleanup } = {}) {
  const binding = { ...service.runtimeBinding(), cleanup }, jobs = service.runtimeJobs;
  const gate = binding.work.audioGate, queuedBehind = gate.active.size >= gate.limit ? gate.waiting.length + 1 : 0;
  try {
    if (!Object.hasOwn(record, 'runtimeJob')) return receipt(await jobs.submit('audio-import', { singleId: record.id }, {}, binding), queuedBehind);
    const restored = await jobs.restore('audio-import', { singleId: record.id }, binding);
    return retry ? receipt(await jobs.recover(restored.jobId, 'retry'), queuedBehind) : receipt(restored);
  } catch (error) { throw audioRefusal(error); }
}

/** Bring a saved single import back into the runtime after a restart (read-only until acted on). */
export function restoreManagedSingle(service, record, cleanup) {
  return service.runtimeJobs.restore('audio-import', { singleId: record.id }, { ...service.runtimeBinding(), cleanup });
}
