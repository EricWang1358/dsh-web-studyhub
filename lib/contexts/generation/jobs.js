import { activeJob, generationControllers, jobs } from '../../legacy-kernel.js';
import { workOwnedBy } from '../../runtime/work-ownership.js';
export function disposeGenerationJobs(root, owner) {
  for (const job of jobs.values()) if (job.root === root && workOwnedBy(job, owner) && job.type !== 'audio-import' && activeJob(job)) {
    job.cancelRequestedAt ||= new Date().toISOString();
    generationControllers.get(job.id)?.abort(new Error('Generation plugin unloaded; approved content retained'));
  }
}
