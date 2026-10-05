import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { readSessionReply, SESSION_REPLY_LIMIT } from '../lib/session-reply.js';
import { withQualityStages } from './helpers/assessment.mjs';
import { settleJob, until } from './helpers/wait.mjs';

// 2.6.1: clicking a call that has ended shows what it wrote. The tail (about 8 KB) is kept in memory; a DSH sub-agent's full final reply is read from
// its session on demand when the tail is not the whole reply, or no tail is left. Never for a running call; an unreadable session is said, not thrown.

const assistant = (...blocks) => ({ type: 'assistant/message', data: { turn: 0, step: 0, message: { role: 'assistant', content: blocks }, stream: [] } });
const text = (value) => ({ type: 'text', text: value });
const toolCall = (name) => ({ type: 'tool-call', id: 't', name, input: {} });

function sessionStore(sessions) {
  const seen = [];
  let released = 0;
  return { seen, released: () => released, query: { observeSession: async (id) => {
    seen.push(id);
    const events = sessions[id];
    if (events instanceof Error) throw events;
    if (!events) throw new Error(`no session ${id}`);
    return { events, [Symbol.dispose]: () => { released++; } };
  } } };
}

// ---- the reader of a session ----

test('readSessionReply: the LAST assistant message that has text; tool-call-only and empty messages are skipped; the lease is released', async () => {
  const store = sessionStore({ c: [
    { type: 'user/message', data: {} },
    assistant(text('first reply')),
    assistant(text('{"issues": ['), text(']}')),
    assistant(toolCall('read')),
    assistant(),
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ] });
  const reply = await readSessionReply(store.query, 'c');
  assert.deepEqual(reply, { text: '{"issues": []}', clipped: false });
  assert.equal(store.released(), 1);
  assert.deepEqual(await readSessionReply(sessionStore({ c: [assistant(toolCall('x'))] }).query, 'c'), { text: '', clipped: false }, 'readable, but nothing was said');
});

test('readSessionReply: unreadable is null (not a throw): no query, no id, a session that is gone', async () => {
  assert.equal(await readSessionReply(undefined, 'c'), null);
  assert.equal(await readSessionReply({}, 'c'), null);
  assert.equal(await readSessionReply(sessionStore({}).query, ''), null);
  const store = sessionStore({ c: new Error('gone') });
  assert.equal(await readSessionReply(store.query, 'c'), null);
  assert.equal(await readSessionReply({ observeSession: async () => ({ get events() { throw new Error('torn'); }, [Symbol.dispose]() {} }) }, 'c'), null);
});

test('readSessionReply: bounded to the limit, from the start, and says it was clipped', async () => {
  assert.equal(SESSION_REPLY_LIMIT, 200 * 1024);
  const big = 'x'.repeat(SESSION_REPLY_LIMIT + 5000);
  const reply = await readSessionReply(sessionStore({ c: [assistant(text(big))] }).query, 'c');
  assert.equal(reply.text.length, SESSION_REPLY_LIMIT);
  assert.equal(reply.clipped, true);
  assert.equal(reply.text, big.slice(0, SESSION_REPLY_LIMIT));
  const small = await readSessionReply(sessionStore({ c: [assistant(text('abcdef'))] }).query, 'c', { limit: 4 });
  assert.deepEqual(small, { text: 'abcd', clipped: true });
});

// ---- through job.output ----

const source = { id: 'page-a', title: 'Book p.1', text: "Architecture includes the principles guiding a system's design and evolution over time." };
const card = (n) => ({ id: `q${n}`, kind: 'flashcard', topic: 'Architecture', objective: `Target ${n}`, prompt: `Question ${n}: what does the passage establish?`,
  answer: `Answer ${n}.`, hint: 'Think about scope.', explanation: 'The passage states it.', misconception: 'Confusing scope.', citations: [{ sourceId: source.id, quote: source.text }] });

