import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { emptyState } from '../lib/store.js';
import { initialReview } from '../lib/domain.js';
import { latestOutcomes } from '../lib/mastery.js';
import { classifyAttemptAssessment, studyMap, studyStats, wrongBook } from '../lib/insights.js';
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

test('the wrong book keeps the mistakes already put right apart from the weak list', () => {
  const state = emptyState();
  state.decks = [{ id: 'd', title: 'Deck', course: 'C', cards: [
    card('still-wrong', 'quiz'), card('fixed', 'quiz'), card('first-try', 'quiz'), card('fixed-later', 'quiz')] }];
  state.attempts = [
    { deckId: 'd', quiz_id: 'still-wrong', grade: 1, timestamp: '2026-10-01T01:00:00Z' },
    { deckId: 'd', quiz_id: 'fixed', grade: 1, timestamp: '2026-10-01T02:00:00Z' },
    { deckId: 'd', quiz_id: 'fixed', grade: 2, timestamp: '2026-10-02T02:00:00Z' },
    { deckId: 'd', quiz_id: 'fixed', grade: 4, timestamp: '2026-10-03T02:00:00Z' },
    { deckId: 'd', quiz_id: 'first-try', grade: 4, timestamp: '2026-10-02T03:00:00Z' },
    { deckId: 'd', quiz_id: 'fixed-later', grade: 1, timestamp: '2026-10-01T04:00:00Z' },
    { deckId: 'd', quiz_id: 'fixed-later', grade: 4, timestamp: '2026-10-04T04:00:00Z' },
  ];
  const weak = wrongBook(state);
  assert.equal(weak.view, 'weak');
  assert.deepEqual(weak.items.map((item) => item.cardId), ['still-wrong']);
  assert.deepEqual(weak.counts, { weak: 1, history: 2 });
  const history = wrongBook(state, { view: 'history' });
  assert.equal(history.view, 'history');
  assert.equal(history.total, 2);
  assert.deepEqual(history.items.map((item) => item.cardId), ['fixed-later', 'fixed'], 'newest correction first');
  assert.deepEqual(history.items.map((item) => [item.wrongCount, item.lastGrade, item.assessment]),
    [[1, 4, 'graded'], [2, 4, 'graded']]);
  assert.equal(history.items[1].firstWrongAt, '2026-10-01T02:00:00Z');
  assert.equal(history.items[1].lastWrongAt, '2026-10-02T02:00:00Z');
  assert.equal(history.items[1].recoveredAt, '2026-10-03T02:00:00Z');
  assert.equal(history.items[1].lastAt, '2026-10-03T02:00:00Z');
  assert.deepEqual(wrongBook(state, { view: 'history', offset: 1, limit: 1 }).items.map((item) => item.cardId), ['fixed']);
  assert.throws(() => wrongBook(state, { view: 'gone' }), /weak or history/);
});

