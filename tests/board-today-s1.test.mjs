/* global document, window, process */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { boardAction } from '../lib/board.js';
import { applyBoardAction, localDate, selectTodayBoard, shouldLandOnToday } from '../lib/board-model.js';
import { addDays } from '../lib/crunch-plan.js';
import { StudyService } from '../lib/service.js';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { COURSE, library as crunchLibrary } from './helpers/crunch-library.mjs';

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

test('Browser E2E (#855): Today landing, quick-add, schedule chip, done-today strikethrough, tab switch, Home 去今日, and responsive widths (1280, 420, 390 px)', { timeout: 300000 }, async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`Chromium unavailable: ${String(error.message).split('\n')[0]}`);
    return;
  }
  const today = localDate();
  const dist = await mkdtemp(join(tmpdir(), 'study-today-s1-dist-'));
  await buildPreview({ outdir: dist });

  const seed = async (root) => {
    await mkdir(root, { recursive: true });
    const service = new StudyService(root);
    await service.call('snapshot');
    const { state } = crunchLibrary();
    await service.store.update((own) => {
      own.sources.push(...state.sources);
      own.decks.push(...state.decks);
      own.focus = state.focus;
    });
    await service.call('course.save', { name: COURSE, exam: { date: addDays(today, 25) } });
    await service.call('course.save', { name: COURSE, plan: { version: 1, minutesPerDay: 90 } });
    await service.dispose();
  };

  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.TODAY_S1_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });

  t.after(async () => {
    await browser?.close();
    await running.close();
    await rm(dist, { recursive: true, force: true });
  });

  // Seed one due-today card and one unscheduled card on the board.
  let seededBoard = await running.api('board.get');
  seededBoard = await running.api('board.card.add', { revision: seededBoard.revision, title: '复习第 2 章错题', due: today, labels: ['复习'] });
  await running.api('board.card.add', { revision: seededBoard.revision, title: '整理实验报告提纲', labels: ['写作'] });

  const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  const { page, errors, context } = await openPage(browser, running, { lang: 'zh', theme: 'dark', width: 1280, height: 860 });
  await page.goto(running.server.url);

  // Decision 1: active course.plan lands directly on 待办 → 今日.
  const todayRoot = page.locator('.board-today');
  await todayRoot.waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.study-app').getAttribute('data-usage-area'), 'board');
  assert.match(await todayRoot.locator('.board-today__plan').innerText(), /SA · .*距考试 25 天/);
  assert.ok((await sideways(page)) <= 0, '1280px: no horizontal overflow');

  // Quick-add a card directly into Today.
  await todayRoot.getByPlaceholder('记一条今天要做的事…').fill('做 10 道概念辨析');
  await todayRoot.getByRole('button', { name: '记一条' }).click();
  await todayRoot.locator('.board-card__title', { hasText: '做 10 道概念辨析' }).waitFor({ timeout: 15000 });

  // Pull an unscheduled card into Today with one click.
  const pick = todayRoot.getByRole('button', { name: '排到今天：整理实验报告提纲' });
  await pick.waitFor({ timeout: 15000 });
  await pick.click();
  await todayRoot.locator('.board-card__title', { hasText: '整理实验报告提纲' }).waitFor({ timeout: 15000 });
  assert.equal(await todayRoot.locator('.board-today__backlog').count(), 0, 'backlog hides once all cards are scheduled');

  // Check one card done: stays visible under 今天已完成 with strikethrough.
  await todayRoot.getByRole('checkbox', { name: '标记完成：做 10 道概念辨析' }).click();
  await todayRoot.locator('.board-today__done').waitFor({ timeout: 15000 });
  assert.match(await todayRoot.locator('.board-today__done').innerText(), /今天已完成 · 1/);
  assert.equal(await todayRoot.locator('.board-today__done .board-card.is-done').count(), 1);
  await settleAnimations(page);
  if (shots) await page.screenshot({ path: join(shots, 'today-populated-1280-dark.png') });

  // Switch to 全部待办: 3 columns intact.
  await page.getByRole('tab', { name: '全部待办' }).click();
  await page.locator('.board-columns').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('.board-column:not(.board-column--new)').count(), 3);
  if (shots) await page.screenshot({ path: join(shots, 'board-all-1280-dark.png') });

  // Navigate to 学习库, then click 去今日 on Home's DailyPlan -> lands back on 待办 → 今日.
  await (await revealNavRow(page, 'library')).click();
  const goToday = page.locator('.daily-plan').getByRole('button', { name: '去今日' });
  await goToday.waitFor({ timeout: 30000 });
  await goToday.click();
  await todayRoot.waitFor({ timeout: 15000 });

  // Narrow viewports (420px and 390px): zero horizontal overflow.
  for (const width of [420, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await settleAnimations(page);
    assert.ok((await sideways(page)) <= 0, `${width}px: no horizontal overflow on Today`);
    if (shots) await page.screenshot({ path: join(shots, `today-populated-${width}-dark.png`) });
  }

  assert.deepEqual(errors.filter((line) => !/favicon|status of 400/.test(line)), [], 'no page console errors');
  await context.close();

  // Decision 1 negative check: without an active plan and without open Today items, StudyHub opens on 学习库.
  await running.api('course.save', { name: COURSE, plan: null });
  let currentBoard = await running.api('board.get');
  for (const id of Object.keys(currentBoard.cards)) {
    currentBoard = await running.api('board.card.remove', { revision: currentBoard.revision, id });
  }
  const fresh = await openPage(browser, running, { lang: 'zh', theme: 'light', width: 1280, height: 860 });
  await fresh.page.goto(running.server.url);
  await fresh.page.locator('[data-usage-area="library"]').waitFor({ timeout: 30000 });
  assert.equal(await fresh.page.locator('.board-today').count(), 0, 'lands on 学习库 when no plan and no open Today cards exist');

  // Empty Today state check when user navigates to 待办.
  await (await revealNavRow(fresh.page, 'board')).click();
  await fresh.page.locator('.board-today__empty').waitFor({ timeout: 15000 });
  assert.match(await fresh.page.locator('.board-today__empty').innerText(), /今天还没有排事。/);
  await settleAnimations(fresh.page);
  if (shots) await fresh.page.screenshot({ path: join(shots, 'today-empty-1280-light.png') });
  await fresh.context.close();
});
