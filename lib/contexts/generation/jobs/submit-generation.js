import { ownWork } from '../../../runtime/work-ownership.js';
import { legacyModels } from './legacy-model.js';
import { REFUSALS } from './messages.js';

/* The one entry through which a prepared generation run is queued: behind the switch `runtime.pilot.generation` it is a job of the unified
   runtime, otherwise the job table and executor it always was. Either way it waits in the library's one queue (library-queue.js).
   `task` is what the operation prepared: { kind, args, root, seed (the card), makeControl?(card), execute({ job, control, controller, models }), models }.
   A run with nothing for the learner to adjust (a selected-passage supplement) has no makeControl and is given the inert control. */

export const NO_CONTROL = Object.freeze({ values: Object.freeze({}), spec: Object.freeze({}), close() {} });

function startLegacy({ queue, work, workOwner, ask, askLight }, task) {
  const job = task.seed;
  ownWork(job, workOwner);
  work.jobs.set(job.id, job);
  const controller = new AbortController();
  work.generationControllers.set(job.id, controller);
  // The learner's live hand on this run (the 任务 console): it lasts as long as the job.
  const control = task.makeControl?.(job) ?? NO_CONTROL;
  if (task.makeControl) work.jobControls.set(job.id, control);
  const models = legacyModels({ job, control, ...task.models, ask, askLight, outputs: work.jobOutputs, messengers: work.generationMessengers });
  queue.run(task.root, job.id, () => task.execute({ job, control, controller, models }));
  return Promise.resolve({ jobId: job.id });
}

// The runtime registers the job in the table in the first, synchronous part of `submit`: the caller's one-run-per-draft check still holds.
async function startManaged({ jobs, queue, work, sharedQuota, prepare, runs }, task) {
  // Generation calls are not yet observed against a shared provider quota (S3-2): refuse instead of failing every call.
  if (sharedQuota) throw Object.assign(new Error(REFUSALS['capability-unverified']), { code: 'capability-unverified' });
  try {
    const started = await jobs.submit(task.kind, { kind: task.kind, args: task.args }, {}, { task, prepare, queue, work, root: task.root, runs });
    return { jobId: started.runtime.legacyId };
  } catch (error) {
    throw REFUSALS[error?.code] ? Object.assign(new Error(REFUSALS[error.code]), { code: error.code }) : error;
  }
}

/** Queue a prepared run; resolves with the id the learner and the tools know the job by. */
export function startGeneration(env, task) {
  return env.managed ? startManaged(env, task) : startLegacy(env, task);
}
