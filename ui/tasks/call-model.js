import { ui, uiFormat } from '../i18n.js';
import { STRENGTH_LABEL } from '../../lib/model-effort.js';
import { formatDuration, joinMeta } from '../format.js';
import { appliedText } from './task-control.js';
import { callErrorText } from '../generation-status.js';
import { runEventText } from '../coverage/copy.js';

/* What the console's panels are drawn from: the timeline's lanes and bars, the list of calls in flight, the log's lines. Plain functions over a job's
   contract (docs/job-contract.md); no React, so a test can read them. */

const KIND_LABEL = { transcribe: '转写', proofread: '校对', translate: '翻译', title: '生成标题', plan: '提取知识点与原文', blueprint: '确定答案与情景', author: '出题与自查',
  review: '独立审阅', repair: '修复题目', publish: '发布检查', prep: '备题', wait: '限流等待', other: '模型调用', 'live.correct': '课堂校正' };

/** The calls each kind of audio job can make, in the order the work goes: what its timeline legend may name. A task of the original path is one kind for all of them. */
const AUDIO_CALLS = { 'audio-subtitles': ['proofread', 'translate'], 'audio-review': ['proofread'], 'audio-live-save': ['proofread', 'translate'], 'audio-live-correction': ['live.correct'] };
export const audioCallKinds = (contractKind) => AUDIO_CALLS[contractKind] || ['transcribe', 'proofread', 'translate'];
const LEGEND = { generation: ['plan', 'author', 'review', 'repair'], coach: ['prep'] };
const LEGEND_LABEL = { plan: '规划', author: '出题', review: '审阅', repair: '修复', prep: '备题' };
/** The legend of the parallel timeline for a family of tasks (and, for audio, for the kind): [[call kind, label]]. */
export const timelineLegend = (family, contractKind) => family === 'audio' ? audioCallKinds(contractKind).map((kind) => [kind, KIND_LABEL[kind]])
  : (LEGEND[family] || LEGEND.generation).map((kind) => [kind, LEGEND_LABEL[kind]]);

/** A call as a short phrase: "校对 6/9", "限流等待"; `file` adds the recording it belongs to. */
export function callLabel(call, { file = false } = {}) {
  if (!call) return '';
  const base = ui(KIND_LABEL[call.kind] || KIND_LABEL.other);
  const counted = call.kind !== 'wait' && call.part != null && call.parts ? uiFormat('{0} {1}/{2}', [base, call.part, call.parts]) : base;
  // A review asked again because its reply could not be used (lib/generation.js) is a retry of the same review, and is called that.
  const numbered = call.kind === 'review' && call.retry > 0 ? uiFormat('{0} · 第 {1} 次重新审阅', [counted, call.retry]) : counted;
  // A transcript taken from the saved one is a call too (drawn as a blue bar), and is called what it is.
  const label = call.reused ? uiFormat('{0} · 复用', [numbered]) : numbered;
  return file && call.file ? joinMeta([label, call.file]) : label;
}

const RUNNER = { subagent: 'DSH 子代理', direct: '直接模型调用', gemini: 'Gemini', saved: '已保存的转写' };
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

const WINDOW_MS = 10 * 60 * 1000, MAX_KEPT_WINDOW_MS = 60 * 60 * 1000, MIN_WINDOW_MS = 60 * 1000, MAX_SLOT_LANES = 8, MAX_TRANSCRIBE_LANES = 3, EDGE = 0.5, REUSED_EDGE = 1.5;
const MAX_LANES = 24, MAX_UNIT_ROWS = 3, ATTACH_MS = 5000, NAME_CHARS = 22;

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

/** A file name short enough for a lane label: the middle becomes "…", the extension stays (the lane's title carries the whole name). */
export function shortFile(name, limit = NAME_CHARS) {
  const text = String(name ?? '');
  if (text.length <= limit) return text;
  const dot = text.lastIndexOf('.'), ext = dot > 0 && text.length - dot <= 6 ? text.slice(dot) : '', stem = ext ? text.slice(0, dot) : text;
  const room = Math.max(2, limit - ext.length - 1), head = Math.ceil(room * 0.6), tail = room - head;
  return `${stem.slice(0, head)}…${tail > 0 ? stem.slice(-tail) : ''}${ext}`;
}

