import { isActiveJob, JOB_STATUS, JOB_TYPES } from '../../lib/job-status.js';

/* What the 任务 console shows as a task, and how it is listed. Plain data and predicates (no React, no ui()), so a DOM-free test can read it.
   A task is a job of the snapshot (`data.jobs`) as it is: the console reads the existing job model and adds nothing of its own to store. */

/** The kind of a job, for its label and for the job-type section of the detail pane. */
export function taskKindOf(job) {
  switch (job?.type) {
    case JOB_TYPES.AUDIO_IMPORT: return 'audio';
    case JOB_TYPES.PDF_CONVERT: return 'pdf';
    case JOB_TYPES.TRANSLATION: return 'translation';
    case JOB_TYPES.SUPPLEMENT: return 'supplement';
    case JOB_TYPES.DRAFT_REPAIR: return 'repair';
    case JOB_TYPES.DRAFT_PUBLISH: return 'publish';
    case undefined: case null: case '': return 'generation';
    default: return job.type === 'coach-prep' ? 'coach' : 'extension';
  }
}

export const isRunningTask = (task) => isActiveJob(task);
const failedStatus = (status) => status === JOB_STATUS.FAILED || status === JOB_STATUS.INTERRUPTED;

/** How many tasks are waiting or running: the badge on the sidebar entry. */
export function runningTaskCount(data) {
  return (Array.isArray(data?.jobs) ? data.jobs : []).filter(isRunningTask).length;
}

const time = (task) => Date.parse(task?.startedAt) || 0;

/** The console's task list, newest first (a stable order for equal times). */
export function tasksOf(data) {
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs.map((job, index) => ({ job, index })).sort((a, b) => time(b.job) - time(a.job) || a.index - b.index).map(({ job }) => job);
}

/** The list's filters with their counts: 全部 / 进行中 / 失败. */
export function taskFilters(tasks) {
  return [{ id: 'all', count: tasks.length }, { id: 'running', count: tasks.filter(isRunningTask).length },
    { id: 'failed', count: tasks.filter((task) => failedStatus(task.status)).length }];
}
export function filterTasks(tasks, filter) {
  if (filter === 'running') return tasks.filter(isRunningTask);
  if (filter === 'failed') return tasks.filter((task) => failedStatus(task.status));
  return tasks;
}

/**
 * Which task the detail pane shows. A new deep link (a focus whose nonce the console has not seen) wins; then the learner's own selection
 * while that task still exists; then a linked job; then the first one that is running; then the newest.
 */
export function pickTask({ tasks, focus, current, focusSeen }) {
  const has = (id) => !!id && tasks.some((task) => task.id === id);
  const fresh = focus && focus.nonce !== focusSeen;
  if (fresh && has(focus.jobId)) return focus.jobId;
  if (has(current)) return current;
  if (has(focus?.jobId)) return focus.jobId;
  return (tasks.find(isRunningTask) || tasks[0])?.id ?? null;
}
