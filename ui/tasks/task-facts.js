import { ui, uiFormat, uiMessage } from '../i18n.js';
import { formatDateTime, formatDuration, formatElapsed, formatNumber, joinMeta } from '../format.js';
import { formatCompactTokens } from '../../lib/token-usage.js';
import { runForecast } from '../../lib/coverage-run.js';
import { forecastTime } from '../coverage/copy.js';
import { parallelNote, reuseNote } from '../audio/audio-notes.js';
import { audioCallKinds } from './call-model.js';
import { contractOf, isRunningTask, taskKindOf } from './task-model.js';

/* The four facts beside a task's progress and the stage segments of its bar, read from the job's contract. */

const dash = '—';
const UNIT_LABEL = { files: '文件', pages: '页', paragraphs: '段落', questions: '题数' };
const SEGMENT_LABEL = { transcribe: '转写', proofread: '校对', translate: '翻译', save: '保存', plan: '规划', blueprint: '答案与情景', author: '出题', review: '审阅', repair: '修复' };

/** When the task really began running: the contract's detail.runStartedAt (the wait in the queue is not in it); a record without one that is not queued began at its start (older hosts); a queued task has not begun (null). */
export function runStartOf(contract) {
  if (contract.detail?.runStartedAt) return contract.detail.runStartedAt;
  return contract.status === 'queued' ? null : contract.startedAt || null;
}

/** How long the task has RUN (the 已用 fact, and the one number the time-limit strip counts against its limit; the queue is not run time): null before it has begun. */
export function elapsedMs(contract, running, now) {
  const from = Date.parse(runStartOf(contract));
  if (!Number.isFinite(from)) return null;
  const end = running ? now : Date.parse(contract.finishedAt || '') || from;
  // The time it spent held in the queue after a model error (lib/job-parallel.js) is not run time.
  return Math.max(0, end - from - (contract.detail?.heldMs > 0 ? contract.detail.heldMs : 0));
}

function elapsedOf(contract, running, now) {
  const ms = elapsedMs(contract, running, now);
  return ms === null ? dash : formatElapsed(ms);
}

/** How long a queued task has waited (it is not working): null without a start. */
function waitedOf(contract, now) {
  const from = Date.parse(contract.startedAt || '');
  return Number.isFinite(from) ? formatElapsed(Math.max(0, now - from)) : dash;
}

/**
 * What is left of a question run, from the contract alone (lib/coverage-run.js runForecast over the questions kept, the tokens and the run clock): null for anything else, for a run that has ended or waits for the
 * learner (自动补到完整 off: its goal is the whole plan but it makes one round), and for a task that is not queued, running or paused.
 */
export function forecastOf(contract, now = Date.now()) {
  if (contract.kind !== 'generation') return null;
  const { progress, usage, detail, status } = contract, run = detail?.run || null;
  const phase = status === 'queued' ? 'queued' : status === 'running' ? 'running' : ['pausing', 'paused'].includes(status) ? 'paused' : null;
  if (!phase || (run && (run.ended || run.waiting || !run.auto))) return null;
  // A continued job is measured from its own start: its goal is the draft it started with plus what it was asked for (the draft's total alone would be reached before it began).
  // What is left is the run's own count when its rounds carry it (`dueKnown`: the sections still without a question, the points the planner returned), the same number as 「还要 … 约 n 题」.
  const own = detail?.own, goal = own ? Math.max(progress?.total ?? 0, own.base + own.asked) : progress?.total;
  return runForecast({ phase, projection: run?.projection, estimate: run?.estimateTokens, tokens: usage?.tokens, kept: progress?.done, goal, base: detail?.keptAtStart, elapsedMs: elapsedMs(contract, true, now) ?? 0,
    ...(run?.dueKnown ? { left: run.questionsLeft } : {}) });
}

const MAX_CLOCK_DRIFT_MS = 12 * 3600 * 1000;
const TIER_SECONDS_PER_PAGE = { basic: 1.6, standard: 2.5 };

