import test from 'node:test';
import assert from 'node:assert/strict';
import { studyStats } from '../lib/insights.js';

// WP24: the dashboard's companion charts read two new projections from the
// existing `stats` action: a 14-day due forecast and 30-day mastery by
// cognitive level / question kind. Everything derives from decks + attempts.
const NOW = new Date(2026, 9, 2, 12, 0, 0); // local noon, Fri 2026-10-02
const at = (days, hour = 9) => new Date(2026, 9, 2 + days, hour, 0, 0).toISOString();
const due = (days, hour = 9) => ({ repetitions: 2, interval_days: 6, ease: 2.5, due_at: at(days, hour) });
const card = (id, patch = {}) => ({ id, kind: 'flashcard', topic: 'T', prompt: `${id}?`, answer: 'a', review: due(1), ...patch });
const attempt = (deckId, quiz_id, grade, days = 0, extra = {}) => ({ deckId, quiz_id, grade, assessment: 'self', timestamp: at(days, 10), ...extra });
const library = (decks, attempts = []) => ({ decks, attempts, runs: [], sources: [], focus: {}, learner: undefined });
const stats = (state, args = {}) => studyStats(state, args, NOW);

test('forecast has 14 daily buckets starting today with the local date key', () => {
  const result = stats(library([{ id: 'a', title: 'A', course: 'X', cards: [card('c1', { review: due(0) })] }]));
  assert.equal(result.today, '2026-10-02');
  assert.equal(result.forecast.days.length, 14);
  assert.equal(result.forecast.days[0].date, '2026-10-02');
  assert.equal(result.forecast.days[13].date, '2026-10-15');
  assert.deepEqual(result.forecast.days.map(d => d.count), [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('overdue cards fold into today; later days, beyond-14-day and unscheduled cards are placed correctly', () => {
  const cards = [
    card('overdue', { review: due(-5) }), card('earlier-today', { review: due(0, 8) }), card('later-today', { review: due(0, 20) }),
    card('d1', { review: due(1) }), card('d1b', { review: due(1, 23) }), card('d3', { review: due(3) }),
    card('d13', { review: due(13, 0) }), card('d14', { review: due(14) }), card('d40', { review: due(40) }),
    card('fresh', { review: undefined }), card('suspended', { review: due(2), suspended: true }),
  ];
  const result = stats(library([{ id: 'a', title: 'A', course: 'X', cards }, { id: 'old', title: 'Old', archived: true, cards: [card('z', { review: due(2) })] }]));
  const days = result.forecast.days;
  assert.equal(days[0].count, 3, 'overdue + earlier + later today');
  assert.equal(days[0].overdue, 1, 'only cards due before today count as overdue');
  assert.equal(days[1].count, 2);
  assert.equal(days[2].count, 0, 'suspended and archived cards never appear');
  assert.equal(days[3].count, 1);
  assert.equal(days[13].count, 1, 'day 13 is the last bucket');
  assert.equal(result.forecast.later, 2, 'cards beyond 14 days are counted once, not drawn');
  assert.equal(days.reduce((n, d) => n + d.count, 0) + result.forecast.later, 9, 'new cards without a schedule are excluded');
  assert.deepEqual(days[1].cards, [{ deckId: 'a', cardId: 'd1' }, { deckId: 'a', cardId: 'd1b' }], 'a bar can start exactly those cards, soonest first');
  assert.deepEqual(days[0].cards.map(c => c.cardId), ['overdue', 'earlier-today', 'later-today']);
});

test('a card that was never answered and has no repetitions is new, not due', () => {
  const result = stats(library([{ id: 'a', title: 'A', course: 'X', cards: [card('n', { review: { repetitions: 0, due_at: at(0) } })] }]));
  assert.equal(result.forecast.days[0].count, 0);
});

test('forecast follows the course filter and an explicit scope', () => {
  const decks = [{ id: 'a', title: 'A', course: 'X', cards: [card('a1', { review: due(1) })] },
    { id: 'b', title: 'B', course: 'Y', cards: [card('b1', { review: due(1) }), card('b2', { review: due(2) })] }];
  const state = library(decks);
  assert.equal(stats(state, { course: 'X' }).forecast.days[1].count, 1);
  assert.equal(stats(state, { course: 'Y' }).forecast.days[1].count, 1);
  assert.equal(stats(state, { course: 'Y' }).forecast.days[2].count, 1);
  assert.equal(stats(state, { course: '*' }).forecast.days[1].count, 2);
  assert.equal(stats(state, { scope: [{ deckId: 'a' }] }).forecast.days[1].count, 1);
});

test('bucket card lists are capped but counts stay exact', () => {
  const cards = Array.from({ length: 450 }, (_, i) => card(`c${i}`, { review: due(-1, i % 24) }));
  const today = stats(library([{ id: 'a', title: 'A', course: 'X', cards }])).forecast.days[0];
  assert.equal(today.count, 450);
  assert.equal(today.cards.length, 300);
  assert.equal(today.truncated, true);
});

const mastery = (state, args) => stats(state, args).mastery;
const deckOf = (cards) => [{ id: 'a', title: 'A', course: 'X', cards }];
const recall = (id, kind = 'flashcard') => card(id, { kind, prompt: `${id} 是什么？` });
const concept = (id, kind = 'flashcard') => card(id, { kind, prompt: `${id} 和 B 的区别？` });
const apply = (id, kind = 'flashcard') => card(id, { kind, prompt: `在某团队的系统设计中，${id} 应该怎么取舍？` });

test('mastery by cognitive level counts answers of the last 30 days and hides thin levels', () => {
  const cards = [recall('r1'), recall('r2'), recall('r3'), concept('c1'), concept('c2'), apply('a1')];
  const attempts = [attempt('a', 'r1', 5), attempt('a', 'r2', 4), attempt('a', 'r3', 1), attempt('a', 'r1', 2, -3),
    attempt('a', 'c1', 3), attempt('a', 'c2', 5), attempt('a', 'a1', 0)];
  const { levels, windowDays, minAnswers } = mastery(library(deckOf(cards), attempts));
  assert.equal(windowDays, 30);
  assert.equal(minAnswers, 3);
  assert.deepEqual(levels.map(l => l.id), ['recall', 'concept', 'apply']);
  const by = Object.fromEntries(levels.map(l => [l.id, l]));
  assert.deepEqual([by.recall.n, by.recall.met, by.recall.rate, by.recall.enough], [4, 2, 50, true]);
  assert.deepEqual([by.concept.n, by.concept.met, by.concept.rate, by.concept.enough], [2, 2, null, false], 'under 3 answers: no rate');
  assert.deepEqual([by.apply.n, by.apply.met, by.apply.rate, by.apply.enough], [1, 0, null, false]);
});

test('mastery uses the learner-stored level over the wording heuristic and ignores old, retry and oral answers', () => {
  const cards = [recall('r1'), recall('r2')];
  const state = library(deckOf(cards), [attempt('a', 'r1', 4), attempt('a', 'r1', 4, -1), attempt('a', 'r1', 4, -2),
    attempt('a', 'r2', 5, -40), attempt('a', 'r2', 5, 0, { retry: true }), attempt('a', 'r2', 5, 0, { assessment: 'oral' })]);
  state.learner = { levels: { r1: 'apply' } };
  const by = Object.fromEntries(mastery(state).levels.map(l => [l.id, l]));
  assert.equal(by.apply.n, 3);
  assert.equal(by.apply.rate, 100);
  assert.equal(by.recall.n, 0, 'old (40 days), retry and oral attempts are not counted');
});

test('mastery by question kind lists only kinds with answers, in a stable order, with counts', () => {
  const cards = [card('q', { kind: 'quiz', options: [] }), card('m', { kind: 'multi', options: [] }), card('f'), card('o', { kind: 'open' }), card('z', { kind: 'cloze' })];
  const attempts = [attempt('a', 'q', 4, 0, { assessment: 'graded' }), attempt('a', 'q', 1, -1, { assessment: 'graded' }), attempt('a', 'q', 5, -2, { assessment: 'graded' }),
    attempt('a', 'f', 3), attempt('a', 'o', 2), attempt('a', 'm', 4, 0, { assessment: 'graded' })];
  const { kinds } = mastery(library(deckOf(cards), attempts));
  assert.deepEqual(kinds.map(k => k.id), ['quiz', 'multi', 'flashcard', 'open']);
  const by = Object.fromEntries(kinds.map(k => [k.id, k]));
  assert.deepEqual([by.quiz.n, by.quiz.met, by.quiz.rate], [3, 2, 67]);
  assert.deepEqual([by.multi.n, by.multi.enough, by.multi.rate], [1, false, null]);
  assert.equal(by.flashcard.n, 1);
});

test('mastery follows the course filter', () => {
  const decks = [{ id: 'a', title: 'A', course: 'X', cards: [recall('r1')] }, { id: 'b', title: 'B', course: 'Y', cards: [recall('r2')] }];
  const attempts = [attempt('a', 'r1', 5), attempt('b', 'r2', 1), attempt('b', 'r2', 1, -1)];
  const x = Object.fromEntries(mastery(library(decks, attempts), { course: 'X' }).levels.map(l => [l.id, l.n]));
  const y = Object.fromEntries(mastery(library(decks, attempts), { course: 'Y' }).levels.map(l => [l.id, l.n]));
  assert.equal(x.recall, 1);
  assert.equal(y.recall, 2);
});

test('trend keeps one row per studied day only, so charts must draw gaps themselves', () => {
  const cards = [card('c1', { kind: 'quiz' })];
  const result = stats(library(deckOf(cards), [attempt('a', 'c1', 4, -10, { assessment: 'graded' }), attempt('a', 'c1', 2, -4, { assessment: 'graded' }), attempt('a', 'c1', 5, 0, { assessment: 'graded' })]));
  assert.deepEqual(result.trend.map(d => d.date), ['2026-09-22', '2026-09-28', '2026-10-02']);
  assert.equal(result.trend[0].gradedAvg, 4);
  assert.equal(result.trend[0].selfAvg, null);
});

test('weak topics carry the course so the dashboard can label them', () => {
  const state = library(deckOf([card('w', { topic: 'Memento' })]), [attempt('a', 'w', 1)]);
  const [row] = stats(state).weakTopics;
  assert.equal(row.course, 'X');
  assert.equal(row.topic, 'Memento');
  assert.equal(row.deckTitle, 'A');
});
