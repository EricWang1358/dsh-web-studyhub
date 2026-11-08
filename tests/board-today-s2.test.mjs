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
import { StudyService } from '../lib/service.js';
import { boardAction } from '../lib/board.js';
import {
  TODAY_LANES,
  TODAY_SLOTS,
  applyBoardAction,
  assignTodaySlots,
  cardTodaySource,
  effectiveTodaySlot,
  resolveTodayLane,
  selectTodayBoard,
} from '../lib/board-model.js';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export { default as Board } from './ui/Board.jsx';
      export { default as TodayView } from './ui/board/TodayView.jsx';
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
const { Board, setUiLanguage } = uiModule.exports;

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

test('assignTodaySlots & Decision 2 slot extensibility: fills AM up to ~half planner budget, then PM, and maps evening cleanly', () => {
  assert.deepEqual(TODAY_SLOTS, ['am', 'pm', 'evening']);
  assert.deepEqual(TODAY_LANES, ['am', 'pm']);
  assert.equal(resolveTodayLane('am'), 'am');
  assert.equal(resolveTodayLane('pm'), 'pm');
  assert.equal(resolveTodayLane('evening'), 'pm');

  // Weekday budget 40 min -> half is 20 min: [10, 10, 10, 10] => AM gets [10, 10] (20 min), PM gets [10, 10] (20 min).
  assert.deepEqual(
    assignTodaySlots([{ minutes: 10 }, { minutes: 10 }, { minutes: 10 }, { minutes: 10 }], 40),
    ['am', 'am', 'pm', 'pm'],
  );

  // Weekend budget 60 min -> half is 30 min: [15, 10, 15, 15] =>
  // item 0 (15): amCount===0 -> 'am' (amMinutes=15)
  // item 1 (10): 15 + 5 < 30 -> 'am' (amMinutes=25)
  // item 2 (15): 25 + 7.5 = 32.5 >= 30 -> 'pm'
  // item 3 (15): inPm -> 'pm'
  assert.deepEqual(
    assignTodaySlots([{ minutes: 15 }, { minutes: 10 }, { minutes: 15 }, { minutes: 15 }], 60),
    ['am', 'am', 'pm', 'pm'],
  );

  // Single oversized task still starts in AM so Morning is not left blank when tasks exist; subsequent tasks go to PM.
  assert.deepEqual(
    assignTodaySlots([{ minutes: 35 }, { minutes: 10 }], 40),
    ['am', 'pm'],
  );
});

