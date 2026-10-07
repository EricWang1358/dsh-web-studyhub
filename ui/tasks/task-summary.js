import { ui, uiFormat } from '../i18n.js';
import { describeFailure, failureSentence, stageCodeLabel } from '../generation-status.js';
import { STATUS } from '../../lib/job-contract.js';
import { formatDay, joinMeta } from '../format.js';
import { contractOf, taskKindOf, isRunningTask, hasDailyFailures } from './task-model.js';
import { roundOfText, waitingText } from '../coverage/copy.js';
import { partTitle } from '../deck-parts.js';

/* A job as one line of the console's list and as the header of its detail: kind, title, a state, a percent and ONE status line, all read from the job's
   contract. The stage is a CODE there; this file is where it becomes words (and the only place that does), so a job reads the same wherever it is shown. */

const KIND_LABEL = {
  audio: '音频批量转写', pdf: 'PDF 转换', translation: '翻译', supplement: '补题', repair: '修题', publish: '发布检查',
  generation: '出题', extension: '后台任务', coach: '为你定制',
};
export const taskKindLabel = (kind) => ui(KIND_LABEL[kind] || KIND_LABEL.extension);

/** The name of a kind of audio job: each has its own (a subtitle import is not a batch transcription). The original path records a batch as an `audio-import` that holds several files. */
const AUDIO_LABEL = { 'audio-batch': '音频批量转写', 'audio-subtitles': '字幕导入', 'audio-review': '转写复核', 'audio-live-save': '课堂保存', 'audio-live-correction': '课堂校正' };
export const audioKindLabel = (contract) => ui(AUDIO_LABEL[contract.kind] || (contract.detail?.files?.length > 1 ? '音频批量转写' : '音频转写'));

/** run | queued | paused | stopping | done | partial | fail | stopped: what a row's dot, colour and word are drawn from. */
export function taskState(job) {
  const contract = contractOf(job), { status, result } = contract;
  if (hasDailyFailures(contract)) return contract.detail.metrics?.passed > 0 ? 'partial' : 'fail';
  switch (status) {
    case STATUS.QUEUED: return 'queued';
    case STATUS.PAUSING: case STATUS.PAUSED: return 'paused';
    case STATUS.CANCELLING: return 'stopping';
    case STATUS.COMPLETE: return result.completeness === 'partial' ? 'partial' : 'done';
    case STATUS.FAILED: return 'fail';
    // A restart (or a closed host) interrupted it: nothing is wrong with the work, it is waiting to be continued. Not 'failed'.
    case STATUS.INTERRUPTED: return 'interrupted';
    case STATUS.CANCELLED: return 'stopped';
    default: return 'run';
  }
}

const dayName = (date) => { const [year, month, day] = String(date).split('-').map(Number); return year ? formatDay(new Date(year, month - 1, day)) : ui('今天'); };

/** The title the learner knows the job by. */
export function taskTitle(job) {
  const { title, kind, detail } = contractOf(job);
  if (kind === 'coach-daily') return uiFormat('为你定制 · {0}', [dayName(title)]);
  // A new draft that will be the next part of a deck (lib/deck-parts.js): 「期中复习 · 第二部分」.
  if (detail?.part?.deckTitle) return partTitle(detail.part.deckTitle, detail.part.n);
  if (title) return kind === 'translation' ? uiFormat('翻译「{0}」', [title]) : title;
  return kind === 'generation' || kind === 'supplement' ? ui('新题组') : taskKindLabel(taskKindOf(job));
}

/** 0-100, or null when nobody can say. A running count is real progress (finished over total), never a guess. */
export const taskPercent = (job) => contractOf(job).progress.percent;

const AUDIO_PHASES = { queued: '排队中', read: '读取并切分音频', transcribe: '转写音频', proofread: '校对识别错误的词', translate: '翻译并整理成中英对照',
  batch: '按顺序整理逐字稿', assemble: '合成逐字稿', done: '完成' };
const PDF_PHASES = { queued: '排队中', split: '切分', upload: '上传', parse: '解析文档', local: '本地解析', download: '下载', merge: '合并', save: '保存', interrupted: '已中断', done: '完成' };
const withCount = (label, { done, total } = {}) => (total > 0 && done !== undefined ? uiFormat('{0} · {1}/{2}', [label, Math.min(done + 1, total), total]) : label);

