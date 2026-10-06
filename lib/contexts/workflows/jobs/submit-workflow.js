import { WORKFLOW } from '../settings.js';
import { SKELETON_KIND } from './skeleton.js';
import { TEACHING_KIND } from './teaching.js';
import { WORKFLOW_MESSAGES } from './messages.js';

/** Which Job runs which unit, and how long it may take (the limit is the Job's own execution time, which stops the request). */
const UNITS = Object.freeze({
  teaching: { kind: TEACHING_KIND, title: () => WORKFLOW_MESSAGES.teachingTitle, timeoutMs: WORKFLOW.teachingTimeoutMs },
  skeleton: { kind: SKELETON_KIND, title: () => WORKFLOW_MESSAGES.skeletonTitle, timeoutMs: WORKFLOW.skeletonTimeoutMs },
});
/** What the runtime refuses a unit with, in the learner's words (any other refusal keeps its own message). */
const REFUSALS = Object.freeze({ 'executor-unavailable': WORKFLOW_MESSAGES.unavailable, 'scope-unloaded': WORKFLOW_MESSAGES.unavailable });

/**
 * How a background unit of the learning workflow is carried out: `execute(unit, { job, input, finish })`. With `runtime.pilot.workflow` on (the one place that reads it) it
 * runs as a Job of the unified runtime; off, in process as before. Either way the session, the step's record and the single-flight table are the domain's:
 * `finish(execution?)` writes the outcome, and a unit the runtime refuses is finished with its refusal as the failure.
 */
export function workflowExecutor(worker) {
  return async (unit, { job, input, finish }) => {
    if (worker.runtimePilot?.workflow !== true || !worker.runtimeJobs) { await finish(); return; }
    const { kind, title, timeoutMs } = UNITS[unit];
    const plain = { id: job.id, sessionId: job.sessionId, stepId: job.stepId, mode: job.mode, title: title(job) };
    try {
      const receipt = await worker.runtimeJobs.submit(kind, { job: plain, input }, { executionTimeoutMs: timeoutMs }, { ...worker.runtimeBinding(), live: job });
      await worker.runtimeJobs.wait(receipt.jobId);
    } catch (error) {
      await finish({ run: async () => { throw error; }, describe: refused => REFUSALS[refused.code] ?? refused.message });
    }
  };
}
