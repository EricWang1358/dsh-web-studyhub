import { withdrawFailureLetter } from '../convert-card.js';
import { TYPE } from '../convert-support.js';

/** mineru.retry of a conversion that is a Job: the Job's own retry (it reads its manifest again, so finished pieces and windows are not done twice).
 * Resolves the receipt, or null when `jobId` is not a conversion Job (the original path retries those). */
export async function retryJob(ports, jobId) {
  const jobs = ports.worker.runtimeJobs;
  let job;
  try { job = jobs?.status(jobId); } catch { return null; }
  if (job?.kind !== TYPE) return null;
  const retried = await jobs.control(jobId, 'retry');
  await withdrawFailureLetter(ports, jobId);
  return { jobId: retried.runtime.legacyId, status: retried.status, queuedBehind: 0, converter: retried.detail.converter };
}
