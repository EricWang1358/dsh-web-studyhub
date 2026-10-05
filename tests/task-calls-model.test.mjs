import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

// WP-TC: what the console's panels are drawn from. The timeline's lanes and bars, the running list, the log's lines: plain functions over the contract.
const m = await loadUi(`
  export * from './ui/tasks/call-model.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const at = (seconds) => new Date(Date.UTC(2026, 9, 5, 10, 0, seconds)).toISOString();
const ms = (seconds) => Date.UTC(2026, 9, 5, 10, 0, seconds);
const call = (callId, kind, from, to, extra = {}) => ({ callId, jobId: 'j', stepKey: kind, kind, stage: null, slot: null, startedAt: at(from), endedAt: to === null ? null : at(to),
  status: to === null ? 'running' : 'ok', runner: null, childId: null, parentId: null, part: null, parts: null, reasoning: null, tokens: null, ...extra });

test('the timeline has one lane per slot, transcription in its own lane(s), and a wait dashed in the lane that was refused', () => {
  const calls = [
    call('t1', 'transcribe', 0, 20, { runner: 'gemini' }), call('t2', 'transcribe', 10, 40, { runner: 'gemini' }),
    call('a', 'proofread', 5, 15, { slot: 1, part: 1, parts: 3 }), call('b', 'proofread', 6, 18, { slot: 2, part: 2, parts: 3 }),
    call('w', 'wait', 18, 20, { slot: 2, status: 'ok', reason: 'rate-limit' }), call('c', 'translate', 20, null, { slot: 1, part: 1, parts: 2 })];
  const view = m.timelineModel(calls, { now: ms(30), running: true });
  assert.deepEqual(view.lanes.map((lane) => lane.key), ['transcribe-1', 'transcribe-2', 'slot-1', 'slot-2'], 'two transcriptions overlap: two lanes; then the slots in order');
  const slot2 = view.lanes.find((lane) => lane.key === 'slot-2');
  assert.deepEqual(slot2.bars.map((bar) => [bar.callId, bar.wait]), [['b', false], ['w', true]]);
  assert.ok(view.lanes.every((lane) => lane.bars.every((bar) => bar.left >= 0 && bar.left + bar.width <= 100.001 && bar.width > 0)), 'every bar sits inside the chart');
  const running = view.lanes.find((lane) => lane.key === 'slot-1').bars.find((bar) => bar.callId === 'c');
  assert.equal(running.running, true);
  assert.ok(Math.abs(running.left + running.width - 100) < 0.01, 'a running call reaches the right edge: now');
});

test('the window is the last ten minutes of a running job, the whole run of a finished one, and never shorter than a minute', () => {
  const long = [call('a', 'proofread', 0, 30, { slot: 1 }), call('b', 'proofread', 1500, 1530, { slot: 1 })];
  const running = m.timelineModel(long, { now: ms(1560), running: true });
  assert.equal(running.windowMs, 10 * 60 * 1000);
  assert.deepEqual(running.lanes[0].bars.map((bar) => bar.callId), ['b'], 'what ended before the window is not drawn');
  const done = m.timelineModel(long, { now: ms(9000), running: false });
  assert.equal(done.windowMs, 10 * 60 * 1000, 'ten minutes at most, ending with the run');
  const short = m.timelineModel([call('a', 'proofread', 0, 5, { slot: 1 })], { now: ms(6), running: false });
  assert.equal(short.windowMs, 60 * 1000);
  assert.equal(m.timelineModel([], { now: ms(0), running: true }).lanes.length, 0);
});

test('calls that belong to no lane (a title) go to a lane of their own; the number of lanes is bounded', () => {
  const view = m.timelineModel([call('t', 'title', 0, 3), call('s', 'proofread', 0, 3, { slot: 1 })], { now: ms(5), running: false });
  assert.deepEqual(view.lanes.map((lane) => lane.key), ['slot-1', 'other-1']);
  const many = Array.from({ length: 40 }, (_, index) => call(`s${index}`, 'proofread', 0, 3, { slot: index + 1 }));
  assert.ok(m.timelineModel(many, { now: ms(5), running: false }).lanes.length <= 12);
});

test('the running list is the calls in flight and the waits, the newest first, each with what it is and who runs it', () => {
  const calls = [call('a', 'proofread', 0, null, { part: 6, parts: 9, runner: 'subagent', reasoning: 'high', childId: 'child', file: 'a.wav' }), call('b', 'transcribe', 5, null, { runner: 'gemini' }),
    call('done', 'proofread', 0, 9), call('w', 'wait', 8, null, { status: 'waiting', reason: 'rate-limit' })];
  const rows = m.runningCalls(calls);
  assert.deepEqual(rows.map((row) => row.callId), ['w', 'b', 'a']);
  assert.equal(m.callLabel(calls[0]), '校对 6/9');
  assert.equal(m.callLabel(calls[0], { file: true }), '校对 6/9 · a.wav');
  assert.equal(m.runnerLabel(calls[0]), 'DSH 子代理 · 推理 高');
  assert.equal(m.runnerLabel(calls[1]), 'Gemini');
  assert.equal(m.runnerLabel(call('x', 'author', 0, null)), '');
  assert.equal(m.callLabel(calls[3]), '限流等待');
});

test('what a call can show: a sub-agent streams, a Gemini request does not, a finished call keeps nothing', () => {
  assert.equal(m.outputMode(call('a', 'proofread', 0, null, { runner: 'subagent' })), 'stream');
  assert.equal(m.outputMode(call('a', 'proofread', 0, null, { runner: 'direct' })), 'stream');
  assert.equal(m.outputMode(call('a', 'author', 0, null)), 'stream', 'unknown until it says: asking is free');
  assert.equal(m.outputMode(call('t', 'transcribe', 0, null, { runner: 'gemini' })), 'none');
  assert.equal(m.outputMode(call('a', 'proofread', 0, 9, { runner: 'subagent' })), 'ended');
  assert.equal(m.outputMode(null), 'idle');
});

const event = (seconds, level, code, extra = {}) => ({ id: `e${seconds}${code}`, at: at(seconds), level, tag: null, code, args: null, ...extra });

test('the log: newest first, the producer\'s events and one line per finished call, with level filters', () => {
  const contract = { calls: [call('a', 'proofread', 0, 41, { part: 5, parts: 9 }), call('b', 'transcribe', 2, 3, { status: 'failed' })], events: [
    event(10, 'warn', 'rate-limit', { args: { slot: 2, seconds: 10 } }), event(5, 'done', 'milestone', { tag: 'transcribe', args: { phase: 'transcribe', partial: false } }), event(1, 'info', 'control', { args: { changed: { textConcurrency: 4 } } }) ] };
  const all = m.logLines(contract, 'all');
  assert.deepEqual(all.map((line) => line.kind), ['call', 'rate-limit', 'milestone', 'call', 'control'], 'newest first');
  assert.equal(all[0].at, at(41), 'a finished call is a line at the moment it ended');
  assert.match(all[0].text, /校对 5\/9/);
  assert.match(all[0].text, /41 秒/);
  assert.equal(all.find((line) => line.kind === 'rate-limit').level, 'warn');
  assert.deepEqual(m.logLines(contract, 'warn').map((line) => line.kind), ['rate-limit', 'call'], 'a failed call is a warning too');
  assert.deepEqual(m.logLines(contract, 'done').map((line) => line.kind), ['milestone']);
  assert.deepEqual(m.logLines(contract, 'step').map((line) => line.kind), ['call'], 'steps are the calls that went well');
  const counts = m.logCounts(contract);
  assert.deepEqual(counts, { all: 5, step: 1, warn: 2, done: 1 });
});

test('a warning that repeats is ONE line with how many times, never a wall of the same sentence', () => {
  const same = '文件扩展名是 .mp3，实际内容是 WAV 格式，已按 WAV 处理';
  const contract = { calls: [], events: [event(1, 'warn', 'warning', { text: same, file: 'a.mp3' }), event(2, 'warn', 'warning', { text: same, file: 'b.mp3' }), event(3, 'warn', 'warning', { text: same, file: 'c.mp3' }),
    event(4, 'warn', 'warning', { text: '另一条' })] };
  const lines = m.logLines(contract, 'all');
  assert.equal(lines.length, 2);
  const grouped = lines.find((line) => line.text.includes('WAV'));
  assert.equal(grouped.count, 3);
  assert.match(grouped.text, /×3|3 个/);
  assert.equal(JSON.stringify(grouped).includes('a.mp3'), false, 'the files are marked on their own rows, not listed here');
});

test('English wording of the log and of the labels', () => {
  m.setUiLanguage('en');
  try {
    assert.equal(m.callLabel(call('a', 'proofread', 0, null, { part: 6, parts: 9 })), 'Proofreading 6/9');
    assert.match(m.eventText(event(1, 'warn', 'rate-limit', { args: { slot: 2, seconds: 10 } })), /Slot 2.*10 s|rate limit/i);
    assert.match(m.eventText(event(1, 'info', 'concurrency', { args: { from: 3, to: 2, limit: 3 } })), /3.*2/);
  } finally { m.setUiLanguage('zh'); }
});
