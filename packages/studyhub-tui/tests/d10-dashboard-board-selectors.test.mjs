// #1354 D10 Single-Source Dashboard & Board Selectors Guardrail & Golden Parity Suite:
// Verifies streak, daily counts, 7-day forecast queue depth, token usage, daily habits,
// board column buckets, due status, active queue depth, and pomodoro focus stats all derive
// from `src/selectors/dashboard-metrics.ts` and `src/selectors/board-metrics.ts` with 1:1
// parity against golden Markdown/render snapshots, legacy formulas, backend `lib/insights.js`,
// and CLI `--board`.
//
// node --test packages/studyhub-tui/tests/d10-dashboard-board-selectors.test.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  { DashboardView, formatDashboardMarkdownReport },
  { BoardView, formatBoardMarkdown },
  boardStore,
  { buildBoardCliReport },
  { studyStats: computeBackendStats },
  storeMod,
] = await Promise.all([
  import('../src/views/dashboard/DashboardView.tsx'),
  import('../src/views/board/BoardView.tsx'),
  import('../src/views/board/board-store.ts'),
  import('../src/cli-commands.ts'),
  import('../../../lib/insights.js'),
  import('../src/state/store.ts'),
]);

const { cardsInColumn, dueStatus, saveBoard, todayFocusStats, todayLocalYmd } = boardStore;
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

function mountInk(element, { cols = 120, rows = 34 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 1;

  let latest = '';
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim()) latest = plain;
  });

  const inst = render(element, { stdout, stdin, interactive: true, exitOnCtrlC: false, patchConsole: false });
  return {
    frame: () => latest,
    async waitFor(pred, timeoutMs = 4000, label = 'frame') {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (pred(latest)) return latest;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`Timed out waiting for ${label}; last frame:\n${latest}`);
    },
    cleanup() {
      inst.unmount();
    },
  };
}

const GOLDEN_DASHBOARD_INPUT = {
  stats: {
    today: '2026-11-26',
    totals: {
      attempts: 48,
      activeDays: 12,
      streak: 5,
      correctRate: 82,
      recentRate: 86,
      cards: 60,
      due: 7,
      mastered: 28,
      weak: 4,
    },
    heatmap: [
      { date: '2026-11-22', count: 4 },
      { date: '2026-11-23', count: 6 },
      { date: '2026-11-24', count: 2 },
      { date: '2026-11-25', count: 5 },
      { date: '2026-11-26', count: 3 },
    ],
    forecast: {
      days: [
        { date: '2026-11-26', count: 5, overdue: 2 },
        { date: '2026-11-27', count: 3, overdue: 0 },
        { date: '2026-11-28', count: 4, overdue: 0 },
        { date: '2026-11-29', count: 1, overdue: 0 },
        { date: '2026-11-30', count: 0, overdue: 0 },
        { date: '2026-12-01', count: 2, overdue: 0 },
        { date: '2026-12-02', count: 1, overdue: 0 },
        { date: '2026-12-03', count: 99, overdue: 0 }, // 8th day must be excluded from 7d window
      ],
    },
    weakTopics: [{ deckId: 'd1', deckTitle: 'OS', course: 'OS', topic: 'Deadlock', wrong: 3 }],
  },
  dailyPlan: {
    date: '2026-11-26',
    budgetMinutes: 60,
    spentMinutes: 35,
    profile: { observedWeekdayMinutes: 45, observedWeekendMinutes: 90 },
  },
  usage: {
    total: {
      calls: 4,
      uncachedInputTokens: 800,
      outputTokens: 400,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
    },
    byFeature: {
      explain: { calls: 4, uncachedInputTokens: 800, outputTokens: 400, cacheReadTokens: 200, cacheWriteTokens: 100 },
    },
  },
  usageDays: 30,
  courseRows: [{ rawCourse: 'OS', label: 'OS', masteryPct: 64, totalCards: 60, dueCount: 7, weakCount: 4 }],
  focusCourse: 'OS',
  generatedAt: '2026-11-26',
};

