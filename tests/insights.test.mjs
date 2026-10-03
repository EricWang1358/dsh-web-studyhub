import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { emptyState } from '../lib/store.js';
import { initialReview } from '../lib/domain.js';
import { latestOutcomes } from '../lib/mastery.js';
import { studyMap, studyStats, wrongBook } from '../lib/insights.js';
import { recommendSimilar } from '../lib/recommend.js';
import { wrongDetail } from '../lib/wrong-detail.js';

const card = (id, kind = 'flashcard', topic = id) => ({ id, kind, topic, prompt: `${id}?`, answer: 'answer',
  ...(kind === 'quiz' ? { options: [{ id: 'yes', text: 'Yes', correct: true }, { id: 'no', text: 'No', correct: false }] } : {}) });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.store.update(s => {
    s.decks.push({ id: 'a', title: 'A deck', course: 'A', folder: 'Chapter', cards: [card('graded', 'quiz'), card('self'), card('oral')] },
      { id: 'b', title: 'B deck', course: 'B', cards: [card('b', 'quiz')] },
      { id: 'u', title: 'Unassigned', course: '', folder: 'A', cards: [card('u', 'quiz')] });
    for (const [deckId, quiz_id, assessment, grade] of [['a', 'graded', 'graded', 1], ['a', 'self', 'self', 2], ['a', 'oral', 'oral', 1], ['b', 'b', 'graded', 5]])
      s.attempts.push({ deckId, quiz_id, assessment, grade, timestamp: new Date().toISOString() });
    s.sources.push({ id: 'empty', title: 'Source only', text: 'No questions yet', courses: ['Empty'] });
    s.focus = { mode: 'class', course: 'A', targetTopics: ['old JD'] };
    s.skeletons.push({ id: 'ka', title: 'A skeleton', scope: [{ deckId: 'a' }], nodes: [], relations: [] },
      { id: 'kb', title: 'B skeleton', scope: [{ deckId: 'b' }], nodes: [], relations: [] });
  });
  return service;
}

test('old snapshot grades stay in history without changing current learning projections', () => {
  for (const grade of [1, 4, 5]) {
    const state = emptyState();
    state.decks = [{ id: 'd', title: 'Deck', course: 'C', cards: [card('mistake', 'quiz', 'Topic'),
      { ...card('corrected', 'quiz', 'Topic'), review: initialReview(state.settings) }] }];
    state.attempts = [{ deckId: 'd', quiz_id: 'mistake', assessment: 'graded', grade: 1, timestamp: '2026-10-02T01:00:00Z' },
      { deckId: 'd', quiz_id: 'corrected', assessment: 'graded', grade, timestamp: '2026-10-02T02:00:00Z', updatedAfterOpening: true }];
    assert.equal(latestOutcomes(Object.freeze(state.attempts))('d', 'corrected'), undefined);
    const map = studyMap(state);
    assert.equal(map.decks[0].counts.new, 1);
    assert.equal(map.decks[0].counts.weak, 1);
    assert.deepEqual(wrongBook(state).items.map(item => item.cardId), ['mistake']);
    const stats = studyStats(state, {}, new Date('2026-10-03T01:00:00Z'));
    assert.equal(stats.totals.weak, 1);
    assert.equal(stats.weakTopics.reduce((sum, topic) => sum + topic.wrong, 0), 1);
    assert.equal(stats.totals.attempts, 2, 'the old snapshot answer remains real study history');
    assert.equal(stats.mastery.kinds.find(item => item.id === 'quiz').n, 1);
    assert.equal(wrongDetail(state, { deckId: 'd', cardId: 'corrected' }).lastGrade, null);
    const recommendations = recommendSimilar(state, { mistakes: [{ deckId: 'd', cardId: 'mistake' }], now: Date.parse('2026-10-03T01:00:00Z') });
    assert.deepEqual(recommendations.items.map(item => item.cardId), ['corrected']);
  }
});

test('an old snapshot outcome never overrides an earlier valid outcome', () => {
  for (const [grade, staleGrade] of [[1, 5], [5, 1]]) {
    const state = emptyState();
    state.decks = [{ id: 'd', title: 'Deck', cards: [card('q', 'quiz')] }];
    state.attempts = [{ deckId: 'd', quiz_id: 'q', grade, timestamp: '2026-10-01T01:00:00Z' },
      { deckId: 'd', quiz_id: 'q', grade: staleGrade, timestamp: '2026-10-02T01:00:00Z', updatedAfterOpening: true }];
    assert.equal(latestOutcomes(state.attempts)('d', 'q'), grade);
    assert.equal(wrongBook(state).total, grade < 3 ? 1 : 0);
    assert.equal(wrongDetail(state, { deckId: 'd', cardId: 'q' }).lastGrade, grade);
    const stats = studyStats(state, {}, new Date('2026-10-03T01:00:00Z'));
    assert.equal(stats.weakTopics.reduce((sum, topic) => sum + topic.wrong, 0), grade < 3 ? 1 : 0);
  }
});