/** A stage of a contract in words: `{ code, args }` to a short phrase. An unknown code falls back to the producer's own prose. */
export function stageLabel(stage) {
  if (!stage) return '';
  const [family, name] = String(stage.code).split('.');
  if (stage.code === 'finished') return ({ complete: ui('已完成'), failed: ui('失败'), cancelled: ui('已停止'), interrupted: ui('已中断') })[stage.args?.status] || '';
  if (family === 'audio' && AUDIO_PHASES[name]) return withCount(ui(AUDIO_PHASES[name]), ['transcribe', 'proofread', 'translate'].includes(name) ? stage.args : undefined);
  if (family === 'pdf' && PDF_PHASES[name]) return ui(PDF_PHASES[name]);
  if (family === 'translation') return name === 'queued' ? ui('排队中') : stage.args?.total > 0 ? uiFormat('正在翻译 · {0}/{1} 段', [stage.args.done, stage.args.total]) : ui('正在翻译');
  if (['generation', 'repair', 'publish'].includes(family)) return stageCodeLabel(name === 'blueprinting' ? 'blueprinting' : name) || ui('进行中');
  if (family === 'task') return name === 'queued' ? ui('排队中') : ui('进行中');
  return stage.text || '';
}

/** The one status line under the title. */
export function taskLine(job) {
  const contract = contractOf(job), state = taskState(job);
  if (contract.kind === 'coach-daily') {
    const { batches = [], metrics = {}, paused } = contract.detail, ran = batches.filter((batch) => batch.status !== 'skipped').length;
    const failed = batches.filter(batch => batch.status === 'failed').length;
    return joinMeta([paused ? ui('今天已暂停') : '', batches.length ? uiFormat('{0} 批 · 备好 {1} 道', [ran, metrics.passed ?? 0]) : ui('今天还没有备题'), failed ? uiFormat('失败 {0} 批', [failed]) : '', metrics.practised > 0 ? uiFormat('练了 {0} 道 · 对 {1}%', [metrics.practised, metrics.accuracy]) : '']);
  }
  // A coverage run says which round it is in (lib/coverage-run.js runFacts; the console's header says the rest).
  const run = contract.detail?.run;
  // Pausing waits for the model calls that are running, never for a round; paused between two rounds also says after which one.
  if (contract.status === STATUS.PAUSING) { const waiting = contract.actions.pause.waiting?.count ?? 0; return waiting > 0 ? uiFormat('正在暂停 · 等正在进行的 {0} 个模型调用结束', [waiting]) : ui('正在暂停'); }
  if (contract.status === STATUS.PAUSED) return run?.pausedAfter ? uiFormat('暂停于第 {0} 轮之后', [run.pausedAfter]) : ui('已暂停 · 点「继续」接着做');
  if (contract.status === STATUS.INTERRUPTED && run) return uiFormat('中断于第 {0} 轮 · 点「接着做」继续', [run.round]);
  // A failed or stopped run that was continued says so (its numbers stay as they were; the task that continued it has the new ones).
  if (contract.continuedBy) return ui('接着做过了 · 新的进度在接着做的任务里');
  // A question run that failed says its cause in plain words, once (the provider's own English, one line per part, stays in the log and the technical detail).
  if (state === 'fail' && ['generation', 'supplement'].includes(contract.kind) && contract.error?.message) return failureSentence(describeFailure(contract.stage.text || contract.error.message));
  if (state === 'fail' || state === 'interrupted') return contract.error?.message ? contract.stage.text || contract.error.message : stageLabel(contract.stage);
  if (run && contract.status === STATUS.COMPLETE && run.waiting) return waitingText(run);
  // A run that ended short of its plan is 部分完成, here as in the header and the badge (not 「已完成」).
  if (state === 'partial' && run) return ui('部分完成');
  if (run && isRunningTask(job) && run.rounds > 1) return joinMeta([roundOfText(run.round, run.rounds), stageLabel(contract.stage)]);
  return stageLabel(contract.stage);
}

/** Everything a list row needs. */
export function taskSummary(job) {
  const contract = contractOf(job), kind = taskKindOf(job);
  return { id: contract.jobId, kind, kindLabel: kind === 'audio' ? audioKindLabel(contract) : taskKindLabel(kind), title: taskTitle(job), state: taskState(job), percent: taskPercent(job), running: isRunningTask(job), line: taskLine(job), status: contract.status };
}

/** The badge word of a state. */
export const stateLabel = (state) => ({ run: ui('进行中'), queued: ui('排队中'), paused: ui('已暂停'), stopping: ui('正在停止'), done: ui('已完成'), partial: ui('部分完成'), fail: ui('失败'), interrupted: ui('已中断'), stopped: ui('已停止') })[state] || '';