const WHOLE = { key: 'whole', kind: 'whole' };
/** The unit of work a call belongs to in this run: its file (an audio import), else its part (a question run, a translation), else the whole run. */
function unitOf(call, mode) {
  if (mode === 'file') return call.file ? { key: `file:${call.file}`, kind: 'file', file: String(call.file) } : WHOLE;
  return Number.isFinite(Number(call.part)) && call.part !== null ? { key: `part:${Number(call.part)}`, kind: 'part', part: Number(call.part) } : WHOLE;
}

/**
 * The parallel timeline: { lanes: [{ key, kind, index, row, file?, part?, bars }], hiddenLanes, windowMs, begin, end }.
 *
 * A lane is a UNIT OF WORK, so it reads as that unit's story from left to right (every model call is a fresh sub-agent: a pool slot says nothing about order).
 *  - A run whose calls name a file (an audio import) has one lane per file ('file'); calls of no file go to a 整体 lane ('whole'), first.
 *  - Else, if its calls carry a part (a question run, a supplement, a translation), one lane per part, by number ('part'), 整体 ('whole') first for the rest.
 *  - Else (为你定制 batches, anything unknown) the old slot lanes: one per pool slot ('slot'), transcription in lanes of its own ('transcribe'), the rest in 'other'.
 *  A rate-limit wait carries a slot, not a unit: it is drawn in the lane of the unit whose call used that slot at that time (the nearest one, at most five seconds
 *  away); a wait no call can claim goes to a lane 'other' (其他), last.
 *  Calls of one unit that overlap in time (parallel windows of a file) get extra lanes of the same unit, at most three (`row` 2 and 3, key `<unit>~2`); a lane drawn
 *  as a continuation has no label of its own.
 *  At most 24 lanes: the units that were active most recently stay (a unit with a call in flight always does), still in their own order; `hiddenLanes` counts the
 *  units left out. A unit with nothing inside the window has no lane.
 *  A reused transcript (call.reused, no duration) is a bar of at least 1.5% of the chart, the others of at least 0.5%.
 * The window is the last ten minutes of a running job, the whole run of a finished one (at most ten minutes, at least one); `pinned` (call ids) widens it back to the earliest of those calls (an hour at most).
 */
