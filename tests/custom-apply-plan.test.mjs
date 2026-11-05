/* 深度定制 (4.4 S3): what course.custom.apply does about the study plan and about the sample: a weekly or by-date plan is saved as the course's own 备考计划 once, never over a plan
   agreed another way; with sampleFirst only the first question run starts (its first round) and the rest waits for the learner's 「做完」 (`confirm`). Fake model that holds every call. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { courseSkeleton } from '../lib/custom-skeleton.js';
import { COURSE, apply, bigBook, open, plan, questionJobs, save, steps } from './helpers/custom-apply-world.mjs';

test('a weekly plan is saved as the course plan, once: saying it again leaves it, another plan on the course is not overwritten', async t => {
  const study = await open(t);
  await save(study, plan({ plan: { make: true, by: 'weekly', chaptersPerWeek: 2, minutesPerDay: 90 } }));
  const first = await apply(study);
  assert.equal(steps(first, 'started', 'plan').length, 1);
  assert.match(steps(first, 'started', 'plan')[0].what, /每周 2 章/);
  const saved = (await study.call('course.get', { name: COURSE })).plan;
  assert.deepEqual([saved.by, saved.chaptersPerWeek, saved.minutesPerDay, saved.status], ['weekly', 2, 90, 'active']);
  assert.match(saved.startDate, /^\d{4}-\d\d-\d\d$/);
  const again = await apply(study);
  assert.deepEqual([steps(again, 'started', 'plan').length, steps(again, 'done', 'plan').length], [0, 1]);
  await study.call('course.save', { name: COURSE, plan: { version: 1, status: 'active', minutesPerDay: 60 } });
  const other = await apply(study);
  assert.match(steps(other, 'waiting', 'plan')[0].what, /已经有一份备考计划/);
  assert.equal((await study.call('course.get', { name: COURSE })).plan.minutesPerDay, 60, 'the plan agreed another way is not replaced');
});

test('a plan by the exam date needs the exam date first; with one it is saved', async t => {
  const study = await open(t);
  await save(study, plan({ plan: { make: true, by: 'exam', minutesPerDay: 60 } }));
  const without = await apply(study);
  assert.match(steps(without, 'waiting', 'plan')[0].what, /考试日期/);
  assert.equal('plan' in (await study.call('course.get', { name: COURSE })), false);
  await study.call('course.save', { name: COURSE, exam: { date: '2099-01-01' } });
  const withDate = await apply(study);
  assert.equal(steps(withDate, 'started', 'plan').length, 1);
  assert.equal((await study.call('course.get', { name: COURSE })).plan.by, 'exam');
});

test('sample first: only the first run, its first round, and the others wait; "confirm" starts the rest', async t => {
  const study = await open(t, { library: bigBook() }), [doc] = courseSkeleton(await study.store.read(), 'Big').documents;
  const big = (over = {}) => plan({ scope: { kind: 'chapters', chapters: doc.chapters.map(chapter => chapter.id) }, questions: { make: true, kinds: ['quiz'], strength: 'full', variants: false }, ...over });
  await study.call('course.save', { name: 'Big', custom: big({ sampleFirst: true }) });
  const sample = await apply(study, { course: 'Big' }), [first] = questionJobs(study);
  assert.equal(questionJobs(study).length, 1, 'one run');
  assert.equal(first.coverageRun.autoComplete, false, 'its first round only');
  assert.match(steps(sample, 'waiting', 'questions')[0].what, /样例先行/);
  const confirmed = await apply(study, { course: 'Big', confirm: true });
  assert.ok(questionJobs(study).length >= 3, 'every run is started');
  assert.ok(steps(confirmed, 'started', 'questions').some(item => item.jobId === first.id), 'the sample run is named, not made twice');
  assert.equal(steps(confirmed, 'waiting', 'questions').length, 0);
});
