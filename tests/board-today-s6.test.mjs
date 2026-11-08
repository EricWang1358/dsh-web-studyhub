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
  applyBoardAction, dueSummary, filterCards, isMemoCard, labelCounts, locateCard,
  memoBody, selectTodayBoard, selectTodayMemos, splitMemoDraft, taskCardCount,
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
const TOMORROW = '2026-11-09';

async function withTempBoard(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'study-board-s6-'));
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

test('S6 (#860): memo add, edit, archive, delete, and undo reuse board.card.* in board.json', async () => {
  await withTempBoard(async () => {
    let board = await boardAction('board.get', {});
    assert.equal(taskCardCount(board), 0);
    assert.deepEqual(selectTodayMemos(board, { today: TODAY }), []);
    // Identity contract when no memos exist
    assert.equal(filterCards(board, {}), board);

    // 1. Add unpinned memo
    const draft1 = splitMemoDraft('把第 4 章易混公式抄在一张纸上\n特别是条件概率与全概率公式的适用前提。');
    board = await boardAction('board.card.add', {
      revision: board.revision,
      kind: 'memo',
      title: draft1.title,
      note: draft1.note,
    }, '/tmp/study');
    const memo1Id = board.columns[0].cardIds[0];
    const memo1 = board.cards[memo1Id];
    assert.equal(isMemoCard(memo1), true);
    assert.equal(memoBody(memo1), '把第 4 章易混公式抄在一张纸上\n特别是条件概率与全概率公式的适用前提。');

    // Memos never leak into task projections, counts, labels, due badges, or Today AM/PM lanes
    assert.equal(taskCardCount(board), 0);
    assert.equal(filterCards(board, {}).columns[0].cardIds.length, 0);
    assert.deepEqual(labelCounts(board), []);
    assert.deepEqual(dueSummary(board, TODAY), { overdue: 0, today: 0 });
    const todayProj = selectTodayBoard(board, { today: TODAY });
    assert.equal(todayProj.open.length, 0);
    assert.equal(todayProj.unscheduled.length, 0);

    // 2. Edit memo (and pin to TOMORROW), then undo edit back to unpinned
    const prevSnapshot = { title: memo1.title, note: memo1.note, plannedDate: memo1.plannedDate || '' };
    const optimisticEdited = applyBoardAction(board, 'board.card.edit', {
      id: memo1Id,
      title: '明天模考前先看错题本第 2 页',
      note: '',
      plannedDate: TOMORROW,
    });
    assert.equal(optimisticEdited.cards[memo1Id].plannedDate, TOMORROW);

    board = await boardAction('board.card.edit', {
      revision: board.revision,
      id: memo1Id,
      title: '明天模考前先看错题本第 2 页',
      note: '',
      plannedDate: TOMORROW,
    });
    // Pinned to TOMORROW -> hidden on TODAY, visible on TOMORROW
    assert.equal(selectTodayMemos(board, { today: TODAY }).length, 0);
    assert.equal(selectTodayMemos(board, { today: TOMORROW }).length, 1);

    // Undo edit -> back to unpinned, visible on both TODAY and TOMORROW
    board = await boardAction('board.card.edit', {
      revision: board.revision,
      id: memo1Id,
      ...prevSnapshot,
    });
    assert.equal(board.cards[memo1Id].plannedDate, undefined);
    assert.equal(selectTodayMemos(board, { today: TODAY }).length, 1);
    assert.equal(selectTodayMemos(board, { today: TOMORROW }).length, 1);

    // 3. Archive memo + Undo (board.card.restore)
    const fromBeforeArchive = locateCard(board, memo1Id);
    board = await boardAction('board.card.archive', {
      revision: board.revision,
      id: memo1Id,
    });
    assert.equal(selectTodayMemos(board, { today: TODAY }).length, 0);
    assert.equal(board.archived.length, 1);
    assert.equal(isMemoCard(board.archived[0]), true);

    board = await boardAction('board.card.restore', {
      revision: board.revision,
      id: memo1Id,
      column: fromBeforeArchive.column,
      index: fromBeforeArchive.index,
    });
    assert.equal(board.archived.length, 0);
    assert.equal(selectTodayMemos(board, { today: TODAY }).length, 1);

    // 4. Delete memo + Undo (board.card.undelete)
    const fromBeforeDelete = locateCard(board, memo1Id);
    const savedCard = structuredClone(board.cards[memo1Id]);
    board = await boardAction('board.card.remove', {
      revision: board.revision,
      id: memo1Id,
    });
    assert.equal(board.cards[memo1Id], undefined);
    assert.equal(selectTodayMemos(board, { today: TODAY }).length, 0);

    board = await boardAction('board.card.undelete', {
      revision: board.revision,
      card: savedCard,
      column: fromBeforeDelete.column,
      index: fromBeforeDelete.index,
    });
    assert.equal(selectTodayMemos(board, { today: TODAY }).length, 1);
    assert.equal(memoBody(board.cards[memo1Id]), '把第 4 章易混公式抄在一张纸上\n特别是条件概率与全概率公式的适用前提。');

    // 5. Removing a column that holds only memos succeeds and relocates memos safely
    const col0 = board.columns[0].id;
    board = await boardAction('board.column.remove', {
      revision: board.revision,
      id: col0,
    });
    assert.ok(board.cards[memo1Id]);
    assert.equal(selectTodayMemos(board, { today: TODAY }).length, 1);
  });
});

