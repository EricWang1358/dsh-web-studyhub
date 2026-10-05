import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEEP_ENDED, OUTPUT_LIMIT, createOutputStore, tapChildStream } from '../lib/job-output.js';
import { StudyService } from '../lib/service.js';
import { withQualityStages } from './helpers/assessment.mjs';
import { settleJob, until } from './helpers/wait.mjs';

// WP-TC step 4: the live output of a running call. An in-memory ring buffer, never persisted, dropped when the call ends; the reader asks for what is new.

test('the buffer keeps the last OUTPUT_LIMIT characters of a call and counts everything it was given', () => {
  assert.equal(OUTPUT_LIMIT, 8192);
  const store = createOutputStore();
  store.open('job', 'call');
  store.append('job', 'call', 'a'.repeat(5000));
  store.append('job', 'call', 'b'.repeat(5000));
  const read = store.read('job', 'call', 0);
  assert.equal(read.total, 10000);
  assert.equal(read.text.length, OUTPUT_LIMIT, 'bounded');
  assert.equal(read.text, ('a'.repeat(5000) + 'b'.repeat(5000)).slice(-OUTPUT_LIMIT));
  assert.equal(read.reset, true, 'the reader asked from the start but the start is gone: it gets the tail and is told');
  assert.equal(read.next, 10000);
  for (let index = 0; index < 50; index++) store.append('job', 'call', 'c'.repeat(1000));
  assert.ok(store.size('job', 'call') <= OUTPUT_LIMIT, 'never more than the limit however much is written');
});

test('since: only the new text comes back, once', () => {
  const store = createOutputStore();
  store.open('j', 'c');
  assert.deepEqual(store.read('j', 'c', 0), { text: '', next: 0, total: 0, reset: false, reasoning: 0 });
  store.append('j', 'c', 'Hello ');
  const first = store.read('j', 'c', 0);
  assert.deepEqual([first.text, first.next, first.reset], ['Hello ', 6, false]);
  store.append('j', 'c', 'world');
  const second = store.read('j', 'c', first.next);
  assert.deepEqual([second.text, second.next, second.reset], ['world', 11, false]);
  const third = store.read('j', 'c', second.next);
  assert.deepEqual([third.text, third.next], ['', 11], 'nothing new, nothing repeated');
  const future = store.read('j', 'c', 99);
  assert.deepEqual([future.text, future.reset], ['Hello world', true], 'a cursor from the future (a reader of another buffer) gets the tail and is told to replace');
  assert.equal(store.read('j', 'c', -5).text, 'Hello world', 'a nonsense cursor reads from the start');
});

test('reasoning is counted, never kept; closing a call KEEPS its text as ended (2.6.1); a late delta is dropped; a job can be dropped', () => {
  const store = createOutputStore();
  store.open('j', 'a'); store.open('j', 'b'); store.open('k', 'c');
  store.reasoning('j', 'a', 40);
  store.append('j', 'a', 'answer');
  assert.equal(store.read('j', 'a', 0).reasoning, 40);
  assert.equal(store.read('j', 'a', 0).text, 'answer');
  assert.equal(store.read('j', 'a', 0).ended, undefined, 'a running call is not marked ended');
  store.close('j', 'a');
  const kept = store.read('j', 'a', 0);
  assert.deepEqual([kept.text, kept.ended, kept.reasoning, kept.next, kept.reset], ['answer', true, 40, 6, false], 'a finished call keeps its tail, marked ended');
  store.append('j', 'a', 'late text after the end');
  assert.equal(store.read('j', 'a', 0).text, 'answer', 'text that arrives after the end is dropped, not appended');
  assert.equal(store.wasOpened('j', 'a'), true);
  store.dropJob('j');
  assert.equal(store.read('j', 'b', 0), null);
  assert.equal(store.read('j', 'a', 0), null, 'dropJob is the hard removal of everything the job has');
  assert.notEqual(store.read('k', 'c', 0), null, 'another job is untouched');
});

test('endJob: the calls of a job that are still open end with it and keep their text; calls that already ended are untouched', () => {
  const store = createOutputStore();
  store.open('j', 'a'); store.open('j', 'b'); store.open('k', 'c');
  store.append('j', 'a', 'one'); store.append('j', 'b', 'two'); store.append('k', 'c', 'three');
  store.close('j', 'a');
  store.endJob('j');
  assert.deepEqual([store.read('j', 'a', 0).text, store.read('j', 'a', 0).ended], ['one', true]);
  assert.deepEqual([store.read('j', 'b', 0).text, store.read('j', 'b', 0).ended], ['two', true]);
  assert.equal(store.read('k', 'c', 0).ended, undefined, 'another job keeps running');
  store.append('j', 'b', 'late');
  assert.equal(store.read('j', 'b', 0).text, 'two');
});

