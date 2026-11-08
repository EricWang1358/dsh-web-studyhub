import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { periodPlan } from '../lib/plan-schedule.js';
import { loadUi } from './helpers/ui-module.mjs';

const emptyBoard = () => ({
  version: 1,
  revision: 1,
  columns: [
    { id: 'todo', title: '待办', done: false, cardIds: [] },
    { id: 'done', title: '已完成', done: true, cardIds: [] },
  ],
  cards: {},
  archived: [],
  todayOrder: {},
  timeLog: [],
  timer: null,
  timerPrefs: { workMinutes: 25, breakMinutes: 5, sound: false, notify: false },
});

const POINTS = [
  { id: 'p-1', code: '1.1', title: '进程与线程', order: 0, questions: 8, weakness: 0.7, size: 1600, pitfalls: 2 },
  { id: 'p-2', code: '1.2', title: '互斥与同步', order: 1, questions: 6, weakness: 0.65, size: 1500, pitfalls: 1 },
  { id: 'p-3', code: '2.1', title: '银行家死锁避免', order: 2, questions: 10, weakness: 0.8, size: 1800, pitfalls: 3 },
  { id: 'p-4', code: '2.2', title: '页表地址变换', order: 3, questions: 0, weakness: 0.6, size: 1400, pitfalls: 0 },
];

const CHAPTERS = [
  { n: 1, title: '第 1 章 进程管理', ids: ['p-1', 'p-2'] },
  { n: 2, title: '第 2 章 死锁与内存', ids: ['p-3', 'p-4'] },
];

function makePlanAnswer({ today = '2026-11-08', examDate = '2026-11-16', plan = { version: 1, minutesPerDay: 45 }, chapters } = {}) {
  const schedule = periodPlan({
    points: POINTS,
    plan,
    examDate,
    today,
    ...(chapters ? { chapters } : {}),
  });
  return {
    status: schedule.status,
    course: '操作系统',
    examDate: schedule.examDate,
    daysLeft: schedule.daysLeft,
    today,
    plan,
    schedule,
    points: POINTS,
  };
}

