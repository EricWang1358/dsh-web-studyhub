import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StudyService } from '../lib/service.js';

/* #543 / #544: the progress, the remaining-time range and the itemized cost are worked out from the library the session really has, and the
   session records what changes them. A real library, no model. */

const questionCard = (id, topic) => ({
  id, kind: 'flashcard', topic, objective: `Know ${topic}`, prompt: `What is ${topic}?`, answer: `${topic} is a thing.`,
  hint: 'Think.', explanation: `${topic} explained.`, misconception: 'None.', citations: [{ sourceId: 'src-live', quote: 'Live source text' }],
});

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'guided-progress-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  t.after(() => study.dispose());
  await study.call('snapshot');
  await study.call('source.add', { id: 'src-live', title: 'Live', text: 'Live source text for the live session.', courses: ['CS101'] });
  await study.call('draft.save', { deck: { id: 'd-live', course: 'CS101', title: 'Live deck',
    cards: [questionCard('c1', 'One'), questionCard('c-branch', 'Two'), questionCard('c-third', 'Three')] } });
  await study.call('draft.publish', { id: 'd-live' });
  const session = await study.call('study.session.start', { courseId: 'CS101', scope: [{ kind: 'deck', id: 'd-live' }],
    goal: { title: 'Live goal', checkItems: [
      { id: 'chk-1', title: 'One', targetCardIds: ['c1'] },
      { id: 'chk-2', title: 'Two', targetCardIds: ['c-branch'] },
      { id: 'chk-3', title: 'Three', targetCardIds: ['c-third'] },
    ] }, settings: { allowNewQuestions: true } });
  const stored = async () => (await study.store.read()).studySessions.find((item) => item.id === session.id);
  return { study, session, stored };
}
const independent = (id, quiz_id, elapsed_ms) => ({ id, runId: 'r-live', quiz_id, deckId: 'd-live', topic: quiz_id, timestamp: Date.now(), grade: 4, assessment: 'graded', elapsed_ms, assistance: { used: false } });

test('study.session.get gives the panel the progress, the range and the cost of the session, and reading writes nothing', async (t) => {
  const { study, session, stored } = await library(t);

  const fresh = await study.call('study.session.get', { sessionId: session.id });
  assert.equal(fresh.progress.totalCount, 3);
  assert.equal(fresh.progress.independentPassedCount, 0);
  assert.equal(fresh.estimate.status, 'estimating');
  assert.equal(fresh.cost.costPerIndependentCheckItem, 'pending_first_pass');
  assert.equal(fresh.cost.breakdown.tutoring.measured, false, 'the main chat\'s own reasoning is not visible to the plugin');

  await study.store.update((s) => { s.attempts.push(independent('att-1', 'c-third', 120000)); });
  const after = await study.call('study.session.get', { sessionId: session.id });
  assert.equal(after.progress.independentPassedCount, 1);
  assert.equal(after.estimate.status, 'estimated');
  assert.equal(after.estimate.preliminary, true);
  assert.ok(Number.isInteger(after.estimate.minMinutes) && after.estimate.minMinutes < after.estimate.maxMinutes);
  assert.equal(after.cost.breakdown.reusedQuestions.count, 1, 'the question the library already had');
  assert.doesNotMatch(JSON.stringify(after.cost), /usd|price/i);

  const before = JSON.stringify(await stored());
  await study.call('study.session.get', { sessionId: session.id });
  await study.call('study.session.resume', { sessionId: session.id });
  assert.equal(JSON.stringify(await stored()), before, 'the panel reads every few seconds: a read changes nothing');
  assert.deepEqual((await study.call('study.session.resume', { sessionId: session.id })).cost, after.cost, 'resume and get tell the same numbers');
});

test('answering writes nothing on the session: predictions move only when the goal or a branch changes', async (t) => {
  const { study, session, stored } = await library(t);
  await study.store.update((s) => { s.attempts.push(independent('att-1', 'c-third', 120000)); });
  const before = JSON.stringify(await stored());
  const run = await study.call('review.start', { mode: 'path', fresh: true, scope: [{ deckId: 'd-live', cardId: 'c1' }] });
  await study.call('review.reveal', { runId: run.id, cardId: 'c1', queueVersion: run.queueVersion });
  await study.call('review.answer', { runId: run.id, cardId: 'c1', grade: 1, queueVersion: run.queueVersion });
  assert.equal(JSON.stringify(await stored()), before);
  assert.equal((await study.call('study.session.get', { sessionId: session.id })).progress.items[0].evidenceAttemptIds.length, 1, 'the read still sees the answer');
});

