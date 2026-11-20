import { ui, uiFormat, uiMessage } from '../i18n.js';
import { describeFailure, failureSentence, stageCodeLabel } from '../generation-status.js';
import { STATUS } from '../../lib/job-contract.js';
import { formatDay, joinMeta } from '../format.js';
import { contractOf, taskKindOf, isRunningTask, hasDailyFailures, isHeldTask } from './task-model.js';
import { badgeText } from './task-parallel.js';
import { roundOfText, waitingText } from '../coverage/copy.js';
import { partTitle } from '../deck-parts.js';

/* A job as one line of the console's list and as the header of its detail: kind, title, a state, a percent and ONE status line, all read from the job's
   contract. The stage is a CODE there; this file is where it becomes words (and the only place that does), so a job reads the same wherever it is shown. */

const KIND_LABEL = {
  audio: '音频批量转写', pdf: 'PDF 转换', translation: '翻译', supplement: '补题', repair: '修题', publish: '发布检查',
  generation: '出题', companion: '交互伴学', 'material-classify': '资料智能分类', 'material-organize': '整理课程归属',
  assist: '后台助教', extension: '后台任务', coach: '为你定制',
};
export const taskKindLabel = (kind) => ui(KIND_LABEL[kind] || KIND_LABEL.extension);

/** The name of a kind of audio job: each has its own (a subtitle import is not a batch transcription). The original path records a batch as an `audio-import` that holds several files. */
const AUDIO_LABEL = { 'audio-batch': '音频批量转写', 'audio-subtitles': '字幕导入', 'audio-review': '转写复核', 'audio-live-save': '课堂保存', 'audio-live-correction': '课堂校正' };
export const audioKindLabel = (contract) => ui(AUDIO_LABEL[contract.kind] || (contract.detail?.files?.length > 1 ? '音频批量转写' : '音频转写'));

/** run | queued | paused | stopping | done | partial | fail | stopped | held: what a row's dot, colour and word are drawn from. */
export function taskState(job) {
  const contract = contractOf(job), { status, result } = contract;
  if (isHeldTask(job) && !isRunningTask(job)) return 'held';
  if (hasDailyFailures(contract)) return contract.detail.metrics?.passed > 0 ? 'partial' : 'fail';
  switch (status) {
    case STATUS.QUEUED: return 'queued';
    case STATUS.PAUSING: case STATUS.PAUSED: return 'paused';
    case STATUS.CANCELLING: return 'stopping';
    case STATUS.COMPLETE: return result.completeness === 'partial' ? 'partial' : 'done';
    case STATUS.FAILED: return 'fail';
    // A restart (or a closed host) interrupted it: nothing is wrong with the work, it is waiting to be continued. Not 'failed'.
    case STATUS.INTERRUPTED: return 'interrupted';
    // A one-click install that was stopped keeps what it downloaded and continues where it stopped: it is paused, the word the card uses too.
    case STATUS.CANCELLED: return contract.detail?.install ? 'paused' : 'stopped';
    default: return 'run';
  }
}

const dayName = (date) => { const [year, month, day] = String(date).split('-').map(Number); return year ? formatDay(new Date(year, month - 1, day)) : ui('今天'); };

