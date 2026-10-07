import { ui, uiFormat } from '../i18n.js';
import { formatElapsed, formatNumber } from '../format.js';
import { formatCompactTokens } from '../../lib/token-usage.js';
import { joinMeta } from '../format.js';
import { parallelNote, reuseNote } from '../audio/audio-notes.js';
import { audioCallKinds } from './call-model.js';
import { contractOf, isRunningTask, taskKindOf } from './task-model.js';

/* The four facts beside a task's progress and the stage segments of its bar, read from the job's contract. */

const dash = '—';
const UNIT_LABEL = { files: '文件', pages: '页', paragraphs: '段落', questions: '题数' };
const SEGMENT_LABEL = { transcribe: '转写', proofread: '校对', translate: '翻译', save: '保存', plan: '规划', blueprint: '答案与情景', author: '出题', review: '审阅', repair: '修复' };

/** How long the task has been going (the 已用 fact, and the one number the time-limit strip counts against its limit): null before it has started. */
export function elapsedMs(contract, running, now) {
  if (!contract.startedAt) return null;
  const end = running ? now : Date.parse(contract.finishedAt || contract.startedAt);
  return Math.max(0, end - Date.parse(contract.startedAt));
}

function elapsedOf(contract, running, now) {
  const ms = elapsedMs(contract, running, now);
  return ms === null ? dash : formatElapsed(ms);
}

/** "151 · 0 失败": model calls made and how many failed. */
function callsFact(contract) {
  const calls = contract.calls.filter((call) => call.kind !== 'wait');
  if (!calls.length) return dash;
  return uiFormat('{0} · {1} 失败', [calls.length, calls.filter((call) => call.status === 'failed').length]);
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

/** The facts row: what is counted for this kind, the clock, the model calls (with their tokens when metered) and the notices. */
export function taskFacts(job, now = Date.now()) {
  const contract = contractOf(job), { progress, usage } = contract, notices = noticesOf(contract);
  if (contract.kind === 'coach-daily') return coachFacts(contract);
  const count = progress.total > 0 ? `${progress.done} / ${progress.total}` : dash;
  return [
    { key: 'primary', label: ui(UNIT_LABEL[progress.unit] || '进度'), value: count },
    { key: 'elapsed', label: ui('已用'), value: elapsedOf(contract, isRunningTask(job), now) },
    { key: 'calls', label: ui('模型任务'), value: usage.tokens > 0 ? `${callsFact(contract)} · ${formatCompactTokens(usage.tokens)}` : callsFact(contract) },
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
  const { progress } = contractOf(job);
  if (progress.segments?.length) return progress.segments.map((segment) => ({ ...segment, label: ui(SEGMENT_LABEL[segment.stage] || '进度') }));
  return [{ stage: 'author', label: ui('进度'), done: progress.done, total: progress.total ?? Math.max(progress.done, 1) }];
}
