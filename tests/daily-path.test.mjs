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
  assert.deepEqual(capped.round, { due: 7, weak: 1, new: 0 }, 'a round of 8 holds the 7 earliest due cards and the first weak one');
  assert.equal(capped.more, 3 + 4 + 2 + 30 - 8);
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

test('the other course becomes the number when the learner switches to it; without a course (or in interview mode) it is every active course', () => {
  const b = studyMap(library({ focus: { mode: 'class', course: 'B' } }), NOW);
  assert.deepEqual([b.today.course, b.today.size, b.today.due, b.today.elsewhere], ['B', 4, 4, 5], 'A has 3 due and 2 weak');
  const interview = studyMap(library({ focus: { mode: 'interview', role: '后端' } }), NOW);
  assert.equal(interview.today.course, null);
  assert.deepEqual([interview.today.due, interview.today.weak, interview.today.new, interview.today.size], [7, 2, 10, 19]);
  assert.equal(interview.today.elsewhere, 0);
  assert.deepEqual(interview.today.scope, []);
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
