import { AUDIO_TEXT, audioRefusal } from '../../../audio-messages.js';
import { subtitleKey, subtitlePlan } from '../../../subtitle-job.js';

export const SUBTITLES_KIND = 'audio-subtitles';
/** The fields of the resolved import context a subtitle job keeps (the cues travel separately; nothing else of the request is needed). */
const CONTEXT_FIELDS = ['title', 'subject', 'course', 'courses', 'vocabulary', 'paidOnly'];

/** Whether new subtitle imports go through the runtime (the switch of this path). */
export const subtitlesOnRuntime = service => service.runtimePilot?.audioSubtitles === true;

const receipt = contract => ({ jobId: contract.runtime.legacyId, status: contract.status, queuedBehind: 0, next: AUDIO_TEXT.started });

/**
 * Start a subtitle import on the runtime. The same file (same cues, same settings) is refused while it is being imported; a different file with the
 * same name is not. `running(key)` says whether a job of this library holds that key. Refusals come back in the learner's words.
 */
export async function startManagedSubtitles(service, { input, args }, running) {
  const context = Object.fromEntries(CONTEXT_FIELDS.filter(field => args[field] !== undefined).map(field => [field, args[field]]));
  if (running(subtitleKey(subtitlePlan({ input, args: context, settings: await service.audioSettings() })))) throw new Error(AUDIO_TEXT.subtitleRunning);
  try { return receipt(await service.runtimeJobs.submit(SUBTITLES_KIND, { input, args: context }, {}, service.runtimeBinding())); }
  catch (error) { throw audioRefusal(error); }
}

/** Retry a job that lives only in this process (its input is in memory, not in a folder): the same job, a new attempt. */
export async function retryInProcess(service, contractJobId) {
  try { return receipt(await service.runtimeJobs.control(contractJobId, 'retry')); }
  catch (error) { throw audioRefusal(error); }
}
