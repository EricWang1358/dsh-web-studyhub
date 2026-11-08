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
import {
  applyBoardAction,
  dayInTimeZone,
  recentLocalDays,
  resolveTimeLogDate,
  selectTodayTimeLog,
  summarizeFocusDuration,
} from '../lib/board-model.js';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export { setUiLanguage } from './ui/i18n.js';
      export { FocusDurationPanel } from './ui/charts/DashboardCharts.jsx';
      export { StatsView } from './ui/Dashboard.jsx';
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
const { setUiLanguage, FocusDurationPanel, StatsView } = uiModule.exports;

async function withTempBoard(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'study-board-s5-'));
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

test('S5 (#859, #210): local calendar day grouping vs UTC midnight & DST transitions', () => {
  // 2026-10-04T23:30:00Z is 2026-10-05 07:30 in Asia/Singapore (UTC+8),
  // 2026-10-04 23:30 in UTC, and 2026-10-04 16:30 in America/Los_Angeles (UTC-7).
  const utcLateNight = '2026-10-04T23:30:00.000Z';
  assert.equal(dayInTimeZone(utcLateNight, 'Asia/Singapore'), '2026-10-05');
  assert.equal(dayInTimeZone(utcLateNight, 'UTC'), '2026-10-04');
  assert.equal(dayInTimeZone(utcLateNight, 'America/Los_Angeles'), '2026-10-04');

  const board = {
    timeLog: [
      { id: 'sg-morning', cardTitle: '早读第 3 章', startedAt: utcLateNight, minutes: 25 },
      { id: 'prev-day', cardTitle: '整理错题', startedAt: '2026-10-03T14:00:00.000Z', minutes: 40 },
    ],
  };

  const sg = summarizeFocusDuration(board, {
    now: Date.parse('2026-10-05T02:00:00.000Z'),
    timeZone: 'Asia/Singapore',
  });
  assert.equal(sg.today, '2026-10-05');
  assert.equal(sg.todayMinutes, 25);
  assert.equal(sg.weekMinutes, 65);
  assert.equal(sg.days.at(-1).date, '2026-10-05');
  assert.equal(sg.days.at(-1).minutes, 25);
  assert.equal(sg.days.find((d) => d.date === '2026-10-04')?.minutes, 0);
  assert.equal(sg.days.find((d) => d.date === '2026-10-03')?.minutes, 40);

  const la = summarizeFocusDuration(board, {
    now: Date.parse('2026-10-05T02:00:00.000Z'),
    timeZone: 'America/Los_Angeles',
  });
  assert.equal(la.today, '2026-10-04');
  assert.equal(la.todayMinutes, 25);
  assert.equal(la.days.at(-1).date, '2026-10-04');
  assert.equal(la.days.at(-1).minutes, 25);

  // DST transitions: 23-hour spring-forward week & 25-hour fall-back week never skip or duplicate calendar dates
  assert.deepEqual(recentLocalDays('2026-04-02', 7), [
    '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02',
  ]);
  assert.deepEqual(recentLocalDays('2026-11-04', 7), [
    '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04',
  ]);

  // Explicit local date recorded at log time is preserved when no override timeZone is supplied
  assert.equal(resolveTimeLogDate({ date: '2026-10-05', startedAt: utcLateNight, minutes: 25 }), '2026-10-05');
});

test('S5 (#859): edit and delete focus records keep Study Stats summary and Today Board totals identical', async () => {
  await withTempBoard(async () => {
    const TODAY = '2026-11-08';
    let board = await boardAction('board.get', {});
    board = await boardAction('board.card.add', {
      revision: board.revision,
      title: '推导银行家安全性算法',
      plannedDate: TODAY,
      slot: 'am',
      slotDate: TODAY,
      now: '2026-11-08T09:00:00.000Z',
    }, '/tmp/study');
    const cardId = board.columns[0].cardIds[0];

    // Add a prior-day session and two today sessions
    board = await boardAction('board.timeLog.add', {
      revision: board.revision,
      cardId,
      minutes: 30,
      date: '2026-11-06',
      startedAt: '2026-11-06T10:00:00.000Z',
    });
    board = await boardAction('board.timeLog.add', {
      revision: board.revision,
      cardId,
      minutes: 25,
      date: TODAY,
      startedAt: '2026-11-08T09:05:00.000Z',
    });
    board = await boardAction('board.timeLog.add', {
      revision: board.revision,
      cardTitle: '复盘错题笔记',
      minutes: 15,
      date: TODAY,
      startedAt: '2026-11-08T10:15:00.000Z',
    });

    let statsFocus = summarizeFocusDuration(board, { today: TODAY });
    let todayFocus = selectTodayTimeLog(board, TODAY);
    assert.equal(statsFocus.todayMinutes, 40);
    assert.equal(todayFocus.totalMinutes, 40);
    assert.equal(statsFocus.weekMinutes, 70);
    assert.equal(board.cards[cardId].actualMinutes, 55);

    // Edit first today session from 25 -> 35 minutes (both optimistic model & persisted server action)
    const firstTodayId = todayFocus.entries[0].id;
    const optimisticEdited = applyBoardAction(board, 'board.timeLog.edit', { id: firstTodayId, minutes: 35 });
    assert.equal(summarizeFocusDuration(optimisticEdited, { today: TODAY }).todayMinutes, 50);
    assert.equal(selectTodayTimeLog(optimisticEdited, TODAY).totalMinutes, 50);

    board = await boardAction('board.timeLog.edit', {
      revision: board.revision,
      id: firstTodayId,
      minutes: 35,
    });
    statsFocus = summarizeFocusDuration(board, { today: TODAY });
    todayFocus = selectTodayTimeLog(board, TODAY);
    assert.equal(statsFocus.todayMinutes, 50);
    assert.equal(todayFocus.totalMinutes, 50);
    assert.equal(statsFocus.weekMinutes, 80);
    assert.equal(board.cards[cardId].actualMinutes, 65);

    // Delete second today session (15 minutes) -> both drop to 35 today, 65 week
    const secondTodayId = todayFocus.entries[1].id;
    board = await boardAction('board.timeLog.remove', {
      revision: board.revision,
      id: secondTodayId,
    });
    statsFocus = summarizeFocusDuration(board, { today: TODAY });
    todayFocus = selectTodayTimeLog(board, TODAY);
    assert.equal(statsFocus.todayMinutes, 35);
    assert.equal(todayFocus.totalMinutes, 35);
    assert.equal(statsFocus.weekMinutes, 65);
    assert.equal(statsFocus.todayEntries.length, 1);
  });
});

