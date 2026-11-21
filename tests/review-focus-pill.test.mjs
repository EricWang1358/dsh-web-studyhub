/* global process */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { boardAction } from '../lib/board.js';
import { resolveTimerPrefs, selectTodayTimeLog, timerSnapshot } from '../lib/board-model.js';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export { default as ReviewFocusPill } from './ui/review/ReviewFocusPill.jsx';
      export { default as Review } from './ui/Review.jsx';
      export { default as Board } from './ui/Board.jsx';
      export { useBoardTimer } from './ui/board/use-board-timer.js';
      export { AppContext } from './ui/app/app-context.js';
      export { StudyServicesContext } from './ui/study-context.jsx';
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
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);

const {
  ReviewFocusPill,
  Review,
  Board,
  useBoardTimer,
  AppContext,
  StudyServicesContext,
  setUiLanguage,
} = mod.exports;

const TODAY = '2026-11-22';
const BASE_NOW = Date.parse('2026-11-22T09:00:00.000Z');

function render(element, lang = 'zh') {
  setUiLanguage(lang);
  try {
    return renderToStaticMarkup(element);
  } finally {
    setUiLanguage('zh');
  }
}

async function withTempBoard(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'study-review-pomo-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Minimal synchronous hook harness for testing `useBoardTimer` actions directly against real `boardAction`. */
function createTimerHarness(initialBoard, { today = TODAY } = {}) {
  let current = initialBoard;
  const calls = [];
  const spoken = [];
  let boardChangedCount = 0;

  const mutate = async (action, args, options) => {
    calls.push({ action, args, options });
    current = await boardAction(action, { revision: current.revision, ...args });
    return true;
  };

  let controls = null;
  function Probe() {
    controls = useBoardTimer({
      mutate,
      today,
      say: (msg) => spoken.push(msg),
      onBoardChanged: () => { boardChangedCount += 1; },
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));

  return {
    controls,
    get board() { return current; },
    calls,
    spoken,
    get boardChangedCount() { return boardChangedCount; },
  };
}

test('useBoardTimer stays 100% synced with board.timer.* and board.timeLog (free focus, pause, resume, complete, break, prefs)', async () => {
  await withTempBoard(async () => {
    const initial = await boardAction('board.get', {});
    const harness = createTimerHarness(initial);

    // 1. Start free focus from quiz page using deck/course title (no todo card required)
    const started = await harness.controls.startFreeFocus('操作系统 · 内存管理');
    assert.equal(started, true);
    assert.equal(harness.board.timer.mode, 'work');
    assert.equal(harness.board.timer.cardId, undefined);
    assert.equal(harness.board.timer.cardTitle, '操作系统 · 内存管理');
    assert.equal(harness.board.timer.durationMinutes, 25);
    assert.equal(harness.spoken.at(-1), '已开始专注：操作系统 · 内存管理');

    // 2. Pause and resume
    assert.equal(await harness.controls.pauseTimer(), true);
    assert.ok(harness.board.timer.pausedAt);
    assert.equal(await harness.controls.resumeTimer(), true);
    assert.equal(harness.board.timer.pausedAt, undefined);

    // 3. Complete & log into board.timeLog -> Board's Today view sees the exact same entry
    const snap = { ...timerSnapshot(harness.board.timer), loggedMinutes: 25 };
    assert.equal(await harness.controls.completeTimer(snap), true);
    assert.equal(harness.board.timer, undefined);
    const todayLog = selectTodayTimeLog(harness.board, TODAY);
    assert.equal(todayLog.totalMinutes, 25);
    assert.equal(todayLog.entries.length, 1);
    assert.equal(todayLog.entries[0].cardTitle, '操作系统 · 内存管理');

    // Verify Board renders this logged session in parity
    const boardHtml = render(React.createElement(Board, {
      state: { board: harness.board, error: '', conflict: false, busy: false, mutate: async () => true, refresh: async () => {} },
      library: { root: '/lib', decks: [], sources: [], courses: [] },
      today: TODAY,
      defaultView: 'today',
      nowMs: BASE_NOW,
    }));
    assert.match(boardHtml, /今日已专注 25 分钟/);
    assert.match(boardHtml, /操作系统 · 内存管理/);

    // 4. Start 5-min break and cancel it
    assert.equal(await harness.controls.startBreak(5), true);
    assert.equal(harness.board.timer.mode, 'break');
    assert.equal(harness.board.timer.durationMinutes, 5);
    assert.equal(await harness.controls.cancelTimer(), true);
    assert.equal(harness.board.timer, undefined);

    // 5. Save custom timer preferences (45+10)
    assert.equal(await harness.controls.saveTimerPrefs({ workMinutes: 45, breakMinutes: 10, sound: true, notify: false }), true);
    assert.deepEqual(resolveTimerPrefs(harness.board), { workMinutes: 45, breakMinutes: 10, sound: true, notify: false });
  });
});

test('ReviewFocusPill renders idle button in ZH & EN and opens popover with daily goal + live remaining pomodoros', () => {
  const board = {
    version: 1,
    revision: 3,
    columns: [{ id: 'todo', title: '待办', done: false, cardIds: [] }],
    cards: {},
    archived: [],
    timeLog: [{ id: 'log-1', cardTitle: '微积分', minutes: 25, date: TODAY, startedAt: '2026-11-22T08:00:00.000Z' }],
  };
  const boardState = { board, mutate: async () => true, refresh: async () => {} };
  const attempts = Array.from({ length: 38 }, () => ({
    timestamp: `${TODAY}T08:30:00.000Z`,
    elapsed_ms: 53_571,
  }));

  // Idle closed in ZH & EN
  const idleZh = render(React.createElement(ReviewFocusPill, {
    boardState,
    attempts,
    focusTitle: '微积分第 3 章',
    today: TODAY,
    nowMs: BASE_NOW,
    goal: 108,
  }), 'zh');
  assert.match(idleZh, /番茄 25\+5/);
  assert.match(idleZh, /data-timer-state="idle"/);

  const idleEn = render(React.createElement(ReviewFocusPill, {
    boardState,
    attempts,
    focusTitle: 'Calculus Ch.3',
    today: TODAY,
    nowMs: BASE_NOW,
    goal: 108,
  }), 'en');
  assert.match(idleEn, /Focus 25\+5/);

  // Idle open popover shows presets, daily goal chips, live pace line, and synced focus minutes
  const openZh = render(React.createElement(ReviewFocusPill, {
    boardState,
    attempts,
    focusTitle: '微积分第 3 章',
    today: TODAY,
    nowMs: BASE_NOW,
    goal: 108,
    defaultOpen: true,
  }), 'zh');
  assert.match(openZh, /开始计时/);
  assert.match(openZh, /休息 5 分钟/);
  assert.match(openZh, /25\+5/);
  assert.match(openZh, /45\+10/);
  assert.match(openZh, /30 题/);
  assert.match(openZh, /60 题/);
  assert.match(openZh, /100 题/);
  assert.match(openZh, /今日 38 \/ 108 题 · 当前约 28 题\/番茄 · 还需约 2\.5 个番茄（含休息约 1 小时 15 分）/);
  assert.match(openZh, /今日已专注 25 分钟/);

  const openEn = render(React.createElement(ReviewFocusPill, {
    boardState,
    attempts,
    focusTitle: 'Calculus Ch.3',
    today: TODAY,
    nowMs: BASE_NOW,
    goal: 108,
    defaultOpen: true,
  }), 'en');
  assert.match(openEn, /Start timer/);
  assert.match(openEn, /Take a 5-min break/);
  assert.match(openEn, /Today 38 \/ 108 questions · ~28 questions\/pomodoro · ~2\.5 pomodoros left \(~1 h 15 min incl\. breaks\)/);
  assert.match(openEn, /Focused 25 min today/);
  assert.match(openEn, /Synced with To-do/);
  assert.doesNotMatch(openEn, /[\u4e00-\u9fff]/, 'EN popover must contain no stray Chinese characters');
});

test('ReviewFocusPill renders calm running, paused, break, and finished states with proper controls', () => {
  const baseBoard = {
    version: 1,
    revision: 5,
    columns: [{ id: 'todo', title: '待办', done: false, cardIds: [] }],
    cards: {},
    archived: [],
    timeLog: [],
  };

  // Running work timer (3m26s elapsed -> 21:34 remaining)
  const runningBoard = {
    ...baseBoard,
    timer: {
      id: 't1',
      mode: 'work',
      cardTitle: '计算机网络',
      startedAt: '2026-11-22T09:00:00.000Z',
      durationMinutes: 25,
      pausedMs: 0,
    },
  };
  const runningHtml = render(React.createElement(ReviewFocusPill, {
    boardState: { board: runningBoard, mutate: async () => true },
    today: TODAY,
    nowMs: Date.parse('2026-11-22T09:03:26.000Z'),
    defaultOpen: true,
  }), 'zh');
  assert.match(runningHtml, /21:34/);
  assert.match(runningHtml, /data-timer-state="running"/);
  assert.match(runningHtml, /暂停/);
  assert.match(runningHtml, /完成，记 3 分钟/);
  assert.match(runningHtml, /放弃这一个/);

  // Paused timer
  const pausedBoard = {
    ...baseBoard,
    timer: {
      ...runningBoard.timer,
      pausedAt: '2026-11-22T09:03:26.000Z',
    },
  };
  const pausedHtml = render(React.createElement(ReviewFocusPill, {
    boardState: { board: pausedBoard, mutate: async () => true },
    today: TODAY,
    nowMs: Date.parse('2026-11-22T09:10:00.000Z'),
    defaultOpen: true,
  }), 'zh');
  assert.match(pausedHtml, /21:34/);
  assert.match(pausedHtml, /data-timer-state="paused"/);
  assert.match(pausedHtml, /已暂停/);
  assert.match(pausedHtml, /继续/);

  // Finished work timer offers both log and 5-min break
  const finishedHtml = render(React.createElement(ReviewFocusPill, {
    boardState: { board: runningBoard, mutate: async () => true },
    today: TODAY,
    nowMs: Date.parse('2026-11-22T09:26:00.000Z'),
    defaultOpen: true,
  }), 'zh');
  assert.match(finishedHtml, /0:00/);
  assert.match(finishedHtml, /data-timer-state="finished"/);
  assert.match(finishedHtml, /完成，记 25 分钟/);
  assert.match(finishedHtml, /休息 5 分钟/);

  // Active break timer
  const breakBoard = {
    ...baseBoard,
    timer: {
      id: 't2',
      mode: 'break',
      cardTitle: '休息片刻',
      startedAt: '2026-11-22T09:26:00.000Z',
      durationMinutes: 5,
      pausedMs: 0,
    },
  };
  const breakHtml = render(React.createElement(ReviewFocusPill, {
    boardState: { board: breakBoard, mutate: async () => true },
    today: TODAY,
    nowMs: Date.parse('2026-11-22T09:28:00.000Z'),
    defaultOpen: true,
  }), 'zh');
  assert.match(breakHtml, /3:00/);
  assert.match(breakHtml, /data-timer-mode="break"/);
  assert.match(breakHtml, /休息中/);
  assert.match(breakHtml, /结束休息/);
});

test('Review mounts ReviewFocusPill in PageHeader actions and renders calm today-pace line on round complete', () => {
  const board = {
    version: 1,
    revision: 1,
    columns: [{ id: 'todo', title: '待办', done: false, cardIds: [] }],
    cards: {},
    archived: [],
    timeLog: [],
  };
  const appValue = {
    board: { state: { board, mutate: async () => true, refresh: async () => {} } },
    dailyPlan: { refresh: () => {} },
    lib: {},
    host: {},
  };
  const studyValue = {
    call: async () => null,
    act: async () => null,
    host: {},
    navigate: () => {},
    openSettings: () => {},
    notify: () => {},
    openModal: () => {},
  };
  const todayIso = new Date().toISOString();
  const data = {
    root: '/lib-test',
    sources: [],
    decks: [],
    attempts: Array.from({ length: 6 }, () => ({ timestamp: todayIso, elapsed_ms: 50_000 })),
  };
  const session = {
    run: {
      id: 'run-1',
      mode: 'path',
      complete: true,
      index: 6,
      total: 6,
      questions: 6,
      answered: 6,
      correct: 5,
      scope: [],
      card: { id: 'q1', kind: 'quiz', topic: 'T', prompt: 'Q?', options: [] },
    },
    choice: true,
    actions: { reviewAct: () => {} },
    enterRun: () => {},
  };

  const html = render(
    React.createElement(
      AppContext.Provider,
      { value: appValue },
      React.createElement(
        StudyServicesContext.Provider,
        { value: studyValue },
        React.createElement(Review, {
          session,
          data,
          shellTitle: '离散数学',
          links: {},
          context: {},
        }),
      ),
    ),
    'zh',
  );

  assert.match(html, /data-testid="review-focus-pill"/);
  assert.match(html, /番茄 25\+5/);
  assert.match(html, /class="review-today-pace"/);
  assert.match(html, /今日已刷 6 题 · 当前约 30 题\/番茄/);
});

function collectElements(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectElements(item, out);
    return out;
  }
  out.push(node);
  if (node.props?.children) collectElements(node.props.children, out);
  if (typeof node.props?.trigger === 'function') {
    collectElements(node.props.trigger({ props: {}, ref: { current: null }, open: true }), out);
  }
  return out;
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && node.props?.children !== undefined) return textOf(node.props.children);
  return '';
}