test('one course drives statistics, wrong-book evidence, graph and skeleton projections', async t => {
  const service = await fixture(t);
  const stats = await service.call('stats', { course: 'A' });
  assert.equal(stats.totals.attempts, 3);
  assert.equal(stats.totals.cards, 3);
  assert.equal(stats.totals.gradedAttempts, 1);
  assert.equal(stats.totals.selfAttempts, 1);
  assert.equal(stats.totals.oralAttempts, 1);
  assert.equal(stats.totals.correctRate, 0, 'oral/self grades never enter objective accuracy');
  assert.equal(stats.trend.at(-1).oralCount, 1);
  const book = await service.call('wrongbook', { course: 'A' });
  assert.deepEqual([book.total, book.gradedTotal, book.selfTotal, book.oralTotal], [3, 1, 1, 1]);
  assert.deepEqual((await service.call('graph', { course: 'A' })).nodes.filter(n => n.kind === 'card').map(n => n.cardId), ['graded', 'self', 'oral']);
  const topics = await service.call('skeleton.topics', { course: 'A' });
  assert.equal(topics.topics.reduce((n, row) => n + row.count, 0), 3);
  assert.deepEqual((await service.call('skeleton.list', { course: 'A' })).skeletons.map(k => k.id), ['ka']);
  assert.equal((await service.call('stats', { course: 'B' })).totals.attempts, 1);
  assert.equal((await service.call('wrongbook', { course: 'B' })).total, 0, 'no fill from another course');
  assert.equal((await service.call('stats', { course: 'A', scope: [] })).totals.attempts, 4, 'explicit all wins');
  const one = await service.call('graph', { course: 'B', scope: [{ deckId: 'a', cardId: 'self' }] });
  assert.deepEqual(one.nodes.filter(n => n.kind === 'card').map(n => n.cardId), ['self']);
  assert.equal(one.nodes.find(n => n.kind === 'deck').total, 1, 'node counts match visible cards');
  assert.equal((await service.call('stats', { course: '' })).totals.cards, 1);
});

test('an empty course stays empty and cannot start practice or an exam from other courses', async t => {
  const service = await fixture(t);
  for (const action of ['stats', 'wrongbook', 'graph', 'skeleton.topics', 'skeleton.list']) {
    const result = await service.call(action, { course: 'Empty' });
    if (action === 'stats') assert.equal(result.totals.cards, 0);
    if (action === 'wrongbook') assert.equal(result.total, 0);
    if (action === 'graph') assert.deepEqual(result.nodes, []);
    if (action === 'skeleton.topics') assert.deepEqual(result.topics, []);
    if (action === 'skeleton.list') assert.deepEqual(result.skeletons, []);
  }
  for (const mode of ['new', 'path', 'exam'])
    await assert.rejects(service.call('review.start', { mode, course: 'Empty', fresh: true }), /没有|No questions/);
  await assert.rejects(service.call('oral.start', { course: 'Empty' }), /没有/);
});

test('explicit new-question card scope survives changed focus and next batch', async t => {
  const service = await fixture(t);
  await service.store.update(s => { s.attempts = []; s.decks[0].cards.push(card('excluded')); });
  const scope = [{ deckId: 'a', cardId: 'self' }, { deckId: 'b', cardId: 'b' }];
  const first = await service.call('review.start', { mode: 'new', scope, count: 1, fresh: true });
  assert.ok(scope.some(ref => ref.cardId === first.card.id), 'only selected cards enter the first batch');
  if (first.card.kind === 'quiz') await service.call('review.answer', { runId: first.id, cardId: first.card.id, selected: ['yes'] });
  else {
    await service.call('review.reveal', { runId: first.id, cardId: first.card.id });
    await service.call('review.answer', { runId: first.id, cardId: first.card.id, grade: 5 });
  }
  await service.call('focus.set', { course: '' });
  const second = await service.call('review.start', { mode: 'new', scope: first.scope, count: 10, fresh: true });
  assert.equal(second.total, 1);
  assert.ok(scope.some(ref => ref.cardId === second.card.id));
});