export function timelineModel(calls, { now = Date.now(), running = false, pinned = [] } = {}) {
  const timed = (calls || []).filter((call) => Number.isFinite(Date.parse(call.startedAt))).map((call) => ({ call, from: Date.parse(call.startedAt), to: call.endedAt ? Date.parse(call.endedAt) : null }));
  if (!timed.length) return { lanes: [], hiddenLanes: 0, windowMs: MIN_WINDOW_MS, begin: now, end: now };
  const first = Math.min(...timed.map((item) => item.from)), last = Math.max(...timed.map((item) => item.to ?? item.from));
  // The steps the time-limit strip points at (`pinned`: call ids) are never cut away: the window reaches back to where the earliest of them began (an hour at most).
  const kept = timed.filter((item) => pinned.includes(item.call.callId)).map((item) => item.from);
  const end = running ? now : last, reach = kept.length ? Math.min(MAX_KEPT_WINDOW_MS, end - Math.min(...kept)) : 0;
  const span = Math.min(Math.max(WINDOW_MS, reach), Math.max(MIN_WINDOW_MS, end - first)), begin = end - span;
  const bar = ({ call, from, to }) => {
    const stop = to ?? end, left = Math.max(0, (Math.max(from, begin) - begin) / span * 100), right = Math.min(100, (Math.min(stop, end) - begin) / span * 100);
    if (right < 0 || stop < begin) return null;
    const edge = call.reused ? REUSED_EDGE : EDGE, width = Math.max(edge, right - left);   // a reused transcript took no time but is still a visible, clickable bar
    return { callId: call.callId, kind: call.kind, status: call.status, wait: call.kind === 'wait', running: !call.endedAt, left: Math.min(left, 100 - edge), width: Math.min(width, 100 - Math.min(left, 100 - edge)),
      label: callLabel(call, { file: true }), runner: call.runner, slot: Number.isInteger(call.slot) ? call.slot : null };
  };
  const intervals = (items) => items.map((item) => ({ ...item, to: item.to ?? end }));
  const real = timed.filter((item) => item.call.kind !== 'wait');
  const mode = real.some((item) => item.call.file) ? 'file' : real.some((item) => item.call.part != null) ? 'part' : 'slot';
  const lanes = [];
  if (mode === 'slot') {
    const transcribe = timed.filter((item) => item.call.kind === 'transcribe');
    pack(intervals(transcribe), MAX_TRANSCRIBE_LANES).forEach((items, index) => lanes.push({ key: `transcribe-${index + 1}`, kind: 'transcribe', index: index + 1, row: 1, bars: items.map(bar).filter(Boolean) }));
    const slotted = timed.filter((item) => item.call.kind !== 'transcribe' && Number.isInteger(item.call.slot) && item.call.slot >= 1 && item.call.slot <= MAX_SLOT_LANES);
    const highest = Math.max(0, ...slotted.map((item) => item.call.slot));
    for (let slot = 1; slot <= highest; slot++) lanes.push({ key: `slot-${slot}`, kind: 'slot', index: slot, row: 1, bars: slotted.filter((item) => item.call.slot === slot).sort((a, b) => a.from - b.from).map(bar).filter(Boolean) });
    const rest = timed.filter((item) => item.call.kind !== 'transcribe' && !slotted.includes(item));
    pack(intervals(rest), 1).forEach((items, index) => lanes.push({ key: `other-${index + 1}`, kind: 'other', index: index + 1, row: 1, bars: items.map(bar).filter(Boolean) }));
    return { lanes, hiddenLanes: 0, windowMs: span, begin, end };
  }
  const units = new Map();
  const place = (unit, item) => { if (!units.has(unit.key)) units.set(unit.key, { ...unit, items: [] }); units.get(unit.key).items.push(item); };
  const claimed = intervals(real).map((item) => ({ ...item, unit: unitOf(item.call, mode) }));
  claimed.forEach((item) => place(item.unit, item));
  const gap = (a, b) => Math.max(0, a.from - b.to, b.from - a.to);
  const strays = [];
  for (const item of intervals(timed.filter((entry) => entry.call.kind === 'wait'))) {
    const owners = Number.isInteger(item.call.slot) ? claimed.filter((other) => other.call.slot === item.call.slot).map((other) => ({ other, away: gap(item, other) })).filter(({ away }) => away <= ATTACH_MS) : [];
    const best = owners.sort((a, b) => a.away - b.away)[0];
    if (best) place(best.other.unit, item); else strays.push(item);
  }
  const rank = (unit) => (unit.kind === 'part' ? unit.part : Math.min(...unit.items.map((item) => item.from)));
  const drawn = [...units.values()].sort((a, b) => (b.kind === 'whole') - (a.kind === 'whole') || rank(a) - rank(b))
    .map((unit) => ({ unit, rows: pack(unit.items, MAX_UNIT_ROWS).map((items) => items.map(bar).filter(Boolean)).filter((bars) => bars.length) })).filter(({ rows }) => rows.length);
  const strayRows = pack(strays, MAX_UNIT_ROWS).map((items) => items.map(bar).filter(Boolean)).filter((bars) => bars.length);
  if (strayRows.length) drawn.push({ unit: { key: 'other', kind: 'other' }, rows: strayRows });
  // Keep the units active most recently while the lanes fit; the rest are counted, not drawn.
  const activity = ({ unit }) => (unit.items ?? []).reduce((latest, item) => Math.max(latest, item.call.endedAt ? item.to : Infinity), 0);
  const keep = new Set();
  let used = 0;
  for (const entry of [...drawn].sort((a, b) => activity(b) - activity(a) || drawn.indexOf(a) - drawn.indexOf(b))) {
    if (used + entry.rows.length > MAX_LANES && keep.size) continue;
    keep.add(entry); used += entry.rows.length;
  }
  for (const entry of drawn.filter((one) => keep.has(one))) {
    entry.rows.forEach((bars, index) => lanes.push({ key: index ? `${entry.unit.key}~${index + 1}` : entry.unit.key, kind: entry.unit.kind, index: entry.unit.part ?? 1, row: index + 1,
      ...(entry.unit.file !== undefined ? { file: entry.unit.file } : {}), ...(entry.unit.part !== undefined ? { part: entry.unit.part } : {}), bars }));
  }
  return { lanes, hiddenLanes: drawn.length - keep.size, windowMs: span, begin, end };
}

