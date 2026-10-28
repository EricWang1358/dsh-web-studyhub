/* 备考计划 (docs/plans/study-plan.md): the pure schedule of a whole-period plan over the review book's points (lib/plan-schedule.js). The strategy is the
   course record's `plan`; the schedule is deterministic, made again every day from what was really done, never stored, and nothing is dropped silently:
   phases, rest days and weekdays, mock days, review cycles, the exam day, coverage and what could not be placed, a past exam. No I/O, no model.
   Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { periodPlan, PLAN_SCHEDULE } from '../lib/plan-schedule.js';
import { addDays } from '../lib/crunch-plan.js';

const TODAY = '2026-10-11'; // a Sunday
const point = (id, order, extra = {}) => ({ id, order, tested: 0, weakness: 0.3, questions: 10, size: 1500, pitfalls: 0, ...extra });
const BOOK = [
  point('h2', 0, { tested: 2, weakness: 0.9, pitfalls: 1 }), point('h3', 1, { tested: 0, weakness: 0.2 }), point('h4', 2, { tested: 1, weakness: 0.6, pitfalls: 3 }),
  point('h6', 3, { tested: 0, weakness: 0.8 }), point('h7', 4, { tested: 2, weakness: 0.1 }), point('h8', 5, { questions: 0, size: 600 }),
  point('h9', 6, { tested: 1, weakness: 0.4, pitfalls: 2 }), point('h10', 7, { tested: 0, weakness: 0 }),
];
const IDS = BOOK.map(item => item.id).sort();
const make = (days, plan = {}, extra = {}) => periodPlan({ points: BOOK, papers: 2, plan, examDate: addDays(TODAY, days), today: TODAY, ...extra });
const modes = schedule => schedule.days.map(day => day.mode);
const learnIds = schedule => schedule.days.filter(day => day.mode === 'learn' && day.offset >= 0).flatMap(day => day.points);

test('today must be a real day; no exam date and a past exam compute nothing but still count the points', () => {
  assert.throws(() => periodPlan({ points: BOOK, plan: {}, examDate: '2026-12-01', today: 'today' }), /today must be/);
  const none = periodPlan({ points: BOOK, plan: {}, today: TODAY });
  assert.equal(none.status, 'no-exam');
  assert.deepEqual(none.days, []);
  assert.equal(none.today, null);
  assert.equal(none.daysLeft, null);
  assert.equal(none.coverage.total, BOOK.length);
  assert.equal(periodPlan({ points: BOOK, plan: {}, examDate: 'soon', today: TODAY }).status, 'no-exam');
  const past = make(-1);
  assert.equal(past.status, 'past');
  assert.equal(past.daysLeft, -1);
  assert.deepEqual(past.days, []);
  assert.equal(make(5, { startDate: addDays(TODAY, 9) }).status, 'past', 'a plan that starts after the exam has no day');
});

test('ten days to go, no phases: one phase to the exam, every point learnt on exactly one day, the exam day looks at the whole book', () => {
  const plan = make(10);
  assert.equal(plan.status, 'ok');
  assert.equal(plan.daysLeft, 10);
  assert.equal(plan.start, TODAY);
  assert.deepEqual(plan.phases, [{ name: '备考', from: TODAY, until: addDays(TODAY, 10) }]);
  assert.equal(plan.days.length, 11);
  assert.deepEqual(plan.days.map(day => day.offset), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(plan.days.slice(0, 10).every(day => day.mode === 'learn'));
  assert.deepEqual([...learnIds(plan)].sort(), IDS, 'each point on exactly one learn day');
  assert.equal(plan.today, plan.days[0]);
  const exam = plan.days[10];
  assert.deepEqual({ mode: exam.mode, code: exam.reason.code, count: exam.reason.count }, { mode: 'review', code: 'exam-day', count: BOOK.length });
  assert.deepEqual([...exam.points].sort(), IDS);
  assert.equal(exam.points[0], 'h4', 'the point with the most 易错点 first');
  assert.deepEqual(plan.coverage, { total: 8, scheduled: 8, unplaced: [] });
  assert.deepEqual(plan.progress, { learnt: 0, total: 8, elapsedDays: 1, totalDays: 11 });
  assert.equal(plan.weighting, 'papers');
  assert.equal(plan.capacity, PLAN_SCHEDULE.minutesPerDay);
  assert.equal(plan.order.learn[0], 'h2', 'exam weight × weakness: the tested and weak point first');
  assert.equal(plan.order.learn.at(-1), 'h10');
  for (const day of plan.days) assert.ok(day.reason?.code, `${day.date} says why`);
  assert.equal(make(0).days[0].reason.code, 'exam-today');
});

test('phases: each runs from the day after the previous one; the last runs to the exam; a date beyond the exam is clamped; every day names its phase', () => {
  const plan = make(20, { phases: [{ name: 'Foundations', until: addDays(TODAY, 9), goal: 'read every chapter' }, { name: 'Practice', until: addDays(TODAY, 30) }, { name: 'Never reached' }] }, { days: 40 });
  assert.deepEqual(plan.phases, [
    { name: 'Foundations', from: TODAY, until: addDays(TODAY, 9), goal: 'read every chapter' },
    { name: 'Practice', from: addDays(TODAY, 10), until: addDays(TODAY, 20) },
  ], 'the phase after the exam is not drawn');
  assert.equal(plan.days[0].phase, 'Foundations');
  assert.equal(plan.days[9].phase, 'Foundations');
  assert.equal(plan.days[10].phase, 'Practice');
  assert.equal(plan.days[20].phase, 'Practice');
  const open = make(8, { phases: [{ name: 'One', until: addDays(TODAY, 3) }, { name: 'Two' }] });
  assert.deepEqual(open.phases.map(phase => [phase.name, phase.until]), [['One', addDays(TODAY, 3)], ['Two', addDays(TODAY, 8)]]);
});

test('a start date in the future moves the first day; a start date in the past never reaches back before today', () => {
  const later = make(20, { startDate: addDays(TODAY, 5) });
  assert.equal(later.start, addDays(TODAY, 5));
  assert.equal(later.days[0].date, addDays(TODAY, 5));
  assert.equal(later.today, null, 'today is before the plan starts: no day of today');
  assert.deepEqual(later.coverage.unplaced, []);
  const earlier = make(20, { startDate: addDays(TODAY, -30) });
  assert.equal(earlier.start, TODAY);
});

test('rest dates and study weekdays are off days; the learning moves to the days that are left, nothing is dropped', () => {
  const plan = make(13, { restDates: [addDays(TODAY, 2)], studyWeekdays: [1, 2, 3, 4, 5] }); // Monday–Friday only
  const off = plan.days.filter(day => day.mode === 'off');
  assert.ok(off.length >= 4);
  const rest = plan.days.find(day => day.date === addDays(TODAY, 2));
  assert.equal(rest.mode, 'off');
  assert.equal(rest.reason.code, 'rest');
  assert.equal(plan.days[0].mode, 'off', 'Sunday is not a study weekday');
  assert.equal(plan.days[0].reason.code, 'weekday');
  assert.deepEqual(off.flatMap(day => day.points), [], 'nothing is put on an off day');
  assert.deepEqual([...learnIds(plan)].sort(), IDS);
  assert.deepEqual(plan.coverage.unplaced, []);
});

test('mock dates are mock days with no points of their own; a day that is both a mock day and a rest day stays a mock day', () => {
  const plan = make(10, { mockDates: [addDays(TODAY, 4), addDays(TODAY, 8)], restDates: [addDays(TODAY, 8)] });
  const mocks = plan.days.filter(day => day.mode === 'mock');
  assert.deepEqual(mocks.map(day => day.date), [addDays(TODAY, 4), addDays(TODAY, 8)]);
  assert.ok(mocks.every(day => day.points.length === 0 && day.reason.code === 'mock'));
  assert.deepEqual([...learnIds(plan)].sort(), IDS);
});

test('a review cycle: every n-th study day looks back at what was learnt, the weakest and most 易错点 first', () => {
  const learnt = Object.fromEntries(['h2', 'h4', 'h9'].map(id => [id, addDays(TODAY, -2)]));
  const plan = make(9, { reviewCycleDays: 3 }, { done: learnt });
  const review = plan.days.filter(day => day.mode === 'review' && day.offset < 9);
  assert.deepEqual(review.map(day => day.offset), [2, 5, 8], 'the 3rd, 6th and 9th study day');
  assert.equal(review[0].reason.code, 'review');
  assert.deepEqual(review[0].points, ['h4', 'h9', 'h2'], 'the most 易错点 first');
  assert.equal(review[0].reason.count, 3);
  assert.deepEqual(plan.order.review, ['h4', 'h9', 'h2']);
  assert.ok(plan.days.filter(day => day.mode === 'learn' && day.offset >= 0).every(day => day.points.every(id => !learnt[id])), 'what was learnt is not learnt again');
  assert.equal(plan.progress.learnt, 3);
});

test('a review day before anything was learnt takes the single most important pending point, so the day is not wasted', () => {
  const plan = make(8, { reviewCycleDays: 2 });
  const review = plan.days.filter(day => day.mode === 'review' && day.offset < 8);
  assert.ok(review.length >= 3);
  assert.equal(review[0].reason.code, 'review-learn');
  assert.deepEqual(review[0].points, ['h2']);
  assert.ok(review.every(day => day.points.length === 1));
  const taken = review.flatMap(day => day.points);
  assert.equal(new Set(taken).size, taken.length, 'a point is pulled once');
  assert.deepEqual([...learnIds(plan), ...taken].sort(), IDS, 'learn days and pulled points together cover the book exactly once');
});

test('what was really done: learnt points are not placed again, past days list what was done and looked at, a mark after today is not counted', () => {
  const done = { h2: addDays(TODAY, -3), h3: addDays(TODAY, -3), h4: TODAY, h6: addDays(TODAY, 2) };
  const seen = { h7: addDays(TODAY, -1), h2: addDays(TODAY, -3) };
  const plan = make(9, {}, { done, seen });
  assert.equal(plan.progress.learnt, 3, 'h6 is marked in the future: not counted');
  assert.ok(learnIds(plan).includes('h6') && !learnIds(plan).includes('h2'));
  const past = plan.days.filter(day => day.offset < 0);
  assert.deepEqual(past.map(day => [day.date, day.mode, day.points]), [[addDays(TODAY, -3), 'learn', ['h2', 'h3']], [addDays(TODAY, -1), 'review', ['h7']]]);
  assert.deepEqual(past[0].done, ['h2', 'h3']);
  assert.equal(past[1].reason.code, 'looked');
  assert.equal(plan.today.done.includes('h4'), true, 'what was done today stays on today');
  assert.ok(plan.today.points.includes('h4'));
});

test('a learn day over its minutes is flagged and listed, never cut', () => {
  const heavy = Array.from({ length: 6 }, (_, at) => point(`p${at}`, at, { size: 30000, questions: 20 }));
  const plan = periodPlan({ points: heavy, papers: 0, plan: { minutesPerDay: 30 }, examDate: addDays(TODAY, 3), today: TODAY });
  assert.equal(plan.capacity, 30);
  assert.ok(plan.merged.length > 0);
  assert.ok(plan.merged.every(entry => entry.minutes > entry.capacity && entry.capacity === 30 && entry.ids.length));
  const day = plan.days.find(item => item.date === plan.merged[0].date);
  assert.equal(day.reason.code, 'learn-over');
  assert.deepEqual([...learnIds(plan)].sort(), heavy.map(item => item.id).sort());
  assert.equal(plan.weighting, 'size');
});

test('no study day left: the pending points are reported as unplaced (and still appear on the exam day), not dropped', () => {
  const plan = make(1, { restDates: [TODAY] });
  assert.equal(plan.status, 'ok');
  assert.deepEqual(modes(plan), ['off', 'review']);
  assert.deepEqual([...plan.coverage.unplaced].sort(), IDS);
  assert.equal(plan.coverage.scheduled, 0);
  assert.deepEqual([...plan.unlearned].sort(), IDS);
  assert.deepEqual([...plan.days[1].points].sort(), IDS);
  assert.equal(make(10).unlearned.length, 0);
});

test('days limits how many of today and the later days are listed; the whole horizon is still computed', () => {
  const plan = make(30, {}, { days: 5 });
  assert.equal(plan.days.length, 5);
  assert.equal(plan.truncated, true);
  assert.equal(plan.coverage.scheduled, 8, 'coverage is of the whole horizon');
  assert.equal(make(30).days.length, PLAN_SCHEDULE.futureDays, 'fourteen days by default');
  assert.equal(make(30, {}, { days: 500 }).days.length, 31, 'at most the days there are');
  assert.equal(make(10).truncated, undefined);
});

test('the same input gives the same schedule; a plan with junk fields still computes (the stored plan is checked elsewhere)', () => {
  assert.deepEqual(make(12, { reviewCycleDays: 4 }), make(12, { reviewCycleDays: 4 }));
  const junk = make(6, { minutesPerDay: 'lots', studyWeekdays: [], restDates: ['nope', null], mockDates: 'x', phases: [null, { name: '  ' }] });
  assert.equal(junk.status, 'ok');
  assert.equal(junk.capacity, PLAN_SCHEDULE.minutesPerDay);
  assert.deepEqual(junk.phases.map(phase => phase.name), ['备考']);
  assert.equal(periodPlan({ points: [{ id: 'a' }, { id: 'a' }, null, { id: '' }, 'x'], plan: {}, examDate: addDays(TODAY, 2), today: TODAY }).coverage.total, 1);
});