test('S6 (#860): reverse-chronological ordering and >500-char splitMemoDraft lossless round-trip', () => {
  const longLine = '极长单行思考记录'.repeat(80); // 640 chars > TITLE_MAX (500)
  const parts = splitMemoDraft(longLine);
  assert.ok(parts.title.length <= 500);
  assert.ok(parts.note.length > 0);
  assert.equal(memoBody(parts), longLine);

  const board = {
    revision: 1,
    columns: [{ id: 'todo', title: '待办', done: false, cardIds: ['m1', 'm2', 'm3', 'm4'] }],
    cards: {
      m1: { id: 'm1', kind: 'memo', title: '最早的备忘', note: '', createdAt: '2026-11-08T08:00:00.000Z', updatedAt: '2026-11-08T08:00:00.000Z' },
      m2: { id: 'm2', kind: 'memo', title: '中间挂今天的备忘', note: '', plannedDate: TODAY, createdAt: '2026-11-08T10:30:00.000Z', updatedAt: '2026-11-08T10:30:00.000Z' },
      m3: { id: 'm3', kind: 'memo', title: '挂明天的备忘', note: '', plannedDate: TOMORROW, createdAt: '2026-11-08T11:00:00.000Z', updatedAt: '2026-11-08T11:00:00.000Z' },
      m4: { id: 'm4', kind: 'memo', title: '最新的备忘', note: '补充说明第二行', createdAt: '2026-11-08T14:15:00.000Z', updatedAt: '2026-11-08T14:15:00.000Z' },
    },
    archived: [],
  };

  const todayList = selectTodayMemos(board, { today: TODAY });
  assert.deepEqual(todayList.map((m) => m.id), ['m4', 'm2', 'm1']);

  const tomorrowList = selectTodayMemos(board, { today: TOMORROW });
  assert.deepEqual(tomorrowList.map((m) => m.id), ['m4', 'm3', 'm1']);
});

test('S6 (#860): SSR TodayMemos empty line and populated sticky memos in zh and en', async () => {
  await withTempBoard(async () => {
    const emptyBoard = await boardAction('board.get', {});
    const stateEmpty = { board: emptyBoard, error: '', conflict: false, busy: false, mutate: async () => true, refresh: async () => {} };

    setUiLanguage('zh');
    const zhEmpty = renderToStaticMarkup(React.createElement(Board, { state: stateEmpty, today: TODAY, view: 'today' }));
    assert.match(zhEmpty, /备忘/);
    assert.match(zhEmpty, /新备忘/);
    assert.match(zhEmpty, /写下你的想法…/);

    setUiLanguage('en');
    const enEmpty = renderToStaticMarkup(React.createElement(Board, { state: stateEmpty, today: TODAY, view: 'today' }));
    assert.match(enEmpty, /Memos/);
    assert.match(enEmpty, /New memo/);
    assert.match(enEmpty, /Jot down your thoughts…/);
    assert.doesNotMatch(enEmpty, /[\u4e00-\u9fff]/);

    // Populated with 2 memos including a long collapsible memo and a pinned memo
    let populated = await boardAction('board.card.add', {
      revision: emptyBoard.revision,
      kind: 'memo',
      title: '考前检查准考证与身份证',
      plannedDate: TODAY,
    }, '/tmp/study');
    populated = await boardAction('board.card.add', {
      revision: populated.revision,
      kind: 'memo',
      title: '长备忘第一行：银行家算法易错点',
      note: '第2行：先算 Need = Max - Allocation\n第3行：检查 Request <= Need\n第4行：检查 Request <= Available\n第5行：试分配后跑安全性检查\n第6行：若不安全必须回滚原状态',
    }, '/tmp/study');
    const statePopulated = { board: populated, error: '', conflict: false, busy: false, mutate: async () => true, refresh: async () => {} };

    setUiLanguage('zh');
    const zhPopulated = renderToStaticMarkup(React.createElement(Board, { state: statePopulated, today: TODAY, view: 'today' }));
    assert.match(zhPopulated, /长备忘第一行：银行家算法易错点/);
    assert.match(zhPopulated, /挂在 /);
    assert.match(zhPopulated, /展开/);

    setUiLanguage('en');
    const enPopulated = renderToStaticMarkup(React.createElement(Board, { state: statePopulated, today: TODAY, view: 'today' }));
    assert.match(enPopulated, /Expand/);
    assert.match(enPopulated, /On /);

    setUiLanguage('zh');
  });
});
