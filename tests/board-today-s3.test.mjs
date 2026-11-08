/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { todayBudgetMinutes } from '../lib/board-model.js';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export { setUiLanguage } from './ui/i18n.js';
      export { default as Board } from './ui/Board.jsx';
      export { default as TodayFocusStrip } from './ui/board/TodayFocusStrip.jsx';
      export { countDueReviews, pickWeakestTopic, selectPlanChip, selectTodayFocusStrip } from './ui/board/today-focus-strip.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom'],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});
const uiModule = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, uiModule, uiModule.exports);
const {
  setUiLanguage,
  Board,
  TodayFocusStrip,
  countDueReviews,
  pickWeakestTopic,
  selectPlanChip,
  selectTodayFocusStrip,
} = uiModule.exports;

const TODAY = '2026-11-08';

const emptyBoard = () => ({
  version: 1,
  revision: 0,
  columns: [
    { id: 'todo', title: '待办', done: false, cardIds: [] },
    { id: 'doing', title: '进行中', done: false, cardIds: [] },
    { id: 'done', title: '已完成', done: true, cardIds: [] },
  ],
  cards: {},
  archived: [],
});

function samplePlanAnswer(overrides = {}) {
  return {
    status: 'ok',
    course: '操作系统',
    examDate: '2026-12-18',
    daysLeft: 40,
    today: TODAY,
    plan: { version: 1, minutesPerDay: 90, status: 'active' },
    points: [
      { id: 'p-sched', code: '3.1', title: '进程调度算法' },
      { id: 'p-deadlock', code: '3.2', title: '死锁预防与避免' },
    ],
    schedule: {
      status: 'ok',
      examDate: '2026-12-18',
      today: {
        date: TODAY,
        offset: 0,
        mode: 'learn',
        points: ['p-sched', 'p-deadlock'],
        done: [],
        minutes: 50,
        reason: { code: 'learn', count: 2, tested: 1, minutes: 50 },
      },
    },
    ...overrides,
  };
}

function sampleLibrary({ weakInFocus = false, weakInDeck = true, due = 6 } = {}) {
  return {
    revision: 1,
    courses: [{ name: '操作系统', active: true, exam: { date: '2026-12-18' }, plan: { version: 1, status: 'active' } }],
    focus: {
      course: '操作系统',
      ...(weakInFocus
        ? {
          progress: {
            course: '操作系统',
            total: 2,
            topics: [
              { topic: '虚拟内存页面置换', cards: 8, mastery: 22, status: 'weak', counts: { weak: 3 }, weakCards: [{}, {}, {}] },
              { topic: '信号量同步', cards: 6, mastery: 45, status: 'weak', counts: { weak: 1 }, weakCards: [{}] },
            ],
          },
        }
        : {}),
    },
    progress: {
      'deck-1': {
        id: 'deck-1',
        title: '操作系统第一章',
        archived: false,
        due,
        topics: weakInDeck
          ? [
            { name: '银行家算法', total: 6, mastery: 30, counts: { weak: 4, new: 0, learning: 2, familiar: 0, mastered: 0 } },
            { name: '管程与条件变量', total: 5, mastery: 55, counts: { weak: 2, new: 0, learning: 3, familiar: 0, mastered: 0 } },
          ]
          : [
            { name: '银行家算法', total: 6, mastery: 90, counts: { weak: 0, new: 0, learning: 0, familiar: 1, mastered: 5 } },
          ],
      },
      'deck-archived': {
        id: 'deck-archived',
        title: '归档题组',
        archived: true,
        due: 99,
        topics: [{ name: '旧考点', total: 10, mastery: 10, counts: { weak: 10 } }],
      },
      'deck-inactive': {
        id: 'deck-inactive',
        title: '停用题组',
        archived: false,
        inactive: true,
        due: 50,
        topics: [{ name: '停用考点', total: 10, mastery: 10, counts: { weak: 10 } }],
      },
    },
  };
}