const GOLDEN_BOARD_DOC = {
  version: 1,
  cards: [
    {
      id: 'b-overdue',
      title: 'Fix Page Table Bug',
      column: 'todo',
      course: 'OS',
      dueDate: '2026-11-20',
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    },
    {
      id: 'b-today',
      title: 'Review Deadlock Proof',
      column: 'todo',
      course: 'OS',
      dueDate: '2026-11-26',
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T00:00:00.000Z',
    },
    {
      id: 'b-doing',
      title: 'Implement Lock-Free Queue',
      column: 'doing',
      course: 'Systems',
      dueDate: '2026-11-30',
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
    },
    {
      id: 'b-done',
      title: 'Setup Kernel Build',
      column: 'done',
      course: 'OS',
      dueDate: '2026-11-15',
      createdAt: '2026-11-10T00:00:00.000Z',
      updatedAt: '2026-11-15T00:00:00.000Z',
    },
  ],
  focusStats: { date: '2026-11-26', completedPomodoros: 3, focusedMinutes: 75 },
  updatedAt: '2026-11-26T00:00:00.000Z',
};

describe('#1354 D10 Dashboard & Board Single-Source Selectors', () => {
  test('1. Golden Markdown snapshot parity: Dashboard & Board reports stay bit-exact across zh & en', () => {
    const dashZh = formatDashboardMarkdownReport({ ...GOLDEN_DASHBOARD_INPUT, lang: 'zh' });
    const dashEn = formatDashboardMarkdownReport({ ...GOLDEN_DASHBOARD_INPUT, lang: 'en' });

    assert.ok(dashZh.includes('- 今日学习时长: 35 / 60 分钟'));
    assert.ok(dashZh.includes('| 总题数 (Total Cards) | 60 |'));
    assert.ok(dashZh.includes('| 已掌握 (Mastered) | 28 |'));
    assert.ok(dashZh.includes('| 今日到期 (Due Today) | 7 |'));
    assert.ok(dashZh.includes('| 薄弱题 (Weak) | 4 |'));
    assert.ok(dashZh.includes('| 累计作答 (Attempts) | 48 |'));
    assert.ok(dashZh.includes('| 正确率 (Accuracy) | 86% |'));
    assert.ok(dashZh.includes('| 活跃天数 (Active Days) | 12 |'));
    assert.ok(dashZh.includes('| 连续学习 (Streak) | 5 天 |'));
    assert.ok(dashZh.includes('| 2026-11-26 (今日) | 5 | 2 |'));
    assert.ok(!dashZh.includes('2026-12-03'), '8th forecast day must not appear in 7-day forecast table');
    assert.ok(dashZh.includes('- 总 Token: 1500 (1.5K)'));

    assert.ok(dashEn.includes('- Daily Plan: 35 / 60 min'));
    assert.ok(dashEn.includes('| Streak | 5d |'));
    assert.ok(dashEn.includes('| Accuracy | 86% |'));
    assert.ok(dashEn.includes('- Total Tokens: 1500 (1.5K)'));

    const boardZh = formatBoardMarkdown(GOLDEN_BOARD_DOC, 'zh');
    const boardEn = formatBoardMarkdown(GOLDEN_BOARD_DOC, 'en');
    assert.ok(boardZh.includes('任务总计: 4 (待办: 2, 进行中: 1, 已完成: 1) | 番茄专注: 3 次 (75 分钟)'));
    assert.ok(boardEn.includes('Cards: 4 (Todo: 2, Doing: 1, Done: 1) | Pomodoro: 3 (75m)'));
  });

  test('2. dashboard-metrics selectors match legacy formulas AND backend lib/insights.js streak semantics 1:1', async () => {
    const dm = await import('../src/selectors/dashboard-metrics.ts');

    // (a) Streak from heatmap matches backend lib/insights.js stats() exactly
    const fixedNow = new Date(2026, 10, 26, 12, 0, 0); // local 2026-11-26
    const localIso = (day) => new Date(2026, 10, day, 10, 0, 0).toISOString();
    const backendState = {
      decks: [],
      runs: [],
      sources: [],
      courses: [],
      attempts: [
        { id: 'a1', deckId: 'd1', quiz_id: 'c1', grade: 4, correct: true, timestamp: localIso(23) },
        { id: 'a2', deckId: 'd1', quiz_id: 'c2', grade: 4, correct: true, timestamp: localIso(24) },
        { id: 'a3', deckId: 'd1', quiz_id: 'c3', grade: 4, correct: true, timestamp: localIso(25) },
      ],
    };
    const backendStats = computeBackendStats(backendState, {}, fixedNow);
    // Today (26) has 0 attempts yet, consecutive days 25, 24, 23 => backend streak = 3
    assert.equal(backendStats.totals.streak, 3);
    assert.equal(
      dm.selectStreakFromHeatmap(backendStats.heatmap, '2026-11-26'),
      backendStats.totals.streak,
      'selectStreakFromHeatmap must match lib/insights.js streak when today has not started yet',
    );
    assert.equal(
      dm.selectStreakFromHeatmap(GOLDEN_DASHBOARD_INPUT.stats.heatmap, '2026-11-26'),
      5,
      '5 consecutive days ending today => streak 5',
    );
    assert.equal(
      dm.selectStreakFromHeatmap(
        [
          { date: '2026-11-23', count: 2 },
          { date: '2026-11-24', count: 2 },
          { date: '2026-11-26', count: 1 },
        ],
        '2026-11-26',
      ),
      1,
      'gap on yesterday breaks prior streak, leaving today=1',
    );

    // (b) KPIs: explicit totals + heatmap fallback when totals.streak/activeDays omitted
    const kpisFull = dm.selectDashboardKpis(GOLDEN_DASHBOARD_INPUT.stats, GOLDEN_DASHBOARD_INPUT.courseRows);
    assert.deepEqual(kpisFull, {
      totalCards: 60,
      mastered: 28,
      due: 7,
      weak: 4,
      attempts: 48,
      accuracyPct: 86,
      accuracyLabel: '86%',
      activeDays: 12,
      streak: 5,
    });

    const kpisFallback = dm.selectDashboardKpis(
      { today: '2026-11-26', heatmap: GOLDEN_DASHBOARD_INPUT.stats.heatmap },
      GOLDEN_DASHBOARD_INPUT.courseRows,
    );
    assert.equal(kpisFallback.totalCards, 60);
    assert.equal(kpisFallback.due, 7);
    assert.equal(kpisFallback.weak, 4);
    assert.equal(kpisFallback.accuracyPct, null);
    assert.equal(kpisFallback.accuracyLabel, '--');
    assert.equal(kpisFallback.activeDays, 5, 'activeDays falls back to non-zero heatmap day count');
    assert.equal(kpisFallback.streak, 5, 'streak falls back to heatmap consecutive days');

    // (c) 7-day forecast queue depth
    const forecast = dm.selectForecastQueueDepth(GOLDEN_DASHBOARD_INPUT.stats.forecast.days);
    assert.equal(forecast.days.length, 7, 'forecast capped at 7 days');
    assert.equal(forecast.total7d, 16, 'sum of first 7 days (5+3+4+1+0+2+1=16), excluding 8th day 99');
    assert.equal(forecast.todayDue, 5);
    assert.equal(forecast.overdue, 2);
    assert.equal(forecast.hasOverdue, true);

    // (d) Usage totals & daily habit metrics
    const usage = dm.selectUsageTotals(GOLDEN_DASHBOARD_INPUT.usage);
    assert.deepEqual(usage, {
      totalTokens: 1500,
      totalCalls: 4,
      uncachedInputTokens: 800,
      outputTokens: 400,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
    });

    const habits = dm.selectDailyHabitMetrics(GOLDEN_DASHBOARD_INPUT.dailyPlan);
    assert.deepEqual(habits, {
      hasDailyBudget: true,
      budgetMinutes: 60,
      spentMinutes: 35,
      hasObservedHabits: true,
      observedWeekdayMinutes: 45,
      observedWeekendMinutes: 90,
    });
  });

  test('3. board-metrics selectors match board-store & CLI buildBoardCliReport 1:1 (including local-date default)', async () => {
    const bm = await import('../src/selectors/board-metrics.ts');

    // (a) Due status parity across all 5 states
    assert.equal(bm.selectBoardDueStatus(undefined, 'todo', '2026-11-26'), 'none');
    assert.equal(bm.selectBoardDueStatus('2026-11-20', 'done', '2026-11-26'), 'done');
    assert.equal(bm.selectBoardDueStatus('2026-11-20', 'todo', '2026-11-26'), 'overdue');
    assert.equal(bm.selectBoardDueStatus(' 2026-11-26 ', 'todo', '2026-11-26'), 'today');
    assert.equal(bm.selectBoardDueStatus('2026-11-30', 'doing', '2026-11-26'), 'upcoming');
    assert.equal(bm.selectBoardDueStatus('next-week', 'todo', '2026-11-26'), 'upcoming');

    // board-store dueStatus delegates to the same local date logic
    const localToday = todayLocalYmd();
    assert.equal(dueStatus(localToday, 'todo'), 'today');
    assert.equal(bm.selectBoardDueStatus(localToday, 'todo'), 'today');

    // (b) Column buckets match legacy cardsInColumn 1:1
    const buckets = bm.selectBoardColumnBuckets(GOLDEN_BOARD_DOC.cards);
    assert.deepEqual(buckets.todo, cardsInColumn(GOLDEN_BOARD_DOC.cards, 'todo'));
    assert.deepEqual(buckets.doing, cardsInColumn(GOLDEN_BOARD_DOC.cards, 'doing'));
    assert.deepEqual(buckets.done, cardsInColumn(GOLDEN_BOARD_DOC.cards, 'done'));

    // (c) Queue metrics & priority sort match CLI buildBoardCliReport 1:1
    const qAll = bm.selectBoardQueueMetrics(GOLDEN_BOARD_DOC.cards, { todayYmd: '2026-11-26' });
    const cliAll = buildBoardCliReport({
      libraryRoot: '/tmp/lib',
      boardPath: '/tmp/lib/tui-board.json',
      existed: true,
      doc: GOLDEN_BOARD_DOC,
      todayYmd: '2026-11-26',
    });
    assert.equal(qAll.total, 4);
    assert.equal(qAll.todo, 2);
    assert.equal(qAll.doing, 1);
    assert.equal(qAll.done, 1);
    assert.equal(qAll.activeQueueDepth, 3, 'activeQueueDepth = todo (2) + doing (1)');
    assert.equal(qAll.overdue, 1);
    assert.equal(qAll.dueToday, 1);
    assert.deepEqual(cliAll.counts, {
      total: qAll.total,
      todo: qAll.todo,
      doing: qAll.doing,
      done: qAll.done,
      overdue: qAll.overdue,
      dueToday: qAll.dueToday,
    });
    assert.deepEqual(
      cliAll.cards.map((c) => [c.id, c.status]),
      qAll.classified.map((c) => [c.card.id, c.status]),
      'CLI --board card ordering and status classification must match selectBoardQueueMetrics 1:1',
    );

    // Course-filtered queue metrics
    const qOs = bm.selectBoardQueueMetrics(GOLDEN_BOARD_DOC.cards, { todayYmd: '2026-11-26', courseFilter: 'os' });
    const cliOs = buildBoardCliReport({
      libraryRoot: '/tmp/lib',
      boardPath: '/tmp/lib/tui-board.json',
      existed: true,
      doc: GOLDEN_BOARD_DOC,
      todayYmd: '2026-11-26',
      courseFilter: 'os',
    });
    assert.equal(qOs.total, 3);
    assert.equal(qOs.activeQueueDepth, 2);
    assert.equal(cliOs.counts.total, qOs.total);
    assert.equal(cliOs.counts.overdue, qOs.overdue);

    // (d) Focus stats: todayFocusStats resets stale dates, selectRawFocusTotals keeps archival counts
    assert.deepEqual(bm.selectTodayFocusStats(GOLDEN_BOARD_DOC.focusStats, '2026-11-26'), {
      date: '2026-11-26',
      completedPomodoros: 3,
      focusedMinutes: 75,
    });
    assert.deepEqual(bm.selectTodayFocusStats(GOLDEN_BOARD_DOC.focusStats, '2026-11-27'), {
      date: '2026-11-27',
      completedPomodoros: 0,
      focusedMinutes: 0,
    });
    assert.deepEqual(todayFocusStats({ date: localToday, completedPomodoros: 2, focusedMinutes: 50 }), {
      date: localToday,
      completedPomodoros: 2,
      focusedMinutes: 50,
    });
    assert.deepEqual(bm.selectRawFocusTotals({ date: '2026-01-01', completedPomodoros: 4, focusedMinutes: 100 }), {
      completedPomodoros: 4,
      focusedMinutes: 100,
    });
  });

  test('4. Live Ink render parity: DashboardView & BoardView render exact selector-derived streak, queue depth & daily counts', async (t) => {
    const prevState = useTuiStore.getState();
    useTuiStore.setState({
      page: 'dashboard',
      snapshot: {
        revision: 1,
        focus: { course: 'OS' },
        courses: [{ name: 'OS' }],
        decks: [{ id: 'd1', title: 'OS', course: 'OS', count: 60, cardCount: 60 }],
        progress: { d1: { total: 60, due: 7, mastery: 64, counts: { new: 10, weak: 4, learning: 8, familiar: 10, mastered: 28 } } },
        sources: [],
        notes: [],
        drafts: [],
        jobs: [],
      },
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
      toasts: [],
    });
    t.after(() => useTuiStore.setState(prevState));

    const dashHost = {
      mode: 'embedded',
      call: async (action) => {
        if (action === 'stats') return { ok: true, value: GOLDEN_DASHBOARD_INPUT.stats };
        if (action === 'usage.summary') return { ok: true, value: GOLDEN_DASHBOARD_INPUT.usage };
        if (action === 'daily.plan.get') return { ok: true, value: GOLDEN_DASHBOARD_INPUT.dailyPlan };
        return { ok: true, value: {} };
      },
      getConfig: () => ({ effective: { ready: false } }),
      close: async () => {},
    };

    const hDash = mountInk(
      React.createElement(DashboardView, { host: dashHost, width: 140, height: 34, isActive: false }),
      { cols: 140, rows: 34 },
    );
    t.after(() => hDash.cleanup());

    const dashFrame = await hDash.waitFor(
      (s) => s.includes('连续 5 天') && s.includes('7天 16题'),
      5000,
      'DashboardView derived metrics',
    );
    assert.ok(dashFrame.includes('86%'), `Dashboard accuracy must match selector (86%):\n${dashFrame}`);
    assert.ok(dashFrame.includes('1.5K'), `Dashboard totalTokens must match selector (1.5K):\n${dashFrame}`);
    assert.ok(dashFrame.includes('4 次 (30天)'), `Dashboard totalCalls must match selector:\n${dashFrame}`);
    assert.ok(dashFrame.includes('逾期2'), `Dashboard overdue queue depth must match selector (2):\n${dashFrame}`);
    assert.ok(dashFrame.includes('45m') && dashFrame.includes('90m'), `Dashboard observed habits must match selector:\n${dashFrame}`);
    hDash.cleanup();

    // Live DashboardView when backend omits totals.streak & totals.activeDays:
    // must fall back through selectDashboardKpis -> heatmap (streak=5, activeDays=5), matching report export 1:1.
    const fallbackDashHost = {
      mode: 'embedded',
      getLibraryRoot: () => '',
      call: async (action) => {
        if (action === 'stats') {
          const { streak: _s, activeDays: _a, ...restTotals } = GOLDEN_DASHBOARD_INPUT.stats.totals;
          return {
            ok: true,
            value: { ...GOLDEN_DASHBOARD_INPUT.stats, totals: restTotals },
          };
        }
        if (action === 'usage.summary') return { ok: true, value: GOLDEN_DASHBOARD_INPUT.usage };
        if (action === 'daily.plan.get') return { ok: true, value: GOLDEN_DASHBOARD_INPUT.dailyPlan };
        return { ok: true, value: {} };
      },
      getConfig: () => ({ effective: { ready: false } }),
      close: async () => {},
    };
    const hDashFallback = mountInk(
      React.createElement(DashboardView, { host: fallbackDashHost, width: 140, height: 34, isActive: false }),
      { cols: 140, rows: 34 },
    );
    t.after(() => hDashFallback.cleanup());
    const fallbackFrame = await hDashFallback.waitFor(
      (s) => s.includes('连续 5 天') && s.includes('活跃 5 天'),
      5000,
      'DashboardView heatmap-derived fallback streak & activeDays',
    );
    assert.ok(fallbackFrame.includes('连续 5 天'), `Live DashboardView must derive streak from heatmap via selector:\n${fallbackFrame}`);
    assert.ok(fallbackFrame.includes('活跃 5 天'), `Live DashboardView must derive activeDays from heatmap via selector:\n${fallbackFrame}`);
    hDashFallback.cleanup();

    // Live BoardView render backed by real temp tui-board.json
    const base = await mkdtemp(path.join(os.tmpdir(), 'studyhub-d10-board-'));
    t.after(() => rm(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));
    await mkdir(base, { recursive: true });
    const localToday = todayLocalYmd();
    await saveBoard(base, {
      ...GOLDEN_BOARD_DOC,
      focusStats: { date: localToday, completedPomodoros: 2, focusedMinutes: 50 },
    });

    useTuiStore.setState({
      page: 'board',
      binding: { root: base },
    });
    const boardHost = {
      mode: 'embedded',
      getLibraryRoot: () => base,
      call: async () => ({ ok: false, error: { message: 'offline' } }),
      getConfig: () => ({ effective: { ready: false } }),
      close: async () => {},
    };
    const hBoard = mountInk(
      React.createElement(BoardView, { host: boardHost, width: 110, height: 28, isActive: false }),
      { cols: 110, rows: 28 },
    );
    t.after(() => hBoard.cleanup());

    const boardFrame = await hBoard.waitFor(
      (s) => s.includes('Fix Page Table Bug') && s.includes('Implement Lock-Free Queue'),
      5000,
      'BoardView loaded cards',
    );
    assert.ok(boardFrame.includes('待办 Todo') && boardFrame.includes('2'), `BoardView Todo column must show count 2:\n${boardFrame}`);
    assert.ok(boardFrame.includes('进行中 Doing') && boardFrame.includes('1'), `BoardView Doing column must show count 1:\n${boardFrame}`);
    assert.ok(boardFrame.includes('已完成 Done') && boardFrame.includes('1'), `BoardView Done column must show count 1:\n${boardFrame}`);
    assert.ok(boardFrame.includes('2') && boardFrame.includes('50'), `BoardView PomodoroBar must show today's focus stats (2 / 50m):\n${boardFrame}`);
  });
});