function quantizeEtaSeconds(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  if (s < 300) return Math.max(1, Math.round(s));
  if (s < 1800) return Math.round(s / 10) * 10;
  return Math.round(s / 60) * 60;
}

function windowDeltaSeconds(window, now) {
  const started = Date.parse(window?.startedAt || '');
  const expected = Number(window?.expectedSeconds) > 0 ? Number(window.expectedSeconds) : 0;
  if (!Number.isFinite(started) || !(expected > 0) || Math.abs(now - started) > MAX_CLOCK_DRIFT_MS) return null;
  const elapsed = Math.max(0, (now - started) / 1000);
  if (elapsed <= expected) return { elapsed, expected, delta: -Math.min(elapsed, expected * 0.85) };
  return { elapsed, expected, delta: -expected * 0.85 + (elapsed - expected) * 0.5 };
}

/**
 * Dynamic expected completion estimate for an active PDF conversion card (`CompactJobCard`):
 * counts down inside the active window, gently extends if the current window runs slower than expected,
 * estimates queue + own duration when queued behind another PDF, and explains Window-1 speed probing.
 */
export function pdfEtaOf(job, now = Date.now()) {
  const contract = contractOf(job);
  if (contract.kind !== 'pdf-convert' || !isRunningTask(job)) return null;
  const { status, detail = {}, progress = {}, stage } = contract;
  if (['paused', 'pausing', 'cancelling'].includes(status)) return null;
  if (typeof detail.note === 'string' && /正忙|正在就绪|busy|warming/i.test(detail.note)) return null;
  const phase = String(stage?.code || '').split('.')[1] || '';
  if (status === 'running' && (phase === 'merge' || phase === 'save')) return { kind: 'finishing' };

  const total = Number(progress.total) || 0, done = Number(progress.done) || 0, leftPages = Math.max(0, total - done);
  if (status === 'queued') {
    const perPage = Number(detail.pace?.secondsPerPage) > 0 ? Number(detail.pace.secondsPerPage) : TIER_SECONDS_PER_PAGE[detail.tier] || 0;
    const ownSeconds = leftPages > 0 && perPage > 0 ? Math.round(leftPages * perPage) : null;
    const aheadSeconds = Number(detail.queue?.aheadSeconds) > 0 ? Math.round(Number(detail.queue.aheadSeconds)) : null;
    if (aheadSeconds > 0 && ownSeconds > 0) {
      const seconds = aheadSeconds + ownSeconds;
      return { kind: 'queued-total', seconds, aheadSeconds, ownSeconds, finishAt: now + seconds * 1000 };
    }
    if (aheadSeconds > 0) return { kind: 'queued-wait', seconds: aheadSeconds, finishAt: now + aheadSeconds * 1000 };
    if (ownSeconds > 0) return { kind: 'queued-own', seconds: ownSeconds };
    return null;
  }

  const win = detail.window || null, liveWin = windowDeltaSeconds(win, now);
  if (detail.eta && Number.isFinite(detail.eta.seconds) && detail.eta.seconds > 0) {
    const shift = liveWin ? liveWin.delta : 0;
    const floor = detail.eta.seconds >= 30 ? 5 : 1;
    const seconds = Math.max(floor, Math.round(detail.eta.seconds + shift));
    if (detail.eta.stable === false && Number.isFinite(detail.eta.lowSeconds) && Number.isFinite(detail.eta.highSeconds)) {
      const lowSeconds = Math.max(floor, Math.round(detail.eta.lowSeconds + shift));
      const highSeconds = Math.max(lowSeconds, Math.round(detail.eta.highSeconds + shift));
      return { kind: 'range', seconds, lowSeconds, highSeconds, finishLowAt: now + lowSeconds * 1000, finishHighAt: now + highSeconds * 1000 };
    }
    return { kind: 'steady', seconds, finishAt: now + seconds * 1000 };
  }

  const chunks = Array.isArray(job?.chunks) ? job.chunks : Array.isArray(detail.legacy?.chunks) ? detail.legacy.chunks : [];
  const timed = chunks.filter((chunk) => chunk?.state === 'done' && Number(chunk.seconds) > 0 && Number(chunk.pages) > 0);
  if (timed.length > 0 && leftPages > 0) {
    const pages = timed.reduce((sum, chunk) => sum + Number(chunk.pages), 0);
    const secs = timed.reduce((sum, chunk) => sum + Number(chunk.seconds), 0);
    const perPage = pages > 0 ? secs / pages : 0;
    if (perPage > 0) {
      const shift = liveWin ? liveWin.delta : 0;
      const seconds = Math.max(5, Math.round(leftPages * perPage + shift));
      return { kind: 'steady', seconds, finishAt: now + seconds * 1000 };
    }
  }

  if (Number(win?.pages) > 0 && done === 0 && Number(win?.expectedSeconds) > 0) {
    if (liveWin && liveWin.elapsed < liveWin.expected) {
      return { kind: 'probing', windowLeftSeconds: Math.max(5, Math.round(liveWin.expected - liveWin.elapsed)) };
    }
    return { kind: 'probing-loading' };
  }
  return null;
}