/** A finished generation job whose calls are DSH sub-agents; call number n writes `written[n]` on the way and ran as child `child-n`. */
async function finishedJob(t, { sessions = {}, written = [], asChild = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-output-ended-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = sessionStore(sessions);
  const service = new StudyService(root, { sessionQuery: store.query });
  await service.call('source.add', source);
  const inner = withQualityStages(async (system, prompt) => {
    if (system.includes('editor')) return JSON.stringify({ issues: [] });
    const request = JSON.parse(prompt.split('REQUEST DATA:\n')[1]);
    return JSON.stringify({ title: 'D', cards: Array.from({ length: request.count }, (_, index) => ({ ...card(index + 1), id: `n${index + 1}`, objective: `New ${index + 1}` })) });
  });
  let number = 0;
  service.complete = async (system, prompt, options) => {
    const mine = number++;
    if (asChild) options.onEvent?.({ childId: `child-${mine}`, runtime: 'subagent' });
    if (written[mine]) options.onOutput?.(written[mine]);
    return inner(system, prompt);
  };
  const job = await service.call('generate', { sourceIds: [source.id], count: 1, kind: 'flashcard' });
  await settleJob(service, job.jobId);
  const snapshot = (await service.call('snapshot')).jobs.find((item) => item.id === job.jobId);
  return { service, store, jobId: job.jobId, calls: snapshot.contract.calls };
}

test('an ended call whose whole reply fit in the kept tail: the tail, from memory, and the session is not touched', async (t) => {
  const { service, store, jobId, calls } = await finishedJob(t, { written: ['{"targets": []}'], sessions: { 'child-0': [assistant(text('SESSION'))] } });
  const first = calls.find((call) => call.childId === 'child-0');
  const reply = await service.call('job.output', { jobId, callId: first.callId, cursor: 0 });
  assert.deepEqual([reply.live, reply.ended, reply.retained, reply.source, reply.text], [false, true, true, 'memory', '{"targets": []}']);
  assert.equal(reply.supported, true);
  assert.equal(reply.truncated, false);
  assert.equal(reply.nextCursor, 15);
  assert.equal(reply.partial, undefined, 'the tail is the whole reply');
  assert.deepEqual(reply.retention, { unit: 'chars', limit: 8192, persisted: false, endedCalls: 60 });
  assert.equal(store.seen.includes('child-0'), false, 'no session read when the memory has all of it');
});

test('an ended call whose reply was longer than the kept tail: the full final reply is read from the DSH session, and replaces what the reader has', async (t) => {
  const long = '{"plan": "' + 'a'.repeat(20000) + '"}';
  const { service, store, jobId, calls } = await finishedJob(t, { written: ['x'.repeat(20000)], sessions: { 'child-0': [assistant(text('draft')), assistant(text(long))] } });
  const first = calls.find((call) => call.childId === 'child-0');
  const reply = await service.call('job.output', { jobId, callId: first.callId, cursor: 0 });
  assert.deepEqual([reply.ended, reply.source, reply.text === long, reply.truncated, reply.retained], [true, 'session', true, true, true]);
  assert.equal(reply.nextCursor, 20000, 'the cursor still counts what was written');
  assert.equal(reply.sessionUnreadable, undefined);
  assert.deepEqual(store.seen.filter((id) => id === 'child-0'), ['child-0']);
  const again = await service.call('job.output', { jobId, callId: first.callId, cursor: reply.nextCursor });
  assert.equal(again.text, '', 'a reader that already read it is not given the session again');
  assert.equal(store.seen.filter((id) => id === 'child-0').length, 1, 'and the session is not read again for it');
});

test('an ended call with no tail left (older than the kept ones, or a restart) is read from its session; the reply is bounded', async (t) => {
  const huge = 'y'.repeat(SESSION_REPLY_LIMIT + 10);
  const { service, jobId, calls } = await finishedJob(t, { written: ['short'], sessions: { 'child-0': [assistant(text(huge))], 'child-1': [assistant(text('{"ok": true}'))] } });
  service.runtime.work.jobOutputs.dropJob(jobId);
  const first = await service.call('job.output', { jobId, callId: calls.find((call) => call.childId === 'child-0').callId, cursor: 0 });
  assert.deepEqual([first.ended, first.retained, first.source, first.supported], [true, false, 'session', true]);
  assert.equal(first.text.length, SESSION_REPLY_LIMIT);
  assert.equal(first.clipped, true, 'a reply longer than the bound says it was cut');
  const second = await service.call('job.output', { jobId, callId: calls.find((call) => call.childId === 'child-1').callId, cursor: 0 });
  assert.deepEqual([second.source, second.text, second.clipped], ['session', '{"ok": true}', undefined]);
});

test('an unreadable session is not an error: the reply says so, and keeps whatever tail there is', async (t) => {
  const { service, jobId, calls } = await finishedJob(t, { written: ['k'.repeat(20000), 'tiny'], sessions: { 'child-0': new Error('store busy') } });
  const long = await service.call('job.output', { jobId, callId: calls.find((call) => call.childId === 'child-0').callId, cursor: 0 });
  assert.deepEqual([long.ended, long.source, long.retained, long.partial, long.sessionUnreadable], [true, 'memory', true, true, true]);
  assert.equal(long.text.length, 8192, 'the kept tail is still shown');
  const none = await service.call('job.output', { jobId, callId: calls.find((call) => call.childId === 'child-1').callId, cursor: 0 });
  assert.equal(none.text, 'tiny', 'a short reply has nothing to look for in the session');
  service.runtime.work.jobOutputs.dropJob(jobId);
  const gone = await service.call('job.output', { jobId, callId: calls.find((call) => call.childId === 'child-0').callId, cursor: 0 });
  assert.deepEqual([gone.ended, gone.text, gone.source ?? null, gone.retained, gone.sessionUnreadable], [true, '', null, false, true]);
});

test('a call without a sub-agent (direct) that lost its tail has nothing to read: no session is tried', async (t) => {
  const { service, store, jobId, calls } = await finishedJob(t, { asChild: false, written: ['abc'], sessions: {} });
  service.runtime.work.jobOutputs.dropJob(jobId);
  const reply = await service.call('job.output', { jobId, callId: calls[0].callId, cursor: 0 });
  assert.deepEqual([reply.ended, reply.text, reply.supported, reply.retained, reply.sessionUnreadable], [true, '', true, false, undefined]);
  assert.deepEqual(store.seen, []);
});

test('the session is NEVER read for a running call', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-output-running-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = sessionStore({ 'child-0': [assistant(text('SESSION'))] });
  const service = new StudyService(root, { sessionQuery: store.query });
  await service.call('source.add', source);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  service.complete = async (system, prompt, options) => { options.onEvent?.({ childId: 'child-0', runtime: 'subagent' }); options.onOutput?.('x'.repeat(20000)); await gate; throw new Error('stop'); };
  const job = await service.call('generate', { sourceIds: [source.id], count: 1, kind: 'flashcard' });
  const running = await until(async () => ((await service.call('snapshot')).jobs.find((item) => item.id === job.jobId)?.contract.calls || []).find((call) => call.status === 'running' && call.childId === 'child-0'), 'a running sub-agent call');
  const reply = await service.call('job.output', { jobId: job.jobId, callId: running.callId, cursor: 0 });
  assert.deepEqual([reply.live, reply.ended, reply.source], [true, undefined, undefined]);
  assert.equal(reply.text.length, 8192);
  assert.deepEqual(store.seen, [], 'a running call is read from the live buffer only');
});
