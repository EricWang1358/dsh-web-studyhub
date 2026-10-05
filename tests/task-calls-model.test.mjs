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

const laneBars = (view, key) => view.lanes.find((lane) => lane.key === key)?.bars.map((bar) => bar.callId);

test('an audio import has one lane per FILE, each file reading as its own story from left to right', () => {
  const calls = [
    call('a1', 'transcribe', 0, 20, { runner: 'gemini', file: 'a.wav' }), call('b1', 'transcribe', 5, 30, { runner: 'gemini', file: 'b.mp3' }),
    call('a2', 'proofread', 21, 40, { slot: 2, part: 1, parts: 2, file: 'a.wav' }), call('b2', 'proofread', 31, 50, { slot: 1, part: 1, parts: 2, file: 'b.mp3' }),
    call('a3', 'translate', 41, null, { slot: 2, part: 1, parts: 1, file: 'a.wav' })];
  const view = m.timelineModel(calls, { now: ms(60), running: true });
  assert.deepEqual(view.lanes.map((lane) => [lane.key, lane.kind, lane.file]), [['file:a.wav', 'file', 'a.wav'], ['file:b.mp3', 'file', 'b.mp3']], 'files in the order they began, no slot lanes');
  assert.deepEqual(laneBars(view, 'file:a.wav'), ['a1', 'a2', 'a3'], 'transcription, proofreading, translation of one file in order');
  assert.deepEqual(laneBars(view, 'file:b.mp3'), ['b1', 'b2']);
  const bars = view.lanes[0].bars;
  assert.ok(bars[0].left < bars[1].left && bars[1].left < bars[2].left, 'the order on the lane is the order of the work');
  assert.equal(bars[1].slot, 2, 'a bar knows the slot it ran in');
  assert.equal(view.hiddenLanes, 0);
  assert.ok(view.lanes.every((lane) => lane.bars.every((bar) => bar.left >= 0 && bar.left + bar.width <= 100.001 && bar.width > 0)), 'every bar sits inside the chart');
  const running = bars.find((bar) => bar.callId === 'a3');
  assert.equal(running.running, true);
  assert.ok(Math.abs(running.left + running.width - 100) < 0.01, 'a running call reaches the right edge: now');
  const titled = m.timelineModel([...calls, call('t', 'title', 52, 55)], { now: ms(60), running: false });
  assert.equal(titled.lanes[0].key, 'whole', 'a call of no file goes to the 整体 lane, first');
});

test('a question run has one lane per PART, with a 整体 lane for what belongs to the whole run', () => {
  const calls = [
    call('plan', 'plan', 0, 10), call('bp2', 'blueprint', 11, 20, { slot: 2, part: 2, parts: 2 }), call('bp1', 'blueprint', 11, 22, { slot: 1, part: 1, parts: 2 }),
    call('au1', 'author', 23, 40, { slot: 1, part: 1, parts: 2 }), call('rv1', 'review', 41, 50, { slot: 2, part: 1, parts: 2 }), call('pub', 'publish', 51, 52)];
  const view = m.timelineModel(calls, { now: ms(60), running: false });
  assert.deepEqual(view.lanes.map((lane) => [lane.key, lane.kind, lane.part ?? null]), [['whole', 'whole', null], ['part:1', 'part', 1], ['part:2', 'part', 2]], '整体 first, then parts by number');
  assert.deepEqual(laneBars(view, 'whole'), ['plan', 'pub']);
  assert.deepEqual(laneBars(view, 'part:1'), ['bp1', 'au1', 'rv1'], 'one part: its blueprint, then its question, then its review');
  assert.deepEqual(laneBars(view, 'part:2'), ['bp2']);
});

test('calls with neither a file nor a part fall back to the slot lanes: one per slot, transcription apart, the rest in one lane', () => {
  const calls = [
    call('t1', 'transcribe', 0, 20, { runner: 'gemini' }), call('t2', 'transcribe', 10, 40, { runner: 'gemini' }),
    call('a', 'prep', 5, 15, { slot: 1 }), call('b', 'prep', 6, 18, { slot: 2 }),
    call('w', 'wait', 18, 20, { slot: 2, status: 'ok', reason: 'rate-limit' }), call('c', 'prep', 20, null, { slot: 1 }), call('title', 'title', 0, 3)];
  const view = m.timelineModel(calls, { now: ms(30), running: true });
  assert.deepEqual(view.lanes.map((lane) => lane.key), ['transcribe-1', 'transcribe-2', 'slot-1', 'slot-2', 'other-1'], 'two transcriptions overlap: two lanes; then the slots in order');
  assert.deepEqual(view.lanes.find((lane) => lane.key === 'slot-2').bars.map((bar) => [bar.callId, bar.wait]), [['b', false], ['w', true]], 'a wait is dashed in the slot that was refused');
  const many = Array.from({ length: 40 }, (_, index) => call(`s${index}`, 'prep', 0, 3, { slot: index + 1 }));
  assert.ok(m.timelineModel(many, { now: ms(5), running: false }).lanes.length <= 12);
});