/** The title the learner knows the job by. */
export function taskTitle(job) {
  const contract = contractOf(job), { title, kind, detail, progress } = contract, taskKind = taskKindOf(job);
  if (kind === 'coach-daily') return uiFormat('为你定制 · {0}', [dayName(title)]);
  // A new draft that will be the next part of a deck (lib/deck-parts.js): 「期中复习 · 第二部分」.
  if (detail?.part?.deckTitle) return partTitle(detail.part.deckTitle, detail.part.n);
  if (taskKind === 'material-classify' || taskKind === 'material-organize') {
    const rawCourse = (typeof detail?.course === 'string' && detail.course.trim()) || (typeof job?.course === 'string' && job.course.trim()) || '';
    const course = rawCourse && rawCourse !== '*' ? rawCourse : '';
    const total = Number(progress?.total) || Number(job?.total) || 0;
    if (taskKind === 'material-classify') {
      if (course && total > 0) return uiFormat('资料智能分类 · {0}（{1} 份）', [course, total]);
      if (course) return uiFormat('资料智能分类 · {0}', [course]);
      if (total > 0) return uiFormat('资料智能分类（{0} 份）', [total]);
      return ui('资料智能分类');
    }
    if (course && total > 0) return uiFormat('整理课程归属 · {0}（{1} 份）', [course, total]);
    if (course) return uiFormat('整理课程归属 · {0}', [course]);
    if (total > 0) return uiFormat('整理课程归属（{0} 份）', [total]);
    return ui('整理课程归属');
  }
  // An install's title is the producer's words (安装本机 MinerU), and so is a search-index build's (建立检索索引 · 课程): in the learner's language like its step.
  if (title === '生成交互伴学课') return ui('生成交互伴学课');
  if (title) return kind === 'translation' ? uiFormat('翻译「{0}」', [title]) : detail?.install || kind === 'retrieval-index' ? uiMessage(title) : title;
  return kind === 'generation' || kind === 'supplement' ? ui('新题组') : taskKindLabel(taskKind);
}

/** 0-100, or null when nobody can say. A running count is real progress (finished over total), never a guess. */
export const taskPercent = (job) => contractOf(job).progress.percent;

const AUDIO_PHASES = { queued: '排队中', read: '读取并切分音频', transcribe: '转写音频', proofread: '校对识别错误的词', translate: '翻译并整理成中英对照',
  batch: '按顺序整理逐字稿', assemble: '合成逐字稿', done: '完成' };
const PDF_PHASES = { held: '等你导入', queued: '排队中', 'start-service': '启动本机服务', split: '切分', upload: '上传', parse: '解析文档', local: '本地解析', download: '下载', merge: '合并', save: '保存', interrupted: '已中断', done: '完成' };
const COMPANION_PHASES = {
  queued: '排队等待中',
  blueprint: '正在设计教学戏剧弧与反例分镜',
  act1: '正在精写上半场（热身、场景、盲猜下注与找茬）',
  act2: '正在精写下半场（交互推演、决策树、小测与带走卡）',
  verify: '正在计算真实公式曲线并执行 18 项结构校验',
  repair: '正在定向修复结构或公式问题',
  saving: '正在编译独立 HTML 并挂载至课程',
  complete: '交互伴学课已就绪',
  paused: '已在检查点暂停',
  cancelled: '已停止',
};
const withCount = (label, { done, total } = {}) => (total > 0 && done !== undefined ? uiFormat('{0} · {1}/{2}', [label, Math.min(done + 1, total), total]) : label);