/** One compact phrase for a PDF card's dynamic expected completion time. */
export function formatPdfCardEta(eta) {
  if (!eta) return '';
  if (eta.kind === 'finishing') return ui('即将完成');
  if (eta.kind === 'probing') return uiFormat('首段测速中（约 {0}后估算总时间）', [formatDuration(quantizeEtaSeconds(eta.windowLeftSeconds) * 1000)]);
  if (eta.kind === 'probing-loading') return ui('首段加载模型与测速中（完成后显示预计时间）');
  if (eta.kind === 'queued-wait') return uiFormat('前序预计约 {0}完成', [formatDuration(quantizeEtaSeconds(eta.seconds) * 1000)]);
  if (eta.kind === 'queued-own') return uiFormat('轮到后预计约 {0}', [formatDuration(quantizeEtaSeconds(eta.seconds) * 1000)]);
  if (eta.kind === 'range') {
    if (eta.highSeconds < 30) return ui('即将完成（不到 1 分钟）');
    const lowDur = formatDuration(Math.max(60, quantizeEtaSeconds(eta.lowSeconds)) * 1000);
    const highDur = formatDuration(Math.max(60, quantizeEtaSeconds(eta.highSeconds)) * 1000);
    if (lowDur === highDur) {
      const clock = eta.seconds < 12 * 3600 && Number.isFinite(eta.finishLowAt) ? formatDateTime(eta.finishLowAt, 'time') : '';
      return clock ? uiFormat('预计约 {0}后完成（约 {1}）', [lowDur, clock]) : uiFormat('预计约 {0}后完成', [lowDur]);
    }
    const lowClock = eta.highSeconds < 12 * 3600 && Number.isFinite(eta.finishLowAt) ? formatDateTime(eta.finishLowAt, 'time') : '';
    const highClock = eta.highSeconds < 12 * 3600 && Number.isFinite(eta.finishHighAt) ? formatDateTime(eta.finishHighAt, 'time') : '';
    return lowClock && highClock && lowClock !== highClock
      ? uiFormat('预计约 {0}–{1}后完成（{2}–{3}）', [lowDur, highDur, lowClock, highClock])
      : uiFormat('预计约 {0}–{1}后完成', [lowDur, highDur]);
  }
  if (eta.seconds < 30) return ui('即将完成（不到 1 分钟）');
  const dur = formatDuration(quantizeEtaSeconds(eta.seconds) * 1000);
  const clock = eta.seconds < 12 * 3600 && Number.isFinite(eta.finishAt) ? formatDateTime(eta.finishAt, 'time') : '';
  return clock ? uiFormat('预计约 {0}后完成（约 {1}）', [dur, clock]) : uiFormat('预计约 {0}后完成', [dur]);
}

/**
 * The quiet live fact a card on a page (`CompactJobCard`) shows beside its progress:
 * - Audio runs: elapsed run time and metered model tokens.
 * - PDF conversions: dynamic expected completion time (ticking countdown + estimated wall-clock finish).
 */
