import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CALLS, MAX_EVENTS, MAX_WAITS, unifyCall, jobCalls, recordEvent, recordWait, observeJob, failStep } from '../lib/job-calls.js';
import { snapshotJob } from '../lib/job-contract.js';
import { createPool } from '../lib/audio-pool.js';
import { generateBatched } from '../lib/batch.js';
import { qualityPlan, qualityReview } from './helpers/assessment.mjs';

// WP-TC step 2: every job records its model calls in ONE shape, in a bounded list, and exposes it on the job in the snapshot.

const at = (seconds) => new Date(Date.UTC(2026, 9, 5, 10, 0, seconds)).toISOString();

test('an audio task and a generation step become the same call shape', () => {
  const task = { id: 't1', kind: 'proofread', part: 6, parts: 9, stage: '校对 6/9', status: 'complete', runtime: 'subagent', childId: 'child-1', parentId: 'parent-1',
    slot: 2, startedAt: at(1), finishedAt: at(40), reasoning: 'high', inputChars: 5400, tokenUsage: { uncachedInputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 } };
  const call = unifyCall(task);
  assert.deepEqual(Object.keys(call).sort(), ['childId', 'endedAt', 'id', 'inputChars', 'kind', 'outputTokens', 'parentId', 'part', 'parts', 'reasoning', 'runner', 'slot', 'stage', 'startedAt', 'status', 'tokens'].sort());
  assert.equal(call.outputTokens, 100, "the provider's completion count rides along: 输出速度（TPS）divides it by the call's decode time");
  assert.equal(call.kind, 'proofread');
  assert.equal(call.status, 'ok');
  assert.equal(call.runner, 'subagent');
  assert.equal(call.endedAt, at(40));
  assert.equal(call.tokens, 1000);
  assert.equal(call.childId, 'child-1');
  // A call whose provider never reported usage says nothing about its output either; nothing is derived from the text.
  assert.equal('outputTokens' in unifyCall({ id: 'x', kind: 'proofread', status: 'complete', startedAt: at(1), finishedAt: at(2) }), false);
  assert.equal(unifyCall({ id: 'x', kind: 'proofread', status: 'complete', startedAt: at(1), tokenUsage: { uncachedInputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }).outputTokens, 0, 'zero output is a measurement, not a missing one');

  const step = { id: 's1', stage: 'Writing and self-checking questions', part: 2, status: 'running', startedAt: at(5), queuedMs: 1200, runtime: 'direct', slot: 1 };
  const generation = unifyCall(step);
  assert.equal(generation.kind, 'author', 'the stage prose names the stage');
  assert.equal(generation.status, 'running');
  assert.equal(generation.endedAt, null);
  assert.equal(generation.runner, 'direct');
  assert.equal(generation.slot, 1);
  assert.equal(unifyCall({ id: 'x', stage: 'Reviewing ambiguity and source support', status: 'failed', startedAt: at(1) }).kind, 'review');
  assert.equal(unifyCall({ id: 'x', stage: 'Repairing flagged questions within this run', status: 'cancelled', startedAt: at(1) }).status, 'cancelled');
  assert.equal(unifyCall({ id: 'x', kind: 'transcribe', status: 'starting', startedAt: at(1), runtime: 'gemini' }).status, 'running', 'starting and finishing are still running');
});

test('a rate-limit wait is a call of its own, dashed on the timeline', () => {
  const job = {};
  recordWait(job, { id: 'w1', phase: 'start', slot: 2, reason: 'rate-limit', ms: 2000, at: at(10) });
  assert.equal(jobCalls(job)[0].status, 'waiting');
  assert.equal(jobCalls(job)[0].kind, 'wait');
  recordWait(job, { id: 'w1', phase: 'end', at: at(12) });
  const [wait] = jobCalls(job);
  assert.equal(wait.status, 'ok');
  assert.equal(wait.endedAt, at(12));
  assert.equal(wait.reason, 'rate-limit');
  assert.equal(wait.slot, 2);
});

test('a batch job lists the calls of its files, oldest first, each knowing its file', () => {
  const job = { members: [
    { filename: 'a.mp3', tasks: [{ id: 'a1', kind: 'transcribe', status: 'complete', runtime: 'gemini', startedAt: at(1), finishedAt: at(9) }] },
    { filename: 'b.mp3', tasks: [{ id: 'b1', kind: 'proofread', status: 'running', startedAt: at(5), slot: 1 }, { id: 'b0', kind: 'transcribe', status: 'complete', startedAt: at(2), finishedAt: at(4), runtime: 'gemini' }] },
  ], waits: [{ id: 'w', kind: 'wait', reason: 'rate-limit', startedAt: at(6), endedAt: at(7), slot: 1 }] };
  const calls = jobCalls(job);
  assert.deepEqual(calls.map((call) => call.id), ['a1', 'b0', 'b1', 'w']);
  assert.equal(calls[0].file, 'a.mp3');
  assert.equal(calls[1].file, 'b.mp3');
  assert.equal(calls.at(-1).file, undefined, 'a wait belongs to the pool of the whole job');
});

test('the list is bounded: only the newest calls are kept, and waits and events have their own bounds', () => {
  const tasks = Array.from({ length: MAX_CALLS + 25 }, (_, index) => ({ id: `t${index}`, kind: 'proofread', status: 'complete', startedAt: new Date(Date.UTC(2026, 9, 5, 10, 0, index)).toISOString() }));
  const calls = jobCalls({ tasks });
  assert.equal(calls.length, MAX_CALLS);
  assert.equal(calls[0].id, 't25');
  assert.equal(calls.at(-1).id, `t${MAX_CALLS + 24}`);

  const job = {};
  for (let index = 0; index < MAX_WAITS + 10; index++) recordWait(job, { id: `w${index}`, phase: 'start', slot: 1, reason: 'rate-limit', at: at(index % 59) });
  assert.equal(job.waits.length, MAX_WAITS);
  assert.equal(job.waits[0].id, 'w10');

  const logged = {};
  for (let index = 0; index < MAX_EVENTS + 20; index++) recordEvent(logged, { level: 'info', code: 'note', text: `line ${index}` });
  assert.equal(logged.events.length, MAX_EVENTS);
  assert.equal(logged.events[0].text, 'line 20');
});

test('an event is a structured line: when, how serious, which stage, a code the UI translates, and its arguments', () => {
  const job = {};
  const event = recordEvent(job, { level: 'warn', tag: 'proofread', code: 'rate-limit', args: { slot: 2, seconds: 10, concurrency: 3 } });
  assert.deepEqual(Object.keys(event).sort(), ['args', 'at', 'code', 'id', 'level', 'tag']);
  assert.match(event.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(recordEvent(job, { level: 'nonsense', code: 'x' }).level, 'info', 'an unknown level reads as info');
});

test('watching a job notes a change of status or stage once, however often it is looked at', () => {
  const job = { id: 'j1', status: 'running', stage: 'Planning evidence and learning targets' };
  observeJob(job);
  observeJob(job);
  assert.equal(job.events.length, 1);
  job.stage = 'Writing and self-checking questions';
  observeJob(job);
  assert.equal(job.events.length, 2);
  assert.equal(job.events[1].code, 'stage');
  assert.equal(job.events[1].text, 'Writing and self-checking questions');
  job.status = 'complete';
  job.stage = 'Draft ready';
  observeJob(job);
  assert.equal(job.events.at(-1).level, 'done');
  assert.equal(job.events.at(-1).code, 'status');
});

test('the snapshot job carries calls and events; the chat tools never see them', () => {
  const job = { id: 'j', root: '/lib', status: 'running', tasks: [{ id: 't', kind: 'translate', status: 'running', startedAt: at(1) }], events: [{ id: 'e', at: at(1), level: 'info', code: 'note' }], waits: [] };
  const view = snapshotJob(job);
  assert.equal(view.contract.calls.length, 1);
  assert.equal(view.contract.events.length, 1);
  assert.equal('calls' in view, false, 'calls and events live in the contract, once');
  assert.equal('root' in view, false, 'the library path is never shown');
  assert.equal('waits' in view, false, 'waits are folded into the calls');
});

test('the audio pool gives each running window the lowest free slot, and reports a back-off as a wait', async () => {
  const slots = [], waits = [];
  const pool = createPool({ limit: 2, backoff: () => 1, onWait: (wait) => waits.push(wait) });
  let refused = false;
  const first = pool.run(async (attempt, slot) => { slots.push(['a', slot]); await new Promise((resolve) => setTimeout(resolve, 30)); return 'a'; });
  const second = pool.run(async (attempt, slot) => {
    slots.push(['b', slot]);
    if (!refused) { refused = true; throw Object.assign(new Error('429 too many requests'), { status: 429 }); }
    return 'b';
  });
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
  assert.deepEqual(slots.slice(0, 2), [['a', 1], ['b', 2]], 'slots count from 1');
  assert.equal(slots.filter(([name]) => name === 'b').length, 2, 'the refused window tried again');
  assert.ok(slots.every(([, slot]) => slot >= 1 && slot <= 2));
  assert.deepEqual(waits.map((wait) => wait.phase), ['start', 'end']);
  assert.equal(waits[0].reason, 'rate-limit');
  assert.equal(waits[0].id, waits[1].id);
  assert.equal(waits[0].slot, 2, 'the wait is drawn in the lane of the call that was refused');
});

test('every generation model call says which slot it ran in, and a 429 back-off is reported as a wait', async () => {
  const sources = [{ id: 's1', title: 'P', text: 'Section 1. Architecture includes the principles guiding a system design and evolution, number 1. '.repeat(2) }];
  const slotsSeen = [], waits = [];
  let limited = false;
  const complete = async (system, prompt, context = {}) => {
    slotsSeen.push(context.slot);
    if (!limited) { limited = true; throw new Error('429 Too Many Requests'); }
    const data = () => JSON.parse(prompt.split('REQUEST DATA:\n')[1]);
    if (system.startsWith('Plan a source-grounded assessment')) {
      const request = data();
      return JSON.stringify({ targets: qualityPlan({ ...request, kind: 'flashcard', sources: request.sources.slice(0, 1) }).targets });
    }
    throw new Error('stop here');
  };
  await assert.rejects(generateBatched(complete, { count: 3, kind: 'flashcard', sources, rateLimitBackoffMs: 1, performance: { concurrency: 2, batchSize: 3, fillRounds: 0 },
    onWait: (wait) => waits.push(wait) }));
  assert.ok(slotsSeen.length >= 2 && slotsSeen.every((slot) => Number.isInteger(slot) && slot >= 1), `slots: ${slotsSeen}`);
  assert.equal(waits[0].phase, 'start');
  assert.equal(waits[0].reason, 'rate-limit');
  assert.equal(waits[1].phase, 'end');
  void qualityReview;
});

test('a call that failed keeps why, in words; a cancel is not a failure and keeps nothing (2.6.1)', () => {
  const rate = Object.assign(new Error('Too many requests'), { code: 'RATE_LIMIT', status: 429 });
  const step = { id: 's1', stage: '确定答案与情景', status: 'starting', startedAt: at(0) };
  failStep(step, rate);
  assert.equal(step.status, 'failed');
  assert.match(step.error, /限流/);
  assert.equal(unifyCall(step).error, step.error, 'the one call shape carries the reason');
  const stopped = { id: 's2', status: 'starting', startedAt: at(0) };
  failStep(stopped, Object.assign(new Error('aborted'), { name: 'AbortError' }));
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.error, undefined);
  assert.equal(unifyCall({ id: 's3', status: 'complete', startedAt: at(0) }).error, undefined, 'a call that went well has no reason');
});

test('the calls of a single audio import carry its file, so the timeline has one lane for the recording (2.6.1)', () => {
  const calls = jobCalls({ type: 'audio-import', filename: 'lecture.mp3', tasks: [
    { id: 't', kind: 'transcribe', part: 1, parts: 2, status: 'complete', startedAt: at(0), finishedAt: at(5) },
    { id: 'p', kind: 'proofread', part: 1, parts: 9, status: 'complete', startedAt: at(6), finishedAt: at(9) }] });
  assert.deepEqual(calls.map((call) => call.file), ['lecture.mp3', 'lecture.mp3']);
  const batch = jobCalls({ type: 'audio-import', filename: 'batch', members: [{ filename: 'a.mp3', tasks: [{ id: 'x', kind: 'transcribe', status: 'complete', startedAt: at(0), finishedAt: at(1) }] }] });
  assert.deepEqual(batch.map((call) => call.file), ['a.mp3'], 'a batch keeps the own file of each member');
  assert.equal(jobCalls({ type: 'generate', filename: 'x', steps: [{ id: 's', stage: 'planning', status: 'complete', startedAt: at(0) }] })[0].file, undefined, 'only an audio import is a recording');
});
