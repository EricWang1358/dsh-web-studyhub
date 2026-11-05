/* 深度定制 (4.4 S3): course.custom.apply starts the work a saved 定制方案 asks for, through the jobs that exist. These tests ask what it STARTS (the task records of the library:
   which pages a question run reads, which kinds, how many questions), never what a model writes: the fake model holds every call, so a task stays where it was started.
   No real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { courseSkeleton } from '../lib/custom-skeleton.js';
import { goalOfChars, LIMITS } from '../lib/coverage-strength.js';
import { COURSE, apply, bigBook, lecture, open, plan, questionJobs, save, steps } from './helpers/custom-apply-world.mjs';

test('no saved plan, no course: nothing starts, and it says which', async t => {
  const study = await open(t);
  const none = await apply(study);
  assert.deepEqual([none.status, none.started, none.waiting, none.recorded, none.done], ['no-plan', [], [], [], []]);
  assert.equal((await apply(study, { course: 'Nope' })).status, 'no-course');
  assert.equal(questionJobs(study).length, 0);
});

test('a plan of chapters 3-4 with the kinds quiz and truefalse: question runs whose pages are those chapters only and whose kinds are those only', async t => {
  const study = await open(t), skeleton = courseSkeleton(await study.store.read(), COURSE), doc = lecture(skeleton, 3);
  await save(study, plan({ scope: { kind: 'chapters', chapters: [doc.chapters[0].id, doc.chapters[1].id] }, questions: { make: true, kinds: ['quiz', 'truefalse'], strength: 'standard', variants: true } }));
  const answer = await apply(study);
  assert.equal(answer.status, 'ok');
  const jobs = questionJobs(study);
  assert.equal(jobs.length, steps(answer, 'started', 'questions').length);
  assert.ok(jobs.length >= 1);
  const pages = jobs.flatMap(job => job.sourceIds).sort();
  assert.deepEqual(pages, ['document-l3-p1', 'document-l3-p2', 'document-l3-p3', 'document-l3-p4'], 'the pages of the two chapters, each once, and no other page of the course');
  for (const job of jobs) {
    assert.deepEqual(job.kinds, ['quiz', 'truefalse'], 'a mixed run limited to those kinds');
    assert.equal(job.course, COURSE);
  }
  assert.deepEqual(steps(answer, 'started', 'questions').map(item => item.jobId).sort(), jobs.map(job => job.id).sort());
  assert.deepEqual(steps(answer, 'started', 'book'), [], 'the book was not asked for');
});

test('saying it again starts nothing new: the runs that are going are named, not repeated', async t => {
  const study = await open(t), doc = lecture(courseSkeleton(await study.store.read(), COURSE), 3);
  await save(study, plan({ scope: { kind: 'chapters', chapters: [doc.chapters[0].id] }, questions: { make: true, kinds: ['quiz'], strength: 'lean', variants: false } }));
  const first = await apply(study), before = [...study.runtime.work.jobs.keys()];
  const second = await apply(study);
  assert.deepEqual([...study.runtime.work.jobs.keys()], before, 'no job was added');
  assert.deepEqual(second.started.map(item => item.jobId), first.started.map(item => item.jobId));
  assert.match(second.started[0].what, /没有再开/);
});

test('a 1,500 question want over 3 chapters is not cut to 500', async t => {
  const study = await open(t, { library: bigBook() });
  const skeleton = courseSkeleton(await study.store.read(), 'Big'), [doc] = skeleton.documents, chars = doc.chapters.reduce((sum, chapter) => sum + chapter.chars, 0);
  assert.equal(doc.chapters.length, 3);
  const wanted = doc.chapters.reduce((sum, chapter) => sum + goalOfChars(chapter.chars, 'full'), 0);
  assert.ok(wanted > 1400 && wanted < 1700, `a want of ${wanted} questions over ${chars} characters`);
  await study.call('course.save', { name: 'Big', custom: plan({ scope: { kind: 'chapters', chapters: doc.chapters.map(chapter => chapter.id) }, questions: { make: true, kinds: ['quiz'], strength: 'full', variants: false } }) });
  const answer = await apply(study, { course: 'Big' });
  const jobs = questionJobs(study);
  assert.deepEqual(answer.waiting, [], JSON.stringify(answer.waiting));
  assert.ok(jobs.length >= 3, `${jobs.length} runs`);
  for (const job of jobs) assert.ok(job.coveragePlan.goal <= LIMITS.total, `a run of ${job.coveragePlan.goal} is within what one run is planned for`);
  const total = jobs.reduce((sum, job) => sum + job.coveragePlan.goal, 0);
  assert.ok(total > 1000, `the runs add up to ${total}, not to ${LIMITS.total}`);
  assert.deepEqual(jobs.flatMap(job => job.sourceIds).length, 30, 'every page once');
});

test('without a model nothing is started and it says so, the plan stays saved', async t => {
  const study = await open(t, { model: false }), doc = lecture(courseSkeleton(await study.store.read(), COURSE), 3);
  await save(study, plan({ scope: { kind: 'chapters', chapters: [doc.chapters[0].id] }, questions: { make: true, kinds: ['quiz'], strength: 'lean', variants: false }, book: { make: true, coverage: 'brief', parts: ['explain'] } }));
  const answer = await apply(study);
  assert.deepEqual(answer.started, []);
  assert.ok(steps(answer, 'waiting', 'questions').length >= 1);
  assert.match(JSON.stringify(answer.waiting), /模型/);
  assert.equal((await study.call('course.get', { name: COURSE })).custom.purpose, 'follow');
});

test('a chapter that names nothing now is not guessed: the book waits and says which', async t => {
  const study = await open(t);
  await save(study, plan({ scope: { kind: 'chapters', chapters: ['gone#9'] }, book: { make: true, coverage: 'brief', parts: ['explain'] } }));
  const answer = await apply(study);
  assert.deepEqual(steps(answer, 'started', 'book'), []);
  assert.match(steps(answer, 'waiting', 'book')[0].what, /gone#9/);
});
