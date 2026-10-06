import { recordGenerationFailure, runDailyGeneration } from '../daily-generation.js';
import { RECAP_KIND } from './daily-recap.js';
import { RECAP_MESSAGES } from './messages.js';

/** What the runtime refuses a generation with, in the learner's words (any other refusal keeps its own message). */
const REFUSALS = Object.freeze({ 'executor-unavailable': RECAP_MESSAGES.unavailable, 'scope-unloaded': RECAP_MESSAGES.unavailable });

/**
 * How one generation is carried out: `{ written }` once it has ended. With `runtime.pilot.dailyRecap` on (the one place that reads it) it runs as a Job of the
 * unified runtime and stopping it stops the Job; off, in process as before. Either way the note, its guards and `pending` are the domain's.
 */
export function dailyRecapExecutor({ worker, store, complete, language }) {
  if (worker?.runtimePilot?.dailyRecap !== true || !worker.runtimeJobs) return job => runDailyGeneration({ store, complete, language, job });
  return async job => {
    const { pending, signal: _signal, ...input } = job;
    try {
      const receipt = await worker.runtimeJobs.submit(RECAP_KIND, { job: input }, {}, { ...worker.runtimeBinding(), pending, agent: worker.runtimePilot?.dailyRecapAgent === true });
      pending.bind(() => worker.runtimeJobs.control(receipt.jobId, 'cancel').catch(() => {}));
      const ended = await worker.runtimeJobs.wait(receipt.jobId);
      return { written: ended.detail.legacy.written === true };
    } catch (error) {
      await recordGenerationFailure(store, job, new Error(REFUSALS[error.code] ?? error.message));
      return { written: false };
    }
  };
}