export function runFacts(job, now = Date.now()) {
  const kind = taskKindOf(job);
  if (kind === 'pdf') return formatPdfCardEta(pdfEtaOf(job, now));
  const contract = contractOf(job);
  if (kind !== 'audio' || !isRunningTask(job) || contract.status === 'queued') return '';
  const elapsed = elapsedOf(contract, true, now);
  return joinMeta([elapsed === dash ? '' : `${ui('已用')} ${elapsed}`, contract.usage.tokens > 0 ? uiFormat('{0} tok', [formatCompactTokens(contract.usage.tokens)]) : '']);
}

/** "151 · 0 失败": model calls made and how many failed. */
function callsFact(contract) {
  const calls = contract.calls.filter((call) => call.kind !== 'wait');
  if (!calls.length) return dash;
  return uiFormat('{0} · {1} 失败', [calls.length, calls.filter((call) => call.status === 'failed').length]);
}

/** A PDF conversion makes no model calls: its third tile counts the windows (段) done, over all of them when the plan is fixed (an adaptive plan decides them as it goes). */
function windowsFact(job, contract) {
  const chunks = Array.isArray(job?.chunks) ? job.chunks : Array.isArray(contract.detail?.legacy?.chunks) ? contract.detail.legacy.chunks : [];
  if (!chunks.length) return dash;
  const done = chunks.filter((chunk) => chunk.state === 'done').length;
  return contract.detail?.adaptive ? String(done) : `${done} / ${chunks.length}`;
}

/** The step an install is on (or stopped at), '全部完成' when every step is done. */
function installStepFact(steps) {
  const current = steps.find((step) => ['active', 'failed'].includes(step.state));
  return current ? uiMessage(current.name) : steps.length && steps.every((step) => step.state === 'done') ? ui('全部完成') : dash;
}

const noticesOf = (contract) => (Array.isArray(contract.detail?.notices) ? contract.detail.notices.length : Array.isArray(contract.detail?.warnings) ? contract.detail.warnings.length : 0);

/** 为你定制 by the day: what was written and kept, what was practised and how well, the tokens in / out / from cache, what was skipped. */
function coachFacts(contract) {
  const { metrics = {}, tokens = {} } = contract.detail, any = (tokens.input || 0) + (tokens.output || 0) + (tokens.cache || 0) > 0;
  return [
    { key: 'primary', label: ui('备好 / 写出'), value: `${metrics.passed ?? 0} / ${metrics.generated ?? 0}` },
    { key: 'elapsed', label: ui('练习 · 正确率'), value: metrics.practised > 0 ? `${metrics.practised} · ${metrics.accuracy}%` : dash },
    { key: 'calls', label: ui('令牌 入/出/缓存'), value: any ? [tokens.input, tokens.output, tokens.cache].map((value) => formatCompactTokens(value || 0)).join('/') : dash },
    { key: 'warnings', label: ui('跳过 · 过期'), value: metrics.skippedExpired > 0 ? formatNumber(metrics.skippedExpired) : dash },
  ];
}

/**
 * What the headline percent and the tile of the questions count, said on hover (ui/tasks/Metrics.jsx): { percent, questions }, '' for a task that is not a question run. A top-up or a continuation counts
 * only its own work, and says so; a run with a plan counts sections, because questions can exceed the plan while sections are missing (docs/job-contract.md).
 */