test('selectTodayFocusStrip (#857): selects all 3 chips and shows planned budget without focused half before S4', () => {
  setUiLanguage('zh');
  assert.equal(todayBudgetMinutes(emptyBoard(), TODAY, 45), 45);
  const strip = selectTodayFocusStrip({
    library: sampleLibrary({ weakInFocus: false, weakInDeck: true, due: 6 }),
    planAnswer: samplePlanAnswer(),
    budgetMinutes: 45,
  });

  assert.equal(strip.visible, true);
  assert.deepEqual(strip.chips.map((c) => c.id), ['plan', 'weak', 'due']);
  assert.equal(strip.chips[0].label, '今日章节：3.1 进程调度算法（共 2 节）');
  assert.match(strip.chips[0].tooltip, /来自「操作系统」备考计划/);
  assert.equal(strip.chips[1].label, '薄弱：银行家算法 · 4 题');
  assert.match(strip.chips[1].tooltip, /错题本薄弱点分布/);
  assert.equal(strip.chips[2].label, '到期复习 6 题');
  assert.match(strip.chips[2].tooltip, /间隔重复排期/);

  assert.equal(strip.budget.label, '今天计划 45 分钟');
  assert.doesNotMatch(strip.budget.label, /已专注/);
  assert.equal(strip.budget.value, 0);
  assert.equal(strip.budget.max, 45);
});

test('selectTodayFocusStrip (#857): prefers course focus-progress weak topic when saved focus topics have mistakes, and supports weekly plans', () => {
  setUiLanguage('zh');
  const weeklyPlan = samplePlanAnswer({
    schedule: {
      status: 'ok',
      weekly: { current: { n: 2, chapters: [{ n: 3, title: '进程管理' }, { n: 4, title: '内存管理' }] }, behind: 0 },
      today: {
        date: TODAY,
        mode: 'learn',
        points: ['p-sched'],
        minutes: 25,
        reason: { code: 'week', count: 1, minutes: 25, carried: 0 },
      },
    },
  });
  const weakest = pickWeakestTopic(sampleLibrary({ weakInFocus: true, weakInDeck: true }));
  assert.equal(weakest.source, 'focus');
  assert.equal(weakest.topic, '虚拟内存页面置换');
  assert.equal(weakest.weakCount, 3);

  const planChip = selectPlanChip(weeklyPlan);
  assert.equal(planChip.label, '本周：第 3–4 章 · 3.1 进程调度算法');

  const withFocusMinutes = selectTodayFocusStrip({
    library: sampleLibrary({ weakInFocus: true, weakInDeck: true, due: 4 }),
    planAnswer: weeklyPlan,
    budgetMinutes: 60,
    focusedMinutes: 25,
  });
  assert.equal(withFocusMinutes.budget.label, '今天计划 60 分钟 / 已专注 25 分钟');
  assert.equal(withFocusMinutes.budget.value, 25);
});

test('selectTodayFocusStrip (#857): handles partial data (no plan, no weak topic, zero due) and hides completely when all are empty', () => {
  setUiLanguage('zh');
  // 1) No course.plan -> only weak + due
  const noPlan = selectTodayFocusStrip({
    library: sampleLibrary({ weakInDeck: true, due: 5 }),
    planAnswer: { status: 'no-plan', course: '操作系统', today: TODAY, plan: null },
    budgetMinutes: 40,
  });
  assert.equal(noPlan.visible, true);
  assert.deepEqual(noPlan.chips.map((c) => c.id), ['weak', 'due']);

  // 2) No weak topic -> plan + due
  const noWeak = selectTodayFocusStrip({
    library: sampleLibrary({ weakInDeck: false, due: 5 }),
    planAnswer: samplePlanAnswer(),
    budgetMinutes: 40,
  });
  assert.equal(noWeak.visible, true);
  assert.deepEqual(noWeak.chips.map((c) => c.id), ['plan', 'due']);

  // 3) Zero due -> plan + weak
  const zeroDue = selectTodayFocusStrip({
    library: sampleLibrary({ weakInDeck: true, due: 0 }),
    planAnswer: samplePlanAnswer(),
    budgetMinutes: 40,
  });
  assert.equal(countDueReviews(sampleLibrary({ weakInDeck: true, due: 0 })), 0);
  assert.equal(zeroDue.visible, true);
  assert.deepEqual(zeroDue.chips.map((c) => c.id), ['plan', 'weak']);

  // 4) Nothing at all (no plan, no weak topic, zero due) -> entire strip hidden even when default budget exists
  const emptyAll = selectTodayFocusStrip({
    library: sampleLibrary({ weakInDeck: false, due: 0 }),
    planAnswer: null,
    budgetMinutes: 40,
  });
  assert.equal(emptyAll.visible, false);
  assert.deepEqual(emptyAll.chips, []);
  assert.equal(emptyAll.budget, null);
});

