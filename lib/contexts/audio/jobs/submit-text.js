import { AUDIO_TEXT, audioRefusal } from '../../../audio-messages.js';

const receipt = contract => ({ jobId: contract.runtime.legacyId, status: contract.status, queuedBehind: 0, next: AUDIO_TEXT.started });

/** Whether new jobs of a text-only audio path go through the runtime (the switch of that path). */
export const textOnRuntime = (service, switchKey) => service.runtimePilot?.[switchKey] === true;

/**
 * Start a text-only audio job (a subtitle import, a review) on the runtime. The same work (`key`) is refused while it is being done, in its own
 * words (`busy`); refusals of the runtime come back in the learner's words. `running(key)` says whether a job of this library holds the key.
 */
export async function startTextJob(service, { kind, input, key, busy }, running) {
  if (running(key)) throw new Error(busy);
  try { return receipt(await service.runtimeJobs.submit(kind, input, {}, service.runtimeBinding())); }
  catch (error) { throw audioRefusal(error); }
}

/** Retry a job that lives only in this process (its input is in memory, not in a folder): the same job, a new attempt. */
export async function retryInProcess(service, contractJobId) {
  try { return receipt(await service.runtimeJobs.control(contractJobId, 'retry')); }
  catch (error) { throw audioRefusal(error); }
}
