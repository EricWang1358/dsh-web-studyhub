import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob, until } from './helpers/wait.mjs';
import { evidence, card, ONE_BY_ONE, authoring } from './helpers/supplement-fixtures.mjs';
import { openLibrary } from './helpers/generation-baseline.mjs';
import { withQualityStages, qualityReview } from './helpers/assessment.mjs';
import { requestData } from './helpers/request-data.mjs';
import { gate } from './helpers/generation-baseline.mjs';
import { checkQuestionRequest, questionOutcome } from '../lib/guided-question-prep.js';

/* #547: 带学「现场出一道新题」 goes through the ordinary supplement job (plan, answer blueprint, author, citation check, independent review,
   publication: HB-7). Nothing is written that the review did not pass, a wrong deck is refused, and the published question opens as a round of
   one question the learner answers on the card. Fake models only. */

async function guided(t, model, settings = { allowNewQuestions: true }) {
  const { service } = await openLibrary(t, { prefix: 'study-guided-q-', model });
  await service.call('source.add', { id: 'p1', title: 'Bridge notes', text: evidence });
  await service.store.update(state => {
    state.decks.push({ id: 'mine', title: 'My Bridge deck', course: 'Design', cards: [card('original')], createdAt: '2026-10-01T00:00:00.000Z' });
  });
  const session = await service.call('study.session.start', { courseId: 'Design', goal: { title: '带我学桥接模式' }, scope: [{ kind: 'source', id: 'p1' }], settings });
  return { service, session };
}
const deckOf = async (service, id = 'mine') => (await service.call('export')).decks.find(deck => deck.id === id);
const sessionOf = async (service, id) => (await service.store.read()).studySessions.find(item => item.id === id);

test('a new question is written and reviewed by the supplement job, then opens as its own round of one question', async t => {
  const { service, session } = await guided(t, authoring({ entered: true }, Infinity, 'live'));
  const started = await service.call('study.question.prepare', { sessionId: session.id, deckId: 'mine', kind: 'flashcard', focus: 'why the two hierarchies vary independently' });
  assert.equal(started.ok, true);
  assert.ok(started.jobId, 'a real background job');
  assert.deepEqual(started.sourceIds, ['p1'], 'the session\'s own sources when none are named');
  assert.equal((await sessionOf(service, session.id)).focus.kind, 'preparing-card', 'the panel can show 正在准备 from the session');
  assert.equal((await deckOf(service)).cards.length, 1, 'nothing is in the deck before the review has passed');
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const result = await service.call('study.question.result', { sessionId: session.id });
  assert.equal(result.status, 'ready');
  const deck = await deckOf(service);
  assert.equal(deck.cards.length, 2);
  const added = deck.cards.find(item => item.id === result.cardId);
  assert.ok(added, 'the round is over the question the job published');
  assert.notEqual(added.prompt, '请根据讲义内容选择正确答案：', 'never a placeholder');
  assert.ok(added.citations[0].quote && evidence.includes(added.citations[0].quote), 'with a quote checked against the material');
  assert.ok(result.runId);
  const run = await service.call('review.get', { runId: result.runId });
  assert.deepEqual(run.entries?.map(entry => entry.card.id) ?? [run.card?.id], [result.cardId], 'a round of exactly that one question');
  const after = await sessionOf(service, session.id);
  assert.deepEqual(after.focus, { kind: 'card', id: result.cardId, deckId: 'mine', runId: result.runId });
});

test('a question the independent review rejects is never added: the session is told why and falls back to existing questions', async t => {
  // The editor fails every candidate on answer leaks, so the supplement publishes nothing.
  const rejecting = withQualityStages(async (system, prompt) => {
    if (system.startsWith('You author')) return JSON.stringify({ title: 'Supplement', cards: [card('leaky', 'p1')] });
    const review = qualityReview(requestData(prompt).candidate);
    for (const check of review.checks) check.answerLeak = 'fail';
    return JSON.stringify(review);
  });
  const { service, session } = await guided(t, rejecting);
  const started = await service.call('study.question.prepare', { sessionId: session.id, deckId: 'mine', kind: 'flashcard', performance: ONE_BY_ONE });
  await settleJob(service, started.jobId);
  const result = await service.call('study.question.result', { sessionId: session.id });
  assert.equal(result.status, 'failed');
  assert.equal(result.fallback, 'reuse_existing');
  assert.match(result.reason, /审核|没有完成/);
  assert.equal((await deckOf(service)).cards.length, 1, 'the deck is unchanged');
  assert.equal((await sessionOf(service, session.id)).focus, null, 'the session no longer waits');
  assert.equal((await service.store.read()).runs.length, 0, 'no round over a question that does not exist');
});

