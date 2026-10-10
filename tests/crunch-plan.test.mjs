/* 期末一周 (docs/plans/review-book.md M7): the pure day plan over the book's points (lib/crunch-plan.js). A week before the exam the first days are learn
   days (read + practise the next 5), the last two 翻看 days with a mock paper on the very last one; points by exam weight × weakness; every point placed,
   nothing dropped silently; deterministic; made again tomorrow it keeps what was done and gives the same next days. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, crunchPlan, daysBetween, isDate, learnMinutes, flipMinutes, CRUNCH } from '../lib/crunch-plan.js';

const TODAY = '2026-10-11';
const point = (id, order, extra = {}) => ({ id, order, tested: 0, weakness: 0.3, questions: 10, size: 1500, pitfalls: 0, ...extra });
const BOOK = [
  point('h2', 0, { tested: 2, weakness: 0.9, pitfalls: 1 }), point('h3', 1, { tested: 0, weakness: 0.2 }), point('h4', 2, { tested: 1, weakness: 0.6, pitfalls: 3 }),
  point('h6', 3, { tested: 0, weakness: 0.8 }), point('h7', 4, { tested: 2, weakness: 0.1 }), point('h8', 5, { questions: 0, size: 600 }),
  point('h9', 6, { tested: 1, weakness: 0.4, pitfalls: 2 }), point('h10', 7, { tested: 0, weakness: 0 }),
];
const week = (extra = {}) => crunchPlan({ points: BOOK, papers: 2, examDate: addDays(TODAY, 7), today: TODAY, ...extra });
const learnIds = plan => plan.days.filter(day => day.mode === 'learn').flatMap(day => day.points);
const flipIds = plan => plan.days.filter(day => day.mode === 'flip').flatMap(day => day.points);

test('dates: real calendar days only, day arithmetic across months', () => {
  assert.equal(isDate('2026-02-29'), false);
  assert.equal(isDate('2028-02-29'), true);
  assert.equal(addDays('2026-10-30', 3), '2026-11-02');
  assert.equal(daysBetween('2026-10-11', '2026-10-18'), 7);
  assert.throws(() => crunchPlan({ points: BOOK, examDate: '2026-10-18', today: 'today' }), /today must be/);
});

test('a week: five learn days, then two 翻看 days, the mock paper on the very last full day; every point learnt once and looked at once', () => {
  const plan = week();
  assert.equal(plan.status, 'ok');
  assert.equal(plan.daysLeft, 7);
  assert.deepEqual(plan.days.map(day => day.mode), ['learn', 'learn', 'learn', 'learn', 'learn', 'flip', 'flip']);
  assert.deepEqual(plan.days.map(day => day.offset), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(plan.flipStart, addDays(TODAY, 5));
  assert.deepEqual(plan.days.map(day => day.mock), [false, false, false, false, false, false, true], 'the mock only on the day before the exam');
  assert.deepEqual([...learnIds(plan)].sort(), BOOK.map(item => item.id).sort(), 'each point on exactly one learn day');
  assert.deepEqual([...flipIds(plan)].sort(), BOOK.map(item => item.id).sort(), 'each point on exactly one 翻看 day');
  assert.equal(plan.today, plan.days[0]);
  assert.deepEqual(plan.merged, []);
  assert.deepEqual(plan.unlearned, []);
  for (const day of plan.days) assert.ok(day.reason?.code, `${day.date} says why`);
  assert.equal(plan.days[6].reason.code, 'flip-mock');
  assert.equal(plan.days[5].reason.code, 'flip');
  assert.equal(plan.days[0].reason.code, 'learn');
});

test('exam weight × weakness: the tested and weak points come first; within a day the points are in reading order', () => {
  const plan = week();
  // h2 is tested by both papers and weak: the most important; h10 untested and mastered: the least.
  assert.equal(plan.order.learn[0], 'h2');
  assert.equal(plan.order.learn.at(-1), 'h10');
  assert.ok(plan.days[0].points.includes('h2'), 'the most important point is learnt on the first day');
  assert.ok(plan.days[4].points.includes('h10') || plan.days[3].points.includes('h10'), 'the least important point comes last');
  for (const day of plan.days.filter(item => item.mode === 'learn')) {
    const orders = day.points.map(id => BOOK.find(item => item.id === id).order);
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b), `${day.date}: reading order`);
  }
  assert.ok(plan.scores.h2.weight === 3 && plan.scores.h10.weight === 1, 'weight is 1 + the papers that tested the point');
  assert.equal(plan.days[0].reason.tested > 0, true);
});

test('翻看 days: the points with the most 易错点 first, then the weakest', () => {
  const plan = week();
  assert.deepEqual(plan.order.flip.slice(0, 3), ['h4', 'h9', 'h2']);
  assert.deepEqual(plan.days[5].points.slice(0, 2), ['h4', 'h9'], 'the first 翻看 day starts with the most 易错点');
  assert.ok(plan.days[5].reason.pitfalls >= 5);
});

test('no sample papers: every point weighs the same, the days are balanced by size', () => {
  const plan = week({ papers: 0 });
  assert.equal(plan.weighting, 'size');
  assert.ok(Object.values(plan.scores).every(score => score.weight === 1));
  assert.equal(plan.days[0].reason.code, 'learn-size');
  const loads = plan.days.filter(day => day.mode === 'learn').map(day => day.minutes);
  assert.ok(Math.max(...loads) - Math.min(...loads) <= Math.max(...BOOK.map(item => learnMinutes(item))), `balanced: ${loads}`);
});

test('a point without questions is read only: its minutes are reading only', () => {
  assert.equal(learnMinutes({ size: 600, questions: 0 }), 3);
  assert.equal(learnMinutes({ size: 3000, questions: 10 }), Math.round(10 + 5 * CRUNCH.questionMinutes));
  assert.equal(flipMinutes({ size: 0, pitfalls: 3 }), 4);
  assert.ok(learnIds(week()).includes('h8'));
});

test('no exam date: no plan (the book still works), the 翻看 order is still given; a past exam: no plan', () => {
  const none = crunchPlan({ points: BOOK, today: TODAY });
  assert.equal(none.status, 'no-exam');
  assert.deepEqual(none.days, []);
  assert.equal(none.today, null);
  assert.deepEqual(none.order.flip.slice(0, 2), ['h4', 'h9']);
  assert.equal(crunchPlan({ points: BOOK, examDate: 'soon', today: TODAY }).status, 'no-exam');
  const past = crunchPlan({ points: BOOK, examDate: addDays(TODAY, -1), today: TODAY });
  assert.equal(past.status, 'past');
  assert.deepEqual(past.days, []);
  assert.equal(crunchPlan({ points: BOOK, examDate: addDays(TODAY, 400), today: TODAY }).status, 'far');
});

test('exam today: one 翻看 day of every point, the 易错点 first, no mock; exam tomorrow: today is the 翻看 day with the mock, nothing new is learnt', () => {
  const now = crunchPlan({ points: BOOK, papers: 2, examDate: TODAY, today: TODAY });
  assert.equal(now.status, 'ok');
  assert.equal(now.days.length, 1);
  assert.deepEqual({ mode: now.today.mode, mock: now.today.mock, code: now.today.reason.code }, { mode: 'flip', mock: false, code: 'exam-today' });
  assert.equal(now.today.points[0], 'h4');
  assert.equal(now.today.points.length, BOOK.length);
  const tomorrow = crunchPlan({ points: BOOK, papers: 2, examDate: addDays(TODAY, 1), today: TODAY });
  assert.deepEqual(tomorrow.days.map(day => [day.mode, day.mock]), [['flip', true]]);
  assert.equal(tomorrow.today.points.length, BOOK.length);
  assert.deepEqual([...tomorrow.unlearned].sort(), BOOK.map(item => item.id).sort(), 'no learn day left: reported, not dropped');
  const two = crunchPlan({ points: BOOK, papers: 2, examDate: addDays(TODAY, 2), today: TODAY });
  assert.deepEqual(two.days.map(day => day.mode), ['flip', 'flip'], 'fewer review days remain: both are 翻看');
  const three = crunchPlan({ points: BOOK, papers: 2, examDate: addDays(TODAY, 3), today: TODAY });
  assert.deepEqual(three.days.map(day => day.mode), ['learn', 'flip', 'flip']);
  assert.deepEqual(three.unlearned, []);
});

test('review days are clamped to 1–3', () => {
  assert.deepEqual(week({ reviewDays: 1 }).days.map(day => day.mode), ['learn', 'learn', 'learn', 'learn', 'learn', 'learn', 'flip']);
  assert.equal(week({ reviewDays: 9 }).reviewDays, 3);
  assert.equal(week({ reviewDays: 0 }).reviewDays, 1);
  assert.equal(week({ reviewDays: 'x' }).reviewDays, 2);
});

test('more points than the days hold: merged onto the days and reported, never dropped', () => {
  const many = Array.from({ length: 40 }, (_, at) => point(`p${at}`, at, { size: 6000, weakness: (at % 5) / 5 }));
  const plan = crunchPlan({ points: many, papers: 0, examDate: addDays(TODAY, 4), today: TODAY, minutesPerDay: 60 });
  assert.deepEqual(plan.days.map(day => day.mode), ['learn', 'learn', 'flip', 'flip']);
  assert.deepEqual([...learnIds(plan)].sort(), many.map(item => item.id).sort(), 'all 40 points are on a learn day');
  assert.ok(plan.merged.length >= 2, 'the over-full days are listed');
  for (const item of plan.merged) assert.ok(item.minutes > item.capacity && item.ids.length > 0);
  assert.equal(plan.days[0].reason.code, 'learn-over');
  assert.equal(plan.days[0].reason.capacity, 60);
});

test('fewer points than days: a day may have none, and says so', () => {
  const plan = crunchPlan({ points: BOOK.slice(0, 2), papers: 2, examDate: addDays(TODAY, 7), today: TODAY });
  assert.ok(plan.days.some(day => day.mode === 'learn' && !day.points.length && day.reason.code === 'learn-free'));
  assert.deepEqual([...learnIds(plan)].sort(), ['h2', 'h3']);
});

test('days off are skipped: the 翻看 days are the last study days, the mock on the last one', () => {
  const exam = addDays(TODAY, 7), plan = week({ daysOff: [addDays(TODAY, 6), addDays(TODAY, 2)] });
  assert.deepEqual(plan.days.map(day => day.mode), ['learn', 'learn', 'off', 'learn', 'flip', 'flip', 'off']);
  assert.equal(plan.days[5].mock, true);
  assert.equal(plan.days[2].reason.code, 'off');
  assert.deepEqual(plan.days[2].points, []);
  assert.equal(daysBetween(plan.flipStart, exam), 3);
  const resting = week({ daysOff: [TODAY], done: { h3: TODAY } });
  assert.deepEqual({ mode: resting.today.mode, points: resting.today.points, done: resting.today.done }, { mode: 'off', points: ['h3'], done: ['h3'] }, 'a day off that is today lists what was done on it');
  assert.equal(learnIds(resting).includes('h3'), false);
});

test('deterministic: the same input gives the same plan, whatever the order of the list', () => {
  assert.deepEqual(week(), week());
  const shuffled = [BOOK[5], BOOK[2], BOOK[7], BOOK[0], BOOK[3], BOOK[1], BOOK[6], BOOK[4]];
  assert.deepEqual(crunchPlan({ points: shuffled, papers: 2, examDate: addDays(TODAY, 7), today: TODAY }).days, week().days);
});

test('made again tomorrow after doing today\'s points: those keep their day, the next days are the same as planned', () => {
  const first = week(), tomorrow = addDays(TODAY, 1);
  const done = Object.fromEntries(first.days[0].points.map(id => [id, TODAY]));
  const again = crunchPlan({ points: BOOK, papers: 2, examDate: addDays(TODAY, 7), today: tomorrow, done });
  assert.equal(again.days[0].date, TODAY, 'the past day is listed with what was done on it');
  assert.deepEqual(again.days[0].points, first.days[0].points);
  assert.deepEqual(again.days[0].done, first.days[0].points);
  assert.equal(again.days[0].reason.code, 'done');
  assert.deepEqual(again.days.slice(1).map(day => [day.date, day.mode, day.points]), first.days.slice(1).map(day => [day.date, day.mode, day.points]), 'the same next days');
  // Idempotent: made again with the same marks it is the same plan.
  assert.deepEqual(crunchPlan({ points: BOOK, papers: 2, examDate: addDays(TODAY, 7), today: tomorrow, done }), again);
});

test('re-planning mid-way when the plan was not followed: done points keep their day, the rest are spread from today', () => {
  const first = week(), late = addDays(TODAY, 2);
  // Only one point was done (two days ago, out of the plan's order); nothing yesterday.
  const again = crunchPlan({ points: BOOK, papers: 2, examDate: addDays(TODAY, 7), today: late, done: { h10: TODAY } });
  assert.equal(first.days[0].points.includes('h10'), false);
  assert.deepEqual(again.days[0], { date: TODAY, offset: -2, mock: false, mode: 'learn', points: ['h10'], done: ['h10'], minutes: again.scores.h10.minutes, reason: { code: 'done', count: 1 } });
  assert.deepEqual(again.days.filter(day => day.offset >= 0).map(day => day.mode), ['learn', 'learn', 'learn', 'flip', 'flip']);
  assert.deepEqual([...learnIds(again)].sort(), BOOK.map(item => item.id).sort());
  // Done today: today's list holds it as done, counted in today's minutes; a mark after today is not counted.
  const today = crunchPlan({ points: BOOK, papers: 2, examDate: addDays(TODAY, 7), today: TODAY, done: { h3: TODAY, h4: addDays(TODAY, 3) } });
  assert.ok(today.today.points.includes('h3') && today.today.done.includes('h3'));
  assert.deepEqual(today.today.done, ['h3']);
  assert.equal(learnIds(today).filter(id => id === 'h4').length, 1);
});

test('翻看 progress: what was looked at on a 翻看 day keeps that day, the rest move to the days left; a 已看 from before the 翻看 days does not count', () => {
  const flipDay = addDays(TODAY, 5), next = addDays(TODAY, 6);
  const first = week({ today: flipDay, done: Object.fromEntries(BOOK.map(item => [item.id, TODAY])) });
  assert.deepEqual(first.days.filter(day => day.offset >= 0).map(day => day.mode), ['flip', 'flip']);
  const looked = first.today.points.slice(0, 2);
  const again = week({ today: next, done: Object.fromEntries(BOOK.map(item => [item.id, TODAY])), seen: { ...Object.fromEntries(looked.map(id => [id, flipDay])), h10: TODAY } });
  const past = again.days.find(day => day.date === flipDay);
  assert.deepEqual(past.points, [...looked].sort((a, b) => BOOK.find(item => item.id === a).order - BOOK.find(item => item.id === b).order));
  assert.equal(past.mode, 'flip');
  assert.equal(again.today.mock, true);
  assert.deepEqual([...again.today.points].sort(), BOOK.map(item => item.id).filter(id => !looked.includes(id)).sort(), 'h10 looked at before the 翻看 days is looked at again');
});
