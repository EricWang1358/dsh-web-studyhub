/* 深度定制 (4.4 S5): 补齐, one action that fills what a chapter is missing by starting EXISTING work only (the book build, generate, coach.variants) and writes nothing of its
   own. The model here never answers: a job it starts stays running, so what was started is what the jobs say. No real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { libraryContracts } from '../lib/study-contracts.js';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, planOf, service as library } from './helpers/readiness-library.mjs';
import { fillCourse } from '../lib/custom-fill.js';

/** A model that waits for the stop: every call it gets is counted. */
function waiting() {
  const calls = [];
  const complete = (system, prompt, options) => { calls.push({ system, prompt }); return new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('stopped')))); };
  return { calls, complete };
}
async function world(t, over = {}) {
  const model = waiting();
  const made = await library(t, { ...over, options: { complete: model.complete, ...switchOptions('runtime', { complete: model.complete, paths: [] }) } });
  const jobs = () => [...made.study.runtime.work.jobs.values()];
  const fill = (args = {}) => made.study.call('course.custom.fill', { course: COURSE, ...args });
  return { ...made, model, jobs, fill };
}
/** The page a chapter's points are read from: one of the two pages of a chapter (the fixture repeats a chapter's text on both, and a repeated text is one passage). */
const pages = n => [1, 3, 5].map(page => `document-l${n}-p${page}`);

test('estimate: true says what would start and the rough calls, and starts nothing', async t => {
  const w = await world(t);
  const answer = await w.fill({ estimate: true });
  assert.equal(answer.status, 'ok');
  assert.equal(answer.estimate, true);
  assert.deepEqual(answer.chapters, ['c1', 'c2', 'c3']);
  assert.deepEqual({ chapters: answer.book.chapters, points: answer.book.points }, { chapters: ['c3'], points: 1 }, 'the points without a written explanation');
  assert.deepEqual({ points: answer.questions.points, chapters: answer.questions.chapters, sources: answer.questions.sources }, { points: 3, chapters: 1, sources: 3 }, 'the points without a question, and how many pages they are');
  assert.deepEqual({ cards: answer.variants.cards, points: answer.variants.points }, { cards: 1, points: 1 }, 'one weak question');
  assert.ok(answer.questions.calls.high >= answer.questions.calls.low && answer.questions.calls.low > 0, 'the question run priced as the generate form prices it');
  assert.deepEqual(answer.variants.calls, { low: 1, high: 1 });
  assert.ok(answer.book.calls.low > 0, 'the estimate of the build itself');
  assert.equal(answer.calls.low, answer.book.calls.low + answer.questions.calls.low + 1, 'the sum of what is known');
  assert.equal(answer.started, undefined);
  assert.equal(w.jobs().length, 0, 'nothing was started');
  assert.equal(w.model.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(answer), /price|usd|cny|¥|\$|元|费用/i);
});

test('a chapter with three unasked points starts ONE question job over exactly those points\' pages and nothing else; a repeat starts nothing new', async t => {
  const w = await world(t);
  const first = await w.fill({ chapters: ['c2'] });
  assert.equal(first.status, 'ok');
  assert.equal(first.book, null, 'its points are written');
  assert.equal(first.variants, null, 'nothing was answered wrong there');
  assert.equal(first.questions.points, 3);
  assert.ok(first.started.questions.jobId, JSON.stringify(first.started));
  assert.deepEqual(Object.keys(first.started), ['questions']);
  const started = w.jobs();
  assert.equal(started.length, 1);
  assert.deepEqual([...started[0].sourceIds].sort(), pages(2), 'the pages of the requirements chapter, and of no other');
  assert.equal(started[0].course, COURSE);
  assert.deepEqual(started[0].kinds, ['quiz', 'cloze'], 'the plan\'s kinds');
  assert.equal(started[0].coveragePlan.level, 'lean', 'the plan\'s strength');
  const again = await w.fill({ chapters: ['c2'] });
  assert.deepEqual(again.started, { questions: { alreadyRunning: true } });
  assert.equal(w.jobs().length, 1, 'no second job');
});

test('a point whose question waits in a draft is not asked again', async t => {
  const w = await world(t);
  await w.study.store.update(own => {
    const card = structuredClone(own.decks.find(deck => deck.id === 'deck-l3').cards[0]);
    const placed = { ...card, id: 'draft-fr', citations: [{ sourceId: 'document-l2-p1', quote: own.sources.find(source => source.id === 'document-l2-p1').text.slice(0, 40) }] };
    own.drafts.push({ id: 'draft-2', title: 'A draft', course: COURSE, cards: [placed] });
  });
  const answer = await w.fill({ chapters: ['c2'], estimate: true });
  assert.deepEqual({ points: answer.questions.points, sources: answer.questions.sources }, { points: 2, sources: 2 });
});

test('a chapter not written is built through the book build, for that chapter alone; its asked points get no question job', async t => {
  const w = await world(t);
  const answer = await w.fill({ chapters: ['c3'] });
  assert.deepEqual(answer.book, { chapters: ['c3'], points: 1, calls: null });
  assert.equal(answer.questions, null, 'its question exists');
  assert.ok(answer.started.book.jobId, JSON.stringify(answer.started));
  assert.deepEqual(w.jobs().map(job => job.type), ['course-book-build']);
  const again = await w.fill({ chapters: ['c3'] });
  assert.equal(again.started.book.alreadyRunning, true, 'the build answers with the one that runs');
  assert.equal(w.jobs().length, 1);
});