test('a rate-limit wait is drawn in the lane of the unit whose call used that slot then; with none, in an 其他 lane', () => {
  const calls = [
    call('a', 'proofread', 0, 18, { slot: 1, part: 1, parts: 2, file: 'a.wav' }), call('b', 'proofread', 0, 18, { slot: 2, part: 1, parts: 2, file: 'b.wav' }),
    call('w2', 'wait', 18, 22, { slot: 2, status: 'ok', reason: 'rate-limit' }), call('b2', 'proofread', 22, 30, { slot: 2, part: 1, parts: 2, file: 'b.wav' }),
    call('lost', 'wait', 40, 44, { slot: 7, status: 'ok', reason: 'rate-limit' })];
  const view = m.timelineModel(calls, { now: ms(50), running: false });
  assert.deepEqual(laneBars(view, 'file:a.wav'), ['a'], 'slot 2 was not a.wav');
  assert.deepEqual(laneBars(view, 'file:b.wav'), ['b', 'w2', 'b2'], 'the wait sits between the refused call and its retry, on the same file');
  assert.equal(view.lanes.find((lane) => lane.key === 'file:b.wav').bars[1].wait, true);
  assert.deepEqual(view.lanes.map((lane) => lane.key), ['file:a.wav', 'file:b.wav', 'other'], 'a wait no call can claim goes to 其他, last');
  assert.deepEqual(laneBars(view, 'other'), ['lost']);
});

test('calls of one unit that overlap in time never sit on top of each other: they get an extra lane of the same unit', () => {
  const calls = [call('w1', 'translate', 0, 30, { slot: 1, part: 1, parts: 3, file: 'a.wav' }), call('w2', 'translate', 5, 35, { slot: 2, part: 2, parts: 3, file: 'a.wav' }),
    call('w3', 'translate', 31, 40, { slot: 1, part: 3, parts: 3, file: 'a.wav' }), call('x', 'translate', 0, 10, { slot: 3, part: 1, parts: 3, file: 'b.wav' })];
  const view = m.timelineModel(calls, { now: ms(50), running: false });
  assert.deepEqual(view.lanes.map((lane) => [lane.key, lane.row]), [['file:a.wav', 1], ['file:a.wav~2', 2], ['file:b.wav', 1]]);
  assert.deepEqual(laneBars(view, 'file:a.wav'), ['w1', 'w3'], 'the first row takes what fits after the previous bar');
  assert.deepEqual(laneBars(view, 'file:a.wav~2'), ['w2']);
  for (const lane of view.lanes) for (let i = 1; i < lane.bars.length; i++) assert.ok(lane.bars[i].left >= lane.bars[i - 1].left + lane.bars[i - 1].width - 0.001, 'no overlap inside a row');
  assert.equal(view.lanes.find((lane) => lane.key === 'file:a.wav~2').file, 'a.wav', 'the extra lane is still that file');
});

test('a reused transcript is a visible, selectable transcription bar at the start of its file lane (at least 1.5% wide)', () => {
  const calls = [call('r', 'transcribe', 0, 0, { runner: 'saved', reused: true, part: 1, parts: 3, file: 'a.wav' }), call('p', 'proofread', 0, 20, { slot: 1, part: 1, parts: 2, file: 'a.wav' }),
    call('n', 'transcribe', 5, 30, { runner: 'gemini', file: 'b.wav' })];
  const view = m.timelineModel(calls, { now: ms(60), running: false });
  const lane = view.lanes.find((one) => one.key === 'file:a.wav');
  assert.deepEqual(lane.bars.map((bar) => bar.callId), ['r', 'p'], 'in its own file lane, first');
  const bar = lane.bars[0];
  assert.equal(bar.kind, 'transcribe', 'coloured like a transcription');
  assert.ok(bar.width >= 1.5 && bar.left + bar.width <= 100.001, `width ${bar.width}`);
  assert.equal(bar.label, '转写 1/3 · 复用 · a.wav');
  assert.ok(view.lanes.find((one) => one.key === 'file:b.wav').bars[0].width > 1.5, 'a real call is as wide as it ran');
  const late = m.timelineModel([call('r', 'transcribe', 50, 50, { reused: true, file: 'a.wav' }), call('x', 'proofread', 0, 50, { file: 'b.wav' })], { now: ms(60), running: false });
  assert.ok(late.lanes[0].bars[0].left + late.lanes[0].bars[0].width <= 100.001, 'at the right edge it still fits inside the chart');
});