const BARE_STAGES = { queued: '排队中', running: '进行中', pausing: '正在暂停', paused: '已暂停', [STATUS.CANCELLING]: '正在停止…',
  complete: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断' };

/** A stage of a contract in words: `{ code, args }` to a short phrase. An unknown code falls back to the producer's own prose. */
export function stageLabel(stage) {
  if (!stage) return '';
  const [family, name] = String(stage.code).split('.');
  if (stage.code === 'finished') return ({ complete: ui('已完成'), failed: ui('失败'), cancelled: ui('已停止'), interrupted: ui('已中断') })[stage.args?.status] || '';
  if (family === 'audio' && AUDIO_PHASES[name]) return withCount(ui(AUDIO_PHASES[name]), ['transcribe', 'proofread', 'translate'].includes(name) ? stage.args : undefined);
  if (family === 'pdf' && PDF_PHASES[name]) return ui(PDF_PHASES[name]);
  if (family === 'companion' && COMPANION_PHASES[name]) return ui(COMPANION_PHASES[name]);
  if (family === 'material-classify' || family === 'material-organize' || family === 'materials') {
    if (name === 'queued') return ui('排队中');
    if (name === 'taxonomy') return stage.args?.total > 0 ? uiFormat('归纳主题目录 · 共 {0} 份资料', [stage.args.total]) : ui('归纳主题目录');
    if (family === 'material-organize' || name === 'organize' || name === 'organize-batch') {
      if (stage.args?.part > 0 && stage.args?.parts > 0) return uiFormat('课程归属第 {0}/{1} 批', [stage.args.part, stage.args.parts]);
      if (stage.args?.total > 0) return uiFormat('整理课程归属 · {0}/{1}', [stage.args.done ?? 0, stage.args.total]);
      return ui('整理课程归属');
    }
    if (stage.args?.part > 0 && stage.args?.parts > 0) return uiFormat('内容分类第 {0}/{1} 批', [stage.args.part, stage.args.parts]);
    if (stage.args?.total > 0) return uiFormat('按内容整理分类 · {0}/{1}', [stage.args.done ?? 0, stage.args.total]);
    return ui('按内容整理分类');
  }
  if (family === 'translation') return name === 'queued' ? ui('排队中') : stage.args?.total > 0 ? uiFormat('正在翻译 · {0}/{1} 段', [stage.args.done, stage.args.total]) : ui('正在翻译');
  if (['generation', 'repair', 'publish'].includes(family)) return stageCodeLabel(name === 'blueprinting' ? 'blueprinting' : name) || ui('进行中');
  if (family === 'task') return name === 'queued' ? ui('排队中') : ui('进行中');
  // A one-click install says its step (第 3/6 步：安装 MinerU) or how it ended, in the producer's words (lib/application-messages.js has the English).
  if (family === 'install') return stage.text ? uiMessage(stage.text) : ui('进行中');
  // A search-index build says its pages in the producer's words (正在建立索引 3 / 513 页, lib/retrieval-messages.js).
  if (family === 'retrieval') return stage.text ? uiMessage(stage.text) : ui('进行中');
  if (family === 'study') {
    const [, sub, step] = String(stage.code).split('.');
    if (sub === 'terms') {
      if (step === 'queued') return ui('排队中');
      if (step === 'running') return ui('正在补齐生词');
      if (step === 'repair') return ui('正在修复补词格式');
      if (step === 'cancelled') return ui('已停止');
      if (step === 'complete') return stage.text ? uiMessage(stage.text) : ui('已完成');
    }
    return stage.text ? uiMessage(stage.text) : (BARE_STAGES[step] ? ui(BARE_STAGES[step]) : ui('进行中'));
  }
  if (stage.text) return stage.text;
  return BARE_STAGES[stage.code] ? ui(BARE_STAGES[stage.code]) : '';
}

/** The one status line under the title. */
export function taskLine(job) {
  const contract = contractOf(job), state = taskState(job);
  if (state === 'held') return uiMessage(contract.stage.text || contract.error?.message || '');
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
  if (state === 'fail' || state === 'interrupted') return contract.error?.message ? uiMessage(contract.stage.text || contract.error.message) : stageLabel(contract.stage);
  if (run && contract.status === STATUS.COMPLETE && run.waiting) return waitingText(run);
  // A run that ended short of its plan is 部分完成, here as in the header and the badge (not 「已完成」).
  if (state === 'partial' && run) return ui('部分完成');
  if (contract.kind === 'pdf-convert' && contract.status === STATUS.QUEUED) {
    const q = contract.detail?.queue, head = q?.head?.title || '';
    if (q?.count > 1 && head) return uiFormat('排队等待本机引擎 · 前面有 {0} 份 PDF（正在解析「{1}」）', [q.count, head]);
    if (head) return uiFormat('排队等待本机引擎 · 等「{0}」完成后自动开始', [head]);
    return ui('排队等待本机引擎空闲后自动开始');
  }
  if (contract.kind === 'pdf-convert' && contract.status === STATUS.RUNNING && contract.detail?.note) {
    return joinMeta([stageLabel(contract.stage), uiMessage(contract.detail.note)]);
  }
  // 要求并行 (lib/job-parallel.js): a job a model error sent back to the queue says so; one that runs beside the queue is marked.
  if (contract.detail?.requeued && contract.status === STATUS.QUEUED) return ui('已退回排队 · 等前面的任务完成后自动继续');
  const beside = contract.detail?.parallel && isRunningTask(job) ? badgeText() : '';
  const taskKind = taskKindOf(job);
  if (taskKind === 'material-classify' || taskKind === 'material-organize') {
    const done = Number(contract.progress?.done ?? job?.done ?? 0);
    const total = Number(contract.progress?.total ?? job?.total ?? 0);
    if (contract.status === STATUS.COMPLETE) {
      return total > 0 ? uiFormat('已完成 · 共 {0} 份资料，待确认应用', [total]) : ui('已完成 · 待确认应用');
    }
    if (contract.status === STATUS.RUNNING) {
      const activeCall = (contract.calls || []).find((call) => call.status === 'running' && call.kind !== 'wait');
      const phase = job?.phase || contract.detail?.phase || '';
      let line = '';
      if (taskKind === 'material-classify') {
        if (phase === 'taxonomy' || activeCall?.stage === 'taxonomy') {
          line = total > 0 ? uiFormat('归纳主题目录 · 共 {0} 份资料', [total]) : ui('归纳主题目录');
        } else if (activeCall?.part > 0 && activeCall?.parts > 0) {
          line = total > 0 ? uiFormat('内容分类第 {0}/{1} 批 · {2}/{3}', [activeCall.part, activeCall.parts, done, total]) : uiFormat('内容分类第 {0}/{1} 批', [activeCall.part, activeCall.parts]);
        } else if (total > 0) {
          line = uiFormat('按内容整理分类 · {0}/{1}', [done, total]);
        } else {
          line = ui('按内容整理分类');
        }
      } else if (activeCall?.part > 0 && activeCall?.parts > 0) {
        line = total > 0 ? uiFormat('课程归属第 {0}/{1} 批 · {2}/{3}', [activeCall.part, activeCall.parts, done, total]) : uiFormat('课程归属第 {0}/{1} 批', [activeCall.part, activeCall.parts]);
      } else if (total > 0) {
        line = uiFormat('整理课程归属 · {0}/{1}', [done, total]);
      } else {
        line = ui('整理课程归属');
      }
      return beside ? joinMeta([beside, line]) : line;
    }
  }
  if (taskKind === 'assist' && contract.detail?.mode === 'terms' && isRunningTask(job) && Array.isArray(contract.detail?.terms) && contract.detail.terms.length) {
    return joinMeta([beside, stageLabel(contract.stage), contract.detail.terms.join('、')]);
  }
  if (run && isRunningTask(job) && run.rounds > 1) return joinMeta([beside, roundOfText(run.round, run.rounds), stageLabel(contract.stage)]);
  return beside ? joinMeta([beside, stageLabel(contract.stage)]) : stageLabel(contract.stage);
}

/** Everything a list row needs. */
export function taskSummary(job) {
  const contract = contractOf(job), kind = taskKindOf(job);
  const kindLabel = kind === 'audio' ? audioKindLabel(contract)
    : kind === 'assist' && contract.detail?.mode === 'terms' ? ui('补齐生词')
    : taskKindLabel(kind);
  return { id: contract.jobId, kind, kindLabel, title: taskTitle(job), state: taskState(job), percent: taskPercent(job), running: isRunningTask(job), line: taskLine(job), status: contract.status };
}

/** The badge word of a state. */
export const stateLabel = (state) => ({ run: ui('进行中'), queued: ui('排队中'), paused: ui('已暂停'), stopping: ui('正在停止'), done: ui('已完成'), partial: ui('部分完成'), fail: ui('失败'), interrupted: ui('已中断'), stopped: ui('已停止'), held: ui('等你导入') })[state] || '';
