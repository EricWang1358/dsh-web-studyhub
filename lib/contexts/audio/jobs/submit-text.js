import { AUDIO_TEXT, audioRefusal } from '../../../audio-messages.js';

const receipt = (contract, queuedBehind = 0) => ({ jobId: contract.runtime.legacyId, status: contract.status, queuedBehind, next: AUDIO_TEXT.started });

/** Whether new jobs of a text-only audio path go through the runtime (the switch of that path). */
export const textOnRuntime = (service, switchKey) => service.runtimePilot?.[switchKey] === true;

/**
 * Start a text-only audio job (a subtitle import, a review, a class save) on the runtime. The same work (`key`) is refused while it is being done, in its
 * own words (`busy`); refusals of the runtime come back in the learner's words. `running(key)` says whether a job of this library holds the key.
 * `gated`: the job waits for the host's transcription slot like a transcription (the receipt says how many are ahead). `bindings`: what the job
 * is given beside the library's services (the live class a save works on).
 */
export async function startTextJob(service, { kind, input, key, busy, gated = false, bindings = {} }, running) {
  if (running(key)) throw new Error(busy);
  const binding = { ...service.runtimeBinding(), ...bindings }, gate = binding.work.audioGate;
  const queuedBehind = gated && gate.active.size >= gate.limit ? gate.waiting.length + 1 : 0;
  try { return receipt(await service.runtimeJobs.submit(kind, input, {}, binding), queuedBehind); }
  catch (error) { throw audioRefusal(error); }
}

/** Retry a job that lives only in this process (its input is in memory, not in a folder): the same job, a new attempt. */
export async function retryInProcess(service, contractJobId) {
  try { return receipt(await service.runtimeJobs.control(contractJobId, 'retry')); }
  catch (error) { throw audioRefusal(error); }
}
