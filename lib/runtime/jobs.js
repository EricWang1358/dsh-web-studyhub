
import { removeAudioBatch } from "../audio-batch.js";
import { withStageCodes } from "../contexts/jobs/contracts.js";
import { snapshotJob } from "../job-contract.js";
import { RUNTIME_CONTRACT_VERSION } from "../jobs/contract.js";
import { archiveRecordOf, jobArchive } from "../job-archive.js";
import { PART_JOBS_KEPT, isOwnRow } from "../job-status.js";

export const supplementPublication = Symbol('supplement publication');
export const supplementBudgetPublication = Symbol('reviewed checkpoint after budget');
const detachedJobClones = new WeakSet();
const detachedSnapshots = new WeakMap();
const SNAPSHOT_STEP_CAP = 300, SNAPSHOT_EVENT_CAP = 200, SNAPSHOT_WAIT_CAP = 100;

/** Clone a single in-memory job record for read-only `library` snapshot consumers without unbounded call/step amplification. */
export function cloneJobForLibrary(job, observe) {
  observe?.(job);
  if (Object.getOwnPropertyDescriptor(job, 'contract')?.get) {
    const presented = job.contract;
    const copy = {};
    for (const key of Object.keys(job)) {
      copy[key] = structuredClone(key === 'contract' ? presented : job[key]);
    }
    detachedJobClones.add(copy);
    return copy;
  }
  const overSteps = Array.isArray(job.steps) && job.steps.length > SNAPSHOT_STEP_CAP;
  const overWaits = Array.isArray(job.waits) && job.waits.length > SNAPSHOT_WAIT_CAP;
  const overEvents = Array.isArray(job.events) && job.events.length > SNAPSHOT_EVENT_CAP;
  let copy;
  if (!overSteps && !overWaits && !overEvents) {
    copy = structuredClone(job);
  } else {
    copy = {};
    for (const key of Object.keys(job)) {
      let value = job[key];
      if (key === 'steps' && overSteps) value = value.slice(-SNAPSHOT_STEP_CAP);
      else if (key === 'waits' && overWaits) value = value.slice(-SNAPSHOT_WAIT_CAP);
      else if (key === 'events' && overEvents) value = value.slice(-SNAPSHOT_EVENT_CAP);
      copy[key] = structuredClone(value);
    }
  }
  detachedJobClones.add(copy);
  return copy;
}

export function createJobServices(work) {
  const { jobs, retryable, generationControllers } = work;
const activeJob = (j) => ["running", "queued", "cancelling"].includes(j.status);

// Every public job carries a stable stage code next to its prose (P29).
// The chat tools get the lean job: the calls and the log are for the panel's console (snapshotJob), not for the model's context.
const publicJob = ({ root, waits, events, restoredContract, restoredArchive, contract, ...j }) => withStageCodes(j);

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
  const ended = [...jobs.values()].filter((j) => !activeJob(j) && !((j.batchId || j.singleId) && j.status !== 'complete'));
  const newestFirst = (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt);
  // A part of another row (a batch of 为你定制) is no row, no archive record and no share of the 100: only the newest few stay readable.
  for (const part of ended.filter((j) => !isOwnRow(j)).sort(newestFirst).slice(PART_JOBS_KEPT)) jobs.delete(part.id);
  const terminal = ended.filter(isOwnRow).sort(newestFirst);
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
  const publicSnapshot = job => {
    if (detachedJobClones.has(job)) {
      const cached = detachedSnapshots.get(job);
      if (cached) return cached;
      if (job.contract?.contractVersion === RUNTIME_CONTRACT_VERSION) {
        const { root: _root, waits: _waits, events: _events, restoredContract: _restored, restoredArchive: _archive, archivedStageCounts: _archived, contract, ...rest } = job;
        const calls = contract.calls.length > SNAPSHOT_STEP_CAP ? contract.calls.slice(-SNAPSHOT_STEP_CAP) : contract.calls;
        for (const call of calls) {
          const text = work.jobOutputs.read(job.id, call.callId, 0)?.text;
          if (text) { const preview = text.replace(/\s+/g, ' ').trim(); call.outputPreview = preview.length > 160 ? `${preview.slice(0, 159)}…` : preview; }
        }
        const built = withStageCodes({ ...rest, contract: calls === contract.calls ? contract : { ...contract, calls } });
        detachedSnapshots.set(job, built);
        return built;
      }
    }
    const view = snapshotJob(job);
    if (view.contract.contractVersion === RUNTIME_CONTRACT_VERSION) for (const call of view.contract.calls) {
      const text = work.jobOutputs.read(job.id, call.callId, 0)?.text;
      if (text) { const preview = text.replace(/\s+/g, ' ').trim(); call.outputPreview = preview.length > 160 ? `${preview.slice(0, 159)}…` : preview; }
    }
    if (detachedJobClones.has(job)) detachedSnapshots.set(job, view);
    return view;
  };
  return { assertDraftWritable, activeJob, publicJob, snapshotJob: publicSnapshot, dropRetry, forgetRetry, pruneJobs, checkSupplementPublication };
}
