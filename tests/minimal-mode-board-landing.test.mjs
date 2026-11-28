/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';

const require = createRequire(import.meta.url);
const HAN = /[\u3400-\u9fff]/;
const noop = () => {};
const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as AppTopbar } from './ui/app/AppTopbar.jsx';
  export { useInitialLanding, fallbackLandingPage } from './ui/app/use-initial-landing.js';
  export { default as TodayView } from './ui/board/TodayView.jsx';
  export { cardMenuItems } from './ui/board/Card.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

async function loadWithMinimalAppearance() {
  const compiled = await build({
    stdin: {
      contents: `
        export { AppContext } from './ui/app/app-context.js';
        export { StudyServicesContext } from './ui/study-context.jsx';
        export { default as AppTopbar } from './ui/app/AppTopbar.jsx';
        export { useInitialLanding } from './ui/app/use-initial-landing.js';
        export { default as TodayView } from './ui/board/TodayView.jsx';
        export { setUiLanguage } from './ui/i18n.js';
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['react', 'react-dom', 'react/*', 'react-dom/*', '@base-ui/*'],
    loader: { '.css': 'text' },
    plugins: [{
      name: 'mock-minimal-appearance',
      setup(pluginBuild) {
        pluginBuild.onLoad({ filter: /ui[\\/]use-appearance\.js$/ }, () => ({
          contents: `
            const prefs = { theme: 'dark', motion: 'auto', sound: 'off', scale: 100, font: 'system', fontTitle: 'follow', fontCustom: '', accent: 'cinnabar', contrast: 'auto', density: 'standard', radius: 'standard', craft: 'standard', minimal: 'on' };
            export const useAppearance = () => [prefs, () => {}, () => {}];
            export const useMinimalMode = () => true;
            export const useAppearanceAttrs = () => ({ 'data-theme': 'dark', 'data-minimal': 'on' });
            export const useSeatAppearance = () => ({ 'data-minimal': 'on' });
          `,
          loader: 'js',
        }));
        pluginBuild.onLoad({ filter: /ui[\\/]appearance-prefs\.js$/ }, async (args) => {
          const src = await readFile(args.path, 'utf8');
          const patched = `${src.replace('export function getCachedAppearance(', 'function _origGetCachedAppearance(')}\nexport function getCachedAppearance() { return { minimal: 'on' }; }\n`;
          return { contents: patched, loader: 'js' };
        });
      },
    }],
    logLevel: 'silent',
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

function runInitialLandingHook(hookFn, props) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const refs = [];
  const effects = [];
  let cursor = 0;
  const prev = internals.H;
  internals.H = {
    useRef: (init) => {
      const i = cursor++;
      if (!(i in refs)) refs[i] = { current: init };
      return refs[i];
    },
    useEffect: (fn) => { effects.push(fn); },
    useLayoutEffect: (fn) => { effects.push(fn); },
  };
  try {
    hookFn(props);
    for (const fn of effects) fn();
  } finally {
    internals.H = prev;
  }
}

function renderTopbar(mod, { data = { root: '/lib', inbox: [], model: { ready: true, label: 'DeepSeek' } }, connection = {}, busy = false, language = 'zh', minimal } = {}) {
  mod.setUiLanguage(language);
  try {
    const app = {
      nav: { page: 'library', navPage: 'library', navigate: noop },
      inbox: { openInboxItem: noop },
      board: { due: { overdue: 0, today: 0 } },
      core: { call: noop, act: noop, busy, notify: noop, setError: noop, quick: {}, quickApi: { failures: {} } },
      connection: { binding: { root: '/lib' }, running: false, publishing: false, syncIssue: '', ...connection },
      settingsEntry: { setSettingsFocus: noop, openModelSettings: noop },
      shell: { navDrawer: true, navOpen: false, setNavOpen: noop },
    };
    const element = React.createElement(mod.AppTopbar, { title: language === 'en' ? 'Library' : '学习库', ...(minimal !== undefined ? { minimal } : {}) });
    return renderToStaticMarkup(inApp(mod, element, { data: data || {}, app: { ...app, data } }));
  } finally {
    mod.setUiLanguage('zh');
  }
}

function makeTodayBoard({ am = [], pm = [], done = [], unscheduled = [], memos = [], timer = null } = {}) {
  const today = '2026-11-28';
  const iso = '2026-11-28T09:00:00.000Z';
  const cards = {};
  const todoIds = [];
  const doneIds = [];
  for (const item of am) {
    cards[item.id] = { id: item.id, title: item.title, note: '', due: '', plannedDate: today, slot: 'am', slotDate: today, labels: [], createdAt: iso, updatedAt: iso, ...item };
    todoIds.push(item.id);
  }
  for (const item of pm) {
    cards[item.id] = { id: item.id, title: item.title, note: '', due: '', plannedDate: today, slot: 'pm', slotDate: today, labels: [], createdAt: iso, updatedAt: iso, ...item };
    todoIds.push(item.id);
  }
  for (const item of unscheduled) {
    cards[item.id] = { id: item.id, title: item.title, note: '', due: '', labels: [], createdAt: iso, updatedAt: iso, ...item };
    todoIds.push(item.id);
  }
  for (const item of memos) {
    cards[item.id] = { id: item.id, kind: 'memo', title: item.title, note: item.note || '', labels: [], createdAt: iso, updatedAt: iso, ...item };
    todoIds.push(item.id);
  }
  for (const item of done) {
    cards[item.id] = { id: item.id, title: item.title, note: '', due: '', plannedDate: today, labels: [], createdAt: iso, updatedAt: iso, ...item };
    doneIds.push(item.id);
  }
  return {
    today,
    board: {
      version: 1,
      revision: 1,
      columns: [
        { id: 'todo', title: '待办', done: false, cardIds: todoIds },
        { id: 'done', title: '已完成', done: true, cardIds: doneIds },
      ],
      cards,
      archived: [],
      todayOrder: {},
      timeLog: [],
      timer,
      timerPrefs: { workMinutes: 25, breakMinutes: 5, sound: false, notify: false },
    },
  };
}

function renderToday(mod, { board, today, library = { root: '/lib', courses: [] }, planAnswer = { status: 'no-plan', course: '' }, minimal, language = 'zh', extraProps = {} } = {}) {
  mod.setUiLanguage(language);
  try {
    return renderToStaticMarkup(React.createElement(mod.TodayView, {
      board,
      today,
      library,
      planAnswer,
      onToggleDone: noop,
      onEdit: noop,
      onAction: noop,
      onTodayAction: noop,
      onMoveToday: noop,
      onQuickAdd: async () => true,
      onScheduleToday: async () => true,
      onStartTimer: noop,
      onPauseTimer: noop,
      onResumeTimer: noop,
      onCancelTimer: noop,
      onCompleteTimer: noop,
      onAddMemo: async () => true,
      onEditMemo: async () => true,
      onArchiveMemo: noop,
      onDeleteMemo: noop,
      onOpenPlan: noop,
      ...(minimal !== undefined ? { minimal } : {}),
      ...extraProps,
    }));
  } finally {
    mod.setUiLanguage('zh');
  }
}

test('useInitialLanding: minimal=true stays on Learning Library even with active plan or open Today tasks, while preserving unavailable-library fallback', async () => {
  const plannedData = {
    contexts: ['library', 'study', 'bank', 'notes'],
    courses: [{ name: 'OS', active: true, plan: { version: 1, minutesPerDay: 60 } }],
  };
  const openTodayBoard = {
    columns: [{ id: 'todo', done: false, cardIds: ['c1'] }],
    cards: { c1: { id: 'c1', title: 'Review', plannedDate: '2026-11-28', slot: 'am', slotDate: '2026-11-28' } },
  };

  // Default (minimal=false): lands on board ('today').
  const defaultCalls = [];
  runInitialLandingHook(m.useInitialLanding, {
    loading: false,
    data: plannedData,
    boardState: { board: openTodayBoard, error: '' },
    nav: { page: 'library', forcePage: (p) => defaultCalls.push(['page', p]) },
    setBoardView: (v) => defaultCalls.push(['boardView', v]),
    navigationCount: () => 0,
    minimal: false,
  });
  assert.deepEqual(defaultCalls, [['boardView', 'today'], ['page', 'board']]);

  // minimal=true with library available: stays on library regardless of active plan or open Today cards.
  for (const [data, board] of [
    [plannedData, { columns: [], cards: {} }],
    [{ contexts: ['library', 'bank', 'study'], courses: [] }, openTodayBoard],
    [plannedData, openTodayBoard],
  ]) {
    const minCalls = [];
    runInitialLandingHook(m.useInitialLanding, {
      loading: false,
      data,
      boardState: { board, error: '' },
      nav: { page: 'library', forcePage: (p) => minCalls.push(['page', p]) },
      setBoardView: (v) => minCalls.push(['boardView', v]),
      navigationCount: () => 0,
      minimal: true,
    });
    assert.deepEqual(minCalls, [], 'minimal mode must not auto-jump to board when library is available');
  }

  // minimal=true with library unavailable: keeps modular fallback intact.
  const noLibPlanCalls = [];
  runInitialLandingHook(m.useInitialLanding, {
    loading: false,
    data: { contexts: ['materials'], courses: [{ name: 'OS', active: true, plan: { version: 1, minutesPerDay: 40 } }] },
    boardState: { board: null, error: '' },
    nav: { page: 'library', forcePage: (p) => noLibPlanCalls.push(['page', p]) },
    setBoardView: (v) => noLibPlanCalls.push(['boardView', v]),
    navigationCount: () => 0,
    minimal: true,
  });
  assert.deepEqual(noLibPlanCalls, [['boardView', 'today'], ['page', 'board']]);

  const noLibSourcesCalls = [];
  runInitialLandingHook(m.useInitialLanding, {
    loading: false,
    data: { contexts: ['materials'], courses: [] },
    boardState: { board: { columns: [], cards: {} }, error: '' },
    nav: { page: 'library', forcePage: (p) => noLibSourcesCalls.push(['page', p]) },
    setBoardView: (v) => noLibSourcesCalls.push(['boardView', v]),
    navigationCount: () => 0,
    minimal: true,
  });
  assert.deepEqual(noLibSourcesCalls, [['page', 'sources']]);

  // Verify real getCachedAppearance().minimal === 'on' reading when minimal parameter is omitted.
  const minimalMod = await loadWithMinimalAppearance();
  const cachedCalls = [];
  runInitialLandingHook(minimalMod.useInitialLanding, {
    loading: false,
    data: plannedData,
    boardState: { board: openTodayBoard, error: '' },
    nav: { page: 'library', forcePage: (p) => cachedCalls.push(['page', p]) },
    setBoardView: (v) => cachedCalls.push(['boardView', v]),
    navigationCount: () => 0,
  });
  assert.deepEqual(cachedCalls, []);
});

test('AppTopbar: minimal=true hides LibraryChip, ModelChip, and idle status, while keeping warnings, busy states, nav, crumbs, and Inbox', async () => {
  const readyData = { root: '/lib', inbox: [], model: { ready: true, label: 'DeepSeek' } };

  // Default (minimal=false): shows LibraryChip, ModelChip, and idle 已连接.
  const defaultHtml = renderTopbar(m, { data: readyData, minimal: false });
  assert.match(defaultHtml, /library-location/);
  assert.match(defaultHtml, /model-in-use/);
  assert.match(defaultHtml, /top-status-label"[^>]*>已连接</);

  // minimal=true idle: hides LibraryChip, ModelChip, and idle status; keeps NavMenuButton, crumbs, and Inbox.
  const minimalIdle = renderTopbar(m, { data: readyData, minimal: true });
  assert.doesNotMatch(minimalIdle, /library-location/);
  assert.doesNotMatch(minimalIdle, /model-in-use/);
  assert.doesNotMatch(minimalIdle, /top-status/);
  assert.doesNotMatch(minimalIdle, /已连接/);
  assert.match(minimalIdle, /nav-menu-toggle/);
  assert.match(minimalIdle, /class="crumbs"/);
  assert.match(minimalIdle, /mailbox/);

  // minimal=true non-idle honest states MUST stay visible ([C06]).
  const honestStates = [
    [{ data: readyData, busy: true, minimal: true }, '正在处理…'],
    [{ data: readyData, connection: { running: true }, minimal: true }, '后台处理中'],
    [{ data: readyData, connection: { running: true, publishing: true }, minimal: true }, '正在发布…'],
    [{ data: readyData, connection: { syncIssue: 'Failed to fetch', syncTransient: true }, minimal: true }, '重新连接中…'],
    [{ data: readyData, connection: { syncIssue: '读取失败', syncTransient: false }, minimal: true }, '读不出学习库'],
    [{ data: null, minimal: true }, '没有连上学习库'],
    [{ data: { root: '/lib', inbox: [], model: { ready: false } }, minimal: true }, '还没配模型'],
  ];
  for (const [opts, expected] of honestStates) {
    const html = renderTopbar(m, opts);
    assert.doesNotMatch(html, /library-location/);
    assert.doesNotMatch(html, /model-in-use/);
    assert.match(html, /top-status/);
    assert.ok(strip(html).includes(expected), `minimal topbar preserves honest state "${expected}"`);
  }

  // English render has zero CJK.
  const enMinimal = renderTopbar(m, { data: { root: '/lib', inbox: [], model: { ready: false } }, minimal: true, language: 'en' });
  assert.doesNotMatch(strip(enMinimal), HAN);
  assert.ok(strip(enMinimal).includes('No model yet'));

  // Verify real useAppearance() hook wiring when minimal prop is omitted.
  const minimalMod = await loadWithMinimalAppearance();
  const wiredIdle = renderTopbar(minimalMod, { data: readyData });
  assert.doesNotMatch(wiredIdle, /library-location/);
  assert.doesNotMatch(wiredIdle, /model-in-use/);
  assert.doesNotMatch(wiredIdle, /top-status/);
});

test('TodayView & board.css: minimal=true merges AM/PM lanes into one daily list, hides timer & right rail, keeps running TodayTimerBar, and preserves slot data', async () => {
  const { today, board } = makeTodayBoard({
    am: [{ id: 'a1', title: 'Morning task', slot: 'am', slotDate: '2026-11-28' }],
    pm: [{ id: 'p1', title: 'Afternoon task', slot: 'pm', slotDate: '2026-11-28' }],
    done: [{ id: 'd1', title: 'Done task' }],
    unscheduled: [{ id: 'u1', title: 'Backlog task' }],
  });

  // Default (minimal=false): AM/PM lanes, timer, right rail, start-timer button.
  const defaultHtml = renderToday(m, { board, today, minimal: false });
  assert.match(defaultHtml, /board-today__lanes/);
  assert.match(defaultHtml, /board-today__rail/);
  assert.match(defaultHtml, /board-timer/);
  assert.match(defaultHtml, /开始专注/);
  assert.match(defaultHtml, /placeholder="加到上午…"/);

  // minimal=true (no memos, no active plan, no timer): single daily list, no lanes, no timer, no rail, no empty memos/plan boxes.
  const minimalHtml = renderToday(m, { board, today, minimal: true });
  assert.match(minimalHtml, /data-minimal="on"/);
  assert.match(minimalHtml, /data-testid="board-today-daily"/);
  assert.doesNotMatch(minimalHtml, /board-today__lanes/);
  assert.doesNotMatch(minimalHtml, /board-today__lane-add/);
  assert.doesNotMatch(minimalHtml, /placeholder="加到上午…"/);
  assert.doesNotMatch(minimalHtml, /placeholder="加到下午…"/);
  assert.doesNotMatch(minimalHtml, /board-today__rail/);
  assert.doesNotMatch(minimalHtml, /class="board-timer[" ]/);
  assert.doesNotMatch(minimalHtml, /开始专注/);
  assert.doesNotMatch(minimalHtml, /board-timer-bar/);
  assert.doesNotMatch(minimalHtml, /board-memos/);
  assert.doesNotMatch(minimalHtml, /board-upcoming/);
  // Both AM & PM open cards, plus done & backlog & quick-add remain intact!
  const text = strip(minimalHtml);
  for (const expected of ['Morning task', 'Afternoon task', 'Done task', 'Backlog task', '记一条']) {
    assert.ok(text.includes(expected), `minimal TodayView keeps "${expected}"`);
  }

  // Underlying slot data is untouched, so switching minimal back off restores AM & PM lanes cleanly.
  assert.equal(board.cards.a1.slot, 'am');
  assert.equal(board.cards.p1.slot, 'pm');
  const restoredHtml = renderToday(m, { board, today, minimal: false });
  assert.match(restoredHtml, /board-today__lanes/);
  assert.match(restoredHtml, /上午[\s\S]*Morning task[\s\S]*下午[\s\S]*Afternoon task/);

  // Active timer in minimal mode: <TodayTimer> stays hidden, while <TodayTimerBar> renders so session is never orphaned.
  const timedData = makeTodayBoard({
    am: [{ id: 'a1', title: 'Timed task', slot: 'am', slotDate: '2026-11-28' }],
    timer: { id: 't1', mode: 'work', cardId: 'a1', cardTitle: 'Timed task', startedAt: '2026-11-28T09:00:00.000Z', durationMinutes: 25, pausedMs: 0 },
  });
  const timedMinimalHtml = renderToday(m, {
    board: timedData.board,
    today: timedData.today,
    minimal: true,
    extraProps: { nowMs: Date.parse('2026-11-28T09:05:00.000Z') },
  });
  assert.doesNotMatch(timedMinimalHtml, /class="board-timer[" ]/);
  assert.match(timedMinimalHtml, /class="board-timer-bar"/);
  assert.ok(strip(timedMinimalHtml).includes('Timed task'));
  assert.ok(strip(timedMinimalHtml).includes('20:00'));

  const timedStandardHtml = renderToday(m, {
    board: timedData.board,
    today: timedData.today,
    minimal: false,
    extraProps: { nowMs: Date.parse('2026-11-28T09:05:00.000Z') },
  });
  assert.match(timedStandardHtml, /全屏专注/);
  assert.doesNotMatch(timedMinimalHtml, /全屏专注/);
  assert.match(timedMinimalHtml, /放弃这一个/);

  // When memos or an active study plan exist in minimal mode, they render quietly below main list without the right rail.
  const extrasData = makeTodayBoard({
    am: [{ id: 'a1', title: 'Task 1', slot: 'am', slotDate: '2026-11-28' }],
    memos: [{ id: 'm1', title: 'Remember formula' }],
  });
  const extrasHtml = renderToday(m, {
    board: extrasData.board,
    today: extrasData.today,
    minimal: true,
    library: { focus: { course: 'OS' }, courses: [{ name: 'OS', active: true, plan: { version: 1, minutesPerDay: 45 } }] },
    planAnswer: {
      status: 'ok',
      course: 'OS',
      plan: { version: 1, status: 'active' },
      points: [{ id: 'p1', code: '1.1', title: 'Paging' }],
      schedule: { status: 'ok', days: [{ date: '2026-11-29', offset: 1, mode: 'learn', points: ['p1'], minutes: 30 }] },
    },
  });
  assert.doesNotMatch(extrasHtml, /board-today__rail/);
  assert.match(extrasHtml, /board-today__extras/);
  assert.match(extrasHtml, /board-memos/);
  assert.match(extrasHtml, /Remember formula/);
  assert.match(extrasHtml, /board-upcoming/);

  // English render in minimal mode contains zero CJK characters.
  const enHtml = renderToday(m, { board, today, minimal: true, language: 'en' });
  assert.doesNotMatch(strip(enHtml), HAN);

  // Verify board.css single-column & timer-bar rules for data-minimal="on" (and zero rules for data-minimal="off") via parsed CSS AST.
  const { declarations, blocks } = parseCss(await readFile('ui/board/board.css', 'utf8'));
  const allPreludes = [...blocks.map((b) => b.prelude), ...declarations.flatMap((d) => d.ctx)];
  assert.equal(allPreludes.some((sel) => /data-minimal\s*=\s*["']off["']/.test(sel)), false, 'zero CSS rules for data-minimal="off"');
  assert.equal(
    declarations.some((d) => d.prop === 'grid-template-columns' && d.value === 'minmax(0, 1fr)'
      && d.ctx.some((sel) => sel.includes('.board-today[data-minimal="on"] .board-today__workspace'))),
    true,
    'minimal TodayView uses a single-column workspace grid',
  );
  assert.equal(
    declarations.some((d) => d.prop === 'display' && d.value === 'flex'
      && d.ctx.some((sel) => sel.includes('.board-today[data-minimal="on"] .board-timer-bar'))),
    true,
    'minimal TodayView keeps an active timer bar visible across viewports',
  );

  // Verify real useAppearance() hook wiring when minimal prop is omitted.
  const minimalMod = await loadWithMinimalAppearance();
  const wiredHtml = renderToday(minimalMod, { board, today });
  assert.match(wiredHtml, /data-minimal="on"/);
  assert.doesNotMatch(wiredHtml, /board-today__lanes/);
  assert.doesNotMatch(wiredHtml, /board-today__rail/);

  // Verify card props in minimal mode: no 移到上午/移到下午 menu items, keeps 移出今天, onStartTimer=null, and ignores left/right lane arrows.
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const states = [];
  const refs = [];
  const memos = [];
  let cState = 0;
  let cRef = 0;
  let cMemo = 0;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const prevH = internals.H;
  const todayActions = [];
  let tree;
  internals.H = {
    useContext: (ctx) => ctx._currentValue,
    useSyncExternalStore: (_sub, get) => get(),
    useState: (init) => { const i = cState++; if (!(i in states)) states[i] = [typeof init === 'function' ? init() : init, noop]; return states[i]; },
    useRef: (init) => { const i = cRef++; if (!(i in refs)) refs[i] = { current: init }; return refs[i]; },
    useMemo: (fn, deps) => { const i = cMemo++; if (!(i in memos) || !sameDeps(memos[i].deps, deps)) memos[i] = { deps, value: fn() }; return memos[i].value; },
    useCallback: (fn, deps) => internals.H.useMemo(() => fn, deps),
    useEffect: noop,
    useLayoutEffect: noop,
  };
  try {
    tree = m.TodayView({
      board,
      today,
      library: { root: '/lib', courses: [] },
      minimal: true,
      onToggleDone: noop,
      onEdit: noop,
      onAction: noop,
      onTodayAction: (action, card, lane) => todayActions.push([action, card.id, lane]),
      onMoveToday: noop,
      onQuickAdd: async () => true,
      onScheduleToday: async () => true,
      onStartTimer: noop,
    });
  } finally {
    internals.H = prevH;
  }
  const boardCards = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (node.props?.todayMeta && node.props?.card) boardCards.push(node.props);
    if (node.props?.children) visit(node.props.children);
  };
  visit(tree);
  assert.equal(boardCards.length, 3); // 2 open (a1, p1) + 1 done (d1)
  const openCardProps = boardCards.filter((p) => p.card.id === 'a1' || p.card.id === 'p1');
  for (const props of openCardProps) {
    assert.equal(props.onStartTimer, null, 'minimal mode clears onStartTimer');
    assert.deepEqual(props.extraItems.map((i) => i.id), ['unplan-today'], 'omits slot:am / slot:pm while keeping unplan-today');
    props.onAction('left', props.card);
    props.onAction('right', props.card);
    props.onAction('unplan-today', props.card);
  }
  assert.deepEqual(todayActions, [['unplan-today', 'a1', 'am'], ['unplan-today', 'p1', 'pm']]);

  // Verify TodayTimerBar props: minimal passes onCancel and omits onOpenFullscreen; standard passes onOpenFullscreen and omits onCancel.
  const inspectTimerBarProps = (minimalFlag) => {
    const tStates = [];
    const tRefs = [];
    const tMemos = [];
    let tcState = 0;
    let tcRef = 0;
    let tcMemo = 0;
    const prev = internals.H;
    const cancelSpy = () => {};
    let tTree;
    internals.H = {
      useContext: (ctx) => ctx._currentValue,
      useSyncExternalStore: (_sub, get) => get(),
      useState: (init) => { const i = tcState++; if (!(i in tStates)) tStates[i] = [typeof init === 'function' ? init() : init, noop]; return tStates[i]; },
      useRef: (init) => { const i = tcRef++; if (!(i in tRefs)) tRefs[i] = { current: init }; return tRefs[i]; },
      useMemo: (fn, deps) => { const i = tcMemo++; if (!(i in tMemos) || !sameDeps(tMemos[i].deps, deps)) tMemos[i] = { deps, value: fn() }; return tMemos[i].value; },
      useCallback: (fn, deps) => internals.H.useMemo(() => fn, deps),
      useEffect: noop,
      useLayoutEffect: noop,
    };
    try {
      tTree = m.TodayView({
        board: timedData.board,
        today: timedData.today,
        library: { root: '/lib', courses: [] },
        minimal: minimalFlag,
        onToggleDone: noop,
        onEdit: noop,
        onAction: noop,
        onQuickAdd: async () => true,
        onScheduleToday: async () => true,
        onCancelTimer: cancelSpy,
      });
    } finally {
      internals.H = prev;
    }
    let barProps = null;
    const findBar = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const child of node) findBar(child); return; }
      if (node.props && 'onOpenFullscreen' in node.props && 'onComplete' in node.props) barProps = node.props;
      if (node.props?.children) findBar(node.props.children);
    };
    findBar(tTree);
    return { barProps, cancelSpy };
  };

  const minBar = inspectTimerBarProps(true);
  assert.equal(minBar.barProps.onOpenFullscreen, undefined);
  assert.equal(minBar.barProps.onCancel, minBar.cancelSpy);

  const stdBar = inspectTimerBarProps(false);
  assert.equal(typeof stdBar.barProps.onOpenFullscreen, 'function');
  assert.equal(stdBar.barProps.onCancel, undefined);
});
