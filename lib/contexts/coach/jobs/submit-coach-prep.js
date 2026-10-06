import { PREP_KIND } from './coach-prep.js';
import { PREP_MESSAGES } from './messages.js';

/** What the runtime refuses a batch with, in the learner's words (any other refusal keeps its own message). */
const REFUSALS = Object.freeze({ 'executor-unavailable': PREP_MESSAGES.unavailable, 'scope-unloaded': PREP_MESSAGES.unavailable });

/**
 * The body of one queued 'prep' task. With `runtime.pilot.coach` on (the one place that reads it) a batch runs as a Job of the unified runtime: the task
 * keeps its place in the library's lane and its view for the card projection, the Job runs the batch and answers its outcome. Off, the old body.
 */
export function prepRunner(worker) {
  if (worker.runtimePilot?.coach !== true || !worker.runtimeJobs) return batch => worker.writePrepared(batch);
  return async batch => {
    const input = { batch, cardIds: [...new Set(batch.map(target => target.cardId))] };
    const receipt = await worker.runtimeJobs.submit(PREP_KIND, input, {}, worker.runtimeBinding()).catch(error => { throw new Error(REFUSALS[error.code] ?? error.message); });
    void worker.pruneJobs?.();
    const ended = await worker.runtimeJobs.wait(receipt.jobId);
    const { message } = ended.detail.legacy;
    if (ended.status === 'complete') return message;
    throw new Error(ended.error?.message || message || PREP_MESSAGES.cancelled);
  };
}
