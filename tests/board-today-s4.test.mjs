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
import { boardAction, boardTransaction } from '../lib/board.js';
import {
  ACTUAL_MINUTES_MAX, applyBoardAction, cardActualMinutes, resolveTimerPrefs, selectTodayTimeLog, timerSnapshot,
} from '../lib/board-model.js';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export { setUiLanguage } from './ui/i18n.js';
      export { default as Board } from './ui/Board.jsx';
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
const { setUiLanguage, Board } = uiModule.exports;

const TODAY = '2026-11-08';

async function withTempBoard(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'study-board-s4-'));
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

test('S4 (#858): start, pause, resume, reload recovery, complete, and abandon minute math', async () => {
  await withTempBoard(async () => {
    let board = await boardAction('board.get', {});
    assert.deepEqual(resolveTimerPrefs(board), { workMinutes: 25, breakMinutes: 5, sound: false, notify: false });

    board = await boardAction('board.card.add', {
      revision: board.revision,
      title: '精读第 3 章死锁预防',
      plannedDate: TODAY,
      slot: 'am',
      slotDate: TODAY,
      now: '2026-11-08T09:00:00.000Z',
    }, '/tmp/study');
    const cardId = board.columns[0].cardIds[0];

    // Start focus at 09:00
    board = await boardAction('board.timer.start', {
      revision: board.revision,
      id: cardId,
      mode: 'work',
      now: '2026-11-08T09:00:00.000Z',
    });
    assert.equal(board.timer.mode, 'work');
    assert.equal(board.timer.cardId, cardId);
    assert.equal(board.timer.durationMinutes, 25);
    assert.equal(board.timer.pausedMs, 0);

    // Pause at 09:10 (10 minutes elapsed)
    board = await boardAction('board.timer.pause', {
      revision: board.revision,
      now: '2026-11-08T09:10:00.000Z',
    });
    assert.equal(board.timer.pausedAt, '2026-11-08T09:10:00.000Z');

    // Simulate reload 7 minutes later while still paused (09:17): remaining stays 15:00, logged stays 10 min
    const reloadedPaused = await boardAction('board.get', {});
    const pausedSnap = timerSnapshot(reloadedPaused.timer, Date.parse('2026-11-08T09:17:00.000Z'));
    assert.equal(pausedSnap.paused, true);
    assert.equal(pausedSnap.elapsedMs, 10 * 60_000);
    assert.equal(pausedSnap.remainingMs, 15 * 60_000);
    assert.equal(pausedSnap.loggedMinutes, 10);

    // Resume at 09:17 -> pausedMs records 7 minutes (420_000ms)
    board = await boardAction('board.timer.resume', {
      revision: reloadedPaused.revision,
      now: '2026-11-08T09:17:00.000Z',
    });
    assert.equal(board.timer.pausedAt, undefined);
    assert.equal(board.timer.pausedMs, 7 * 60_000);

    // Simulate another reload at 09:25 (18 min active elapsed: 25m wall - 7m pause): remaining 7:00, logged 18 min
    const reloadedRunning = await boardAction('board.get', {});
    const runningSnap = timerSnapshot(reloadedRunning.timer, Date.parse('2026-11-08T09:25:00.000Z'));
    assert.equal(runningSnap.running, true);
    assert.equal(runningSnap.remainingMs, 7 * 60_000);
    assert.equal(runningSnap.loggedMinutes, 18);

    // Complete early at 09:25 -> records 18 minutes on manual card + board.timeLog
    board = await boardAction('board.timer.complete', {
      revision: reloadedRunning.revision,
      date: TODAY,
      now: '2026-11-08T09:25:00.000Z',
    });
    assert.equal(board.timer, undefined);
    assert.equal(board.cards[cardId].actualMinutes, 18);
    assert.equal(board.timeLog.length, 1);
    assert.equal(board.timeLog[0].minutes, 18);
    assert.equal(board.timeLog[0].cardId, cardId);
    assert.equal(board.timeLog[0].date, TODAY);

    // Start another session and abandon ("放弃这一个") -> nothing logged, actualMinutes stays 18
    board = await boardAction('board.timer.start', {
      revision: board.revision,
      id: cardId,
      mode: 'work',
      now: '2026-11-08T10:00:00.000Z',
    });
    board = await boardAction('board.timer.cancel', {
      revision: board.revision,
      now: '2026-11-08T10:12:00.000Z',
    });
    assert.equal(board.timer, undefined);
    assert.equal(board.cards[cardId].actualMinutes, 18);
    assert.equal(board.timeLog.length, 1);

    // Break mode completion never logs work minutes
    board = await boardAction('board.timer.prefs', {
      revision: board.revision,
      workMinutes: 30,
      breakMinutes: 8,
      sound: true,
      notify: false,
    });
    assert.deepEqual(resolveTimerPrefs(board), { workMinutes: 30, breakMinutes: 8, sound: true, notify: false });
    board = await boardAction('board.timer.start', {
      revision: board.revision,
      mode: 'break',
      cardTitle: '休息',
      now: '2026-11-08T10:15:00.000Z',
    });
    assert.equal(board.timer.durationMinutes, 8);
    board = await boardAction('board.timer.complete', {
      revision: board.revision,
      now: '2026-11-08T10:23:00.000Z',
    });
    assert.equal(board.timer, undefined);
    assert.equal(board.timeLog.length, 1, 'break completion does not add a focus timeLog entry');
  });
});

