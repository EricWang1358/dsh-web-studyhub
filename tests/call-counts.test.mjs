import test from 'node:test';
import assert from 'node:assert/strict';
import { replyCounts } from '../lib/call-counts.js';
import { unifyCall } from '../lib/job-calls.js';
import { stepOfCall } from '../lib/contexts/generation/jobs/generation-view.js';
import { legacyModels } from '../lib/contexts/generation/jobs/legacy-model.js';
import { createModelGateway } from '../lib/jobs/gateway.js';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';

// What a model call of a question run knows about the questions in ITS OWN reply: how many the writing produced, how many cards one review judged and how many of those it
// flagged, how many cards a repair re-worded. The count is read from the reply when the call ends and kept on the call (`counts`); no model, no tokens, nothing guessed.
const check = (cardId, verdict = 'pass') => ({ cardId, selfContained: verdict, answerLeak: 'pass', optionQuality: 'na', learningValue: 'pass', sourceSupport: 'pass', explanation: 'fine' });
const review = (...verdicts) => JSON.stringify({ issues: [], suggestions: [], summary: 's', checks: verdicts.map((verdict, index) => check(`q${index + 1}`, verdict)) });
const cards = (n) => Array.from({ length: n }, (_, index) => ({ id: `q${index + 1}`, kind: 'mcq', prompt: 'p' }));

test('the writing: the cards in the reply, whether the deck is wrapped or bare, or a cut-off reply with whole cards', () => {
  assert.deepEqual(replyCounts('author', JSON.stringify({ deck: { cards: cards(10) } })), { written: 10 });
  assert.deepEqual(replyCounts('author', '```json\n' + JSON.stringify({ cards: cards(3) }) + '\n```'), { written: 3 });
  assert.equal(replyCounts('author', 'not json at all'), undefined, 'a reply that cannot be read counts nothing');
  assert.equal(replyCounts('author', JSON.stringify({ deck: { cards: [] } })), undefined, 'no cards is not a count of zero questions written: the call failed');
});

test('a review: the checks in the reply are the cards it judged, each with any failed dimension counted as flagged', () => {
  assert.deepEqual(replyCounts('review', review('pass', 'pass', 'fail', 'pass', 'fail')), { reviewed: 5, passed: 3, flagged: 2 });
  assert.deepEqual(replyCounts('review', review('pass', 'suggest')), { reviewed: 2, passed: 2, flagged: 0 }, 'a suggestion never rejects a card');
  // A re-ask names only the cards still missing: its reply counts its own cards, not the whole part.
  assert.deepEqual(replyCounts('review', review('pass', 'fail')), { reviewed: 2, passed: 1, flagged: 1 });
  assert.equal(replyCounts('review', JSON.stringify({ issues: [], checks: [] })), undefined);
  assert.equal(replyCounts('review', '{"issues": ["x"], "checks": [{"cardId": "q1"'), undefined, 'a cut-off check is not counted');
});

test('a repair: the cards the reply re-words', () => {
  assert.deepEqual(replyCounts('repair', JSON.stringify({ cards: [{ id: 'q1', prompt: 'new' }, { id: 'q4', prompt: 'new' }, { notAnId: 1 }] })), { rewritten: 2 });
  assert.deepEqual(replyCounts('repair', JSON.stringify([{ id: 'q1', prompt: 'new' }])), { rewritten: 1 });
  assert.equal(replyCounts('repair', '{}'), undefined);
});

test('other kinds, other types of reply and junk leave nothing', () => {
  for (const kind of ['plan', 'blueprint', 'publish', 'title', 'other', undefined]) assert.equal(replyCounts(kind, JSON.stringify({ deck: { cards: cards(2) } })), undefined, String(kind));
  for (const kind of ['author', 'review', 'repair']) for (const reply of [undefined, null, '', 42, {}, '[]', 'null']) assert.equal(replyCounts(kind, reply), undefined, `${kind} ${String(reply)}`);
});

test('the call record copies the counts, and only whole numbers of the kinds it knows', () => {
  const counts = { reviewed: 5, passed: 3, flagged: 2 };
  assert.deepEqual(unifyCall({ id: 'a', stage: 'Reviewing ambiguity and source support', status: 'complete', counts }).counts, counts);
  assert.equal(unifyCall({ id: 'a', status: 'complete' }).counts, undefined, 'no counts: no field');
  assert.deepEqual(unifyCall({ id: 'a', status: 'complete', counts: { written: 4, bogus: 9, flagged: -1, passed: 'x', reviewed: 2.5 } }).counts, { written: 4 }, 'junk is dropped');
  assert.equal(unifyCall({ id: 'a', status: 'complete', counts: { bogus: 9 } }).counts, undefined);
  assert.deepEqual(stepOfCall({ callId: 'c', kind: 'review', status: 'ok', counts }).counts, counts, 'the runtime path hands the counts on to the card');
});

test('the old model path keeps the counts on the step when the call ends, only for the kinds that have them', async () => {
  const job = { id: 'j', steps: [] }, replies = [JSON.stringify({ deck: { cards: cards(4) } }), review('pass', 'fail'), '{"plan": true}'];
  const outputs = { open() {}, append() {}, reasoning() {}, close() {} };
  const models = legacyModels({ job, control: { values: {} }, performance: {}, feature: 'generation', ask: async () => replies.shift(), outputs, messengers: new Map() });
  const signal = new AbortController().signal;
  await models.call('s', 'p', { stage: 'Writing and self-checking questions', part: 1, signal });
  await models.call('s', 'p', { stage: 'Reviewing ambiguity and source support', part: 1, signal });
  await models.call('s', 'p', { stage: 'Planning', part: 1, signal });
  assert.deepEqual(job.steps.map((step) => step.counts), [{ written: 4 }, { reviewed: 2, passed: 1, flagged: 1 }, undefined]);
  assert.equal(job.steps.every((step) => step.status === 'complete' && step.finishedAt), true);
});

test('the runtime gateway keeps the counts on the call, set before the call ends', async () => {
  const record = structuredClone(goldenRuntimeContracts.running); record.calls = []; record.runtime.steps = [];
  const controller = new AbortController();
  const context = { jobId: record.jobId, attemptId: record.attemptId, signal: controller.signal, requiresExternalObservation: false, assertCurrent() { controller.signal.throwIfAborted(); } };
  const host = { ctx: {}, sessionId: 'absent', route: { provider: 'fake', model: 'fake' }, complete: async () => review('pass', 'pass', 'fail') };
  const gateway = createModelGateway({ context, record, host });
  const policy = { purpose: 'review', feature: 'generation', requestedEffort: 'default', executionMode: 'agent-preferred', budget: null };
  const text = await gateway.step('review:1', policy, { counted: (reply) => replyCounts('review', reply) }).complete('s', 'p');
  assert.equal(text, review('pass', 'pass', 'fail'));
  assert.deepEqual(record.calls[0].counts, { reviewed: 3, passed: 2, flagged: 1 });
  assert.ok(record.calls[0].endedAt);
  const plain = await gateway.step('review:2', policy).complete('s', 'p');
  assert.ok(plain);
  assert.equal(record.calls[1].counts, undefined);
});
