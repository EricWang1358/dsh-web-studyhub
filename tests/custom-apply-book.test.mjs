/* 深度定制 (4.4 S3): the book step of course.custom.apply. The review book is built by the existing generation.courseBook.build, only for the chapters of the plan (the ids of the
   current outline), at the plan's detail level; saying it again does not write it twice; without a model nothing starts. Fake model of the book build (the same as
   tests/book-pick-chapters.test.mjs), no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { bookModel } from './helpers/course-book-model.mjs';
import { isCourseNotesSource } from '../lib/exam-point-list.js';
import { SAMPLE_FROM } from '../lib/contexts/generation/book/constants.js';
import { apply, plan, save, steps } from './helpers/custom-apply-world.mjs';

async function world(t) {
  const fake = bookModel(), root = await privateRoot(t, 'custom-apply-book-');
  const study = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => study.dispose());
  const built = outlineLibrary();
  await study.store.update(state => { state.sources.push(...structuredClone(built.sources)); state.decks.push(...structuredClone(built.decks)); state.focus = { mode: 'class', course: COURSE }; });
  const organised = await settleJob(study, (await study.call('generation.courseOutline.build', { course: COURSE, language: 'zh' })).jobId);
  assert.equal(organised.status, 'complete');
  return { study, fake };
}
const notesOf = async study => (await study.store.read()).sources.filter(isCourseNotesSource).find(record => !record.archived);

test('the book of a plan of one chapter: only that chapter is written, with the plan\'s detail level, and saying it again writes nothing more', async t => {
  const { study, fake } = await world(t);
  const { skeleton } = await study.call('course.custom.preview', { course: COURSE });
  assert.equal(skeleton.basis, 'outline');
  const chapter = skeleton.outline.chapters.find(item => item.points > 0 && item.points < SAMPLE_FROM);
  await save(study, plan({ scope: { kind: 'chapters', chapters: [chapter.id] }, book: { make: true, coverage: 'brief', parts: ['explain'] } }));
  const first = await apply(study), [book] = steps(first, 'started', 'book');
  assert.ok(book.jobId, 'the build is a task of the console');
  assert.equal(steps(first, 'recorded', 'book-parts').length, 0, 'the build leaves out the parts the plan does not tick (S2): nothing is only recorded');
  assert.equal((await settleJob(study, book.jobId)).status, 'complete');
  const written = (await notesOf(study)).courseNotes.leaves.filter(leaf => leaf.body && !leaf.body.empty);
  assert.ok(written.length > 0 && written.length <= chapter.points, 'only the points of the chapter');
  const calls = fake.calls.length, second = await apply(study);
  assert.equal(steps(second, 'started', 'book').length, 0, 'nothing started');
  assert.equal(steps(second, 'done', 'book').length, 1);
  assert.equal(fake.calls.length, calls, 'the model was not asked again');
});

test('a book of a whole-course scope is built without a pick; the sample first waits for the learner and is not made again', async t => {
  const { study } = await world(t), { skeleton } = await study.call('course.custom.preview', { course: COURSE });
  const total = skeleton.outline.chapters.reduce((sum, chapter) => sum + chapter.points, 0);
  assert.ok(total >= SAMPLE_FROM, `${total} points make a sample`);
  await save(study, plan({ book: { make: true, coverage: 'brief', parts: ['explain'] }, sampleFirst: true }));
  const first = await apply(study), [book] = steps(first, 'started', 'book');
  assert.match(book.what, /样例/);
  assert.equal((await settleJob(study, book.jobId)).status, 'complete');
  const sample = (await notesOf(study)).courseNotes.sample;
  assert.equal(sample.status, 'waiting');
  const written = (await notesOf(study)).courseNotes.leaves.filter(leaf => leaf.body && !leaf.body.empty);
  assert.equal(written.length, 2, 'two points, as the build\'s own rule says');
  const again = await apply(study);
  assert.equal(steps(again, 'started', 'book').length, 0, 'the sample is not made again');
  assert.match(steps(again, 'waiting', 'book')[0].what, /在等你看过/);
  const rest = await apply(study, { confirm: true }), [more] = steps(rest, 'started', 'book');
  assert.equal((await settleJob(study, more.jobId)).status, 'complete');
  const all = (await notesOf(study)).courseNotes.leaves.filter(leaf => leaf.body && !leaf.body.empty);
  assert.ok(all.length > 2, 'the rest of the book is written after the learner said so');
});