test('daily.plan.accept assigns AM/PM slots and plan/mistake sources by planner budget without mutating course.plan or budget', async () => {
  const home = await mkdtemp(join(tmpdir(), 'study-board-s2-plan-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const root = join(home, 'library');
  const service = new StudyService(root);
  try {
    const weekday = '2026-10-05'; // Monday
    const weekend = '2026-10-10'; // Saturday
    await service.store.update((s) => {
      s.decks.push(
        {
          id: 'weak-deck',
          title: 'Page Tables',
          course: 'OS',
          cards: Array.from({ length: 5 }, (_, i) => ({
            id: `w${i}`,
            kind: 'flashcard',
            topic: 'Paging',
            prompt: `Weak Q${i}`,
            answer: 'A',
            options: [],
            citations: [],
            requires: [],
            review: { repetitions: 1, interval_days: 1, ease_factor: 2.0, due_at: '2026-10-01T00:00:00.000Z' },
          })),
        },
        {
          id: 'fresh-deck',
          title: 'Scheduling',
          course: 'OS',
          cards: Array.from({ length: 5 }, (_, i) => ({
            id: `f${i}`,
            kind: 'flashcard',
            topic: 'Scheduling',
            prompt: `Fresh Q${i}`,
            answer: 'B',
            options: [],
            citations: [],
            requires: [],
            review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null },
          })),
        },
      );
      s.attempts.push({
        id: 'att-fail-1',
        deckId: 'weak-deck',
        quiz_id: 'w0',
        correct: false,
        grade: 1,
        at: '2026-10-04T10:00:00.000Z',
      });
      s.sources.push({ id: 'src-1', title: 'Virtual Memory Notes', text: 'TLB and multi-level page tables', courses: ['OS'] });
    });

    await service.call('course.save', { name: 'OS', exam: { date: '2026-10-30' } });
    await service.call('course.save', { name: 'OS', plan: { version: 1, minutesPerDay: 90 } });
    const snapBefore = await service.call('snapshot');
    const coursePlanBefore = snapBefore.courses.find((c) => c.name === 'OS').plan;
    assert.ok(coursePlanBefore, 'course.plan present in snapshot before daily.plan.accept');

    await service.call('daily.plan.profile', { date: weekday, weekdayMinutes: 30, weekendMinutes: 60 });
    const draft = await service.call('daily.plan.suggest', { date: weekday });
    assert.equal(draft.budgetMinutes, 30);
    assert.ok(draft.proposal.items.length >= 2, 'suggests multiple items within 30 min weekday budget');

    const accepted = await service.call('daily.plan.accept', { date: weekday, proposalId: draft.proposal.id });
    const boardAfterAccept = await boardAction('board.get');
    const projected = selectTodayBoard(boardAfterAccept, { today: weekday });
    assert.ok(projected.lanes.am.count >= 1, 'morning lane receives initial tasks');
    assert.ok(projected.lanes.pm.count >= 1, 'afternoon lane receives second-half tasks');
    assert.equal(projected.lanes.am.count + projected.lanes.pm.count, accepted.tasks.length);

    // Mistake-backed practice task is tagged as mistake; non-mistake tasks are tagged as plan.
    const weakCard = Object.values(boardAfterAccept.cards).find((c) => c.studyRef?.id === 'weak-deck');
    const otherCard = Object.values(boardAfterAccept.cards).find((c) => c.id !== weakCard?.id);
    assert.equal(cardTodaySource(weakCard), 'mistake');
    assert.equal(cardTodaySource(otherCard), 'plan');

    // Reorder across lanes and verify neither course.plan nor dailyPlanner budget changed.
    const moveTarget = projected.lanes.am.cards[0];
    const reorderedIds = [
      ...projected.lanes.am.cards.slice(1).map((c) => c.id),
      ...projected.lanes.pm.cards.map((c) => c.id),
      moveTarget.id,
    ];
    await boardAction('board.today.move', {
      revision: boardAfterAccept.revision,
      id: moveTarget.id,
      date: weekday,
      slot: 'pm',
      order: reorderedIds,
    });

    const planAfterMove = await service.call('daily.plan.get', { date: weekday });
    const weekendPlan = await service.call('daily.plan.get', { date: weekend });
    const snapAfterMove = await service.call('snapshot');
    assert.equal(planAfterMove.budgetMinutes, 30, 'weekday daily budget untouched');
    assert.equal(weekendPlan.budgetMinutes, 60, 'weekend daily budget untouched');
    assert.deepEqual(
      snapAfterMove.courses.find((c) => c.name === 'OS').plan,
      coursePlanBefore,
      'course.plan untouched by lane reordering',
    );
  } finally {
    await service.dispose();
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('slot expiry across days & board.today.move persistence + optimistic parity', async () => {
  const home = await mkdtemp(join(tmpdir(), 'study-board-s2-move-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const day1 = '2026-10-02';
    const day2 = '2026-10-03';
    let b = await boardAction('board.get');
    b = await boardAction('board.card.add', { revision: b.revision, title: 'Card A', due: day1, slot: 'am', slotDate: day1 });
    b = await boardAction('board.card.add', { revision: b.revision, title: 'Card B', due: day1, slot: 'pm', slotDate: day1 });
    b = await boardAction('board.card.add', { revision: b.revision, title: 'Card C (evening extensible)', due: day1, slot: 'evening', slotDate: day1 });
    const [idA, idB, idC] = b.columns[0].cardIds;

    // Validation rejects invalid slots without mutating board.json.
    const boardFile = join(home, 'study', 'board.json');
    const beforeBad = await readFile(boardFile, 'utf8');
    await assert.rejects(() => boardAction('board.card.add', { revision: b.revision, title: 'Bad', slot: 'midnight' }), /slot/);
    await assert.rejects(() => boardAction('board.today.move', { revision: b.revision, id: idA, date: day1, slot: 'dawn' }), /slot/);
    assert.equal(await readFile(boardFile, 'utf8'), beforeBad);

    // On day 1: A in AM, B & C in PM (evening resolves to PM).
    const p1 = selectTodayBoard(b, { today: day1 });
    assert.deepEqual(p1.lanes.am.cards.map((c) => c.id), [idA]);
    assert.deepEqual(p1.lanes.pm.cards.map((c) => c.id), [idB, idC]);

    // Move A after C in PM and compare optimistic applyBoardAction with persisted boardAction.
    const moveArgs = { id: idA, date: day1, slot: 'pm', order: [idC, idB, idA] };
    const optimistic = applyBoardAction(b, 'board.today.move', moveArgs);
    b = await boardAction('board.today.move', { revision: b.revision, ...moveArgs });
    assert.deepEqual(
      selectTodayBoard(optimistic, { today: day1 }).lanes.pm.cards.map((c) => c.id),
      [idC, idB, idA],
    );
    assert.deepEqual(
      selectTodayBoard(b, { today: day1 }).lanes.pm.cards.map((c) => c.id),
      [idC, idB, idA],
    );

    // Next day (day 2): all three cards are still open on Today because `due: day1` is now overdue,
    // BUT day 1's `slot` and `todayOrder` expire automatically -> natural column order [idA, idB, idC] in AM!
    assert.equal(effectiveTodaySlot(b.cards[idA], day2), null);
    assert.equal(effectiveTodaySlot(b.cards[idB], day2), null);
    const p2 = selectTodayBoard(b, { today: day2 });
    assert.deepEqual(p2.lanes.am.cards.map((c) => c.id), [idA, idB, idC]);
    assert.deepEqual(p2.lanes.pm.cards.map((c) => c.id), []);
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('SSR UI (#856): AM/PM headers with N 项 · 约 M 分钟, source badges, duration omission on manual cards, empty lane hint, and English zero-CJK', () => {
  const today = '2026-10-02';
  const iso = new Date(2026, 9, 2, 9, 0, 0).toISOString();
  const library = { root: '/lib', courses: [] };
  const stateOf = (b) => ({ board: b, error: '', conflict: false, busy: false, mutate: async () => true, refresh: noop, clearError: noop });

  const bothLanesBoard = {
    version: 1,
    revision: 5,
    columns: [
      { id: 'todo', title: '待办', done: false, cardIds: ['planCard', 'mistakeCard', 'manualCard'] },
      { id: 'doing', title: '进行中', done: false, cardIds: [] },
      { id: 'done', title: '已完成', done: true, cardIds: [] },
    ],
    cards: {
      planCard: {
        id: 'planCard',
        title: 'Read chapter 4',
        note: '',
        due: '',
        labels: ['学习计划'],
        slot: 'am',
        slotDate: today,
        createdAt: iso,
        updatedAt: iso,
        studyRef: { root: '/lib', kind: 'source', id: 's1' },
        learningTask: { version: 1, kind: 'reading', source: 'plan', minutes: 20, reason: 'New chapter', createdDate: today, scope: [] },
      },
      mistakeCard: {
        id: 'mistakeCard',
        title: 'Drill TLB misses',
        note: '',
        due: '',
        labels: ['学习计划'],
        slot: 'pm',
        slotDate: today,
        createdAt: iso,
        updatedAt: iso,
        studyRef: { root: '/lib', kind: 'deck', id: 'd1' },
        learningTask: { version: 1, kind: 'practice', source: 'mistake', minutes: 15, reason: 'Weak topic', createdDate: today, scope: [{ deckId: 'd1', cardId: 'c1' }] },
      },
      manualCard: {
        id: 'manualCard',
        title: 'Email TA about lab',
        note: '',
        due: '',
        plannedDate: today,
        slot: 'am',
        slotDate: today,
        labels: [],
        createdAt: iso,
        updatedAt: iso,
      },
    },
    archived: [],
  };

  const zhHtml = render(React.createElement(Board, { state: stateOf(bothLanesBoard), library, today, view: 'today' }));
  const zhText = strip(zhHtml);
  for (const expected of [
    '上午',
    '2 项 · 约 20 分钟',
    '下午',
    '1 项 · 约 15 分钟',
    '备考计划',
    '约 20 分钟',
    '错题',
    '约 15 分钟',
    '自己加的',
  ]) {
    assert.ok(zhText.includes(expected), `expected "${expected}" in rendered Today view`);
  }
  assert.match(zhHtml, /placeholder="加到上午…"/);
  assert.match(zhHtml, /placeholder="加到下午…"/);
  // Manual card has no learningTask.minutes, so only two `.board-duration` badges exist (for planCard & mistakeCard).
  assert.equal((zhHtml.match(/class="board-duration"/g) || []).length, 2, 'manual card omits 约 N 分钟 badge');
  assert.doesNotMatch(zhText, /学习计划/, 'auto-label 学习计划 is suppressed in favor of source chip on Today');

  // One lane empty state: remove mistakeCard so PM is empty while AM has 2 cards.
  const oneLaneEmptyBoard = {
    ...bothLanesBoard,
    columns: [
      { id: 'todo', title: '待办', done: false, cardIds: ['planCard', 'manualCard'] },
      { id: 'doing', title: '进行中', done: false, cardIds: [] },
      { id: 'done', title: '已完成', done: true, cardIds: [] },
    ],
    cards: {
      planCard: bothLanesBoard.cards.planCard,
      manualCard: bothLanesBoard.cards.manualCard,
    },
  };
  const oneEmptyHtml = render(React.createElement(Board, { state: stateOf(oneLaneEmptyBoard), library, today, view: 'today' }));
  assert.match(oneEmptyHtml, /这一段还没有安排，拖卡片到这里或在下面添加。/);
  assert.ok(strip(oneEmptyHtml).includes('0 项 · 约 0 分钟'));

  // English UI zero-CJK check across both-lanes and one-lane-empty boards.
  for (const b of [bothLanesBoard, oneLaneEmptyBoard]) {
    const enHtml = render(React.createElement(Board, { state: stateOf(b), library, today, view: 'today' }), 'en');
    assert.doesNotMatch(strip(enHtml), han, 'English Today view has zero untranslated Chinese characters');
  }
});
