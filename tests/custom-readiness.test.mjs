/* 深度定制 (4.4 S5): how ready each chapter of a course is, read from what the library holds (no model call, nothing written): per chapter the points that are
   explained, asked, practised and solid, one readiness number (the weighted share of solid points), the questions the review sent back, and what is still missing. Only
   the parts the 定制方案 ticked count. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { libraryContracts } from '../lib/study-contracts.js';
import { SOLID_DAYS, cardSolid, pointSolid, readinessOf } from '../lib/custom-readiness.js';
import { COURSE, planOf, service } from './helpers/readiness-library.mjs';

const readiness = (study, args = {}) => study.call('course.custom.readiness', { course: COURSE, ...args });
const row = chapter => ({ id: chapter.id, built: chapter.built, points: chapter.points, explained: chapter.explained, asked: chapter.asked, practised: chapter.practised, solid: chapter.solid, readiness: chapter.readiness });

test('a plan of three chapters: the counts of each, exact, and the readiness of each and of the course', async t => {
  const { study } = await service(t);
  const answer = await readiness(study);
  assert.equal(answer.status, 'ok');
  assert.equal(answer.basis, 'outline');
  assert.deepEqual(answer.counted, { explained: true, questions: true });
  assert.deepEqual(answer.chapters.map(row), [
    // what: one of four questions solid and one weak: not solid. who: both of its questions solid.
    { id: 'c1', built: true, points: 2, explained: 2, asked: 2, practised: 2, solid: 1, readiness: 0.5 },
    // Written and never asked.
    { id: 'c2', built: true, points: 3, explained: 3, asked: 0, practised: 0, solid: 0, readiness: 0 },
    // Not written yet, but its question was answered.
    { id: 'c3', built: false, points: 1, explained: 0, asked: 1, practised: 1, solid: 0, readiness: 0 },
  ]);
  assert.deepEqual(answer.chapters.map(chapter => chapter.title), ['Introduction', 'Requirements', 'Patterns']);
  assert.deepEqual({ points: answer.total.points, solid: answer.total.solid, readiness: answer.total.readiness }, { points: 6, solid: 1, readiness: 0.17 });
  assert.deepEqual(answer.unknownChapters, []);
});

test('what is still missing, by chapter: points to explain, points to ask, questions answered wrong', async t => {
  const { study, ids } = await service(t);
  const [c1, c2, c3] = (await readiness(study)).chapters;
  assert.deepEqual(c1.todo, { explain: 0, questions: 0, weak: 1 });
  assert.deepEqual(c2.todo, { explain: 0, questions: 3, weak: 0 });
  assert.deepEqual(c3.todo, { explain: 1, questions: 0, weak: 0 }, 'nothing to ask: its question was answered');
  assert.equal(ids.what.length, 4);
});

test('a question the review sent back and that waits in a draft is counted in its chapter; what the checks dropped is not recorded, and the answer says so', async t => {
  const { study } = await service(t);
  const answer = await readiness(study);
  assert.deepEqual(answer.chapters.map(chapter => chapter.quality.sentBack), [0, 0, 1]);
  assert.deepEqual(answer.chapters.map(chapter => chapter.drafted), [0, 0, 1]);
  assert.equal(answer.quality.dropped, null, 'dropped candidates are kept per draft, not per chapter, and a published draft is deleted: nothing to say');
});

test('only the ticked parts count: no book, no explained; no questions, no asked, no readiness', async t => {
  const noBook = await service(t, { custom: planOf({ book: { make: false, coverage: 'brief', parts: [] } }) });
  const answer = await readiness(noBook.study);
  assert.deepEqual(answer.counted, { explained: false, questions: true });
  assert.deepEqual(answer.chapters.map(chapter => chapter.explained), [null, null, null]);
  assert.deepEqual(answer.chapters.map(chapter => chapter.solid), [1, 0, 0]);
  assert.equal(answer.chapters[0].todo.explain, 0);
  const noQuestions = await service(t, { custom: planOf({ questions: { make: false, kinds: [], strength: 'lean', variants: false } }) });
  const quiet = await readiness(noQuestions.study);
  assert.deepEqual(quiet.counted, { explained: true, questions: false });
  assert.deepEqual(quiet.chapters.map(chapter => [chapter.explained, chapter.asked, chapter.practised, chapter.solid, chapter.readiness]), [[2, null, null, null, null], [3, null, null, null, null], [0, null, null, null, null]]);
  assert.deepEqual(quiet.chapters.map(chapter => chapter.todo), [{ explain: 0, questions: 0, weak: 0 }, { explain: 0, questions: 0, weak: 0 }, { explain: 1, questions: 0, weak: 0 }]);
  assert.equal(quiet.total.readiness, null);
});

test('only the chapters the plan chose; a chapter id that names nothing is said, not guessed', async t => {
  const { study } = await service(t, { custom: planOf({ scope: { kind: 'chapters', chapters: ['c2', 'nope'] } }) });
  const answer = await readiness(study);
  assert.deepEqual(answer.chapters.map(chapter => chapter.id), ['c2']);
  assert.deepEqual(answer.unknownChapters, ['nope']);
  const all = await service(t, { custom: planOf({ scope: { kind: 'all' } }) });
  assert.deepEqual((await readiness(all.study)).chapters.map(chapter => chapter.id), ['c1', 'c2', 'c3']);
});

test('a course with a review book and no plan shows every chapter, everything counted; a course with neither says so', async t => {
  const { study } = await service(t, { plan: false });
  const answer = await readiness(study);
  assert.equal(answer.status, 'ok');
  assert.equal(answer.plan, false);
  assert.deepEqual(answer.chapters.map(row).map(item => item.id), ['c1', 'c2', 'c3']);
  assert.deepEqual(answer.counted, { explained: true, questions: true });
  assert.equal((await readiness(study, { course: 'No such course' })).status, 'no-course');
  await study.store.update(own => { own.sources = own.sources.filter(source => !source.courseOutline && !source.courseNotes); });
  assert.equal((await readiness(study)).status, 'no-book');
});

test('a plan before the outline exists: its chapters are the materials\' chapters, none of them built', async t => {
  const { study } = await service(t);
  await study.store.update(own => { own.sources = own.sources.filter(source => !source.courseOutline && !source.courseNotes); });
  const skeleton = (await study.call('course.custom.preview', { course: COURSE })).skeleton;
  const ids = skeleton.documents.find(doc => doc.chapters.length === 3 && !doc.copyOf).chapters.map(chapter => chapter.id);
  await study.call('course.save', { name: COURSE, custom: planOf({ scope: { kind: 'chapters', chapters: ids } }) });
  const answer = await readiness(study);
  assert.equal(answer.basis, 'documents');
  assert.equal(answer.chapters.length, 3);
  assert.ok(answer.chapters.every(chapter => chapter.built === false && chapter.points === 0 && chapter.readiness === null && chapter.title));
});

test('solid is defined once: a card is solid when it is 已掌握 or was answered right on two different days (a wrong answer after that undoes it); a point is solid when at least half of its questions are and none is weak', () => {
  assert.equal(SOLID_DAYS, 2);
  assert.equal(cardSolid('mastered', 1), true, 'the schedule says so');
  assert.equal(cardSolid('learning', 2), true, 'right again on a later day');
  assert.equal(cardSolid('learning', 1), false);
  assert.equal(cardSolid('weak', 3), false, 'the last answer was wrong');
  assert.equal(cardSolid('new', 0), false);
  const cards = (...states) => states.map(([solid, weak]) => ({ solid, weak }));
  assert.equal(pointSolid(cards([true, false])), true);
  assert.equal(pointSolid(cards([true, false], [false, false])), true, 'half');
  assert.equal(pointSolid(cards([true, false], [false, false], [false, false])), false, 'a third');
  assert.equal(pointSolid(cards([true, false], [true, false], [false, true])), false, 'one is weak');
  assert.equal(pointSolid([]), false, 'no question, no solid');
});

test('the readiness number is the weighted share of solid points, equal weights unless the book says some matter more', () => {
  assert.equal(readinessOf([]), null);
  assert.equal(readinessOf([{ solid: true, weight: 1 }, { solid: false, weight: 1 }, { solid: false, weight: 1 }, { solid: false, weight: 1 }]), 0.25);
  assert.equal(readinessOf([{ solid: true, weight: 2 }, { solid: false, weight: 1 }]), 0.67, 'a point a sample paper tested counts double');
});

test('the op reads and writes nothing, the chat may call it, and its contract is told', async t => {
  const { study } = await service(t);
  const before = JSON.stringify(await study.call('export'));
  await readiness(study);
  assert.equal(JSON.stringify(await study.call('export')), before);
  assert.deepEqual(writesFor('library', 'course.custom.readiness'), []);
  assert.equal(assistantRefusal('course.custom.readiness'), null);
  assert.match(libraryContracts.custom, /course\.custom\.readiness \{course\?\}/);
});