export function progressHint(job) {
  const contract = contractOf(job);
  if (!['generation', 'supplement'].includes(contract.kind)) return { percent: '', questions: '' };
  const { own, cover, run } = contract.detail, mine = !!own || cover?.atStart > 0;
  const covering = ui('覆盖：有题的小节 ÷ 计划里的小节。题数多不等于覆盖多，所以这里数小节，不数题。');
  const percent = cover ? (mine ? uiFormat('这个任务自己的进度：它补上的小节 ÷ 它要补的小节（开始时草稿里有 {0} 个小节没有题）。草稿原有的题和小节不算在内。', [cover.asked]) : covering)
    : own ? ui('这个任务自己的进度：它新写的题 ÷ 它要补的题。草稿里原有的题不算在内。') : Number.isFinite(run?.percent) ? covering : ui('已通过审阅并保存的题 ÷ 要求的题数。');
  const questions = own ? uiFormat('本任务新写的题 ÷ 本任务要补的题（约数）。草稿里原有的题不算在内；草稿共 {0} 题。', [contract.progress.done])
    : run ? (run.dueKnown
      // One fact, one number (#774): the tile counts questions against the PLAN's goal, while 「还要约 N 题」 counts what the sections without a question still need. They are
      // two different facts, so they do not add up to the plan and must not be read as if they did; the tile says which one it is.
      ? ui('草稿里现有的题 ÷ 出题计划的题数。下面的「还要约 N 题」数的是还没有题的小节，和计划里的题数不是同一个数，所以加起来不等于它。')
      : ui('草稿里现有的题 ÷ 出题计划的题数。题数可以超过计划；有多少小节有题，要看覆盖率。'))
    : ui('已通过审阅并保存的题 ÷ 要求的题数。');
  return { percent, questions };
}

/**
 * Whether the facts row of this kind of task can carry a note under a tile (the estimate under 已用, the draft's total under the questions of a continuation): the console reserves the line in EVERY tile of such a
 * row, and in no tile of any other, so a note that comes or goes moves nothing and a row that never has one is not taller for it. Decided from the kind, never from the data of the moment.
 */
export const rowHasNotes = (kind) => kind === 'generation' || kind === 'supplement';

/** The facts row: what is counted for this kind, the clock, the model calls (with their tokens when metered) and the notices. */
export function taskFacts(job, now = Date.now()) {
  const contract = contractOf(job), { progress, usage } = contract, notices = noticesOf(contract);
  if (contract.kind === 'coach-daily') return coachFacts(contract);
  let count = progress.total > 0 ? `${progress.done} / ${progress.total}` : dash;
  // A task that waits shows its wait, as a wait: 已用 is the time it RUNS. A question run says under it what is left (the line is there for every one, empty or not, so nothing moves when the numbers come).
  const queued = contract.status === 'queued', note = contract.kind === 'generation' ? { note: forecastTime(forecastOf(contract, now)?.time) } : {};
  // The questions a run with rounds counts are the draft's, over the WHOLE plan (progress.total: every round), not the round that is being made.
  let unit = progress.unit === 'questions' && contract.detail?.run ? ui('题数 · 全部计划') : ui(UNIT_LABEL[progress.unit] || '进度');
  // A continued job counts the questions IT writes over the ones it was asked for (about, when a plan decides), and says under it what the whole draft holds: its tile never starts at the draft's own count.
  const own = contract.detail?.own, primary = { key: 'primary' };
  if (own) {
    unit = ui('题数 · 本任务');
    count = own.asked > 0 ? uiFormat(contract.detail.run ? '{0} / 约 {1}' : '{0} / {1}', [own.made, own.asked]) : String(own.made);
    primary.note = uiFormat('草稿共 {0} 题', [progress.done]);
  }
  const hint = progressHint(job).questions;
  return [
    { ...primary, label: unit, value: count, ...(hint ? { hint } : {}) },
    { key: 'elapsed', label: queued ? ui('排队中') : ui('已用'), value: queued ? uiFormat('已等 {0}', [waitedOf(contract, now)]) : elapsedOf(contract, isRunningTask(job), now), ...note },
    contract.kind === 'pdf-convert' ? { key: 'calls', label: ui('已完成的段'), value: windowsFact(job, contract) }
      // An install makes no model calls: the tile says the step it is on (the same step the list below marks).
      : contract.detail?.install?.steps ? { key: 'calls', label: ui('当前步骤'), value: installStepFact(contract.detail.install.steps) }
      // A search-index build writes pages to the local search extension: no model, no tokens, and the tile says so instead of counting its one local call.
      : contract.kind === 'retrieval-index' ? { key: 'calls', label: ui('运行方式'), value: ui('本机 · 不用 AI'), hint: ui('在本机把页面写进检索扩展，不调用 AI，不花 token。停止后已写入的页会保留，再次开始只写还没建好的页。') }
      : { key: 'calls', label: ui('模型任务'), value: usage.tokens > 0 ? `${callsFact(contract)} · ${formatCompactTokens(usage.tokens)}` : callsFact(contract) },
    { key: 'warnings', label: ui('提醒'), value: notices ? uiFormat('{0} 条', [formatNumber(notices)]) : dash },
  ];
}

