/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { boardAction } from '../lib/board.js';
import { applyBoardAction, selectTodayBoard, shouldLandOnToday } from '../lib/board-model.js';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export { default as Board } from './ui/Board.jsx';
      export { default as TodayView } from './ui/board/TodayView.jsx';
      export { default as CardEditor } from './ui/board/CardEditor.jsx';
      export { default as DailyPlan } from './ui/DailyPlan.jsx';
      export { formatTodayHeading, todayPlanLine } from './ui/board/today-header.js';
      export { setUiLanguage } from './ui/i18n.js';
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
const { Board, CardEditor, DailyPlan, formatTodayHeading, todayPlanLine, setUiLanguage } = uiModule.exports;

const han = /[㐀-鿿]/;
const noop = () => {};
const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = (element, language = 'zh') => {
  setUiLanguage(language);
  try {
    return renderToStaticMarkup(element);
  } finally {
    setUiLanguage('zh');
  }
};

test('boardAction plannedDate: validates YYYY-MM-DD, keeps unscheduled cards lean, clears cleanly, and loads legacy boards unchanged', async () => {
  const home = await mkdtemp(join(tmpdir(), 'study-board-s1-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const initial = await boardAction('board.get');
    assert.equal(initial.columns.length, 3);

    const plain = await boardAction('board.card.add', { revision: initial.revision, title: '普通待办' }, '/ws/a');
    const plainCard = Object.values(plain.cards)[0];
    assert.equal(Object.hasOwn(plainCard, 'plannedDate'), false, 'omitted plannedDate is not written onto the card');

    const scheduled = await boardAction('board.card.add', { revision: plain.revision, title: '今天要做的事', plannedDate: '2026-10-02' }, '/ws/a');
    const scheduledCard = Object.values(scheduled.cards).find((c) => c.title === '今天要做的事');
    assert.equal(scheduledCard.plannedDate, '2026-10-02');

    const leap = await boardAction('board.card.edit', { revision: scheduled.revision, id: scheduledCard.id, plannedDate: '2028-02-29' });
    assert.equal(leap.cards[scheduledCard.id].plannedDate, '2028-02-29');

    const boardFile = join(home, 'study', 'board.json');
    const beforeBad = await readFile(boardFile, 'utf8');
    for (const bad of ['2026-02-29', '2026/10/02', 'tomorrow', 20261002]) {
      await assert.rejects(() => boardAction('board.card.edit', { revision: leap.revision, id: scheduledCard.id, plannedDate: bad }), /plannedDate/);
      await assert.rejects(() => boardAction('board.card.add', { revision: leap.revision, title: '坏日期', plannedDate: bad }), /plannedDate/);
    }
    assert.equal(await readFile(boardFile, 'utf8'), beforeBad, 'rejected plannedDate never mutates board.json');

    const cleared = await boardAction('board.card.edit', { revision: leap.revision, id: scheduledCard.id, plannedDate: '' });
    assert.equal(Object.hasOwn(cleared.cards[scheduledCard.id], 'plannedDate'), false, 'clearing plannedDate deletes the key');

    // Optimistic reducer mirrors boardAction semantics.
    const optimisticSet = applyBoardAction(cleared, 'board.card.edit', { id: scheduledCard.id, plannedDate: '2026-10-03' });
    assert.equal(optimisticSet.cards[scheduledCard.id].plannedDate, '2026-10-03');
    const optimisticCleared = applyBoardAction(optimisticSet, 'board.card.edit', { id: scheduledCard.id, plannedDate: '' });
    assert.equal(Object.hasOwn(optimisticCleared.cards[scheduledCard.id], 'plannedDate'), false);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('selectTodayBoard and shouldLandOnToday: merges daily plan, due/overdue, plannedDate, today-only done cards, and Decision 1 landing rules', () => {
  const today = '2026-10-02';
  const todayNoonIso = new Date(2026, 9, 2, 12, 0, 0).toISOString();
  const yesterdayIso = new Date(2026, 9, 1, 12, 0, 0).toISOString();
  const card = (id, extra = {}) => ({
    id,
    title: `Card ${id}`,
    note: '',
    due: '',
    labels: [],
    createdAt: yesterdayIso,
    updatedAt: yesterdayIso,
    ...extra,
  });

  const board = {
    version: 1,
    revision: 4,
    columns: [
      { id: 'todo', title: '待办', done: false, cardIds: ['dueToday', 'overdue', 'plannedToday', 'plannedFuture', 'dailyAccepted', 'backlog'] },
      { id: 'doing', title: '进行中', done: false, cardIds: ['createdTodayTask'] },
      { id: 'done', title: '已完成', done: true, cardIds: ['doneToday', 'doneYesterday'] },
    ],
    cards: {
      dueToday: card('dueToday', { due: today }),
      overdue: card('overdue', { due: '2026-09-29' }),
      plannedToday: card('plannedToday', { plannedDate: today }),
      plannedFuture: card('plannedFuture', { plannedDate: '2026-10-05' }),
      dailyAccepted: card('dailyAccepted'),
      backlog: card('backlog', { due: '2026-10-10' }),
      createdTodayTask: card('createdTodayTask', { learningTask: { kind: 'reading', minutes: 15, createdDate: today } }),
      doneToday: card('doneToday', { updatedAt: todayNoonIso }),
      doneYesterday: card('doneYesterday', { updatedAt: yesterdayIso }),
    },
    archived: [],
    dailyPlanner: {
      version: 1,
      profile: { weekdayMinutes: 30, weekendMinutes: 45 },
      plans: { '/lib::2026-10-02': { date: today, taskIds: ['dailyAccepted'] } },
    },
  };

  const projected = selectTodayBoard(board, { today });
  assert.deepEqual(
    projected.open.map((c) => c.id),
    ['dueToday', 'overdue', 'plannedToday', 'dailyAccepted', 'createdTodayTask'],
  );
  assert.deepEqual(projected.done.map((c) => c.id), ['doneToday'], 'only cards finished today stay visible with strikethrough');
  assert.deepEqual(projected.unscheduled.map((c) => c.id), ['plannedFuture', 'backlog']);

  // Decision 1 landing checks:
  const emptyBoard = { ...board, columns: board.columns.map((col) => ({ ...col, cardIds: [] })), cards: {}, dailyPlanner: { plans: {} } };
  assert.equal(shouldLandOnToday({ data: { courses: [] }, board: emptyBoard, today }), false);
  assert.equal(
    shouldLandOnToday({
      data: { courses: [{ name: 'CS101', active: true, plan: { version: 1, minutesPerDay: 60 } }] },
      board: emptyBoard,
      today,
    }),
    true,
    'active course.plan lands on Today even when board is empty',
  );
  assert.equal(
    shouldLandOnToday({
      data: { courses: [{ name: 'CS101', active: false, plan: { version: 1, minutesPerDay: 60 } }] },
      board: emptyBoard,
      today,
    }),
    false,
    'parked course does not trigger Today landing',
  );
  assert.equal(
    shouldLandOnToday({
      data: { courses: [{ name: 'CS101', active: true, plan: { version: 1, status: 'paused', minutesPerDay: 60 } }] },
      board: emptyBoard,
      today,
    }),
    false,
    'paused course.plan does not trigger Today landing',
  );
  assert.equal(
    shouldLandOnToday({ data: { courses: [] }, board, today }),
    true,
    'open Today items trigger Today landing without a course.plan',
  );
});

test('SSR UI: TodayView header, tabs, empty state, CardEditor plannedDate, DailyPlan 去今日, and English zero-CJK', () => {
  const today = '2026-10-02';
  const todayIso = new Date(2026, 9, 2, 10, 30, 0).toISOString();
  const libraryWithPlan = {
    root: '/lib',
    focus: { course: 'Operating Systems' },
    courses: [
      {
        name: 'Operating Systems',
        active: true,
        exam: { date: '2026-10-20' },
        plan: { version: 1, minutesPerDay: 90 },
      },
    ],
    decks: [{ id: 'd1', title: 'Virtual memory' }],
    sources: [],
    notes: [],
    skeletons: [],
  };

  setUiLanguage('zh');
  assert.match(formatTodayHeading(today), /10/);
  assert.equal(todayPlanLine(libraryWithPlan, today), 'Operating Systems · 课前：导入资料 · 距考试 18 天');
  setUiLanguage('en');
  assert.doesNotMatch(formatTodayHeading(today), han);
  assert.equal(todayPlanLine(libraryWithPlan, today), 'Operating Systems · Before class: import the material · Exam in 18 days');
  setUiLanguage('zh');

  const populatedBoard = {
    version: 1,
    revision: 3,
    columns: [
      { id: 'todo', title: '待办', done: false, cardIds: ['c1', 'c2'] },
      { id: 'doing', title: '进行中', done: false, cardIds: [] },
      { id: 'done', title: '已完成', done: true, cardIds: ['c3'] },
    ],
    cards: {
      c1: { id: 'c1', title: 'Review page tables', note: '', due: today, plannedDate: today, labels: ['exam'], createdAt: todayIso, updatedAt: todayIso },
      c2: { id: 'c2', title: 'Read scheduling paper', note: '', due: '', labels: [], createdAt: todayIso, updatedAt: todayIso },
      c3: { id: 'c3', title: 'Set up lab VM', note: '', due: '', plannedDate: today, labels: [], createdAt: todayIso, updatedAt: todayIso },
    },
    archived: [{ id: 'c4', title: 'Old task', note: '', due: '', labels: [], createdAt: todayIso, updatedAt: todayIso }],
  };
  const stateOf = (b) => ({ board: b, error: '', conflict: false, busy: false, mutate: async () => true, refresh: noop, clearError: noop });

  const todayHtml = render(React.createElement(Board, { state: stateOf(populatedBoard), library: libraryWithPlan, today, view: 'today' }));
  assert.match(todayHtml, /role="tablist"/);
  for (const text of ['今日', '(1)', '全部待办', '归档', 'Operating Systems · 课前：导入资料 · 距考试 18 天', '记一条', 'Review page tables', '今天已完成 · 1', 'Set up lab VM', '还没排的待办', 'Read scheduling paper']) {
    assert.ok(strip(todayHtml).includes(text), `Today view includes "${text}"`);
  }

  const emptyBoard = {
    ...populatedBoard,
    columns: populatedBoard.columns.map((col) => ({ ...col, cardIds: [] })),
    cards: {},
    archived: [],
  };
  const emptyTodayHtml = render(React.createElement(Board, { state: stateOf(emptyBoard), library: { root: '/lib', courses: [] }, today, view: 'today' }));
  assert.match(emptyTodayHtml, /今天还没有排事。/);
  assert.match(emptyTodayHtml, /排今天/);
  assert.doesNotMatch(emptyTodayHtml, /还没有待办/, 'Today empty state stays a single quiet row, not the full-board EmptyState');

  const editorHtml = render(React.createElement(CardEditor, {
    card: populatedBoard.cards.c2,
    board: populatedBoard,
    library: libraryWithPlan,
    today,
    onSave: async () => true,
    onArchive: noop,
    onDelete: noop,
    onClose: noop,
  }));
  assert.match(editorHtml, /排在哪天/);
  assert.match(editorHtml, /排到今天/);
  assert.match(editorHtml, /只排在哪天做，不改截止日期/);

  const planControls = {
    state: { date: today, budgetMinutes: 30, spentMinutes: 0, profile: { weekdayMinutes: 30, weekendMinutes: 45 }, tasks: [], proposal: null },
    busy: '',
    error: '',
    suggest: noop,
    accept: noop,
    saveProfile: noop,
    start: noop,
    complete: noop,
    refresh: noop,
  };
  const homePlanHtml = render(React.createElement(DailyPlan, { plan: planControls, onBoard: noop }));
  assert.match(homePlanHtml, /去今日/);

  // English UI zero-CJK checks across Today (populated & empty), All tasks, Archive, CardEditor, and DailyPlan.
  for (const element of [
    React.createElement(Board, { state: stateOf(populatedBoard), library: libraryWithPlan, today, view: 'today' }),
    React.createElement(Board, { state: stateOf(emptyBoard), library: libraryWithPlan, today, view: 'today' }),
    React.createElement(Board, { state: stateOf(populatedBoard), library: libraryWithPlan, today, view: 'all' }),
    React.createElement(Board, { state: stateOf(populatedBoard), library: libraryWithPlan, today, view: 'archive' }),
    React.createElement(CardEditor, { card: populatedBoard.cards.c1, board: populatedBoard, library: libraryWithPlan, today, onSave: async () => true, onArchive: noop, onDelete: noop, onClose: noop }),
    React.createElement(DailyPlan, { plan: planControls, onBoard: noop }),
  ]) {
    assert.doesNotMatch(strip(render(element, 'en')), han, 'English render contains zero Chinese characters');
  }
});