test('the request is refused before any job starts: no deck, a deck that does not exist, another course, no permission, no sources', async t => {
  const calls = [];
  const model = async (system) => { calls.push(system); throw new Error('no model call may happen for a refused request'); };
  const { service, session } = await guided(t, model);
  await service.store.update(state => state.decks.push({ id: 'other', title: 'Other course', course: 'Law', cards: [card('x')] }));
  const refused = async (args, code) => assert.rejects(service.call('study.question.prepare', { sessionId: session.id, ...args }), error => error.code === code, JSON.stringify(args));
  await refused({}, 'study-question-deck');
  await refused({ deckId: 'no-such-deck' }, 'study-question-deck');
  await refused({ deckId: 'other' }, 'study-scope-denied');
  await refused({ deckId: 'mine', sourceIds: ['ghost'] }, 'study-question-sources');
  await refused({ deckId: 'mine', kind: 'essay' }, 'study-question-kind');
  const locked = await service.call('study.session.start', { courseId: 'Design', scope: [{ kind: 'source', id: 'p1' }] });
  await assert.rejects(service.call('study.question.prepare', { sessionId: locked.id, deckId: 'mine' }), error => error.code === 'study-setting-disabled');
  assert.deepEqual(calls, []);
  assert.equal((await deckOf(service)).cards.length, 1);
  assert.equal((await service.call('job.status', {})).jobs.length, 0, 'no job was started');
});

test('the question body cannot be passed in: prompt, options and the review switches are not arguments any more', () => {
  const state = { studySessions: [{ id: 's', status: 'active', courseId: 'C', scope: [{ kind: 'source', id: 'p' }], settings: { allowNewQuestions: true } }],
    decks: [{ id: 'd', course: 'C', cards: [] }], sources: [{ id: 'p', courses: ['C'] }] };
  const asked = checkQuestionRequest(state, { sessionId: 's', deckId: 'd', prompt: '1+1=?', options: [{ text: '2', correct: false }], simulateVerificationFailure: true, modelAvailable: true });
  assert.deepEqual(Object.keys(asked).sort(), ['deck', 'focus', 'kind', 'knownCardIds', 'session', 'sourceIds']);
  // Only a complete job that added exactly one question to that deck is a question to show.
  const preparing = { jobId: 'j', deckId: 'd', knownCardIds: ['a'] };
  const deck = (ids) => ({ decks: [{ id: 'd', cards: ids.map(id => ({ id })) }] });
  assert.equal(questionOutcome(deck(['a']), preparing, { status: 'running' }).status, 'running');
  assert.equal(questionOutcome(deck(['a', 'b']), preparing, { status: 'complete' }).card.id, 'b');
  assert.equal(questionOutcome(deck(['a']), preparing, { status: 'complete' }).status, 'failed');
  assert.equal(questionOutcome(deck(['a', 'b', 'c']), preparing, { status: 'complete' }).status, 'failed');
  assert.equal(questionOutcome(deck(['a', 'b']), preparing, { status: 'failed', error: 'x' }).status, 'failed', 'a failed job is never shown, whatever the deck holds');
  assert.equal(questionOutcome(deck(['a']), preparing, { status: 'cancelled' }).reason, '出题已取消');
});

test('取消准备 cancels the job and the session stops waiting', async t => {
  const hold = gate();
  t.after(() => hold.open());
  const { service, session } = await guided(t, authoring(hold, 1, 'held'));
  const started = await service.call('study.question.prepare', { sessionId: session.id, deckId: 'mine', kind: 'flashcard' });
  await until(() => hold.entered, 'the job to reach the model');
  const cancelled = await service.call('study.question.cancel', { sessionId: session.id });
  hold.open();
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.jobId, started.jobId);
  assert.equal((await sessionOf(service, session.id)).focus, null);
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'cancelled');
  assert.equal((await deckOf(service)).cards.length, 1);
});

test('with no AI model nothing starts: the session is told to use existing questions and does not wait', async t => {
  const { service } = await openLibrary(t, { prefix: 'study-guided-nomodel-' });
  await service.call('source.add', { id: 'p1', title: 'Bridge notes', text: evidence });
  await service.store.update(state => state.decks.push({ id: 'mine', title: 'Mine', course: 'Design', cards: [card('original')] }));
  const session = await service.call('study.session.start', { courseId: 'Design', scope: [{ kind: 'source', id: 'p1' }], settings: { allowNewQuestions: true } });
  const result = await service.call('study.question.prepare', { sessionId: session.id, deckId: 'mine' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'model_unavailable');
  assert.equal(result.fallback, 'reuse_existing');
  assert.equal((await sessionOf(service, session.id)).focus, null);
});
