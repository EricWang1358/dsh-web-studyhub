/* A passage supplement as the learner sees it (the reader's learning panel). It is an ordinary background job
   (lib/contexts/generation/selection-jobs.js); this module reads that job into plain words: which phase it is in,
   how many questions passed, how long it has run, why some did not pass, what failed and which retry is safe.
   Pure; the components are SelectionJobs.jsx. */
import { ui, uiFormat } from '../i18n.js';
import { jobCode, describeFailure, stageCodeLabel } from '../generation-status.js';
import { shortfall } from '../draft-shortfall.js';
import { passageKey } from '../../lib/selection-evidence.js';
import { isActiveJob } from '../../lib/job-status.js';

export const isActive = isActiveJob;

const savedOf = (job) => job.savedCount ?? job.publication?.added ?? 0;
const requestedOf = (job) => job.requestedTotal ?? job.count ?? 0;
export const deckName = (job) => job.targetTitle || job.deckTitle || ui('题组');

/** The five working phases, in order, as the progress strip shows them. */
export const WORK_PHASES = Object.freeze(['planning', 'writing', 'reviewing', 'saving']);

/** queued | planning | writing | reviewing | saving | cancelling | done | partial | conflict | failed | cancelled */
export function jobPhase(job) {
  switch (job?.status) {
    case 'queued': return 'queued';
    case 'cancelling': return 'cancelling';
    case 'cancelled': return 'cancelled';
    case 'failed': return job.outcome === 'conflict' ? 'conflict' : 'failed';
    case 'complete': return savedOf(job) < requestedOf(job) ? 'partial' : 'done';
    default: {
      const code = jobCode(job);
      return code === 'planning' ? 'planning' : code === 'reviewing' ? 'reviewing' : code === 'publishing' ? 'saving' : 'writing';
    }
  }
}

export function phaseLabel(phase) {
  return ({
    queued: stageCodeLabel('queued'),
    planning: ui('正在规划考点'),
    writing: ui('正在出题'),
    reviewing: ui('独立审阅中'),
    saving: ui('正在保存到题组'),
    cancelling: ui('正在停止…'),
  })[phase] || '';
}

/** The names the progress strip shows for the working phases. */
export const phaseName = (phase) => ({ planning: ui('规划考点'), writing: ui('出题'), reviewing: ui('独立审阅'), saving: ui('保存') })[phase] || '';

/** "已通过 n / 共 m", with what has been written while the review is still to come. */
export function countsText(job) {
  const passed = job.passed ?? job.savedCount ?? 0;
  const base = uiFormat('已通过 {0} / 共 {1}', [passed, requestedOf(job)]);
  const waiting = job.status === 'running' && Number.isInteger(job.written) && ['writing', 'reviewing'].includes(jobPhase(job));
  return waiting ? uiFormat('已写出 {0} 题，等待独立审阅 · {1}', [job.written, base]) : base;
}

/** "1:05": how long the job has run (not queued), frozen at the finish. */
export function elapsedClock(job, now = Date.now()) {
  if (job?.status === 'queued') return '';
  const start = Date.parse(job?.runStartedAt || job?.startedAt || '');
  if (!Number.isFinite(start)) return '';
  const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** "已加入「题组」n 张，k 张未通过审阅": the one line a finished supplement is known by. */
export function resultHeadline(job) {
  const added = savedOf(job), requested = requestedOf(job), dropped = job.rejected?.length || 0;
  if (dropped > 0) return uiFormat('已加入「{0}」{1} 张，{2} 张未通过审阅', [deckName(job), added, dropped]);
  if (added < requested) return uiFormat('已加入「{0}」{1} 张（要求 {2} 张）', [deckName(job), added, requested]);
  return uiFormat('已加入「{0}」{1} 张', [deckName(job), added]);
}

/** Why questions did not pass, in the draft page's words: counts per reason, and each dropped question. */
export function resultReasons(job) {
  const found = shortfall({ editorial: { omitted: job.rejected || [] }, cards: [] });
  return { reasons: found.reasons, items: found.records };
}

/** What a stopped job says and which retry is safe (the same operation reuses what it saved). */
export function failureCopy(job) {
  const phase = jobPhase(job);
  if (phase === 'conflict') return { kind: 'conflict', retry: 'save', title: ui('题组已更新，已审核的题目等待再次保存'),
    hint: uiFormat('题组在生成期间有变化。已通过审阅的 {0} 题还没有保存，重试时会按题组现在的版本保存。', [job.passed || 0]), retryLabel: ui('保留审核结果并重试保存') };
  if (phase === 'cancelled') return { kind: 'cancelled', retry: 'restart', title: ui('已停止，题组没有变化'), hint: '', retryLabel: ui('重新开始') };
  const found = describeFailure(job.stage);
  return { kind: found.kind, action: found.action, retry: 'retry', title: found.title, hint: found.hint, retryLabel: ui('重试') };
}

/** The running or queued job that already works on this passage for this deck, if any (the backend refuses the second one too). */
export const blockingJob = (jobs = [], selection, deckId) =>
  jobs.find((job) => isActive(job) && job.deckId === deckId && passageKey(job.selection) === passageKey(selection)) || null;

/** Replace the job of the same operation, or add it first. */
export function upsertJob(jobs = [], job) {
  const index = jobs.findIndex((item) => item.operationId === job.operationId);
  return index < 0 ? [job, ...jobs] : jobs.map((item, at) => (at === index ? job : item));
}

/** Add jobs the panel did not know (a reader reopened over running work) and keep the newest first. */
export function mergeJobs(jobs = [], found = []) {
  const merged = found.reduce((list, job) => (list.some((item) => item.operationId === job.operationId) ? list : [...list, job]), jobs);
  return [...merged].sort((a, b) => Date.parse(b.startedAt || 0) - Date.parse(a.startedAt || 0));
}

/** The toast when a supplement starts: it goes on without the reader. */
export function startedNotice(started, title) {
  const text = started.status === 'queued'
    ? uiFormat('补题「{0}」已排队，排在 {1} 个任务之后，完成后进信箱。', [title, started.queuedBehind ?? 1])
    : uiFormat('已开始补题「{0}」，后台继续生成，完成后进信箱。', [title]);
  return { text, tone: 'info' };
}

/** The toast when it ends, with where to jump when questions were added. */
export function finishedNotice(job) {
  const phase = jobPhase(job);
  if (phase === 'done' || phase === 'partial') {
    return { text: resultHeadline(job), tone: phase === 'partial' ? 'warning' : 'success',
      jump: { deckId: job.publication?.deckId || job.deckId, cardIds: job.publication?.cardIds || [] } };
  }
  if (phase === 'cancelled') return { text: uiFormat('已停止补题「{0}」，题组没有变化。', [deckName(job)]), tone: 'info', jump: null };
  return { text: uiFormat('补题「{0}」没有完成：{1}', [deckName(job), failureCopy(job).title]), tone: 'error', jump: null };
}

/** A start that the backend refused, in plain words; its own messages and unknown ones pass through. */
export function startErrorText(message) {
  const text = String(message ?? '');
  if (/stale|select the current passage|POSITION_CONFLICT/i.test(text)) return ui('这段原文与资料里的文字对不上了，请在当前原文中重新选择。');
  if (/active ordinary deck|Destination deck|target deck|目标题组/i.test(text)) return ui('要补题的题组不可用（可能已归档或删除），请重新选择题组。');
  if (/model is required|model_unavailable/i.test(text)) return ui('当前没有可用模型，请先在设置里连接模型。');
  return text;
}