test('a wrong answer after a right one is weak again, not history', () => {
  const state = emptyState();
  state.decks = [{ id: 'd', title: 'Deck', cards: [card('q', 'quiz')] }];
  state.attempts = [
    { deckId: 'd', quiz_id: 'q', grade: 4, timestamp: '2026-10-01T01:00:00Z' },
    { deckId: 'd', quiz_id: 'q', grade: 1, timestamp: '2026-10-02T01:00:00Z' },
  ];
  const book = wrongBook(state);
  assert.deepEqual(book.items.map((item) => item.cardId), ['q']);
  assert.deepEqual(book.counts, { weak: 1, history: 0 });
  assert.equal(wrongBook(state, { view: 'history' }).total, 0);
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

test('wrongDetail history view reads the missed run entry rather than the later clearing run', () => {
  const state = emptyState();
  state.decks = [{
    id: 'd',
    title: 'Deck',
    cards: [{
      id: 'q',
      kind: 'quiz',
      topic: 'Topic',
      prompt: 'Current prompt?',
      options: [{ id: 'yes', text: 'Right option', correct: true }, { id: 'no', text: 'Wrong option', correct: false }],
    }],
  }];
  state.attempts = [
    { deckId: 'd', quiz_id: 'q', runId: 'run-missed', assessment: 'graded', grade: 1, timestamp: '2026-10-01T01:00:00Z' },
    { deckId: 'd', quiz_id: 'q', runId: 'run-cleared', assessment: 'graded', grade: 5, timestamp: '2026-10-02T01:00:00Z' },
  ];
  state.runs = [
    {
      id: 'run-missed',
      entries: [{
        card: { id: 'q', kind: 'quiz', prompt: 'Original prompt?', options: state.decks[0].cards[0].options },
        feedback: { correct: false, selected: ['no'] },
      }],
    },
    {
      id: 'run-cleared',
      entries: [{
        card: { id: 'q', kind: 'quiz', prompt: 'Updated prompt?', options: state.decks[0].cards[0].options },
        feedback: { correct: true, selected: ['yes'] },
      }],
    },
  ];
  const detail = wrongDetail(state, { deckId: 'd', cardId: 'q' }, { view: 'history' });
  assert.equal(detail.lastGrade, 5);
  assert.equal(detail.missedGrade, 1);
  assert.equal(detail.yourAnswer, 'Wrong option');
});

test('implicit prerequisite credits and #778 unverified self-reports never clear unresolved mistakes in wrongBook or wrongDetail', () => {
  const state = emptyState();
  state.decks = [{ id: 'd', title: 'Deck', course: 'C', cards: [
    card('imp-miss', 'quiz'),
    card('self-miss', 'task'),
    card('verified-later', 'task'),
  ] }];
  state.attempts = [
    { deckId: 'd', quiz_id: 'imp-miss', grade: 1, assessment: 'graded', timestamp: '2026-10-01T01:00:00Z' },
    { deckId: 'd', quiz_id: 'imp-miss', grade: 4, implicit: true, timestamp: '2026-10-02T01:00:00Z' },
    { deckId: 'd', quiz_id: 'self-miss', grade: 1, assessment: 'rubric', timestamp: '2026-10-01T02:00:00Z' },
    { deckId: 'd', quiz_id: 'self-miss', grade: 3, assessment: 'self-report', correct: false, selfReported: true, unverified: true, timestamp: '2026-10-02T02:00:00Z' },
    { deckId: 'd', quiz_id: 'verified-later', grade: 1, assessment: 'rubric', timestamp: '2026-10-01T03:00:00Z' },
    { deckId: 'd', quiz_id: 'verified-later', grade: 3, assessment: 'self-report', correct: false, selfReported: true, unverified: true, timestamp: '2026-10-02T03:00:00Z' },
    { deckId: 'd', quiz_id: 'verified-later', grade: 4, assessment: 'rubric', correct: true, timestamp: '2026-10-03T03:00:00Z' },
  ];

  const weak = wrongBook(state);
  assert.deepEqual(weak.items.map((item) => item.cardId), ['self-miss', 'imp-miss']);
  assert.deepEqual(weak.counts, { weak: 2, history: 1 });

  const history = wrongBook(state, { view: 'history' });
  assert.deepEqual(history.items.map((item) => item.cardId), ['verified-later']);
  assert.equal(history.items[0].recoveredAt, '2026-10-03T03:00:00Z');

  assert.equal(wrongDetail(state, { deckId: 'd', cardId: 'imp-miss' }).lastGrade, 1);
  assert.equal(wrongDetail(state, { deckId: 'd', cardId: 'self-miss' }).lastGrade, 1);
  assert.equal(wrongDetail(state, { deckId: 'd', cardId: 'verified-later' }, { view: 'history' }).lastGrade, 4);
});

test('#1449-8: wrongBook preserves rubric/task-static/taskCheck assessments and rubricTotal across weak & history without changing studyStats', () => {
  // Default classifier stays unchanged for studyStats (#93/#1308)
  assert.equal(classifyAttemptAssessment({ assessment: 'rubric' }), 'graded');
  assert.equal(classifyAttemptAssessment({ assessment: 'task-static' }), 'graded');
  assert.equal(classifyAttemptAssessment({ assessment: 'graded', taskCheck: { passed: false } }), 'graded');
  assert.equal(classifyAttemptAssessment({ assessment: 'coach-sync' }), 'graded');
  assert.equal(classifyAttemptAssessment({ via: 'voice' }), 'graded');
  assert.equal(classifyAttemptAssessment({ assessment: 'self' }), 'self');
  assert.equal(classifyAttemptAssessment({ assessment: 'oral' }), 'oral');
  assert.equal(classifyAttemptAssessment({ assessment: 'self-report', selfReported: true }), 'self-report');

  // preserveRubric keeps rubric / task-static / taskCheck distinct while keeping coach-sync / voice / graded as graded
  assert.equal(classifyAttemptAssessment({ assessment: 'rubric' }, null, { preserveRubric: true }), 'rubric');
  assert.equal(classifyAttemptAssessment({ assessment: 'task-static' }, null, { preserveRubric: true }), 'rubric');
  assert.equal(classifyAttemptAssessment({ assessment: 'graded', taskCheck: { passed: false } }, null, { preserveRubric: true }), 'rubric');
  assert.equal(classifyAttemptAssessment({ assessment: 'graded' }, null, { preserveRubric: true }), 'graded');
  assert.equal(classifyAttemptAssessment({ assessment: 'coach-sync' }, null, { preserveRubric: true }), 'graded');
  assert.equal(classifyAttemptAssessment({ via: 'voice' }, null, { preserveRubric: true }), 'graded');
  assert.equal(classifyAttemptAssessment({ assessment: 'self' }, null, { preserveRubric: true }), 'self');
  assert.equal(classifyAttemptAssessment({ assessment: 'oral' }, null, { preserveRubric: true }), 'oral');
  assert.equal(classifyAttemptAssessment({ assessment: 'self-report', selfReported: true }, null, { preserveRubric: true }), 'self-report');

  const state = emptyState();
  state.decks = [{
    id: 'd',
    title: 'Mixed Deck',
    course: 'C',
    cards: [
      card('c-rubric', 'open'),
      card('c-task-static', 'task'),
      card('c-task-check', 'task'),
      card('c-quiz', 'quiz'),
      card('c-voice', 'quiz'),
      card('c-self', 'flashcard'),
      card('c-oral', 'quiz'),
      card('c-rubric-fixed', 'open'),
    ],
  }];
  state.attempts = [
    { deckId: 'd', quiz_id: 'c-rubric', assessment: 'rubric', grade: 1, timestamp: '2026-10-01T01:00:00Z' },
    { deckId: 'd', quiz_id: 'c-task-static', assessment: 'task-static', grade: 1, timestamp: '2026-10-01T02:00:00Z' },
    { deckId: 'd', quiz_id: 'c-task-check', assessment: 'graded', taskCheck: { passed: false }, grade: 1, timestamp: '2026-10-01T03:00:00Z' },
    { deckId: 'd', quiz_id: 'c-quiz', assessment: 'graded', grade: 1, timestamp: '2026-10-01T04:00:00Z' },
    { deckId: 'd', quiz_id: 'c-voice', via: 'voice', grade: 1, timestamp: '2026-10-01T05:00:00Z' },
    { deckId: 'd', quiz_id: 'c-self', assessment: 'self', grade: 2, timestamp: '2026-10-01T06:00:00Z' },
    { deckId: 'd', quiz_id: 'c-oral', assessment: 'oral', grade: 1, timestamp: '2026-10-01T07:00:00Z' },
    { deckId: 'd', quiz_id: 'c-rubric-fixed', assessment: 'rubric', grade: 1, timestamp: '2026-10-01T08:00:00Z' },
    { deckId: 'd', quiz_id: 'c-rubric-fixed', assessment: 'rubric', grade: 4, timestamp: '2026-10-02T08:00:00Z' },
  ];

  const weak = wrongBook(state, { view: 'weak' });
  assert.equal(weak.total, 7);
  assert.equal(weak.rubricTotal, 3, 'rubric, task-static, and taskCheck are counted in rubricTotal');
  assert.equal(weak.gradedTotal, 2, 'only plain graded and voice stay in gradedTotal');
  assert.equal(weak.selfTotal, 1);
  assert.equal(weak.oralTotal, 1);
  const weakById = new Map(weak.items.map((item) => [item.cardId, item.assessment]));
  assert.equal(weakById.get('c-rubric'), 'rubric');
  assert.equal(weakById.get('c-task-static'), 'rubric');
  assert.equal(weakById.get('c-task-check'), 'rubric');
  assert.equal(weakById.get('c-quiz'), 'graded');
  assert.equal(weakById.get('c-voice'), 'graded');
  assert.equal(weakById.get('c-self'), 'self');
  assert.equal(weakById.get('c-oral'), 'oral');

  const history = wrongBook(state, { view: 'history' });
  assert.equal(history.total, 1);
  assert.equal(history.rubricTotal, 1, 'recovered rubric mistake keeps rubricTotal in history view');
  assert.equal(history.gradedTotal, 0);
  assert.equal(history.items[0].cardId, 'c-rubric-fixed');
  assert.equal(history.items[0].assessment, 'rubric');

  // studyStats must still aggregate rubric/task-static/taskCheck into gradedAttempts (unchanged #93/#1308 contract)
  const stats = studyStats(state, {}, new Date('2026-10-05T00:00:00Z'));
  assert.equal(stats.totals.gradedAttempts, 7);
  assert.equal(stats.totals.selfAttempts, 1);
  assert.equal(stats.totals.oralAttempts, 1);
});