test('selectTodayUpcomingPlan (#861): reads next N days strictly from periodPlan including rest days and mock days', async () => {
  const { selectTodayUpcomingPlan, setUiLanguage } = await loadUi(`
    export { selectTodayUpcomingPlan } from './ui/board/today-upcoming-plan.js';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  setUiLanguage('zh');

  const plan = {
    version: 1,
    minutesPerDay: 45,
    restDates: ['2026-11-10'],
    mockDates: ['2026-11-11'],
  };
  const answer = makePlanAnswer({ today: '2026-11-08', examDate: '2026-11-16', plan });
  const library = {
    focus: { course: '操作系统' },
    courses: [{ name: '操作系统', active: true, exam: { date: '2026-11-16' }, plan }],
  };

  const model3 = selectTodayUpcomingPlan({ library, planAnswer: answer });
  assert.equal(model3.visible, true);
  assert.equal(model3.kind, 'plan');
  assert.equal(model3.course, '操作系统');
  assert.equal(model3.days.length, 3);
  assert.deepEqual(
    model3.days.map((d) => d.date),
    ['2026-11-09', '2026-11-10', '2026-11-11'],
    'excludes today (offset 0) and lists next 3 days in schedule order',
  );
  assert.equal(model3.days[0].dateLabel, '11/09');
  assert.equal(model3.days[0].mode, 'learn');
  assert.match(model3.days[0].summary, /^读 /);

  assert.equal(model3.days[1].dateLabel, '11/10');
  assert.equal(model3.days[1].mode, 'off');
  assert.equal(model3.days[1].summary, '休息');

  assert.equal(model3.days[2].dateLabel, '11/11');
  assert.equal(model3.days[2].mode, 'mock');
  assert.equal(model3.days[2].summary, '模拟考 · 整套模拟卷');

  const model2 = selectTodayUpcomingPlan({ library, planAnswer: answer, limit: 2 });
  assert.deepEqual(model2.days.map((d) => d.date), ['2026-11-09', '2026-11-10']);
});

test('selectTodayUpcomingPlan (#861): returns empty upcoming days on exam day and after exam day', async () => {
  const { selectTodayUpcomingPlan, setUiLanguage } = await loadUi(`
    export { selectTodayUpcomingPlan } from './ui/board/today-upcoming-plan.js';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  setUiLanguage('zh');

  const plan = { version: 1, minutesPerDay: 90 };
  const library = {
    focus: { course: '操作系统' },
    courses: [{ name: '操作系统', active: true, exam: { date: '2026-11-08' }, plan }],
  };

  // On exam day: schedule.days has offset 0 (today) and zero days with offset > 0.
  const onExamDay = makePlanAnswer({ today: '2026-11-08', examDate: '2026-11-08', plan });
  const examDayModel = selectTodayUpcomingPlan({ library, planAnswer: onExamDay });
  assert.equal(examDayModel.visible, true);
  assert.equal(examDayModel.kind, 'plan');
  assert.deepEqual(examDayModel.days, []);
  assert.equal(examDayModel.emptyNote, '今天考试，之后没有新的排期。');

  // After exam day: periodPlan status is 'past' and days is [].
  const afterExam = makePlanAnswer({ today: '2026-11-09', examDate: '2026-11-08', plan });
  assert.equal(afterExam.status, 'past');
  const pastModel = selectTodayUpcomingPlan({ library, planAnswer: afterExam });
  assert.equal(pastModel.visible, true);
  assert.equal(pastModel.kind, 'plan');
  assert.deepEqual(pastModel.days, []);
  assert.equal(pastModel.emptyNote, '考试日期已过，备考计划不再排日子。');
});

test('selectTodayUpcomingPlan (#861): weekly chapter plan uses plan-weekly phrasing and empties after final week', async () => {
  const { selectTodayUpcomingPlan, setUiLanguage } = await loadUi(`
    export { selectTodayUpcomingPlan } from './ui/board/today-upcoming-plan.js';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  setUiLanguage('zh');

  const weeklyPlan = {
    version: 1,
    by: 'weekly',
    chaptersPerWeek: 1,
    startDate: '2026-11-08',
    minutesPerDay: 60,
  };
  const library = {
    focus: { course: '操作系统' },
    courses: [{ name: '操作系统', active: true, plan: weeklyPlan }],
  };

  const activeWeek = makePlanAnswer({
    today: '2026-11-08',
    examDate: null,
    plan: weeklyPlan,
    chapters: CHAPTERS,
  });
  const weekModel = selectTodayUpcomingPlan({ library, planAnswer: activeWeek });
  assert.equal(weekModel.visible, true);
  assert.equal(weekModel.kind, 'plan');
  assert.equal(weekModel.weeklyLine, '本周：第 1 章');
  assert.equal(weekModel.days.length, 3);

  // Past the last day of week 2 ('2026-11-21'): weekly schedule has no future days.
  const afterWeeks = makePlanAnswer({
    today: '2026-11-25',
    examDate: null,
    plan: weeklyPlan,
    chapters: CHAPTERS,
  });
  const overModel = selectTodayUpcomingPlan({ library, planAnswer: afterWeeks });
  assert.equal(overModel.visible, true);
  assert.equal(overModel.kind, 'plan');
  assert.match(overModel.weeklyLine, /已经过了/);
  assert.deepEqual(overModel.days, []);
});

test('selectTodayUpcomingPlan (#861): falls back to quiet 建一个备考计划 state when no active plan exists, and suppresses flash while loading', async () => {
  const { selectTodayUpcomingPlan, setUiLanguage } = await loadUi(`
    export { selectTodayUpcomingPlan } from './ui/board/today-upcoming-plan.js';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  setUiLanguage('zh');

  // Planned course whose RPC is still in flight (`planAnswer: null`): waits quietly.
  const loadingModel = selectTodayUpcomingPlan({
    library: {
      focus: { course: '操作系统' },
      courses: [{ name: '操作系统', active: true, plan: { version: 1, minutesPerDay: 60 } }],
    },
    planAnswer: null,
  });
  assert.equal(loadingModel.visible, false);
  assert.equal(loadingModel.kind, 'loading');

  // Course without a plan: renders single quiet fallback row.
  const noPlanModel = selectTodayUpcomingPlan({
    library: {
      focus: { course: '计算机网络' },
      courses: [{ name: '计算机网络', active: true }],
    },
    planAnswer: null,
  });
  assert.equal(noPlanModel.visible, true);
  assert.equal(noPlanModel.kind, 'empty');
  assert.equal(noPlanModel.course, '计算机网络');

  // Completely empty workspace with no courses, decks, or sources: stays hidden.
  const emptyLib = selectTodayUpcomingPlan({
    library: { courses: [], decks: [], sources: [] },
    planAnswer: null,
  });
  assert.equal(emptyLib.visible, false);
});

test('TodayUpcomingPlan & TodayView (#861): SSR renders zh and en with plan, no-plan fallback, and narrow disclosure button', async () => {
  const { TodayView, setUiLanguage } = await loadUi(`
    export { default as TodayView } from './ui/board/TodayView.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);

  const board = emptyBoard();
  const plan = {
    version: 1,
    minutesPerDay: 45,
    restDates: ['2026-11-10'],
    mockDates: ['2026-11-11'],
  };
  const answer = makePlanAnswer({ today: '2026-11-08', examDate: '2026-11-16', plan });
  const plannedLib = {
    focus: { course: '操作系统' },
    courses: [{ name: '操作系统', active: true, exam: { date: '2026-11-16' }, plan }],
  };

  setUiLanguage('zh');
  const zhHtml = renderToStaticMarkup(
    React.createElement(TodayView, {
      board,
      today: '2026-11-08',
      library: plannedLib,
      planAnswer: answer,
      onOpenPlan: () => {},
      onToggleDone: () => {},
      onEdit: () => {},
      onAction: () => {},
      onQuickAdd: async () => true,
      onScheduleToday: async () => true,
    }),
  );
  assert.match(zhHtml, /备考计划 · 接下来/);
  assert.match(zhHtml, /打开备考计划/);
  assert.match(zhHtml, /更多 · 备考计划/);
  assert.match(zhHtml, /11\/09/);
  assert.match(zhHtml, /休息/);
  assert.match(zhHtml, /模拟考 · 整套模拟卷/);

  setUiLanguage('en');
  const enHtml = renderToStaticMarkup(
    React.createElement(TodayView, {
      board,
      today: '2026-11-08',
      library: {
        focus: { course: 'Computer Networks' },
        courses: [{ name: 'Computer Networks', active: true }],
      },
      planAnswer: { status: 'no-plan', course: 'Computer Networks' },
      onOpenPlan: () => {},
      onToggleDone: () => {},
      onEdit: () => {},
      onAction: () => {},
      onQuickAdd: async () => true,
      onScheduleToday: async () => true,
    }),
  );
  assert.match(enHtml, /No study plan yet/);
  assert.match(enHtml, /Create a study plan/);
  assert.match(enHtml, /More · Study plan/);
  setUiLanguage('zh');
});