test('finished calls are kept in memory, at most KEEP_ENDED of them (the oldest finished goes first); running buffers have their own bound', () => {
  assert.equal(KEEP_ENDED, 60);
  const store = createOutputStore({ keepEnded: 3, maxCalls: 3 });
  for (let index = 0; index < 6; index++) { store.open('j', `c${index}`); store.append('j', `c${index}`, `text ${index}`); store.close('j', `c${index}`); }
  assert.equal(store.endedCount(), 3);
  assert.equal(store.read('j', 'c2', 0), null, 'older than the last three finished: gone');
  assert.equal(store.read('j', 'c3', 0).text, 'text 3');
  assert.equal(store.read('j', 'c5', 0).text, 'text 5');
  assert.equal(store.wasOpened('j', 'c0'), true, 'it was opened once, so a reader can tell "ended, nothing kept" from "never streamed"');
  assert.equal(store.wasOpened('j', 'never'), false);
  // finished calls never push running ones out
  store.open('j', 'r1'); store.open('j', 'r2');
  for (let index = 6; index < 12; index++) { store.open('x', `d${index}`); store.close('x', `d${index}`); }
  assert.notEqual(store.read('j', 'r1', 0), null);
  assert.notEqual(store.read('j', 'r2', 0), null);
});

test('a finished call is capped like a running one: at most OUTPUT_LIMIT characters are kept, and the total says how much was written', () => {
  const store = createOutputStore();
  store.open('j', 'c');
  for (let index = 0; index < 5; index++) store.append('j', 'c', 'z'.repeat(5000));
  store.close('j', 'c');
  const read = store.read('j', 'c', 0);
  assert.equal(read.text.length, OUTPUT_LIMIT);
  assert.equal(read.total, 25000);
  assert.deepEqual([read.reset, read.ended], [true, true], 'from the start, but the start is gone: the tail, and the reader is told to replace');
});

test('the cursor protocol works on an ended call: read it once from 0, then nothing new', () => {
  const store = createOutputStore();
  store.open('j', 'c'); store.append('j', 'c', 'Hello '); store.append('j', 'c', 'world'); store.close('j', 'c');
  const first = store.read('j', 'c', 0);
  assert.deepEqual([first.text, first.next, first.reset, first.ended], ['Hello world', 11, false, true]);
  const again = store.read('j', 'c', first.next);
  assert.deepEqual([again.text, again.next, again.reset, again.ended], ['', 11, false, true]);
  const partway = store.read('j', 'c', 6);
  assert.equal(partway.text, 'world', 'a reader that stopped halfway gets the rest');
});

test('the number of buffers is bounded too: a leak of never-closed calls cannot grow memory', () => {
  const store = createOutputStore({ maxCalls: 5 });
  for (let index = 0; index < 20; index++) { store.open('j', `c${index}`); store.append('j', `c${index}`, 'x'); }
  assert.equal(store.count(), 5);
  assert.equal(store.read('j', 'c0', 0), null, 'the oldest went first');
  assert.notEqual(store.read('j', 'c19', 0), null);
});

// ---- the sub-agent stream ----

function fakeHost() {
  const listeners = new Map();
  return { ctx: { on(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); return () => listeners.get(name).delete(listener); } },
    emit(name, payload) { for (const listener of [...(listeners.get(name) || [])]) listener(payload); }, count: (name) => listeners.get(name)?.size || 0 };
}
const frame = (chunk) => ({ type: 'chunk', attemptId: 'a:1', revision: 1, index: 0, time: 0, chunk });

test('the stream tap follows ONE sub-agent: its text deltas are the output, its reasoning only a count, other agents and other frames are ignored', () => {
  const host = fakeHost(), text = [], reasoning = [];
  const off = tapChildStream(host.ctx, 'child-1', { text: (value) => text.push(value), reasoning: (count) => reasoning.push(count) });
  assert.equal(host.count('agent/assistant-stream'), 1);
  host.emit('agent/assistant-stream', { agent: { id: 'child-1', session: { id: 'child-1' } }, frame: { type: 'start', attemptId: 'a:1', revision: 0 } });
  host.emit('agent/assistant-stream', { agent: { id: 'child-1', session: { id: 'child-1' } }, frame: frame({ type: 'text-delta', index: 0, text: '{"corr' }) });
  host.emit('agent/assistant-stream', { agent: { id: 'other', session: { id: 'other' } }, frame: frame({ type: 'text-delta', index: 0, text: 'NOT MINE' }) });
  host.emit('agent/assistant-stream', { agent: { id: 'child-1', session: { id: 'child-1' } }, frame: frame({ type: 'reasoning-delta', index: 1, text: 'thinking hard' }) });
  host.emit('agent/assistant-stream', { agent: { id: 'child-1', session: { id: 'child-1' } }, frame: frame({ type: 'tool-call-delta', index: 2, argumentsDelta: '{}' }) });
  host.emit('agent/assistant-stream', { agent: { id: 'child-1', session: { id: 'child-1' } }, frame: frame({ type: 'text-delta', index: 0, text: 'ections": []}' }) });
  assert.deepEqual(text, ['{"corr', 'ections": []}']);
  assert.deepEqual(reasoning, ['thinking hard'.length]);
  off();
  assert.equal(host.count('agent/assistant-stream'), 0, 'listening stops with the call');
  host.emit('agent/assistant-stream', { agent: { id: 'child-1', session: { id: 'child-1' } }, frame: frame({ type: 'text-delta', index: 0, text: 'late' }) });
  assert.equal(text.length, 2);
});