test('S5 (#859): FocusDurationPanel and StatsView SSR in zh and en (empty 1-sentence state + populated chart & logs)', () => {
  const TODAY = '2026-11-08';
  const emptyBoard = {
    version: 1,
    revision: 1,
    columns: [{ id: 'todo', title: '待办', cardIds: [] }, { id: 'done', title: '已完成', done: true, cardIds: [] }],
    cards: {},
    archived: [],
    timeLog: [],
  };
  const populatedBoard = {
    ...emptyBoard,
    timeLog: [
      { id: 'l1', date: '2026-11-05', startedAt: '2026-11-05T08:00:00.000Z', cardTitle: '精读第 2 章', minutes: 30 },
      { id: 'l2', date: TODAY, startedAt: '2026-11-08T09:10:00.000Z', cardTitle: '手写银行家算法', minutes: 25 },
      { id: 'l3', date: TODAY, startedAt: '2026-11-08T11:00:00.000Z', cardTitle: '错题巩固', minutes: 20 },
    ],
  };

  setUiLanguage('zh');
  try {
    // Empty state: single quiet sentence, no SVG chart or empty placeholder box
    const emptyHtml = renderToStaticMarkup(React.createElement(FocusDurationPanel, {
      board: emptyBoard,
      today: TODAY,
      onOpenToday: () => {},
    }));
    assert.match(emptyHtml, /专注时长/);
    assert.match(emptyHtml, /还没有专注记录。在「待办 → 今日」点击卡片上的「开始专注」后会记在这里。/);
    assert.doesNotMatch(emptyHtml, /<svg[^>]*class="dash-svg"/);
    assert.match(emptyHtml, /去今日/);

    // Populated state inside StatsView
    const sampleStats = {
      generatedAt: '2026-11-08T12:00:00Z',
      today: TODAY,
      totals: { attempts: 12, activeDays: 3, streak: 3, due: 4, gradedRate: 75, gradedAttempts: 8, selfRate: 80, selfAttempts: 4, oralAttempts: 0, oralStrong: 0 },
      heatmap: [],
      trend: [],
      forecast: { days: [], later: 0 },
      mastery: { windowDays: 30, minAnswers: 3, levels: [], kinds: [] },
      weakTopics: [],
    };
    const fullHtml = renderToStaticMarkup(React.createElement(StatsView, {
      stats: sampleStats,
      course: '*',
      data: { decks: [], focus: {} },
      board: populatedBoard,
      focusToday: TODAY,
      onEditTimeLog: () => {},
      onRemoveTimeLog: () => {},
      onOpenToday: () => {},
      onStartScope: () => {},
      onLibrary: () => {},
      onCreate: () => {},
      onSources: () => {},
    }));
    assert.match(fullHtml, /dash-focus-panel/);
    assert.match(fullHtml, /今日已专注 45 分钟/);
    assert.match(fullHtml, /近 7 天共 75 分钟/);
    assert.match(fullHtml, /手写银行家算法/);
    assert.match(fullHtml, /错题巩固/);
    assert.match(fullHtml, /修改时长：手写银行家算法/);
    assert.match(fullHtml, /删除记录：错题巩固/);

    // English translation check (zero Chinese characters in non-card UI labels)
    setUiLanguage('en');
    const enBoard = {
      ...emptyBoard,
      timeLog: [
        { id: 'e1', date: TODAY, startedAt: '2026-11-08T09:10:00.000Z', cardTitle: 'Deadlock safety sequence', minutes: 25 },
      ],
    };
    const enEmpty = renderToStaticMarkup(React.createElement(FocusDurationPanel, {
      board: emptyBoard,
      today: TODAY,
      onOpenToday: () => {},
    }));
    assert.match(enEmpty, /Focus time/);
    assert.match(enEmpty, /No focus sessions yet/);
    assert.doesNotMatch(enEmpty, /[\u4e00-\u9fff]/);

    const enPopulated = renderToStaticMarkup(React.createElement(FocusDurationPanel, {
      board: enBoard,
      today: TODAY,
      onEditLog: () => {},
      onRemoveLog: () => {},
      onOpenToday: () => {},
    }));
    assert.match(enPopulated, /Focused 25 min today/);
    assert.match(enPopulated, /25 min in the last 7 days/);
    assert.match(enPopulated, /Today&#x27;s focus sessions|Today's focus sessions/);
    assert.doesNotMatch(enPopulated, /[\u4e00-\u9fff]/);
  } finally {
    setUiLanguage('zh');
  }
});
