import { ui, uiFormat, uiMessage } from '../i18n.js';
import { JOB_STATUS } from '../../lib/job-status.js';
import { jobCode, jobDeckName, jobHeadline, jobSavedProgress, jobStageLabel } from '../generation-status.js';
import { audioProgress } from '../audio/AudioJobs.jsx';
import { taskKindOf, isRunningTask } from './task-model.js';

/* A job as one line of the console's list and as the header of its detail: kind, title, a state, a percent and ONE status line.
   The same words serve the compact card on the pages, so a job reads the same wherever it is shown. */

const KIND_LABEL = {
  audio: '音频批量转写', pdf: 'PDF 转换', translation: '翻译', supplement: '补题', repair: '修题', publish: '发布检查',
  generation: '出题', extension: '后台任务', coach: '为你定制',
};
export const taskKindLabel = (kind) => ui(KIND_LABEL[kind] || KIND_LABEL.extension);

/** run | queued | done | partial | fail | stopped: what a row's dot, colour and word are drawn from. */
export function taskState(job) {
  switch (job?.status) {
    case JOB_STATUS.QUEUED: return 'queued';
    case JOB_STATUS.COMPLETE: return jobCode(job) === 'partial' && taskKindOf(job) === 'generation' ? 'partial' : 'done';
    case 'partial': return 'partial';
    case JOB_STATUS.FAILED: case JOB_STATUS.INTERRUPTED: return 'fail';
    case JOB_STATUS.CANCELLED: return 'stopped';
    default: return 'run';
  }
}

const clampPercent = (value) => Math.max(0, Math.min(100, Math.round(value)));
const ratio = (done, total) => (total > 0 ? clampPercent((done / total) * 100) : null);

/** The title the learner knows the job by. */
export function taskTitle(job, drafts = []) {
  switch (taskKindOf(job)) {
    case 'audio': return job.filename || ui('音频');
    case 'pdf': return job.filename || ui('PDF');
    case 'translation': return job.targetTitle ? uiFormat('翻译「{0}」', [job.targetTitle]) : ui('翻译');
    case 'supplement': case 'repair': case 'publish': case 'generation': return jobDeckName(job, drafts);
    default: return job.label || job.filename || job.stage || ui('后台任务');
  }
}

/** 0–100, or null when nobody can say. A running count is real progress (finished over total), never a guess. */
export function taskPercent(job, drafts = []) {
  if (job.status === JOB_STATUS.COMPLETE) return 100;
  switch (taskKindOf(job)) {
    case 'audio': return audioProgress(job).percent;
    case 'pdf': case 'translation': return ratio(job.done, job.total);
    case 'generation': case 'supplement': {
      const saved = jobSavedProgress(job, drafts);
      return saved ? ratio(saved.saved, saved.total) : null;
    }
    case 'repair': return ratio(job.savedCount, job.count);
    default: return ratio(job.done, job.total);
  }
}

/** The one status line under the title. */
export function taskLine(job, { drafts = [], jobs = [] } = {}) {
  switch (taskKindOf(job)) {
    case 'generation': case 'supplement': case 'repair': case 'publish': return jobStageLabel(job, drafts, jobs);
    default: return uiMessage(String(job.stage || ''));
  }
}

/** Everything a list row needs. */
export function taskSummary(job, context = {}) {
  const kind = taskKindOf(job), state = taskState(job), percent = taskPercent(job, context.drafts);
  return { id: job.id, kind, kindLabel: taskKindLabel(kind), title: taskTitle(job, context.drafts), state, percent,
    running: isRunningTask(job), line: taskLine(job, context), headline: ['generation', 'supplement', 'repair', 'publish'].includes(kind) ? jobHeadline(job, context.drafts) : taskTitle(job, context.drafts) };
}

/** The badge word of a state. */
export const stateLabel = (state) => ({ run: ui('进行中'), queued: ui('排队中'), done: ui('已完成'), partial: ui('部分完成'), fail: ui('失败'), stopped: ui('已停止') })[state] || '';
