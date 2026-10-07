import { recordNoteFailure, runNoteGeneration } from '../note-generation.js';
import { NOTE_KIND } from './note-generate.js';
import { NOTE_MESSAGES } from './messages.js';

/** What the runtime refuses a draft with, in the learner's words (any other refusal keeps its own message). */
const REFUSALS = Object.freeze({ 'executor-unavailable': NOTE_MESSAGES.unavailable, 'scope-unloaded': NOTE_MESSAGES.unavailable });

/**
 * How one draft is carried out: `start(job)` resolves once the draft is under way with `{ done }`, which resolves `{ written }`
 * when it has ended. With `runtime.pilot.noteGenerate` on (the one place that reads it) the draft is a Job of the unified runtime,
 * submitted before `start` resolves, and stopping it stops the Job; off, it runs in process as before.
 * Either way the note, its guards and `pending` (what every caller stops it by) are the domain's.
 */
export function noteGenerateExecutor({ worker, store, complete }) {
  if (worker?.runtimePilot?.noteGenerate !== true || !worker.runtimeJobs) return async job => ({ done: runNoteGeneration({ store, complete, job }) });
  return async job => {
    const { pending, signal: _signal, ...input } = job;
    try {
      const receipt = await worker.runtimeJobs.submit(NOTE_KIND, { job: input }, {}, { ...worker.runtimeBinding(), pending });
      pending.bind(() => worker.runtimeJobs.control(receipt.jobId, 'cancel').catch(() => {}));
      return { done: worker.runtimeJobs.wait(receipt.jobId).then(ended => ({ written: ended.detail.legacy.written === true })) };
    } catch (error) {
      await recordNoteFailure(store, job, new Error(REFUSALS[error.code] ?? error.message)).catch(() => {});
      return { done: Promise.resolve({ written: false }) };
    }
  };
}
