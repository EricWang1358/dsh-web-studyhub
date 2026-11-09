import { isActiveJob } from '../job-visibility.js';
import { mergePartial } from '../snapshot-share.js';

/* The live part of the running jobs (#886). While a job runs, the snapshot's fingerprint holds only its structure (lib/job-structure.js), so its
   progress, stage, usage, calls and streamed output no longer make every poll a whole snapshot. Between two snapshots the panel reads the rows of the
   running jobs with this one small read and puts them over the snapshot's own rows: every page that reads `data.jobs` (the task cards, the 任务 console,
   the badge) sees them. The poll of the snapshot asks it (ui/app/use-library-connection.js), so it shares that loop: no overlap, silent while hidden. */

/** The host's read of the library's active jobs, as the snapshot shows them: { jobs }. */
export const LIVE_JOBS = 'job.live.list';

/**
 * The snapshot's jobs with each row the live read carries put in place of the row of the same id. A job the live read does not carry (it ended, or it is
 * new) keeps its snapshot row: its status is part of the fingerprint, so the next snapshot brings it whole.
 */
export function withLiveJobs(jobs, live) {
  const rows = new Map((Array.isArray(live) ? live : []).map((job) => [job.id, job]));
  return rows.size && Array.isArray(jobs) ? jobs.map((job) => rows.get(job.id) ?? job) : jobs;
}

/**
 * Ask for the live rows when the snapshot the panel holds has an active job, and merge them: { value, texts, changed } as mergePartial answers, or null
 * when no job is active (nothing is asked).
 */
export async function readLiveJobs(call, held, texts) {
  if (!Array.isArray(held?.jobs) || !held.jobs.some(isActiveJob)) return null;
  const { jobs } = await call(LIVE_JOBS, {});
  return mergePartial(held, { jobs: withLiveJobs(held.jobs, jobs) }, texts);
}
