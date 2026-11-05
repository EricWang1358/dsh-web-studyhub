/* 深度定制 (4.4 S3): a 备考计划 by chapters per week, with no exam date (lib/plan-schedule.js, lib/plan-weekly.js). `plan.by: 'weekly'` + `chaptersPerWeek` lays the
   book's chapters out week after week from the plan's start date; every study day of a week carries the points of that week's chapters; what is not learnt when its
   week is over moves into the current week, nothing is dropped; the weeks never move with today. `by: 'exam'` is what it always was. No I/O, no model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { periodPlan } from '../lib/plan-schedule.js';
import { addDays } from '../lib/crunch-plan.js';
import { checkedPlan } from '../lib/courses.js';
import { chaptersOfBook, weekLine } from '../lib/plan-weekly.js';
import { localDate } from '../lib/board-model.js';
import { bookKey } from '../lib/course-outline-book-view.js';
import { customDefaults } from '../lib/custom-plan.js';
import { COURSE, service } from './helpers/crunch-library.mjs';

const TODAY = '2026-10-11'; // a Sunday
const point = (id, order) => ({ id, order, tested: 0, weakness: 0.3, questions: 10, size: 1500, pitfalls: 0 });
const POINTS = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'd1', 'd2'].map(point);
const CHAPTERS = [['a', 'A'], ['b', 'B'], ['c', 'C'], ['d', 'D']].map(([key, title], at) => ({ n: at + 1, title, ids: [`${key}1`, `${key}2`] }));
const weekly = (plan = {}, extra = {}) => periodPlan({ points: POINTS, chapters: CHAPTERS, plan: { by: 'weekly', chaptersPerWeek: 2, startDate: TODAY, ...plan }, today: TODAY, ...extra });
const learnDays = schedule => schedule.days.filter(day => day.mode === 'learn' && day.offset >= 0);

test('the plan record keeps by and chaptersPerWeek, checked; exam is the default and a stray chaptersPerWeek is not kept', () => {
  assert.equal(checkedPlan({ version: 1 }).by, undefined, 'nothing the learner did not say');
  assert.equal(checkedPlan({ version: 1, by: 'weekly', chaptersPerWeek: 3 }).chaptersPerWeek, 3);
  assert.equal(checkedPlan({ version: 1, by: 'weekly', chaptersPerWeek: 3 }).by, 'weekly');
  assert.equal(checkedPlan({ version: 1, by: 'exam', chaptersPerWeek: 3 }).chaptersPerWeek, undefined);
  assert.throws(() => checkedPlan({ version: 1, by: 'monthly' }), /by 需为 exam 或 weekly/);
  assert.throws(() => checkedPlan({ version: 1, by: 'weekly', chaptersPerWeek: 11 }), /1–10/);
  assert.throws(() => checkedPlan({ version: 1, by: 'weekly', chaptersPerWeek: 1.5 }), /1–10/);
});

test('without an exam date a weekly plan has a schedule: two chapters a week, the weeks from the start date', () => {
  const plan = weekly();
  assert.equal(plan.status, 'ok');
  assert.equal(plan.examDate, null);
  assert.equal(plan.daysLeft, null);
  assert.equal(plan.weekly.chaptersPerWeek, 2);
  assert.deepEqual(plan.weekly.weeks.map(week => [week.n, week.from, week.until, week.chapters.map(chapter => chapter.n)]),
    [[1, TODAY, addDays(TODAY, 6), [1, 2]], [2, addDays(TODAY, 7), addDays(TODAY, 13), [3, 4]]]);
  assert.equal(plan.weekly.thisWeek, 1);
  assert.deepEqual([plan.weekly.position, plan.weekly.startsOn, plan.weekly.endsOn], ['during', TODAY, addDays(TODAY, 13)]);
  assert.deepEqual(plan.weekly.current.chapters.map(chapter => chapter.title), ['A', 'B']);
  const ids = week => learnDays(plan).filter(day => day.week === week).flatMap(day => day.points).sort();
  assert.deepEqual(ids(1), ['a1', 'a2', 'b1', 'b2'], 'week 1 carries the points of chapters 1 and 2');
  assert.deepEqual(ids(2), ['c1', 'c2', 'd1', 'd2']);
  assert.deepEqual(plan.coverage, { total: 8, scheduled: 8, unplaced: [] });
  assert.equal(plan.days.at(-1).date, addDays(TODAY, 13), 'the schedule ends with the last week, not with an exam');
  assert.equal(plan.today.week, 1);
  assert.deepEqual(plan.today.reason, { code: 'week', week: 1, chapters: [1, 2], count: plan.today.points.length, minutes: plan.today.minutes });
  assert.equal(plan.progress.totalDays, 14);
});

test('one chapter a week; a last week with the chapters that are left', () => {
  const one = weekly({ chaptersPerWeek: 1 });
  assert.equal(one.weekly.weeks.length, 4);
  const three = weekly({ chaptersPerWeek: 3 });
  assert.deepEqual(three.weekly.weeks.map(week => week.chapters.map(chapter => chapter.n)), [[1, 2, 3], [4]]);
});

test('rest days and study weekdays are kept: the week points go on the days that are left', () => {
  const plan = weekly({ studyWeekdays: [1, 3] });
  const days = learnDays(plan).filter(day => day.week === 1);
  assert.deepEqual(days.map(day => day.date), [addDays(TODAY, 1), addDays(TODAY, 3)], 'Monday and Wednesday');
  assert.equal(days.flatMap(day => day.points).length, 4);
  assert.ok(plan.days.filter(day => day.mode === 'off').length >= 4);
});

test('the weeks do not move with today: a week that is over leaves what was not learnt in the current week', () => {
  const later = weekly({}, { today: addDays(TODAY, 8) });
  assert.equal(later.weekly.thisWeek, 2);
  assert.equal(later.weekly.weeks[0].from, TODAY, 'the start date is the plan, not today');
  assert.deepEqual(learnDays(later).flatMap(day => day.points).sort(), ['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'd1', 'd2'], 'week 1 was not learnt: it is placed in week 2');
  assert.equal(later.weekly.behind, 4);
  assert.equal(learnDays(later).reduce((sum, day) => sum + (day.reason.carried ?? 0), 0), 4, 'each day says how many of its points are owed from earlier weeks');
  const done = weekly({}, { today: addDays(TODAY, 8), done: { a1: TODAY, a2: TODAY, b1: addDays(TODAY, 2), b2: addDays(TODAY, 3) } });
  assert.equal(done.weekly.behind, 0, 'learnt points are not owed');
  assert.deepEqual(learnDays(done).flatMap(day => day.points).sort(), ['c1', 'c2', 'd1', 'd2']);
});

test('after the last week: still ok, no current week, what is left is said', () => {
  const over = weekly({}, { today: addDays(TODAY, 20) });
  assert.equal(over.status, 'ok');
  assert.equal(over.weekly.thisWeek, null);
  assert.equal(over.weekly.position, 'over');
  assert.equal(weekly({ startDate: addDays(TODAY, 3) }).weekly.position, 'before');
  assert.equal(over.weekly.current, null);
  assert.deepEqual(over.days, []);
  assert.equal(over.coverage.unplaced.length, 8);
});

test('a weekly plan ignores the exam date; a plan by exam with no date is still no-exam', () => {
  assert.equal(weekly({}, { examDate: addDays(TODAY, 5) }).days.at(-1).date, addDays(TODAY, 13));
  const none = periodPlan({ points: POINTS, chapters: CHAPTERS, plan: { by: 'exam' }, today: TODAY });
  assert.equal(none.status, 'no-exam');
  assert.equal('weekly' in none, false);
  const plain = periodPlan({ points: POINTS, plan: { by: 'weekly', chaptersPerWeek: 2 }, today: TODAY });
  assert.equal(plain.status, 'no-exam', 'a weekly plan with no chapters to lay out has nothing to schedule');
});

test('the chapters of a book are its top-level nodes, each with its points; the line for a week names them', () => {
  const nodes = [{ title: 'Basics', leaf: false, children: [{ hid: 'p1', leaf: true }, { hid: 'p2', leaf: true }] }, { title: 'Memory', leaf: false, children: [{ hid: 'p3', leaf: true }] },
    { hid: 'p4', title: 'Lone', leaf: true }];
  assert.deepEqual(chaptersOfBook(nodes), [{ n: 1, title: 'Basics', ids: ['p1', 'p2'] }, { n: 2, title: 'Memory', ids: ['p3'] }, { n: 3, title: 'Lone', ids: ['p4'] }]);
  // A plan of chosen chapters schedules those only, under the numbers the book gives them.
  const keyed = ['a', 'b', 'c', 'd'].map(id => ({ key: `book:${id}`, title: id.toUpperCase(), leaf: false, children: [{ hid: `${id}1`, leaf: true }] }));
  assert.deepEqual(chaptersOfBook(keyed, new Set(['book:c', 'book:d'])).map(chapter => [chapter.n, chapter.title, chapter.ids]), [[3, 'C', ['c1']], [4, 'D', ['d1']]]);
  assert.equal(chaptersOfBook(keyed, new Set(['book:zzz'])).length, 4, 'ids that name no chapter of the book choose nothing: every chapter');
  assert.equal(chaptersOfBook(keyed).length, 4);
  assert.deepEqual(weekLine({ chapters: [{ n: 3 }, { n: 4 }] }), { from: 3, to: 4, count: 2 });
  assert.deepEqual(weekLine({ chapters: [{ n: 5 }] }), { from: 5, to: 5, count: 1 });
});

test('course.plan answers a weekly plan with no exam date: the book chapter is this week, and a plan by exam with no date still says no-exam', async t => {
  const { study } = await service(t);
  await study.call('course.save', { name: COURSE, plan: { version: 1, by: 'exam' } });
  assert.equal((await study.call('course.plan', { course: COURSE })).status, 'no-exam');
  await study.call('course.save', { name: COURSE, plan: { version: 1, by: 'weekly', chaptersPerWeek: 2, minutesPerDay: 60 } });
  const answer = await study.call('course.plan', { course: COURSE, date: localDate() });
  assert.equal(answer.status, 'ok');
  assert.equal(answer.examDate, null);
  assert.equal(answer.schedule.weekly.thisWeek, 1);
  assert.deepEqual(answer.schedule.weekly.current.chapters.map(chapter => chapter.title), ['Introduction']);
  assert.equal(answer.schedule.today.week, 1);
  assert.ok(answer.schedule.today.points.length > 0);
  assert.equal(answer.plan.by, 'weekly');
  // A custom plan that chose chapters limits the weeks to them: the ids are the outline's, and the book's chapter keys are those ids under the book prefix.
  assert.equal((await study.call('course.book.open')).nodes[0].key, bookKey('c1'));
  await study.call('course.save', { name: COURSE, custom: { ...customDefaults('follow'), scope: { kind: 'chapters', chapters: ['c1'] } } });
  assert.deepEqual((await study.call('course.plan', { course: COURSE, date: localDate() })).schedule.weekly.current.chapters.map(chapter => chapter.n), [1]);
});