const PHASE = { transcribe: '转写', proofread: '校对', translate: '翻译' };
const STATUS_WORD = (status) => ({ complete: ui('任务完成'), failed: ui('任务失败'), cancelled: ui('任务已停止'), interrupted: ui('任务中断'), running: ui('任务开始'), queued: ui('排队中') })[status] || '';

const BATCH_REASON = { paused: '今天已暂停备题', limit: '今天的备题次数已用完', full: '备好的题已经攒满', none: '没有需要备的题', invalid: '这批没有写出通过校验的题', changed: '学习档案或授权变了，旧结果已丢弃', cancelled: '这批备题已取消' };
/** Why a batch of 为你定制 wrote nothing, in words (the producer records a code, so the words are translated here); a model error keeps its own message. */
export const batchReason = (batch) => (batch.reason === 'error' ? batch.message || ui('这批没有完成') : batch.reason && BATCH_REASON[batch.reason] ? ui(BATCH_REASON[batch.reason]) : batch.status === 'ok' ? '' : ui('这批没有写出题'));
const batchText = (args, text) => (args.status === 'ok' ? uiFormat('备好 {0} 道定制题', [args.passed ?? 0]) : batchReason({ status: args.status, reason: args.reason, message: text }));

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
    case 'batch': return batchText(a, event.text);
    // The rounds of a coverage run: one line per round boundary and one for the reason a run stops (ui/coverage/copy.js is the one wording).
    case 'round-start': case 'round-end': case 'round-rerun': case 'run-paused': case 'run-resumed': case 'run-waiting': case 'run-interrupted': case 'run-stop': return runEventText(event.code, a);
    default: return event.text || String(event.code || '');
  }
}

const LEVEL = { step: 'step', warn: 'warn', error: 'warn', done: 'done', info: 'info' };
const sameStep = (a, b) => a.kind === b.kind && (a.file ?? '') === (b.file ?? '') && (a.part ?? null) === (b.part ?? null);
const AUDIO_KINDS = new Set(['transcribe', 'proofread', 'translate']);

/**
 * What came of a failed call. The later calls of the same step (same kind, file and part) are its retries (only a rate limit is retried by itself).
 * With none, say so and say how the learner goes on: questions that did not get written are added by hand with 补题, an audio import continues with 接着做.
 */
export function retryNote(call, calls) {
  const later = (calls || []).filter((other) => other !== call && other.kind !== 'wait' && sameStep(call, other) && Date.parse(other.startedAt) > Date.parse(call.startedAt))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  if (!later.length) return joinMeta([ui('没有自动重试'), AUDIO_KINDS.has(call.kind) ? ui('可点「接着做」补上') : ui('缺的题请在草稿里点「补题」')]);
  const last = later[later.length - 1], times = later.length > 1 ? uiFormat('已重试 {0} 次', [later.length]) : ui('已重试');
  if (last.status === 'running' || last.status === 'waiting') return ui('重试中');
  if (last.status === 'ok') return later.length > 1 ? uiFormat('已重试 {0} 次，成功', [later.length]) : ui('已重试，成功');
  if (last.status === 'cancelled') return uiFormat('{0}，已停止', [times]);
  return uiFormat('已重试 {0} 次，仍失败', [later.length]);
}
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
    const failed = call.status === 'failed';
    lines.push({ id: `call:${call.callId}`, at: call.endedAt, level: call.status === 'ok' ? 'step' : failed ? 'warn' : 'info', kind: 'call', tag: call.kind,
      text: joinMeta([`${callLabel(call, { file: true })} ${CALL_STATUS(call.status)}`.trim(), took,
        call.reused ? ui('音频内容和转写设置与之前相同') : '',
        failed && call.error ? uiFormat('原因：{0}', [callErrorText(call.error)]) : '', failed ? retryNote(call, contract.calls) : '']) });
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
