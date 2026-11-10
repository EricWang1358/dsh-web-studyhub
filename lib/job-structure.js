import { isActiveJob, isOwnRow } from './job-status.js';
import { offerParallel } from './job-parallel.js';

/* A job as the snapshot shows it (lib/job-contract.js snapshotJob, its row in `snapshot.jobs`), split by how often it moves (#886).

   STRUCTURE, what says what the pages show and allow. It changes a few times in a job's life (queued, running, paused, stopping, ended, continued):
     row id, type, status            isActiveJob (the poll rhythm, 正在运行, every page that waits for a job), the publishing check, the pages that find a job by kind
     contract jobId, attemptId, kind, title, status, endReason, continuedBy
                                     the 任务 console's list, its row and the sidebar badge (running, ended since the last visit, failed)
     contract actions                the console's buttons (stop, pause, resume, retry, settings)
     contract result, error          what it made (the draft, the deck, the materials) and why it failed
     contract startedAt, finishedAt  the console's order and the badge's news
   LIVE, everything else: the row's own progress fields (stage, stageCode, savedCount, steps, tasks, members, tokenUsage, phase ...) and the contract's stage, progress,
   usage, execution, detail, calls (with each call's output preview) and events. They move on every tick and every streamed chunk while the job runs.

   While a job is active the snapshot's fingerprint holds its structure only, so a running job alone no longer makes every poll a whole snapshot; the panel reads the live
   rows with job.live.list between snapshots (ui/app/live-jobs.js). A job that is not active is in the fingerprint whole, as before: nothing reads it live. */

const CONTRACT_STRUCTURE = Object.freeze(['jobId', 'attemptId', 'kind', 'title', 'status', 'endReason', 'continuedBy', 'actions', 'result', 'error', 'startedAt', 'finishedAt']);

/** The structure of a snapshot row. */
export function jobStructure(row) {
  const contract = row?.contract ?? {};
  return { id: row?.id ?? null, type: row?.type ?? null, status: row?.status ?? null,
    contract: Object.fromEntries(CONTRACT_STRUCTURE.filter((key) => Object.hasOwn(contract, key)).map((key) => [key, contract[key]])) };
}

/** What a snapshot row puts in the snapshot's fingerprint: an active job its structure, any other the whole row. */
export const fingerprintJob = (row) => (isActiveJob(row) ? jobStructure(row) : row);

/**
 * A job's row as the panel reads it, in `snapshot.jobs` and in `job.live.list` alike: `view` is the host's projection of one job (lib/runtime/jobs.js snapshotJob),
 * plus what only the library's jobs together can say (lib/job-parallel.js offerParallel: 要求并行, what a queued job waits behind). `jobs`: the library's jobs.
 */
export const jobRow = (view, job, jobs) => offerParallel(view(job), job, jobs);

/** What job.live.list answers: the rows of the library's active jobs that are rows of their own (a batch of 为你定制 is part of its day's row). */
export const liveRows = (view, jobs) => jobs.filter((job) => isOwnRow(job) && isActiveJob(job)).map((job) => jobRow(view, job, jobs));
