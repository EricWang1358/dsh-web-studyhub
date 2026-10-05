import { jobContract, isLiveStatus, STATUS } from '../../lib/job-contract.js';

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

const KINDS = { 'audio-import': 'audio', 'pdf-convert': 'pdf', translation: 'translation', generation: 'generation', supplement: 'supplement',
  'draft-repair': 'repair', 'draft-publish': 'publish', extension: 'extension' };
/** The kind of a job, for its label and for the job-type section of the detail pane. */
export const taskKindOf = (job) => KINDS[contractOf(job).kind] || 'extension';

/** The identity a selection and a deep link use: what survives a retry. */
export const taskId = (job) => contractOf(job).jobId;

/** Still a live task: waiting, working, pausing or paused, or stopping. */
export const isRunningTask = (job) => isLiveStatus(contractOf(job).status);
const isFailed = (job) => [STATUS.FAILED, STATUS.INTERRUPTED].includes(contractOf(job).status);

/** How many tasks are waiting or running: the badge on the sidebar entry. */
export function runningTaskCount(data) {
  return (Array.isArray(data?.jobs) ? data.jobs : []).filter(isRunningTask).length;
}

const time = (task) => Date.parse(contractOf(task).startedAt) || 0;

/** The console's task list, newest first (a stable order for equal times). */
export function tasksOf(data) {
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.map((job, index) => ({ job, index })).sort((a, b) => time(b.job) - time(a.job) || a.index - b.index).map(({ job }) => job);
}

/** The list's filters with their counts: 全部 / 进行中 / 失败. */
export function taskFilters(tasks) {
  return [{ id: 'all', count: tasks.length }, { id: 'running', count: tasks.filter(isRunningTask).length }, { id: 'failed', count: tasks.filter(isFailed).length }];
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
