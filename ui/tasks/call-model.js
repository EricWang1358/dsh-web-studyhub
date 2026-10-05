import { ui, uiFormat } from '../i18n.js';
import { STRENGTH_LABEL } from '../../lib/model-effort.js';
import { formatDuration, joinMeta } from '../format.js';
import { appliedText } from './task-control.js';

/* What the console's panels are drawn from: the timeline's lanes and bars, the list of calls in flight, the log's lines. Plain functions over a job's
   contract (docs/job-contract.md); no React, so a test can read them. */

const KIND_LABEL = { transcribe: '转写', proofread: '校对', translate: '翻译', title: '生成标题', plan: '提取知识点与原文', blueprint: '确定答案与情景', author: '出题与自查',
  review: '独立审阅', repair: '修复题目', publish: '发布检查', wait: '限流等待', other: '模型调用' };

/** A call as a short phrase: "校对 6/9", "限流等待"; `file` adds the recording it belongs to. */
export function callLabel(call, { file = false } = {}) {
  if (!call) return '';
  const base = ui(KIND_LABEL[call.kind] || KIND_LABEL.other);
  const label = call.kind !== 'wait' && call.part != null && call.parts ? uiFormat('{0} {1}/{2}', [base, call.part, call.parts]) : base;
  return file && call.file ? joinMeta([label, call.file]) : label;
}

const RUNNER = { subagent: 'DSH 子代理', direct: '直接模型调用', gemini: 'Gemini' };
/** Who runs a call, and at what reasoning level when one was asked for. */
export function runnerLabel(call) {
  if (!call?.runner) return '';
  const who = ui(RUNNER[call.runner] || call.runner);
  const level = call.reasoning && call.reasoning !== 'default' ? uiFormat('推理 {0}', [ui(STRENGTH_LABEL[call.reasoning] || call.reasoning)]) : '';
  return joinMeta([who, level]);
}

/** What the output panel can show for a call: 'stream' (it can write text on the way: ask), 'none' (it cannot), 'ended' (nothing is kept), 'idle' (no call). */
export function outputMode(call) {
  if (!call) return 'idle';
  if (call.status !== 'running') return 'ended';
  if (call.kind === 'wait' || call.runner === 'gemini' || call.kind === 'transcribe') return 'none';
  return 'stream';
}

/** The calls in flight (and the waits), the newest first. */
export function runningCalls(calls) {
  return (calls || []).filter((call) => call.status === 'running' || call.status === 'waiting').sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
}

const WINDOW_MS = 10 * 60 * 1000, MIN_WINDOW_MS = 60 * 1000, MAX_SLOT_LANES = 8, MAX_TRANSCRIBE_LANES = 3, EDGE = 0.5;

/** Put intervals in the fewest lanes where none overlap (first fit), at most `limit` lanes. */
function pack(items, limit) {
  const lanes = [];
  for (const item of [...items].sort((a, b) => a.from - b.from)) {
    let lane = lanes.find((entry) => entry.until <= item.from);
    if (!lane && lanes.length < limit) { lane = { until: 0, items: [] }; lanes.push(lane); }
    if (!lane) lane = lanes[lanes.length - 1];
    lane.items.push(item);
    lane.until = Math.max(lane.until, item.to);
  }
  return lanes.map((lane) => lane.items);
}

/**
 * The parallel timeline: { lanes: [{ key, kind: 'transcribe' | 'slot' | 'other', index, bars }], windowMs, begin, end }. One lane per slot of the pool the calls ran
 * in (a rate-limit wait is drawn in the slot that was refused), transcription in lanes of its own (side by side where requests overlap), anything else in
 * one more. The window is the last ten minutes of a running job, the whole run of a finished one (at most ten minutes, at least one).
 */
export function timelineModel(calls, { now = Date.now(), running = false } = {}) {
  const timed = (calls || []).filter((call) => Number.isFinite(Date.parse(call.startedAt))).map((call) => ({ call, from: Date.parse(call.startedAt), to: call.endedAt ? Date.parse(call.endedAt) : null }));
  if (!timed.length) return { lanes: [], windowMs: MIN_WINDOW_MS, begin: now, end: now };
  const first = Math.min(...timed.map((item) => item.from)), last = Math.max(...timed.map((item) => item.to ?? item.from));
  const end = running ? now : last, span = Math.min(WINDOW_MS, Math.max(MIN_WINDOW_MS, end - first)), begin = end - span;
  const bar = ({ call, from, to }) => {
    const stop = to ?? end, left = Math.max(0, (Math.max(from, begin) - begin) / span * 100), right = Math.min(100, (Math.min(stop, end) - begin) / span * 100);
    if (right < 0 || stop < begin) return null;
    const width = Math.max(EDGE, right - left);
    return { callId: call.callId, kind: call.kind, status: call.status, wait: call.kind === 'wait', running: to === null, left: Math.min(left, 100 - EDGE), width: Math.min(width, 100 - Math.min(left, 100 - EDGE)),
      label: callLabel(call, { file: true }), runner: call.runner };
  };
  const intervals = (items) => items.map((item) => ({ ...item, to: item.to ?? end }));
  const lanes = [];
  const transcribe = timed.filter((item) => item.call.kind === 'transcribe');
  pack(intervals(transcribe), MAX_TRANSCRIBE_LANES).forEach((items, index) => lanes.push({ key: `transcribe-${index + 1}`, kind: 'transcribe', index: index + 1, bars: items.map(bar).filter(Boolean) }));
  const slotted = timed.filter((item) => item.call.kind !== 'transcribe' && Number.isInteger(item.call.slot) && item.call.slot >= 1 && item.call.slot <= MAX_SLOT_LANES);
  const highest = Math.max(0, ...slotted.map((item) => item.call.slot));
  for (let slot = 1; slot <= highest; slot++) lanes.push({ key: `slot-${slot}`, kind: 'slot', index: slot, bars: slotted.filter((item) => item.call.slot === slot).sort((a, b) => a.from - b.from).map(bar).filter(Boolean) });
  const rest = timed.filter((item) => item.call.kind !== 'transcribe' && !slotted.includes(item));
  pack(intervals(rest), 1).forEach((items, index) => lanes.push({ key: `other-${index + 1}`, kind: 'other', index: index + 1, bars: items.map(bar).filter(Boolean) }));
  return { lanes, windowMs: span, begin, end };
}

