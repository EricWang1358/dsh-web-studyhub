/* The daily path is the home card's one number: the round of the CURRENT course (due, weak, then new), capped at the round size, with the
   breakdown counted over the very cards the round holds. Another course's work is said once, as "elsewhere", never mixed into the number. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { planPath } from '../lib/mastery.js';
import { studyMap } from '../lib/insights.js';
import { dailyPlan } from '../lib/daily-path.js';
import { emptyState } from '../lib/store.js';

const NOW = Date.parse('2026-10-08T08:00:00Z');
const PAST = '2026-10-01T00:00:00Z';
const make = (id, state) => ({ id, kind: 'quiz', topic: 'T', prompt: `${id}?`, answer: 'a',
  options: [{ id: 'y', text: 'Yes', correct: true }, { id: 'n', text: 'No', correct: false }],
  ...(state === 'due' ? { review: { repetitions: 2, interval_days: 3, ease: 2.5, due_at: PAST } } : {}) });
/** A deck with `due`, `weak` and `fresh` cards; the attempts that make them so go to `attempts`. */
function deckOf(id, course, { due = 0, weak = 0, fresh = 0 }, attempts) {
  const cards = [];
  for (let at = 0; at < due; at++) { const card = make(`${id}-due${at}`, 'due'); cards.push(card); attempts.push({ deckId: id, quiz_id: card.id, grade: 4, timestamp: PAST }); }
  for (let at = 0; at < weak; at++) { const card = make(`${id}-weak${at}`); cards.push(card); attempts.push({ deckId: id, quiz_id: card.id, grade: 1, timestamp: PAST }); }
  for (let at = 0; at < fresh; at++) cards.push(make(`${id}-new${at}`));
  return { id, title: id, course, cards };
}
function library({ a = { due: 3, weak: 2, fresh: 30 }, b = { due: 4 }, settings, focus = { mode: 'class', course: 'A' } } = {}) {
  const state = emptyState(), attempts = [];
  state.decks = [deckOf('a', 'A', a, attempts), deckOf('b', 'B', b, attempts)];
  state.attempts = attempts;
  state.focus = focus;
  if (settings) state.settings = { ...state.settings, practice: settings };
  return state;
}
async function service(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'study-daily-path-'));
  const instance = new StudyService(root);
  t.after(async () => { instance.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const state = library(options);
  await instance.store.update((s) => { Object.assign(s, { decks: state.decks, attempts: state.attempts, focus: state.focus }); if (state.settings.practice) s.settings.practice = state.settings.practice; });
  return instance;
}

test('planPath reports what the round holds, counted over its own cards, and how much waits behind it', () => {
  const state = library();
  const plan = planPath(state.decks.filter((deck) => deck.id === 'a'), (deckId, cardId) => state.attempts.findLast((x) => x.deckId === deckId && x.quiz_id === cardId)?.grade, { now: NOW });
  assert.equal(plan.size, 15, '3 due + 2 weak + 10 new (the new limit)');
  assert.deepEqual(plan.round, { due: 3, weak: 2, new: 10 });
  assert.equal(plan.more, 20, 'the other new cards wait for a later round');
  assert.deepEqual(plan.counts, { due: 3, weak: 2, new: 30 }, 'the pool counts stay as they were');
  const capped = planPath(state.decks, (deckId, cardId) => state.attempts.findLast((x) => x.deckId === deckId && x.quiz_id === cardId)?.grade, { now: NOW, limit: 8, newLimit: 4 });
  assert.equal(capped.size, 8);
  assert.deepEqual(capped.round, { due: 7, weak: 1, new: 0 }, 'a round of 8 holds all 7 due cards (the least likely to be recalled first) and the first weak one');
  assert.equal(capped.more, 3 + 4 + 2 + 30 - 8);
});

/* Due questions are ordered by predicted recall (#881): within the 重点 tier, the question least likely to be recalled now comes first;
   equal recall goes by due date, then by the library's own order. */
const DAY = 864e5;
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
/** A question answered `lastDaysAgo` days before NOW with this stability, due `dueDaysAgo` days before NOW (FSRS form). */
const dueCard = (id, stability, lastDaysAgo, dueDaysAgo, extra = {}) => ({ ...make(id), ...extra, review: { algorithm: 'fsrs-6', stability, difficulty: 5, reps: 3, lapses: 0,
  repetitions: 3, interval_days: lastDaysAgo - dueDaysAgo, ease_factor: 2.5, last_review: at(lastDaysAgo), due_at: at(dueDaysAgo) } });
/** A backlog whose due-date order and recall order differ. Recall at NOW in the comments (FSRS-6 default weights). */
const backlog = () => [
  dueCard('twin-1', 20, 30, 10), //            R 0.870, due first by date
  dueCard('twin-2', 20, 30, 10), //            the same state: stays after twin-1
  dueCard('long-gap', 60, 65, 5), //           R 0.894: a long gap a little overdue
  dueCard('short-gap', 3, 6, 3), //            R 0.846: a short gap long overdue
  { ...make('legacy'), review: { repetitions: 2, interval_days: 2, ease_factor: 2.5, due_at: at(2) } }, // SM-2: last answer 4 days ago, R(4, 2) = R(6, 3)
  dueCard('focus-safe', 100, 101, 1, { focus: true }), // R 0.900, but a 重点 question
];
const BY_RECALL = ['focus-safe', 'short-gap', 'legacy', 'twin-1', 'twin-2', 'long-gap'];

test('due questions come least likely to be recalled first, inside the 重点 tier; equal recall goes by due date, then library order', () => {
  const plan = planPath([{ id: 'a', title: 'a', cards: backlog() }], () => undefined, { now: NOW });
  assert.deepEqual(plan.entries.map((entry) => entry.card.id), BY_RECALL,
    'by due date this was focus-safe, twin-1, twin-2, long-gap, short-gap, legacy');
  assert.deepEqual(plan.round, { due: 6, weak: 0, new: 0 });
});

test('a prerequisite is still placed before the due question that needs it, after the recall order', () => {
  const cards = backlog();
  cards.find((card) => card.id === 'short-gap').requires = [{ deckId: 'a', cardId: 'pre' }];
  cards.push(make('pre'), make('new-1'));
  const plan = planPath([{ id: 'a', title: 'a', cards }], (_deck, card) => (card === 'pre' ? 1 : undefined), { now: NOW });
  assert.deepEqual(plan.entries.map((entry) => entry.card.id), ['focus-safe', 'pre', 'short-gap', 'legacy', 'twin-1', 'twin-2', 'long-gap', 'new-1']);
});

test('a due FSRS record with no known last review is reached: first in its tier, inside a round smaller than the backlog', () => {
  const cards = backlog();
  cards.push({ ...make('no-last'), review: { algorithm: 'fsrs-6', stability: 20, difficulty: 5, repetitions: 3, interval_days: 20, due_at: at(4) } });
  const plan = planPath([{ id: 'a', title: 'a', cards }], () => undefined, { now: NOW, limit: 3 });
  assert.equal(plan.counts.due, 7, 'a backlog of 7 due questions');
  assert.deepEqual(plan.entries.map((entry) => entry.card.id), ['focus-safe', 'no-last', 'short-gap'],
    'the 重点 question, then the record without a last review (recall 0), then the lowest recall');
});

test('one now, one round: the home card and the round 开始今日学习 starts hold the same questions in the same order', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const root = await mkdtemp(join(tmpdir(), 'study-daily-path-'));
  const study = new StudyService(root);
  t.after(async () => { study.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const attempts = [];
  const a = deckOf('a', 'A', { weak: 2, fresh: 3 }, attempts), b = deckOf('b', 'B', { due: 2 }, attempts);
  a.cards.unshift(...backlog());
  await study.store.update((s) => Object.assign(s, { decks: [a, b], attempts, focus: { mode: 'class', course: 'A' } }));
  const snapshot = await study.call('snapshot');
  const home = dailyPlan(await study.store.read(), { now: NOW });
  const run = await study.call('review.start', { mode: 'path', fresh: false, course: 'A', daily: true });
  const started = (await study.store.read()).runs.find((item) => item.id === run.id).entries.map((entry) => entry.card.id);
  assert.deepEqual(started, home.plan.entries.map((entry) => entry.card.id), 'the started round is the home plan, card for card');
  assert.equal(snapshot.today.size, started.length, 'and the home number counts it');
  assert.deepEqual(started, [...BY_RECALL, 'a-weak0', 'a-weak1', 'a-new0', 'a-new1', 'a-new2']);
});

test('the home number is the current course alone: its round, its breakdown, and the others said once', () => {
  const map = studyMap(library(), NOW);
  assert.equal(map.today.course, 'A');
  assert.equal(map.today.size, 15);
  assert.deepEqual([map.today.due, map.today.weak, map.today.new], [3, 2, 10], 'the breakdown adds up to the number');
  assert.equal(map.today.more, 20);
  assert.equal(map.today.elsewhere, 4, 'course B has 4 reviews due: one number, labelled, not mixed in');
  assert.deepEqual(map.today.scope, [{ deckId: 'a' }], 'the scope that round runs on, so the home can find its open run');
  assert.equal(map.today.ahead, false);
});

test('the other course becomes the number when the learner switches to it; an interview course stays scoped to itself, and with no courses it is null', () => {
  const b = studyMap(library({ focus: { mode: 'class', course: 'B' } }), NOW);
  assert.deepEqual([b.today.course, b.today.size, b.today.due, b.today.elsewhere], ['B', 4, 4, 5], 'A has 3 due and 2 weak');
  const interviewState = library({ focus: { mode: 'class', course: '笔试 / 面试' } });
  interviewState.courses = [{ id: 'course-iv', name: '笔试 / 面试', interview: { role: '后端' } }];
  const interview = studyMap(interviewState, NOW);
  assert.equal(interview.today.course, '笔试 / 面试');
  assert.deepEqual([interview.today.due, interview.today.weak, interview.today.new, interview.today.size], [0, 0, 0, 0]);
  assert.equal(interview.today.elsewhere, 9, 'interview prep is its own course rather than mixing A and B');
  assert.deepEqual(interview.today.scope, []);
  const empty = studyMap({ ...emptyState(), focus: { mode: 'class' } }, NOW);
  assert.equal(empty.today.course, null);
  assert.deepEqual(empty.today.scope, []);
});

test('a course with nothing to do says so and still points at the work elsewhere', () => {
  const map = studyMap(library({ a: { fresh: 0 } }), NOW);
  assert.deepEqual([map.today.course, map.today.size, map.today.elsewhere], ['A', 0, 4]);
});

test('the round size of the Settings page sets the cap, and half of it at most is new', () => {
  const map = studyMap(library({ settings: { roundSize: 10 } }), NOW);
  assert.equal(map.today.size, 10);
  assert.deepEqual([map.today.due, map.today.weak, map.today.new], [3, 2, 5]);
  const small = studyMap(library({ settings: { roundSize: 5 } }), NOW);
  assert.equal(small.today.size, 5);
  assert.equal(studyMap(library({ settings: { roundSize: 'x' } }), NOW).today.size, 15, 'a wrong saved value is the default');
});

test('review.start with daily on a course starts that course\'s round, resumes it, and remembers the course', async (t) => {
  const study = await service(t);
  const run = await study.call('review.start', { mode: 'path', course: 'A', daily: true });
  assert.equal(run.total, 15, 'the same 15 the home card promised, not the 35 cards of the course');
  assert.deepEqual(run.scope, [{ deckId: 'a' }]);
  assert.equal(run.dailyCourse, 'A');
  assert.equal(run.deckId, 'a');
  assert.equal((await study.call('review.start', { mode: 'path', course: 'A', daily: true })).id, run.id, 'an open round is resumed, not doubled');
  const snapshot = await study.call('snapshot');
  assert.deepEqual(snapshot.runs.map((item) => item.scope), [[{ deckId: 'a' }]]);
  assert.equal(snapshot.today.size, 15);
});

test('without daily, a course path still means the whole course (nothing that used to work changes)', async (t) => {
  const study = await service(t);
  const run = await study.call('review.start', { mode: 'path', scope: [{ deckId: 'a' }] });
  assert.equal(run.total, 35);
  assert.equal(run.dailyCourse, undefined);
});

test('the default path and the course round both follow the round size', async (t) => {
  const study = await service(t, { settings: { roundSize: 10 } });
  assert.equal((await study.call('review.start', { mode: 'path' })).total, 10, 'every active course, ten questions');
  const course = await study.call('review.start', { mode: 'path', course: 'A', daily: true });
  assert.equal(course.total, 10);
  assert.equal(course.dailyCourse, 'A');
});

test('daily is only for a course: a scope the caller lists is studied whole, whatever else is said', async (t) => {
  const study = await service(t);
  const run = await study.call('review.start', { mode: 'path', scope: [{ deckId: 'a' }], daily: true });
  assert.equal(run.total, 35);
  assert.equal(run.dailyCourse, undefined);
});

test('a course without decks cannot start a round', async (t) => {
  const study = await service(t);
  await assert.rejects(study.call('review.start', { mode: 'path', course: 'Nothing', daily: true }), /当前范围没有可用题目/);
});