test('at most 24 lanes: the most recently active units stay, and the model says how many more there are', () => {
  const calls = Array.from({ length: 30 }, (_, index) => call(`f${index}`, 'proofread', index * 10, index * 10 + 8, { file: `f${index}.wav`, part: 1, parts: 1 }));
  const view = m.timelineModel(calls, { now: ms(305), running: true });
  assert.equal(view.lanes.length, 24);
  assert.equal(view.hiddenLanes, 6);
  assert.deepEqual(view.lanes.map((lane) => lane.file), Array.from({ length: 24 }, (_, index) => `f${index + 6}.wav`), 'the newest 24, still in the order they began');
  const running = m.timelineModel([...calls.slice(0, 29), call('live', 'proofread', 0, null, { file: 'f0.wav', part: 1, parts: 1 })], { now: ms(305), running: true });
  assert.ok(running.lanes.some((lane) => lane.file === 'f0.wav'), 'a unit with a call in flight is never the one dropped');
  assert.equal(m.timelineModel(many(3), { now: ms(5), running: false }).hiddenLanes, 0);
  function many(n) { return Array.from({ length: n }, (_, index) => call(`s${index}`, 'proofread', 0, 3, { file: `f${index}` })); }
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
  const files = m.timelineModel([call('a', 'proofread', 0, 30, { file: 'a.wav' }), call('b', 'proofread', 1500, 1530, { file: 'b.wav' })], { now: ms(1560), running: true });
  assert.deepEqual(files.lanes.map((lane) => lane.file), ['b.wav'], 'a unit with nothing inside the window has no lane');
});

test('a long file name is shortened in the middle (the whole name is the lane title), the extension kept', () => {
  assert.equal(m.shortFile('a.wav'), 'a.wav');
  const short = m.shortFile('Lecture 03 - Probability and Statistics (recording).mp3');
  assert.ok(short.length <= 24 && short.endsWith('.mp3') && short.includes('…'), short);
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

test('a failed call says why and what came of it: retried and then fine, still failing, retrying now, or not retried and how to go on (2.6.1)', () => {
  const failed = (id, from, to, extra = {}) => call(id, 'blueprint', from, to, { status: 'failed', error: '模型请求太频繁，被限流了', ...extra });
  const lineOf = (calls, status, id) => m.logLines({ calls, status, events: [] }, 'all').find((line) => line.id === `call:${id}`);
  const recovered = [failed('a', 0, 2), call('b', 'blueprint', 3, 9)];
  assert.match(lineOf(recovered, 'running', 'a').text, /失败/);
  assert.match(lineOf(recovered, 'running', 'a').text, /模型请求太频繁/, 'the reason is on the line');
  assert.match(lineOf(recovered, 'running', 'a').text, /已重试.*成功/, 'a later call of the same step finished');
  const still = [failed('a', 0, 2), failed('b', 3, 5)];
  assert.match(lineOf(still, 'running', 'a').text, /已重试 1 次.*仍失败/);
  assert.match(lineOf([failed('a', 0, 2), call('b', 'blueprint', 3, null)], 'running', 'a').text, /重试中/);
  assert.match(lineOf([failed('a', 0, 2)], 'running', 'a').text, /没有自动重试/, 'only a rate limit is retried by itself: nothing after it means no retry');
  assert.match(lineOf([failed('a', 0, 2)], 'failed', 'a').text, /缺的题请在草稿里点「补题」/, 'a question run says how to go on: 补题 by hand');
  assert.match(lineOf([failed('a', 0, 2, { kind: 'proofread' })], 'failed', 'a').text, /接着做/, 'an audio import goes on with 接着做');
  const parts = [failed('a', 0, 2, { part: 1, parts: 2, stepKey: 'blueprint:1' }), call('b', 'blueprint', 3, 9, { part: 2, parts: 2, stepKey: 'blueprint:2' })];
  assert.match(lineOf(parts, 'failed', 'a').text, /没有自动重试/, 'another part finishing is not a retry of this one');
  assert.doesNotMatch(lineOf([call('ok', 'blueprint', 0, 5)], 'running', 'ok').text, /重试/, 'a call that went well says nothing about retries');
  assert.doesNotMatch(lineOf([failed('a', 0, 2, { error: undefined })], 'failed', 'a').text, /undefined|原因/, 'no reason recorded: nothing is invented');
});

test('a reused transcript is a transcription call called 复用, with the log saying why (2.6.1)', () => {
  const reused = call('t', 'transcribe', 0, 0, { runner: 'saved', reused: true, part: 1, parts: 3, file: 'a.mp3' });
  assert.equal(m.callLabel(reused), '转写 1/3 · 复用');
  assert.equal(m.runnerLabel(reused), '已保存的转写');
  assert.equal(m.outputMode(call('t', 'transcribe', 0, null, { runner: 'saved', reused: true })), 'none');
  const line = m.logLines({ calls: [reused], events: [] }, 'all')[0];
  assert.match(line.text, /转写 1\/3 · 复用/);
  assert.match(line.text, /音频内容和转写设置与之前相同/, 'the line says why it was reused');
  assert.equal(line.level, 'step');
});
