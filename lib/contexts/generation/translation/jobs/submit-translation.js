import { REFUSALS } from '../../jobs/messages.js';
import { TRANSLATION_KIND } from './translation.js';

const PRESENTED_WAIT_MS = 1000;

/** Hand a prepared translation to the unified runtime (the entry is only reached behind `runtime.pilot.translation`); resolves with the id the learner and
 * the tools know the job by. The job waits in the library's one queue, behind everything accepted before it, like every other job of the library. */
export async function startTranslation(env, task) {
  // Calls of a job are not yet observed against a shared provider quota: refuse instead of failing every call.
  if (env.sharedQuota) throw Object.assign(new Error(REFUSALS['capability-unverified']), { code: 'capability-unverified' });
  try {
    const started = await env.jobs.submit(TRANSLATION_KIND, { args: task.args }, {}, { task: { ...task, queue: env.queue, work: env.work } });
    // The record is in the job table at once; what it says about itself (its root, its document) from its first turn. The caller that asks for the job straight away
    // (a second start, the list, the status) finds it whole: wait for that turn, a moment at most (a slow executor is not waited for: the second start has the id).
    const id = started.runtime.legacyId;
    for (let waited = 0; env.work.jobs.get(id)?.origin !== 'translation' && waited < PRESENTED_WAIT_MS; waited += 10) await new Promise(resolve => setTimeout(resolve, 10));
    return { jobId: id };
  } catch (error) {
    throw REFUSALS[error?.code] ? Object.assign(new Error(REFUSALS[error.code]), { code: error.code }) : error;
  }
}