test('S4 (#858): manual backfill, edit, delete, card delete+undo, and actualMinutes 240 ceiling on learningTask & manual cards', async () => {
  await withTempBoard(async () => {
    let board = await boardAction('board.get', {});
    board = await boardAction('board.card.add', {
      revision: board.revision,
      title: '自己加的错题整理卡',
      plannedDate: TODAY,
      now: '2026-11-08T08:00:00.000Z',
    }, '/tmp/study');
    const manualId = board.columns[0].cardIds[0];

    // Seed a learningTask card with pre-existing actualMinutes = 200 from daily.plan.complete
    const planCardId = 'plan_task_1';
    await boardTransaction((draft) => {
      draft.cards[planCardId] = {
        id: planCardId,
        title: '巩固 银行家算法',
        note: '',
        due: '',
        plannedDate: TODAY,
        labels: ['学习计划'],
        createdAt: '2026-11-08T08:00:00.000Z',
        updatedAt: '2026-11-08T08:00:00.000Z',
        origin: { workspace: '/tmp/study', workspaceTitle: 'study' },
        studyRef: { root: '/tmp/study', kind: 'deck', id: 'deck-1' },
        learningTask: {
          version: 1,
          kind: 'practice',
          source: 'mistake',
          minutes: 25,
          actualMinutes: 200,
          reason: '薄弱知识点需要巩固',
          createdDate: TODAY,
          scope: [{ deckId: 'deck-1', cardId: 'q-1' }],
        },
      };
      draft.columns[0].cardIds.push(planCardId);
    });
    board = await boardAction('board.get', {});

    // Add 60 min focus log onto learningTask card -> 200 + 60 clamps to 240
    board = await boardAction('board.timeLog.add', {
      revision: board.revision,
      cardId: planCardId,
      minutes: 60,
      date: TODAY,
      startedAt: '2026-11-08T08:30:00.000Z',
    });
    assert.equal(board.cards[planCardId].learningTask.actualMinutes, ACTUAL_MINUTES_MAX);
    assert.equal(cardActualMinutes(board.cards[planCardId]), 240);

    // Add two focus logs (150 + 120 = 270) onto manual card -> clamps to 240
    board = await boardAction('board.timeLog.add', {
      revision: board.revision,
      cardId: manualId,
      minutes: 150,
      date: TODAY,
      startedAt: '2026-11-08T09:00:00.000Z',
    });
    board = await boardAction('board.timeLog.add', {
      revision: board.revision,
      cardId: manualId,
      minutes: 120,
      date: TODAY,
      startedAt: '2026-11-08T12:00:00.000Z',
    });
    assert.equal(board.cards[manualId].actualMinutes, 240);

    // Edit second log from 120 -> 40: 150 + 40 = 190 (optimistic model agrees with server)
    const secondLogId = board.timeLog[board.timeLog.length - 1].id;
    const optimisticEdited = applyBoardAction(board, 'board.timeLog.edit', { id: secondLogId, minutes: 40 });
    assert.equal(optimisticEdited.cards[manualId].actualMinutes, 190);
    board = await boardAction('board.timeLog.edit', {
      revision: board.revision,
      id: secondLogId,
      minutes: 40,
    });
    assert.equal(board.cards[manualId].actualMinutes, 190);

    // Remove second log -> manual card actualMinutes drops to 150
    const optimisticRemoved = applyBoardAction(board, 'board.timeLog.remove', { id: secondLogId });
    assert.equal(optimisticRemoved.cards[manualId].actualMinutes, 150);
    board = await boardAction('board.timeLog.remove', {
      revision: board.revision,
      id: secondLogId,
    });
    assert.equal(board.cards[manualId].actualMinutes, 150);
    assert.equal(selectTodayTimeLog(board, TODAY).totalMinutes, 210);

    // Delete manual card -> prunes its timeLog; undelete with saved timeLog restores both card and timeLog
    const cardSnapshot = structuredClone(board.cards[manualId]);
    const savedLogs = structuredClone(board.timeLog.filter((entry) => entry.cardId === manualId));
    board = await boardAction('board.card.remove', {
      revision: board.revision,
      id: manualId,
    });
    assert.equal(board.cards[manualId], undefined);
    assert.equal(selectTodayTimeLog(board, TODAY).totalMinutes, 60);

    board = await boardAction('board.card.undelete', {
      revision: board.revision,
      card: cardSnapshot,
      column: 'todo',
      index: 0,
      timeLog: savedLogs,
    });
    assert.equal(board.cards[manualId].actualMinutes, 150);
    assert.equal(selectTodayTimeLog(board, TODAY).totalMinutes, 210);
  });
});

