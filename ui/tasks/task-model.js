import { jobContract, isLiveStatus, STATUS } from '../../lib/job-contract.js';
import { AUDIO_JOB_TYPES } from '../../lib/job-status.js';

export { isLiveStatus };

/* What the 任务 console shows as a task, and how it is listed. Plain data and predicates (no React, no ui()), so a DOM-free test can read it.
   A task is a job of the snapshot (`data.jobs`) seen through its CONTRACT (lib/job-contract.js, docs/job-contract.md): the console never reads a
   job's own fields. A job from a host that predates the contract is put through the same adapter here, so there is one reading either way. */

const own = new WeakMap();
/** The contract of a job of the snapshot (the snapshot carries it; an older host's job is adapted once). */
export function contractOf(job) {
  if (job?.contract) return job.contract;
  if (!job || typeof job !== 'object') return jobContract({});
  if (!own.has(job)) own.set(job, jobContract(job));
  return own.get(job);
}

const KINDS = { ...Object.fromEntries(AUDIO_JOB_TYPES.map((type) => [type, 'audio'])), 'pdf-convert': 'pdf', translation: 'translation', generation: 'generation', supplement: 'supplement',
  'draft-repair': 'repair', 'draft-publish': 'publish', 'coach-daily': 'coach', extension: 'extension' };
/** The kind of a job, for its label and for the job-type section of the detail pane. */
export const taskKindOf = (job) => KINDS[contractOf(job).kind] || 'extension';

/** The identity a selection and a deep link use: what survives a retry. */
export const taskId = (job) => contractOf(job).jobId;

/** Still a live task: waiting, working, pausing or paused, or stopping. */
export const isRunningTask = (job) => isLiveStatus(contractOf(job).status);
/** A resting daily record may contain failed work; its lifecycle only says whether a batch is in flight. */
export const hasDailyFailures = (contract) => contract.kind === 'coach-daily' && !isLiveStatus(contract.status) && contract.detail.batches?.some(batch => batch.status === 'failed');
const isFailed = (job) => { const contract = contractOf(job); return [STATUS.FAILED, STATUS.INTERRUPTED].includes(contract.status) || hasDailyFailures(contract); };

/** How many tasks are waiting or running: the badge on the sidebar entry. */
export function runningTaskCount(data) {
  return (Array.isArray(data?.jobs) ? data.jobs : []).filter(isRunningTask).length;
}

/* What ended since the learner last had the console open. Audio, PDF conversion, translation and a passage top-up already come as a letter in the 信箱
   (lib/inbox-kinds.js), a day of 为你定制 has its own entry, and a job the learner stopped needs no news: the rest (a question run, a publication, a repair,
   an extension) has no other way to say it finished or failed, so the badge does. */
const HAS_LETTER = new Set(['audio-import', 'pdf-convert', 'translation', 'supplement', 'coach-daily']);
const NEWS = new Set([STATUS.COMPLETE, STATUS.FAILED, STATUS.INTERRUPTED]);
const isNews = (job, seenAt) => {
  const contract = contractOf(job);
  return NEWS.has(contract.status) && !HAS_LETTER.has(contract.kind) && (Date.parse(contract.finishedAt || contract.startedAt) || 0) > seenAt;
};

/** The jobs of the snapshot that ended after `seenAt` (ms) and have no letter. */
export function unseenResults(data, seenAt) {
  return (Array.isArray(data?.jobs) ? data.jobs : []).filter((job) => isNews(job, seenAt));
}

/** What the sidebar badge counts: `running` (waiting or working), `unseen` (ended since the last visit), `failed` (of those, the ones that did not finish) and their `total`. */
export function taskBadge(data, seenAt) {
  const running = runningTaskCount(data), news = unseenResults(data, seenAt);
  const failed = news.filter((job) => contractOf(job).status !== STATUS.COMPLETE).length;
  return { running, unseen: news.length, failed, total: running + news.length };
}

const time = (task) => Date.parse(contractOf(task).startedAt) || 0;

/** The console's task list, newest first (a stable order for equal times). */
export function tasksOf(data) {
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.map((job, index) => ({ job, index })).sort((a, b) => time(b.job) - time(a.job) || a.index - b.index).map(({ job }) => job);
}

/** A task of the archive (data.archivedJobs): a read-only record of a finished job (lib/job-archive.js). */
export const isArchivedTask = (job) => !!job?.archived;

/** The archived tasks of the snapshot, the newest archived first. */
export function archivedTasksOf(data) {
  const records = Array.isArray(data?.archivedJobs) ? data.archivedJobs : [];
  const at = (job) => Date.parse(job.archived?.at) || 0;
  return records.map((job, index) => ({ job, index })).sort((a, b) => at(b.job) - at(a.job) || a.index - b.index).map(({ job }) => job);
}

/** The list's filters with their counts: 全部 / 进行中 / 失败 / 已归档 (the archived ones are in no other filter). */
export function taskFilters(tasks, archived = []) {
  return [{ id: 'all', count: tasks.length }, { id: 'running', count: tasks.filter(isRunningTask).length }, { id: 'failed', count: tasks.filter(isFailed).length },
    { id: 'archived', count: archived.length }];
}
export function filterTasks(tasks, filter) {
  if (filter === 'running') return tasks.filter(isRunningTask);
  if (filter === 'failed') return tasks.filter(isFailed);
  return tasks;
}

/**
 * Which task the detail pane shows (by its task id). A new deep link (a focus whose nonce the console has not seen) wins; then the learner's own selection
 * while that task still exists; then a linked job; then the first one that is running; then the newest. A link may name the job or one of its attempts.
 */
export function pickTask({ tasks, focus, current, focusSeen }) {
  const find = (id) => (id ? tasks.find((task) => taskId(task) === id || task.id === id) : undefined);
  const fresh = focus && focus.nonce !== focusSeen;
  const chosen = (fresh && find(focus.jobId)) || find(current) || find(focus?.jobId) || tasks.find(isRunningTask) || tasks[0];
  return chosen ? taskId(chosen) : null;
}