test('a host that cannot be listened to (no ctx.on, or one that throws) is not an error: that call simply has no live output', () => {
  assert.equal(typeof tapChildStream(undefined, 'c', { text() {} }), 'function');
  assert.equal(typeof tapChildStream({}, 'c', { text() {} }), 'function');
  assert.equal(typeof tapChildStream({ on() { throw new Error('nope'); } }, 'c', { text() {} }), 'function');
});

// ---- through the service ----

const source = { id: 'page-a', title: 'Book p.1', text: "Architecture includes the principles guiding a system's design and evolution over time." };
const card = (n) => ({ id: `q${n}`, kind: 'flashcard', topic: 'Architecture', objective: `Target ${n}`, prompt: `Question ${n}: what does the passage establish?`,
  answer: `Answer ${n}.`, hint: 'Think about scope.', explanation: 'The passage states it.', misconception: 'Confusing scope.', citations: [{ sourceId: source.id, quote: source.text }] });

test('job.output: a running generation call streams what the model writes, incrementally; when the call ends the same text can be read again (2.6.1)', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call('source.add', source);
  let release, started = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const inner = withQualityStages(async (system, prompt) => {
    if (system.includes('editor')) return JSON.stringify({ issues: [] });
    const request = JSON.parse(prompt.split('REQUEST DATA:\n')[1]);
    return JSON.stringify({ title: 'D', cards: Array.from({ length: request.count }, (_, index) => ({ ...card(index + 1), id: `n${index + 1}`, objective: `New ${index + 1}` })) });
  });
  service.complete = async (system, prompt, options) => {
    if (started++ === 0) {
      options.onOutput?.('{"targets": [');
      await gate;
      options.onOutput?.(']}');
    }
    return inner(system, prompt);
  };
  const job = await service.call('generate', { sourceIds: [source.id], count: 1, kind: 'flashcard' });
  await until(async () => ((await service.call('snapshot')).jobs.find((item) => item.id === job.jobId)?.contract.calls || []).some((call) => call.status === 'running'), 'a running call');
  const snapshot = (await service.call('snapshot')).jobs.find((item) => item.id === job.jobId);
  const call = snapshot.contract.calls.find((item) => item.status === 'running');
  const first = await service.call('job.output', { jobId: job.jobId, callId: call.callId, cursor: 0 });
  assert.equal(first.supported, true);
  assert.equal(first.live, true);
  assert.equal(first.text, '{"targets": [');
  assert.equal(first.nextCursor, 13);
  assert.deepEqual(first.retention, { unit: 'chars', limit: 8192, persisted: false, endedCalls: 60 }, 'the response says how long text is kept: in memory only, never persisted');
  assert.equal(first.truncated, false);
  const same = await service.call('job.output', { jobId: job.jobId, callId: call.callId, cursor: first.nextCursor });
  assert.equal(same.text, '', 'nothing new yet');
  release();
  await settleJob(service, job.jobId);
  const after = await service.call('job.output', { jobId: job.jobId, callId: call.callId, cursor: 0 });
  assert.equal(after.live, false);
  assert.equal(after.ended, true);
  assert.equal(after.retained, true);
  assert.equal(after.source, 'memory');
  assert.equal(after.text, '{"targets": []}', 'the text of a finished call is kept in memory and can be read again');
  assert.equal(after.truncated, false);
  assert.equal(after.nextCursor, 15);
  const nothingNew = await service.call('job.output', { jobId: job.jobId, callId: call.callId, cursor: after.nextCursor });
  assert.equal(nothingNew.text, '', 'a reader that already has it gets nothing again');
  assert.equal(nothingNew.ended, true);
  await assert.rejects(service.call('job.output', { jobId: job.jobId, callId: 'nope', cursor: 0 }), /call|Call/);
  await assert.rejects(service.call('job.output', { jobId: 'nope', callId: call.callId }), /not found|Study job/i);
  await assert.rejects(service.call('job.output', { jobId: job.jobId }), /callId/);
});

test('a call through the host model is opened for output before its first character, so the reader can tell it from one that cannot stream', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-output-quiet-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call('source.add', source);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  // This model writes nothing on the way; the call is still one that could.
  service.complete = async () => { await gate; throw new Error('stop'); };
  const job = await service.call('generate', { sourceIds: [source.id], count: 1, kind: 'flashcard' });
  await until(async () => ((await service.call('snapshot')).jobs.find((item) => item.id === job.jobId)?.contract.calls || []).some((call) => call.status === 'running'), 'a running call');
  const call = (await service.call('snapshot')).jobs.find((item) => item.id === job.jobId).contract.calls.find((item) => item.status === 'running');
  const reply = await service.call('job.output', { jobId: job.jobId, callId: call.callId, cursor: 0 });
  assert.equal(reply.live, true);
  assert.equal(reply.supported, true, 'a call through the host model is opened for output even before the first character');
  assert.equal(reply.text, '');
});
