
import { removeAudioBatch } from "../audio-batch.js";
import { withStageCodes } from "../contexts/jobs/contracts.js";
import { snapshotJob } from "../job-contract.js";
import { RUNTIME_CONTRACT_VERSION } from "../jobs/contract.js";
import { archiveRecordOf, jobArchive } from "../job-archive.js";

export const supplementPublication = Symbol('supplement publication');
export const supplementBudgetPublication = Symbol('reviewed checkpoint after budget');
export function createJobServices(work) {
  const { jobs, retryable, generationControllers } = work;
const activeJob = (j) => ["running", "queued", "cancelling"].includes(j.status);

// Every public job carries a stable stage code next to its prose (P29).
// The chat tools get the lean job: the calls and the log are for the panel's console (snapshotJob), not for the model's context.
const publicJob = ({ root, waits, events, restoredContract, restoredArchive, ...j }) => withStageCodes(j);

function dropRetry(jobId) {
  const entry = retryable.get(jobId);
  if (!entry) return;
  retryable.delete(jobId);
  void Promise.resolve().then(() => entry.cleanup?.()).catch(() => {});
}

/** The hold on a retry is let go WITHOUT its cleanup: what the retry would have used stays where it is (an archived job keeps its files). */
function forgetRetry(jobId) { retryable.delete(jobId); }

/* More than 100 finished jobs in memory: the oldest leave the list. They no longer vanish without a trace: each one is put in the archive first (lib/job-archive.js,
   marked `auto`), so it is still in the console under 已归档 (newest 200, 90 days). The files of a finished audio batch go as they always did (its transcripts are in the library).
   Returns the promise of the archive write (nobody has to wait for it). */
function pruneJobs() {
  const terminal = [...jobs.values()]
    .filter((j) => !activeJob(j) && !((j.batchId || j.singleId) && j.status !== 'complete'))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const leaving = terminal.slice(100), writes = [];
  for (const job of leaving) {
    const history = job.restoredContract?.contractVersion === RUNTIME_CONTRACT_VERSION;
    const record = job.root && (!job.restoredContract || history) ? archiveRecordOf(job, { auto: true }) : null;
    if (record) writes.push({ root: job.root, record, ...(history ? { history: job } : {}) });
    // Keep v2 history and its recovery exclusions until the existing archive writer succeeds.
    if (history && record) continue;
    dropRetry(job.id); jobs.delete(job.id);
    if (job.batchId || job.singleId) void removeAudioBatch(job.root, job.batchId || job.singleId).catch(() => {});
  }
  const roots = [...new Set(writes.map(({ root }) => root))];
  // An older archived record that falls off the end because of them lets its audio working copy go.
  return Promise.all(roots.map((root) => jobArchive(root).add(writes.filter((item) => item.root === root).map(({ record }) => record))
    .then(({ evicted }) => {
      for (const { history } of writes.filter((item) => item.root === root)) if (history && jobs.get(history.id) === history) {
        forgetRetry(history.id); jobs.delete(history.id);
      }
      return Promise.all(evicted.filter((record) => record.files).map((record) => removeAudioBatch(root, record.files).catch(() => {})));
    })
    .catch(() => {})));
}

function checkSupplementPublication(args) {
  const jobId = args[supplementPublication] || args.publishJobId;
  const signal = generationControllers.get(jobId)?.signal;
  // Only the scheduler's deadline permits receipt-only finalization. User
  // cancellation still wins, including cancellation during the atomic write.
  if (args[supplementBudgetPublication] && signal?.reason?.code === 'GENERATION_BUDGET' &&
      !jobs.get(jobId)?.cancelRequestedAt) return;
  signal?.throwIfAborted();
}
function assertDraftWritable(root, draftId, publishJobId) {
  const publishing = [...jobs.values()].find(job => job.root === root && job.draftId === draftId && job.type === 'draft-publish' && activeJob(job));
  if (publishing && publishJobId !== publishing.id) throw new Error('这份草稿正在后台发布检查，请等待结果');
}
  return { assertDraftWritable, activeJob, publicJob, snapshotJob, dropRetry, forgetRetry, pruneJobs, checkSupplementPublication };
}
