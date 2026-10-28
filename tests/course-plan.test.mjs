/* 备考计划 on the library (docs/review-book.md "备考计划"): the strategy is the course record's `plan`, saved only through course.save {plan} and checked there
   (limits on days, dates, phases and text); course.plan expands it over the review book's points and today's mastery with no model call, and says
   no-plan / no-book / no-exam / past / ok. The final-week view (book.crunch) is untouched. No real model, no network.
   Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { localDate } from '../lib/board-model.js';
import { addDays } from '../lib/crunch-plan.js';
import { PLAN_LIMITS, checkedPlan } from '../lib/courses.js';
import { COURSE, service } from './helpers/crunch-library.mjs';

const TODAY = localDate();
const base = (extra = {}) => ({ version: 1, ...extra });
const save = (study, plan, extra = {}) => study.call('course.save', { name: COURSE, plan, ...extra });
const examIn = (study, days) => study.call('course.save', { name: COURSE, exam: { date: addDays(TODAY, days) } });

test('course.save {plan}: only what the learner agreed to is kept, tidied; the start date is the day it was agreed to and stays', async t => {
  const { study } = await service(t);
  const saved = await save(study, base({ minutesPerDay: 120, studyWeekdays: [5, 1, 3, 1], restDates: ['2026-12-02', '2026-12-01', '2026-12-01'], mockDates: ['2026-12-10'],
    reviewCycleDays: 4, phases: [{ name: ' Foundations ', until: '2026-11-20', goal: ' read it all ' }, { name: 'Practice' }], missing: ' past papers ', rules: 'drop a week if behind', notes: '' }));
  assert.equal(saved.plan.version, 1);
  assert.equal(saved.plan.status, 'active');
  assert.equal(saved.plan.startDate, TODAY);
  assert.match(saved.plan.updatedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(saved.plan.studyWeekdays, [1, 3, 5]);
  assert.deepEqual(saved.plan.restDates, ['2026-12-01', '2026-12-02']);
  assert.deepEqual(saved.plan.mockDates, ['2026-12-10']);
  assert.deepEqual(saved.plan.phases, [{ name: 'Foundations', until: '2026-11-20', goal: 'read it all' }, { name: 'Practice' }]);
  assert.equal(saved.plan.missing, 'past papers');
  assert.equal(saved.plan.rules, 'drop a week if behind');
  assert.equal('notes' in saved.plan, false, 'an empty text is not kept');
  assert.deepEqual((await study.call('course.get', { name: COURSE })).plan, saved.plan, 'course.get reads what was saved');
  // The whole plan is replaced; a stated start date is kept; the exam and the plan do not overwrite each other.
  const again = await save(study, base({ startDate: addDays(TODAY, 3), status: 'paused' }));
  assert.equal(again.plan.startDate, addDays(TODAY, 3));
  assert.equal(again.plan.status, 'paused');
  assert.deepEqual(again.plan.phases, []);
  await examIn(study, 20);
  assert.equal((await study.call('course.get', { name: COURSE })).plan.status, 'paused', 'saving the exam leaves the plan');
  await study.call('course.save', { name: COURSE, plan: base() });
  assert.equal((await study.call('course.get', { name: COURSE })).exam.date, addDays(TODAY, 20), 'saving the plan leaves the exam');
  const removed = await save(study, null);
  assert.equal('plan' in removed, false, 'plan:null removes it');
  assert.equal(removed.exam.date, addDays(TODAY, 20));
});

test('course.save {plan}: every limit is checked, the plan is not stored when one fails', async t => {
  const { study } = await service(t);
  const refused = [
    ['a list', [], /备考计划格式不对/], ['a string', 'plan', /备考计划格式不对/], [`version 2`, { version: 2 }, /version 需为 1/], ['no version', {}, /version 需为 1/],
    ['status', base({ status: 'later' }), /status 需为 active/], ['start date', base({ startDate: '2026-02-30' }), /开始日期需为 YYYY-MM-DD/],
    ['minutes 14', base({ minutesPerDay: 14 }), /15–960/], ['minutes 961', base({ minutesPerDay: 961 }), /15–960/], ['minutes as text', base({ minutesPerDay: '60' }), /15–960/],
    ['weekdays empty', base({ studyWeekdays: [] }), /studyWeekdays/], ['weekday 7', base({ studyWeekdays: [7] }), /studyWeekdays/], ['weekday 1.5', base({ studyWeekdays: [1.5] }), /studyWeekdays/],
    ['eight weekdays', base({ studyWeekdays: [0, 1, 2, 3, 4, 5, 6, 0] }), /studyWeekdays/],
    ['rest date', base({ restDates: ['soon'] }), /restDates/], ['rest dates not a list', base({ restDates: '2026-12-01' }), /restDates/],
    [`${PLAN_LIMITS.restDates + 1} rest dates`, base({ restDates: Array.from({ length: PLAN_LIMITS.restDates + 1 }, (_, at) => addDays('2027-01-01', at)) }), /restDates/],
    [`${PLAN_LIMITS.mockDates + 1} mock dates`, base({ mockDates: Array.from({ length: PLAN_LIMITS.mockDates + 1 }, (_, at) => addDays('2027-01-01', at)) }), /mockDates/],
    ['review cycle 1', base({ reviewCycleDays: 1 }), /2–30/], ['review cycle 31', base({ reviewCycleDays: 31 }), /2–30/],
    [`${PLAN_LIMITS.phases + 1} phases`, base({ phases: Array.from({ length: PLAN_LIMITS.phases + 1 }, (_, at) => ({ name: `p${at}`, until: addDays('2027-01-01', at) })) }), /阶段最多 12 个/],
    ['phases not a list', base({ phases: {} }), /阶段最多/], ['phase not an object', base({ phases: ['x'] }), /阶段格式不对/], ['phase without a name', base({ phases: [{ name: ' ' }] }), /需要名称/],
    ['phase name too long', base({ phases: [{ name: 'x'.repeat(201) }] }), /阶段名称过长/], ['phase end date', base({ phases: [{ name: 'a', until: 'later' }] }), /阶段截止日期需为/],
    ['only the last phase is open', base({ phases: [{ name: 'a' }, { name: 'b' }] }), /只有最后一个阶段/],
    ['phase dates must advance', base({ phases: [{ name: 'a', until: '2026-12-02' }, { name: 'b', until: '2026-12-02' }] }), /逐个推后/],
    ['phase goal too long', base({ phases: [{ name: 'a', goal: 'x'.repeat(PLAN_LIMITS.goal + 1) }] }), /阶段目标过长/],
    ['notes too long', base({ notes: 'x'.repeat(PLAN_LIMITS.text + 1) }), /备注 notes过长/], ['rules not text', base({ rules: { a: 1 } }), /调整规则 rules过长/],
    ['missing too long', base({ missing: 'x'.repeat(PLAN_LIMITS.text + 1) }), /缺失材料 missing过长/],
  ];
  for (const [label, plan, message] of refused) await assert.rejects(save(study, plan), message, label);
  assert.equal('plan' in (await study.call('course.get', { name: COURSE })), false, 'nothing was stored');
  // The limits themselves are accepted.
  const edge = await save(study, base({ minutesPerDay: 960, reviewCycleDays: 30, studyWeekdays: [0, 1, 2, 3, 4, 5, 6], notes: 'x'.repeat(PLAN_LIMITS.text),
    phases: Array.from({ length: PLAN_LIMITS.phases }, (_, at) => ({ name: `p${at}`, ...(at < PLAN_LIMITS.phases - 1 ? { until: addDays('2027-01-01', at) } : {}), goal: 'g'.repeat(PLAN_LIMITS.goal) })) }));
  assert.equal(edge.plan.phases.length, PLAN_LIMITS.phases);
  assert.deepEqual({ ...PLAN_LIMITS }, { phases: 12, restDates: 60, mockDates: 20, text: 2000, goal: 500 });
});

test('the errors read in English for an English request, and stay Chinese otherwise', async t => {
  const { study } = await service(t);
  const message = async (plan, uiLanguage) => (await save(study, plan, { uiLanguage }).then(() => null, error => error.message));
  assert.equal(await message(base({ minutesPerDay: 5 }), 'en'), 'Minutes per day must be between 15 and 960');
  assert.equal(await message(base({ minutesPerDay: 5 }), 'zh'), '每日学习分钟数需为 15–960');
  assert.equal(await message([], 'en'), 'Invalid study plan');
  const cases = [
    [{ version: 2 }, 'The study plan version must be 1'], [base({ status: 'x' }), 'The study plan status must be active, paused or done'],
    [base({ startDate: 'x' }), 'The study plan start date must be YYYY-MM-DD'], [base({ studyWeekdays: [] }), 'studyWeekdays must be a list of weekdays 0–6 (0 is Sunday), at least one'],
    [base({ restDates: ['x'] }), 'restDates must be a list of YYYY-MM-DD dates, at most 60'], [base({ mockDates: ['x'] }), 'mockDates must be a list of YYYY-MM-DD dates, at most 20'],
    [base({ reviewCycleDays: 1 }), 'The review cycle must be 2–30 days'], [base({ phases: Array.from({ length: 13 }, () => ({ name: 'a' })) }), 'A study plan can have at most 12 phases'],
    [base({ phases: ['x'] }), 'Invalid plan phase'], [base({ phases: [{ name: '' }] }), 'Every phase needs a name'],
    [base({ phases: [{ name: 'x'.repeat(201) }] }), 'The phase name is too long or invalid'], [base({ phases: [{ name: 'a', until: 'x' }] }), 'The phase end date must be YYYY-MM-DD'],
    [base({ phases: [{ name: 'a' }, { name: 'b' }] }), 'Only the last phase may have no end date'],
    [base({ phases: [{ name: 'a', until: '2026-12-02' }, { name: 'b', until: '2026-12-01' }] }), 'Phase end dates must be in increasing order'],
    [base({ phases: [{ name: 'a', goal: 'x'.repeat(501) }] }), 'The phase goal is too long'],
    [base({ notes: 'x'.repeat(2001) }), 'notes is too long (at most 2000 characters)'], [base({ rules: 'x'.repeat(2001) }), 'rules is too long (at most 2000 characters)'],
    [base({ missing: 'x'.repeat(2001) }), 'missing is too long (at most 2000 characters)'],
  ];
  for (const [plan, expected] of cases) assert.equal(await message(plan, 'en'), expected);
});

test('checkedPlan: nothing and null pass through (course.save leaves the plan, or removes it)', () => {
  assert.equal(checkedPlan(undefined), undefined);
  assert.equal(checkedPlan(null), null);
  assert.deepEqual(checkedPlan({ version: 1 }), { version: 1, status: 'active', restDates: [], mockDates: [], phases: [] });
});

test('course.plan: a course without a plan says no-plan (with its exam date, so the page knows what to offer); a course name that is not one says no-course', async t => {
  const { study } = await service(t);
  const none = await study.call('course.plan', { date: TODAY });
  assert.deepEqual({ status: none.status, course: none.course, examDate: none.examDate, plan: none.plan }, { status: 'no-plan', course: COURSE, examDate: null, plan: null });
  await examIn(study, 30);
  assert.equal((await study.call('course.plan', { date: TODAY })).examDate, addDays(TODAY, 30));
  assert.equal((await study.call('course.plan', { course: '*', date: TODAY })).status, 'no-course');
  await assert.rejects(study.call('course.plan', { date: '2026-13-01' }), /date must be/);
});

test('course.plan: a plan but no review book says no-book; a plan but no exam date computes nothing (no-exam); a past exam says past', async t => {
  const { study } = await service(t, { book: false });
  await study.store.update(state => { state.sources = state.sources.filter(source => source.provenance !== 'course-book-doc'); });
  await save(study, base());
  await examIn(study, 10);
  assert.equal((await study.call('course.plan', { date: TODAY })).status, 'no-book');
  const second = await service(t);
  await save(second.study, base());
  const noExam = await second.study.call('course.plan', { date: TODAY });
  assert.equal(noExam.status, 'no-exam');
  assert.equal(noExam.daysLeft, null);
  assert.equal(noExam.points.length, 2, 'the points are still read');
  assert.equal(noExam.schedule.coverage.total, 2);
  await examIn(second.study, -2);
  const past = await second.study.call('course.plan', { date: TODAY });
  assert.deepEqual({ status: past.status, daysLeft: past.daysLeft }, { status: 'past', daysLeft: -2 });
});

test('course.plan: ok - the stored plan expanded over the book, from the first day; the answer carries the plan as saved and the points like book.crunch', async t => {
  const { study, what, who } = await service(t);
  await examIn(study, 40);
  const saved = await save(study, base({ phases: [{ name: 'Foundations', until: addDays(TODAY, 25), goal: 'read it all' }, { name: 'Practice' }], mockDates: [addDays(TODAY, 30)], restDates: [addDays(TODAY, 1)] }));
  const plan = await study.call('course.plan', { date: TODAY });
  assert.equal(plan.status, 'ok');
  assert.equal(plan.course, COURSE);
  assert.equal(plan.examDate, addDays(TODAY, 40));
  assert.equal(plan.daysLeft, 40);
  assert.deepEqual(plan.plan, saved.plan);
  assert.ok(plan.revision);
  assert.deepEqual(plan.points.map(point => point.id), [what.hid, who.hid]);
  const crunch = await study.call('book.crunch', { date: TODAY });
  assert.deepEqual(plan.points.map(point => [point.id, point.title, point.questions]), crunch.points.map(point => [point.id, point.title, point.questions]));
  const { schedule } = plan;
  assert.equal(schedule.status, 'ok');
  assert.deepEqual(schedule.phases.map(phase => phase.name), ['Foundations', 'Practice']);
  assert.equal(schedule.days.length, 14, 'today and the next thirteen days');
  assert.equal(schedule.today.date, TODAY);
  assert.equal(schedule.days[1].mode, 'off');
  assert.deepEqual(schedule.coverage, { total: 2, scheduled: 2, unplaced: [] });
  assert.equal((await study.call('course.plan', { date: TODAY, days: 40 })).schedule.days.length, 40, 'days is how many of today and later days are listed');
  assert.equal((await study.call('course.plan', { date: TODAY, days: 400 })).schedule.days.length, 41, 'at most the days there are');
  assert.equal((await study.call('course.plan', { date: TODAY, days: 3 })).schedule.days.length, 3);
  assert.equal((await study.call('course.plan', { date: TODAY, days: 0 })).schedule.days.length, 14, 'days outside 1–400 are the default');
  assert.deepEqual((await study.call('course.plan', { date: addDays(TODAY, 29) })).schedule.days.find(day => day.date === addDays(TODAY, 30))?.mode, 'mock', 'asked on a later day, the schedule starts that day');
});

test('course.plan: made again from what was really done - a point with five questions answered today is learnt and the progress says so; the saved plan is untouched', async t => {
  const { study, deck, what } = await service(t);
  await examIn(study, 12);
  const saved = await save(study, base());
  const before = await study.call('course.plan', { date: TODAY });
  assert.equal(before.schedule.progress.learnt, 0);
  const now = new Date().toISOString();
  await study.store.update(state => {
    for (const card of deck.cards.slice(0, 5)) state.attempts.push({ id: `a-${card.id}`, quiz_id: card.id, deckId: deck.id, timestamp: now, grade: 4, assessment: 'graded' });
  });
  const after = await study.call('course.plan', { date: TODAY });
  assert.equal(after.schedule.progress.learnt, 1);
  assert.ok(after.schedule.today.done.includes(what.hid));
  assert.equal(after.points.find(point => point.id === what.hid).done, TODAY);
  assert.deepEqual((await study.call('course.get', { name: COURSE })).plan, saved.plan, 'reading the plan never changes it');
  // Nothing is written by asking, and asking twice gives the same answer.
  assert.deepEqual(await study.call('course.plan', { date: TODAY }), after);
});

test('course.plan is a read: no model is called and the course record is not written', async t => {
  const { study } = await service(t);
  await examIn(study, 9);
  await save(study, base());
  const record = JSON.stringify((await study.store.read()).courses);
  await study.call('course.plan', { date: TODAY });
  assert.equal(JSON.stringify((await study.store.read()).courses), record);
});

test('merging courses: the course that had no plan takes the plan of the one merged into it, one that has its own keeps it; saving the exam in the course settings leaves the plan', async t => {
  const { study } = await service(t);
  await save(study, base({ minutesPerDay: 90 }));
  const first = await study.call('course.get', { name: COURSE });
  const empty = await study.call('course.save', { name: 'Other course' });
  const merged = await study.call('course.merge', { from: [first.id], into: empty.id });
  assert.equal(merged.course.plan.minutesPerDay, 90);
  const own = await study.call('course.save', { name: 'Own course', plan: base({ minutesPerDay: 45 }) });
  const second = await study.call('course.save', { name: 'Second course', plan: base({ minutesPerDay: 200 }) });
  assert.equal((await study.call('course.merge', { from: [second.id], into: own.id })).course.plan.minutesPerDay, 45);
  // The course settings page saves {id, name, exam, guidanceSourceIds, focusTopics} and no plan: the plan stays.
  const again = await study.call('course.save', { id: own.id, name: 'Own course', exam: { format: 'other', date: addDays(TODAY, 9) }, guidanceSourceIds: [], focusTopics: [] });
  assert.equal(again.plan.minutesPerDay, 45);
});
