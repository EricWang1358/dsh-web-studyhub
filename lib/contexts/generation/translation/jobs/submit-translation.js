import { REFUSALS } from '../../jobs/messages.js';
import { TRANSLATION_KIND } from './translation.js';

/** Hand a prepared translation to the unified runtime (the entry is only reached behind `runtime.pilot.translation`); resolves with the id the learner and
 * the tools know the job by. The job waits in the library's one queue, behind everything accepted before it, like every other job of the library. */
export async function startTranslation(env, task) {
  // Calls of a job are not yet observed against a shared provider quota: refuse instead of failing every call.
  if (env.sharedQuota) throw Object.assign(new Error(REFUSALS['capability-unverified']), { code: 'capability-unverified' });
  try {
    const started = await env.jobs.submit(TRANSLATION_KIND, { args: task.args }, {}, { task: { ...task, queue: env.queue, work: env.work }, announce: env.announce });
    return { jobId: started.runtime.legacyId };
  } catch (error) {
    throw REFUSALS[error?.code] ? Object.assign(new Error(REFUSALS[error.code]), { code: error.code }) : error;
  }
}