/**
 * What an audio import has asked of its providers, as ONE line (the console keeps the line's height for every audio job): the Gemini requests, free and paid, with what the
 * paid part of the transcription would cost, the free providers' counts, that this attempt asked for less than the whole (a reused transcript), and who did the text steps.
 */
export function usageLine(job) {
  const contract = contractOf(job), usage = contract.detail?.usage;
  if (taskKindOf(job) !== 'audio') return '';
  const files = contract.detail.files || [];
  const windows = contract.status === 'running' && files.some((file) => file.status === 'running' && ['proofread', 'translate'].includes(file.phase)) ? parallelNote(contract.detail.parallel?.text) : '';
  // A task that only works on text never asks the transcription service: it says what the model did, not what the service did not.
  if (!audioCallKinds(contract.kind).includes('transcribe')) return textLine(contract, windows);
  const total = files.reduce((sum, file) => sum + (file.steps?.transcribe?.total || 0), 0);
  const reused = reuseNote(total > 0 ? { transcribe: { total, done: total, reused: files.reduce((sum, file) => sum + (file.steps?.transcribe?.reused || 0), 0) } } : undefined);
  if (!usage) return joinMeta([ui('还没有向转写服务发请求'), reused, windows]);
  const gemini = usage.gemini.free + usage.gemini.paid;
  const text = hostTextDone(contract)
    ? ui('校对和翻译由 DSH 模型完成') : '';
  return joinMeta([gemini > 0 ? uiFormat('Gemini 请求：免费 {0} · 付费 {1}', [usage.gemini.free, usage.gemini.paid]) : '',
    gemini > 0 && usage.paidUsd > 0 ? uiFormat('转写付费约 ${0}', [usage.paidUsd]) : '',
    usage.thisRun ? uiFormat('本次：免费 {0} · 付费 {1}', [usage.thisRun.free, usage.thisRun.paid]) : gemini === 0 && usage.siliconflow + usage.groq === 0 ? ui('这次没有新发转写请求') : '',
    usage.siliconflow > 0 ? uiFormat('硅基流动 {0}（免费）', [usage.siliconflow]) : '', usage.groq > 0 ? uiFormat('Groq {0}（免费额度）', [usage.groq]) : '', text, reused, windows]);
}

const hostTextDone = (contract) => contract.detail.textProvider === 'host' && contract.progress.segments?.some((segment) => ['proofread', 'translate'].includes(segment.stage) && segment.done > 0);

/** The request line of a task that makes no transcription: who did the text steps, the parallel windows; else what kind of work it is. */
function textLine(contract, windows) {
  const host = hostTextDone(contract);
  return joinMeta([host ? ui('文字处理由 DSH 模型完成') : '', windows]) || ui('文字处理任务');
}

/** The stage segments of the progress bar: [{ stage, label, done, total }], in the order the work happens. */
export function taskSegments(job) {
  const contract = contractOf(job), { progress } = contract;
  if (progress.segments?.length) return progress.segments.map((segment) => ({ ...segment, label: ui(SEGMENT_LABEL[segment.stage] || '进度') }));
  // A question run that counts its own work has a bar of that work (the sections it covered over the ones it was asked for, else its questions over its request): the draft it started from does not fill it.
  const { cover, own } = contract.detail || {}, mine = cover?.asked > 0 ? { done: cover.covered - cover.atStart, total: cover.asked } : own?.asked > 0 ? { done: own.made, total: own.asked } : null;
  if (mine) return [{ stage: 'author', label: ui('进度'), done: Math.max(0, Math.min(mine.done, mine.total)), total: mine.total }];
  return [{ stage: 'author', label: ui('进度'), done: progress.done, total: progress.total ?? Math.max(progress.done, 1) }];
}