test('opening a side question and changing the goal each leave a reason in the predictions', async (t) => {
  const { study, session, stored } = await library(t);
  await study.store.update((s) => { s.attempts.push(independent('att-1', 'c-third', 120000)); });
  await study.call('study.session.update', { sessionId: session.id, focus: { kind: 'card', id: 'c1', deckId: 'd-live' } });
  await study.call('study.branch.open', { sessionId: session.id, targetDeckId: 'd-live', targetCardId: 'c-branch', reason: 'contrast' });
  const [first] = (await stored()).predictions;
  assert.equal(first.reason, '新增前置支线');
  const wider = (await stored()).goal;
  await study.call('study.session.update', { sessionId: session.id, goal: { ...wider, checkItems: [...wider.checkItems, { id: 'chk-4', title: 'Four', targetCardIds: ['c-x'] }], scopeNote: '多加一项' } });
  assert.equal((await stored()).predictions.at(-1).reason, '目标范围调整');
});

test('a pause writes no clock on the session, and it does not change the range', async (t) => {
  const { study, session, stored } = await library(t);
  await study.store.update((s) => { s.attempts.push(independent('att-1', 'c-third', 120000)); });
  const before = (await study.call('study.session.get', { sessionId: session.id })).estimate;
  await study.call('study.session.pause', { sessionId: session.id });
  await study.call('study.session.update', { sessionId: session.id, status: 'active' });
  const kept = await stored();
  assert.equal('pausedAt' in kept, false);
  assert.equal('activityLog' in kept, false);
  assert.deepEqual((await study.call('study.session.get', { sessionId: session.id })).estimate, before);
});

test('settling a question keeps the job\'s tokens and the card it wrote; a job the session did not wait for adds nothing', async (t) => {
  const { study, session, stored } = await library(t);
  const waiting = { kind: 'preparing-card', jobId: 'job-1', deckId: 'd-live', knownCardIds: ['c1', 'c-branch', 'c-third'], startedAt: new Date(Date.now() - 3 * 60000).toISOString() };
  await study.store.update((s) => {
    s.studySessions.find((item) => item.id === session.id).focus = waiting;
    s.decks.find((deck) => deck.id === 'd-live').cards.push(questionCard('gen-1', 'Written'));
  });
  const tokenUsage = { uncachedInputTokens: 4000, outputTokens: 700, cacheReadTokens: 2000, cacheWriteTokens: 0, calls: 5 };

  assert.deepEqual(await study.call('study.question.settle', { sessionId: session.id, jobId: 'other-job', cardId: 'gen-1', tokenUsage }), { settled: false });
  assert.equal((await stored()).usage.length, 0);

  const settled = await study.call('study.question.settle', { sessionId: session.id, jobId: 'job-1', cardId: 'gen-1', runId: 'r1', tokenUsage });
  assert.equal(settled.settled, true);
  const kept = await stored();
  assert.equal(kept.usage.length, 1);
  assert.equal(kept.usage[0].cardId, 'gen-1');
  assert.equal(kept.usage[0].tokens, 6700);
  assert.equal('activityLog' in kept, false);

  await study.store.update((s) => {
    s.studySessions.find((item) => item.id === session.id).goal.checkItems[0].targetCardIds.push('gen-1'); // the main chat links the new question to a check item
    s.attempts.push(independent('att-gen', 'gen-1', 90000));
  });
  const { cost, estimate } = await study.call('study.session.get', { sessionId: session.id });
  assert.equal(cost.breakdown.generation.tokens, 6700);
  assert.equal(cost.breakdown.reusedQuestions.count, 0, 'the one question answered was written for this session');
  assert.deepEqual(cost.costPerIndependentCheckItem, { tokens: 6700, includesTutoring: false });
  assert.equal(estimate.status, 'estimated');
});

test('a question job that failed still spent its tokens, and a job that reported none is not counted as 0', async (t) => {
  const { study, session, stored } = await library(t);
  const wait = (jobId) => study.store.update((s) => {
    s.studySessions.find((item) => item.id === session.id).focus = { kind: 'preparing-card', jobId, deckId: 'd-live', knownCardIds: [], startedAt: new Date().toISOString() };
  });
  await wait('job-fail');
  await study.call('study.question.settle', { sessionId: session.id, jobId: 'job-fail', tokenUsage: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  assert.equal((await stored()).focus, null);
  assert.equal((await stored()).usage[0].tokens, 1200);
  await wait('job-silent');
  await study.call('study.question.settle', { sessionId: session.id, jobId: 'job-silent' });
  const { cost } = await study.call('study.session.get', { sessionId: session.id });
  assert.equal(cost.breakdown.generation.measured, false);
  assert.equal(cost.breakdown.generation.tokens, null);
});