const PHASE = { transcribe: '转写', proofread: '校对', translate: '翻译' };
const STATUS_WORD = (status) => ({ complete: ui('任务完成'), failed: ui('任务失败'), cancelled: ui('任务已停止'), interrupted: ui('任务中断'), running: ui('任务开始'), queued: ui('排队中') })[status] || '';

/** One event of the log as a sentence (the codes the backend records, translated here). */
export function eventText(event) {
  const a = event.args || {};
  switch (event.code) {
    case 'status': return ['failed', 'interrupted'].includes(a.status) && event.text ? uiFormat('{0}：{1}', [STATUS_WORD(a.status), event.text]) : STATUS_WORD(a.status) || event.text || '';
    case 'stage': return event.text || '';
    case 'phase': return a.total > 0 ? uiFormat('{0}开始 · 共 {1} 段', [ui(PHASE[a.phase] || a.phase), a.total]) : uiFormat('{0}开始', [ui(PHASE[a.phase] || a.phase)]);
    case 'milestone': return a.partial ? uiFormat('{0}完成；有的段落没有成功，保留原文', [ui(PHASE[a.phase] || a.phase)]) : uiFormat('{0}全部完成', [ui(PHASE[a.phase] || a.phase)]);
    case 'warning': return event.text || '';
    case 'rate-limit': return uiFormat('槽 {0} 被限流，{1} 秒后重试', [a.slot ?? '—', a.seconds ?? '—']);
    case 'concurrency': return uiFormat('同时调用数从 {0} 调到 {1}（设置为 {2}）', [a.from, a.to, a.limit]);
    case 'throttle': return a.reason === 'rate-limit' ? uiFormat('模型限流，同时调用数降到 {0}（设置为 {1}）', [a.concurrency, a.configured]) : uiFormat('限流已缓解，同时调用数回到 {0}', [a.concurrency]);
    case 'control': return appliedText(a.changed);
    case 'paused': return ui('已暂停：没有调用在进行');
    default: return event.text || String(event.code || '');
  }
}

const LEVEL = { step: 'step', warn: 'warn', error: 'warn', done: 'done', info: 'info' };
const CALL_STATUS = (status) => ({ ok: ui('完成'), failed: ui('失败'), cancelled: ui('已取消'), skipped: ui('已跳过') })[status] || '';

/**
 * The log, newest first: the producer's own events and one line per finished call, a warning that repeats as ONE line with its count.
 * filter: all | step | warn | done. Line: { id, at, level, kind, text, tag?, count? }.
 */
export function logLines(contract, filter = 'all') {
  const lines = [];
  const warnings = new Map();
  for (const event of contract?.events || []) {
    const text = eventText(event);
    if (event.code === 'warning') {
      const key = event.text, seen = warnings.get(key);
      if (seen) { seen.count += 1; if (Date.parse(event.at) > Date.parse(seen.at)) seen.at = event.at; continue; }
      const line = { id: event.id, at: event.at, level: 'warn', kind: 'warning', text, tag: event.tag ?? null, count: 1 };
      warnings.set(key, line); lines.push(line); continue;
    }
    lines.push({ id: event.id, at: event.at, level: LEVEL[event.level] || 'info', kind: event.code, text, tag: event.tag ?? null });
  }
  for (const call of contract?.calls || []) {
    if (call.kind === 'wait' || !call.endedAt) continue;
    const took = formatDuration(Date.parse(call.endedAt) - Date.parse(call.startedAt));
    lines.push({ id: `call:${call.callId}`, at: call.endedAt, level: call.status === 'ok' ? 'step' : call.status === 'failed' ? 'warn' : 'info', kind: 'call', tag: call.kind,
      text: joinMeta([`${callLabel(call, { file: true })} ${CALL_STATUS(call.status)}`.trim(), took]) });
  }
  for (const line of lines) if (line.count > 1) line.text = `${line.text} ×${line.count}`;
  const ordered = lines.map((line, index) => ({ line, index })).sort((a, b) => (Date.parse(b.line.at) || 0) - (Date.parse(a.line.at) || 0) || b.index - a.index).map(({ line }) => line);
  return filter === 'all' ? ordered : ordered.filter((line) => line.level === filter);
}

/** How many lines each filter shows. */
export function logCounts(contract) {
  const all = logLines(contract, 'all');
  return { all: all.length, step: all.filter((line) => line.level === 'step').length, warn: all.filter((line) => line.level === 'warn').length, done: all.filter((line) => line.level === 'done').length };
}