test('TodayFocusStrip SSR (#857): uses Tooltip (never title=), hides when empty, and renders clean English without CJK', () => {
  setUiLanguage('zh');
  const board = emptyBoard();
  const state = { board, error: '', conflict: false, busy: false, mutate: async () => true, refresh: () => {} };

  const emptyHtml = renderToStaticMarkup(
    React.createElement(Board, {
      state,
      library: sampleLibrary({ weakInDeck: false, due: 0 }),
      today: TODAY,
      defaultView: 'today',
      dailyBudgetMinutes: 40,
      planAnswer: null,
    }),
  );
  assert.doesNotMatch(emptyHtml, /board-today__focus-strip/, 'entire strip hides when nothing is due, weak, or planned');

  const fullStripHtml = renderToStaticMarkup(
    React.createElement(TodayFocusStrip, {
      library: sampleLibrary({ weakInDeck: true, due: 8 }),
      today: TODAY,
      budgetMinutes: 50,
      planAnswer: samplePlanAnswer(),
    }),
  );
  assert.match(fullStripHtml, /今天的重点/);
  assert.match(fullStripHtml, /今日章节：3\.1 进程调度算法（共 2 节）/);
  assert.match(fullStripHtml, /薄弱：银行家算法 · 4 题/);
  assert.match(fullStripHtml, /到期复习 8 题/);
  assert.match(fullStripHtml, /今天计划 50 分钟/);
  assert.doesNotMatch(fullStripHtml, /已专注/);
  assert.match(fullStripHtml, /role="tooltip"/, 'renders accessible Tooltip descriptions');
  assert.doesNotMatch(fullStripHtml, /\stitle=/, 'never uses native title= attribute');

  setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(
      React.createElement(TodayFocusStrip, {
        library: {
          ...sampleLibrary({ weakInDeck: false, due: 8 }),
          courses: [{ name: 'Operating Systems', active: true, plan: { version: 1, status: 'active' } }],
          progress: {
            'deck-en': {
              id: 'deck-en',
              title: 'OS Deck',
              archived: false,
              due: 8,
              topics: [{ name: 'Banker Algorithm', total: 5, mastery: 30, counts: { weak: 3 } }],
            },
          },
        },
        today: TODAY,
        budgetMinutes: 50,
        planAnswer: samplePlanAnswer({
          course: 'Operating Systems',
          points: [{ id: 'p-sched', code: '3.1', title: 'CPU Scheduling' }],
          schedule: {
            status: 'ok',
            examDate: '2026-12-18',
            today: { date: TODAY, mode: 'learn', points: ['p-sched'], minutes: 25, reason: { code: 'learn', count: 1, tested: 1, minutes: 25 } },
          },
        }),
      }),
    );
    assert.match(enHtml, /Today&#x27;s focus/);
    assert.match(enHtml, /Today&#x27;s section: 3\.1 CPU Scheduling/);
    assert.match(enHtml, /Weakest: Banker Algorithm · 3 weak/);
    assert.match(enHtml, /8 due for review/);
    assert.match(enHtml, /Planned 50 min today/);
    assert.doesNotMatch(enHtml, /[\u4e00-\u9fff]/, 'English rendering contains zero CJK characters');
  } finally {
    setUiLanguage('zh');
  }
});