test('weak questions go to the coach\'s variants when the plan ticks them; the coach asks for the consent itself', async t => {
  const w = await world(t);
  const answer = await w.fill({ chapters: ['c1'] });
  assert.equal(answer.status, 'ok');
  assert.deepEqual({ book: answer.book, questions: answer.questions, cards: answer.variants.cards }, { book: null, questions: null, cards: 1 });
  assert.ok(answer.started.variants, 'asked of the coach');
  assert.equal(w.jobs().length, 0, 'no job of this library: the coach\'s own queue does it');
});

test('only the ticked parts: no variants when unticked, no book without the explanations, nothing to do is said', async t => {
  const w = await world(t, { custom: planOf({ questions: { make: true, kinds: ['quiz'], strength: 'lean', variants: false }, book: { make: false, coverage: 'brief', parts: [] } }) });
  const c1 = await w.fill({ chapters: ['c1'] });
  assert.equal(c1.status, 'nothing');
  assert.deepEqual([c1.book, c1.questions, c1.variants], [null, null, null]);
  const c3 = await w.fill({ chapters: ['c3'] });
  assert.equal(c3.status, 'nothing', 'no book was ticked: its missing explanation is not a gap');
  assert.equal(w.jobs().length, 0);
});

test('a chapter the plan did not choose is said, never started; the whole plan is one call', async t => {
  const w = await world(t, { custom: planOf({ scope: { kind: 'chapters', chapters: ['c1', 'c2'] } }) });
  const answer = await w.fill({ chapters: ['c3', 'c2'], estimate: true });
  assert.deepEqual(answer.chapters, ['c2']);
  assert.deepEqual(answer.unknownChapters, ['c3']);
  const all = await w.fill({ estimate: true });
  assert.deepEqual(all.chapters, ['c1', 'c2']);
  assert.equal(all.book, null);
  await assert.rejects(w.fill({ chapters: 'c2' }), /chapters must be|章节需为/);
});

test('a course with no review book or no plan to read says why and starts nothing', async t => {
  const w = await world(t);
  assert.equal((await w.fill({ course: 'No such course' })).status, 'no-course');
  await w.study.store.update(own => { own.sources = own.sources.filter(source => !source.courseOutline && !source.courseNotes); });
  const skeleton = (await w.study.call('course.custom.preview', { course: COURSE })).skeleton;
  const ids = skeleton.documents.find(doc => doc.chapters.length === 3 && !doc.copyOf).chapters.map(chapter => chapter.id);
  await w.study.call('course.save', { name: COURSE, custom: planOf({ scope: { kind: 'chapters', chapters: ids } }) });
  assert.equal((await w.fill({})).status, 'no-outline', 'the points exist only once the outline does');
  assert.equal(w.jobs().length, 0);
});

test('the op writes no record of its own and the chat\'s contract tells it', () => {
  assert.deepEqual(writesFor('library', 'course.custom.fill'), []);
  assert.match(libraryContracts.custom, /course\.custom\.fill \{course\?,chapters\?,estimate\?\}/);
});

/* Gate review of #738: what 补齐 starts must not pay twice, nor at a detail level the plan did not choose. */

test('two fills at once start one question job: the op runs one at a time per library, as apply does', async t => {
  const w = await world(t);
  const [one, two] = await Promise.all([w.fill({ chapters: ['c2'] }), w.fill({ chapters: ['c2'] })]);
  assert.equal(w.jobs().length, 1, JSON.stringify([one.started, two.started]));
  assert.ok([one, two].some(answer => answer.started.questions.alreadyRunning));
});

test('a job running over some of the pages keeps them: the new job reads only the pages no job holds', async t => {
  const w = await world(t);
  await w.study.call('generate', { sourceIds: [pages(2)[0]], course: COURSE, kinds: ['quiz'] });
  assert.equal(w.jobs().length, 1);
  const answer = await w.fill({ chapters: ['c2'] });
  assert.ok(answer.started.questions.jobId, JSON.stringify(answer.started));
  assert.equal(answer.started.questions.leftToRunning, 1, 'the page the running job reads is said, not asked again');
  const fresh = w.jobs().find(job => job.id === answer.started.questions.jobId);
  assert.deepEqual([...fresh.sourceIds].sort(), pages(2).slice(1));
});

test('the book build is asked at the detail level of the plan, with the sample settled, as apply asks it', async t => {
  const w = await world(t);
  const asked = [];
  const call = async (name, args) => { asked.push({ name, args }); return { jobId: 'job-x' }; };
  await fillCourse(await w.study.store.read(), { course: COURSE, chapters: ['c3'] }, { call, busy: () => new Set() });
  const build = asked.find(item => item.name === 'courseBook.build');
  assert.deepEqual(build.args, { course: COURSE, chapters: ['c3'], coverage: 'brief', sample: 'skip' });
});