test('ReviewFocusPill interactive handlers wire idle start, duration presets, daily goal chips, and active timer controls', async () => {
  const hookCompiled = await build({
    stdin: { contents: "export { default as ReviewFocusPill } from './ui/review/ReviewFocusPill.jsx';", resolveDir: process.cwd() },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['react', 'react-dom'],
    loader: { '.css': 'text' },
    logLevel: 'silent',
  });
  const hooks = {
    ...React,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: (val) => ({ current: val }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useContext: () => ({ show: () => {}, dismiss: () => {} }),
    useSyncExternalStore: (_sub, snap) => snap(),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useInsertionEffect: () => {},
    useId: () => 'rfp-test',
  };
  hooks.default = hooks;
  const localMod = { exports: {} };
  new Function('require', 'module', 'exports', hookCompiled.outputFiles[0].text)(
    (id) => (id === 'react' ? hooks : require(id)),
    localMod,
    localMod.exports,
  );
  const Pill = localMod.exports.ReviewFocusPill;

  const calls = [];
  const goals = [];
  const baseBoard = {
    version: 1,
    revision: 2,
    columns: [{ id: 'todo', title: '待办', done: false, cardIds: [] }],
    cards: {},
    archived: [],
    timeLog: [],
  };
  const mutate = async (action, args, options) => {
    calls.push({ action, args, options });
    return true;
  };

  // 1. Idle state: click 番茄 25+5 -> board.timer.start free focus with deck title; click 45+10 -> board.timer.prefs; click 60 题 / 清除目标
  const idleTree = Pill({
    boardState: { board: baseBoard, mutate },
    focusTitle: '微积分第 3 章',
    today: TODAY,
    nowMs: BASE_NOW,
    goal: 100,
    onGoalChange: (next) => goals.push(next),
    defaultOpen: true,
  });
  const idleNodes = collectElements(idleTree);
  const startIdleBtn = idleNodes.find((el) => typeof el.props?.onClick === 'function' && el.props?.['data-timer-state'] === 'idle');
  assert.ok(startIdleBtn, 'idle start button exists');
  await startIdleBtn.props.onClick();
  assert.deepEqual(calls.at(-1), {
    action: 'board.timer.start',
    args: { mode: 'work', cardTitle: '微积分第 3 章' },
    options: { optimistic: false },
  });

  const preset45Btn = idleNodes.find((el) => typeof el.props?.onClick === 'function' && textOf(el) === '45+10');
  assert.ok(preset45Btn, '45+10 preset chip exists');
  await preset45Btn.props.onClick();
  assert.deepEqual(calls.at(-1), {
    action: 'board.timer.prefs',
    args: { workMinutes: 45, breakMinutes: 10, sound: false, notify: false },
    options: undefined,
  });

  const goal60Btn = idleNodes.find((el) => typeof el.props?.onClick === 'function' && textOf(el) === '60 题');
  assert.ok(goal60Btn, '60 题 goal chip exists');
  goal60Btn.props.onClick();
  assert.equal(goals.at(-1), 60);

  const clearGoalBtn = idleNodes.find((el) => typeof el.props?.onClick === 'function' && textOf(el) === '清除目标');
  assert.ok(clearGoalBtn, 'clear goal button exists');
  clearGoalBtn.props.onClick();
  assert.equal(goals.at(-1), null);

  // 2. Finished work timer: click 休息 5 分钟 -> completes & logs work time first, then starts 5-min break
  const finishedBoard = {
    ...baseBoard,
    timer: {
      id: 't-done',
      mode: 'work',
      cardTitle: '微积分第 3 章',
      startedAt: '2026-11-22T09:00:00.000Z',
      durationMinutes: 25,
      pausedMs: 0,
    },
  };
  const finishedTree = Pill({
    boardState: { board: finishedBoard, mutate },
    focusTitle: '微积分第 3 章',
    today: TODAY,
    nowMs: Date.parse('2026-11-22T09:26:00.000Z'),
    defaultOpen: true,
  });
  const finishedNodes = collectElements(finishedTree);
  const breakBtn = finishedNodes.find((el) => typeof el.props?.onClick === 'function' && textOf(el) === '休息 5 分钟');
  assert.ok(breakBtn, 'break button exists when work timer finished');
  const beforeLen = calls.length;
  await breakBtn.props.onClick();
  assert.deepEqual(calls.slice(beforeLen), [
    { action: 'board.timer.complete', args: { minutes: 25, date: TODAY }, options: { optimistic: false } },
    { action: 'board.timer.start', args: { mode: 'break', cardTitle: '休息片刻', durationMinutes: 5 }, options: { optimistic: false } },
  ]);
});
