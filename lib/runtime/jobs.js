
import { removeAudioBatch } from "../audio-batch.js";
import { withStageCodes } from "../contexts/jobs/contracts.js";

export const supplementPublication = Symbol('supplement publication');
export const supplementBudgetPublication = Symbol('reviewed checkpoint after budget');
export function createJobServices(work) {
  const { jobs, retryable, generationControllers } = work;
const activeJob = (j) => ["running", "queued", "cancelling"].includes(j.status);

// Every public job carries a stable stage code next to its prose (P29).
const publicJob = ({ root, ...j }) => withStageCodes(j);

function dropRetry(jobId) {
  const entry = retryable.get(jobId);
  if (!entry) return;
  retryable.delete(jobId);
  void Promise.resolve().then(() => entry.cleanup?.()).catch(() => {});
}

function pruneJobs() {
  const terminal = [...jobs.values()]
    .filter((j) => !activeJob(j) && !((j.batchId || j.singleId) && j.status !== 'complete'))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  for (const job of terminal.slice(100)) {
    dropRetry(job.id); jobs.delete(job.id);
    if (job.batchId || job.singleId) void removeAudioBatch(job.root, job.batchId || job.singleId).catch(() => {});
  }
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
  return { assertDraftWritable, activeJob, publicJob, dropRetry, pruneJobs, checkSupplementPublication };
}