test('S4 (#858): Today view SSR renders Start Focus button, active countdown, actualMinutes chip, and bilingual strings', () => {
  const board = {
    version: 1,
    revision: 3,
    columns: [
      { id: 'todo', title: '待办', done: false, cardIds: ['c1', 'c2'] },
      { id: 'doing', title: '进行中', done: false, cardIds: [] },
      { id: 'done', title: '已完成', done: true, cardIds: [] },
    ],
    cards: {
      c1: {
        id: 'c1',
        title: '推导页面置换缺页率',
        note: '',
        due: '',
        plannedDate: TODAY,
        slot: 'am',
        slotDate: TODAY,
        actualMinutes: 25,
        labels: [],
        createdAt: '2026-11-08T08:00:00.000Z',
        updatedAt: '2026-11-08T08:30:00.000Z',
        origin: { workspace: '/tmp/ws', workspaceTitle: 'ws' },
      },
      c2: {
        id: 'c2',
        title: '复习管程条件变量',
        note: '',
        due: '',
        plannedDate: TODAY,
        slot: 'pm',
        slotDate: TODAY,
        labels: [],
        createdAt: '2026-11-08T08:05:00.000Z',
        updatedAt: '2026-11-08T08:05:00.000Z',
        origin: { workspace: '/tmp/ws', workspaceTitle: 'ws' },
      },
    },
    archived: [],
    timer: {
      id: 't1',
      mode: 'work',
      cardId: 'c1',
      cardTitle: '推导页面置换缺页率',
      durationMinutes: 25,
      startedAt: '2026-11-08T09:00:00.000Z',
      pausedMs: 0,
    },
    timeLog: [
      {
        id: 'log1',
        date: TODAY,
        cardId: 'c1',
        cardTitle: '推导页面置换缺页率',
        startedAt: '2026-11-08T08:00:00.000Z',
        minutes: 25,
      },
    ],
  };

  const library = {
    revision: 1,
    courses: [],
    progress: {
      d1: { id: 'd1', title: 'OS', archived: false, due: 3, topics: [] },
    },
  };
  const nowMs = Date.parse('2026-11-08T09:10:00.000Z'); // 15:00 remaining, 10 min elapsed

  setUiLanguage('zh-CN');
  const zhHtml = renderToStaticMarkup(
    React.createElement(Board, {
      state: { board, error: '', conflict: false, busy: false },
      library,
      today: TODAY,
      view: 'today',
      dailyBudgetMinutes: 50,
      nowMs,
    }),
  );
  assert.match(zhHtml, /15:00/);
  assert.match(zhHtml, /完成，记 10 分钟/);
  assert.match(zhHtml, /放弃这一个/);
  assert.match(zhHtml, /专注中/);
  assert.match(zhHtml, /开始专注/);
  assert.match(zhHtml, /实际 25 分钟/);
  assert.match(zhHtml, /今天计划 50 分钟 \/ 已专注 25 分钟/);
  assert.match(zhHtml, /今日已专注 25 分钟/);

  setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(
      React.createElement(Board, {
        state: { board, error: '', conflict: false, busy: false },
        library,
        today: TODAY,
        view: 'today',
        dailyBudgetMinutes: 50,
        nowMs,
      }),
    );
    assert.match(enHtml, /15:00/);
    assert.match(enHtml, /Finish, log 10 min/);
    assert.match(enHtml, /Abandon/);
    assert.match(enHtml, /Start focus/);
    assert.match(enHtml, /Actual: 25 min/);
    assert.match(enHtml, /Planned 50 min \/ Focused 25 min today/);
  } finally {
    setUiLanguage('zh-CN');
  }
});
