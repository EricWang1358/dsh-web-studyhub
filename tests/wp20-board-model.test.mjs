/* WP20 · the board's pure model: title validation, checklist progress, due
   states, stable label hues, filtering and the optimistic patches. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECKLIST_MAX_ITEMS, CHECKLIST_MAX_TEXT, isMeaningfulTitle, checklistProgress, dueState, labelHue, LABEL_HUES,
  labelCounts, filterCards, isFiltering, locateCard, doneToggleTarget, applyBoardAction, weekEnd,
} from '../lib/board-model.js';

const card = (id, extra = {}) => ({ id, title: id, note: '', due: '', labels: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  origin: { workspace: '/w', workspaceTitle: 'w' }, ...extra });
const board = () => ({
  version: 1, revision: 4,
  columns: [
    { id: 'todo', title: '待办', done: false, cardIds: ['a', 'b', 'c'] },
    { id: 'doing', title: '进行中', done: false, cardIds: ['d'] },
    { id: 'done', title: '已完成', done: true, cardIds: ['e'] },
  ],
  cards: {
    a: card('a', { title: 'SCS TechConnect 2026', note: '时间：10 月 19 日\n地点：SIT', labels: ['career', 'event'], due: '2026-10-19' }),
    b: card('b', { title: 'Platform Engineering 期末复习', labels: ['exam'], due: '2026-10-01', checklist: [{ id: 'i1', text: 'x', done: true }, { id: 'i2', text: 'y', done: false }] }),
    c: card('c', { title: 'Read paper', note: 'Chapter **3**', labels: ['reading'], due: '2026-10-05' }),
    d: card('d', { title: 'Write report', labels: ['exam', 'writing'] }),
    e: card('e', { title: 'Old task', due: '2026-09-01' }),
  },
  archived: [card('z', { title: 'Archived one' })],
});

test('titles that are empty or only punctuation are not meaningful', () => {
  for (const bad of ['', '   ', '?', '？？', '...', '—', '!?', ' ? ']) assert.equal(isMeaningfulTitle(bad), false, JSON.stringify(bad));
  for (const good of ['a', 'Read', '复习 1', '2', '？ 为什么', 'Q?']) assert.equal(isMeaningfulTitle(good), true, JSON.stringify(good));
  assert.equal(isMeaningfulTitle(undefined), false);
  assert.equal(isMeaningfulTitle(3), false);
});

test('checklist limits are 50 items of 200 characters', () => {
  assert.equal(CHECKLIST_MAX_ITEMS, 50);
  assert.equal(CHECKLIST_MAX_TEXT, 200);
});

test('checklist progress counts done items and tolerates cards without a checklist', () => {
  assert.deepEqual(checklistProgress(card('x')), { done: 0, total: 0 });
  assert.deepEqual(checklistProgress(board().cards.b), { done: 1, total: 2 });
  assert.deepEqual(checklistProgress({ checklist: [{ done: true }, { done: true }] }), { done: 2, total: 2 });
});

test('due states are relative to today and overdue only when the card is not done', () => {
  const today = '2026-10-02';
  assert.equal(dueState('', today, false), null);
  assert.deepEqual(dueState('2026-10-02', today, false), { kind: 'today', days: 0 });
  assert.deepEqual(dueState('2026-10-03', today, false), { kind: 'tomorrow', days: 1 });
  assert.deepEqual(dueState('2026-10-05', today, false), { kind: 'soon', days: 3 });
  assert.deepEqual(dueState('2026-10-19', today, false), { kind: 'later', days: 17 });
  assert.deepEqual(dueState('2026-09-30', today, false), { kind: 'overdue', days: -2 });
  assert.deepEqual(dueState('2026-09-30', today, true), { kind: 'done', days: -2 }, 'a finished card is never overdue');
  assert.deepEqual(dueState('2028-03-01', '2028-02-28', false), { kind: 'soon', days: 2 }, 'leap years count');
});

test('every label gets a stable hue class index from a small fixed set', () => {
  assert.ok(LABEL_HUES >= 5);
  const seen = new Set();
  for (const label of ['career', 'event', 'SIT', 'exam', '复习', 'reading', 'writing']) {
    const hue = labelHue(label);
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < LABEL_HUES);
    assert.equal(labelHue(label), hue, 'stable');
    seen.add(hue);
  }
  assert.ok(seen.size >= 3, 'labels spread over several hues instead of one loud colour');
  assert.equal(labelHue('Career'), labelHue('career'), 'case does not change the hue');
});

test('label counts list existing labels, most used first', () => {
  assert.deepEqual(labelCounts(board()), [{ label: 'exam', count: 2 }, { label: 'career', count: 1 }, { label: 'event', count: 1 }, { label: 'reading', count: 1 }, { label: 'writing', count: 1 }]);
});

test('filterCards searches title, note and labels and keeps column order', () => {
  const b = board();
  const ids = (result) => result.columns.flatMap((column) => column.cardIds);
  assert.deepEqual(ids(filterCards(b, {})), ['a', 'b', 'c', 'd', 'e'], 'no query keeps everything');
  assert.deepEqual(ids(filterCards(b, { text: 'techconnect' })), ['a']);
  assert.deepEqual(ids(filterCards(b, { text: '地点' })), ['a'], 'note text matches');
  assert.deepEqual(ids(filterCards(b, { text: 'EXAM' })), ['b', 'd'], 'labels match, case-insensitively');
  assert.deepEqual(ids(filterCards(b, { text: '  chapter  3 ' })), ['c'], 'all words must match');
  assert.deepEqual(ids(filterCards(b, { text: 'nothing like this' })), []);
  const result = filterCards(b, { text: 'exam' });
  assert.deepEqual(result.columns.map((column) => column.id), ['todo', 'doing', 'done'], 'columns are kept even when empty');
  assert.equal(b.columns[0].cardIds.length, 3, 'the input board is not mutated');
});

test('label chips filter with AND semantics and combine with text', () => {
  const b = board();
  const ids = (result) => result.columns.flatMap((column) => column.cardIds);
  assert.deepEqual(ids(filterCards(b, { labels: ['exam'] })), ['b', 'd']);
  assert.deepEqual(ids(filterCards(b, { labels: ['exam', 'writing'] })), ['d']);
  assert.deepEqual(ids(filterCards(b, { labels: ['exam'], text: 'write' })), ['d']);
});

test('due filters: overdue ignores done columns, week covers today through the end of the week', () => {
  const b = board();
  const ids = (result) => result.columns.flatMap((column) => column.cardIds);
  assert.deepEqual(ids(filterCards(b, { due: 'overdue', today: '2026-10-02' })), ['b'], 'e is overdue but already done');
  assert.deepEqual(ids(filterCards(b, { due: 'week', today: '2026-10-02' })), ['c']);
});

test('week filter means the next seven days including today, overdue excluded', () => {
  assert.equal(weekEnd('2026-10-02'), '2026-10-08');
  assert.equal(weekEnd('2026-12-28'), '2027-01-03');
  const b = board();
  const ids = (result) => result.columns.flatMap((column) => column.cardIds);
  assert.deepEqual(ids(filterCards(b, { due: 'week', today: '2026-10-02' })), ['c']);
  assert.deepEqual(ids(filterCards(b, { due: 'week', today: '2026-10-15' })), ['a']);
});

test('isFiltering is false for an empty query', () => {
  assert.equal(isFiltering({}), false);
  assert.equal(isFiltering({ text: '  ', labels: [], due: '' }), false);
  assert.equal(isFiltering({ text: 'a' }), true);
  assert.equal(isFiltering({ labels: ['x'] }), true);
  assert.equal(isFiltering({ due: 'overdue' }), true);
});

test('locateCard and doneToggleTarget describe where a card is and where a check sends it', () => {
  const b = board();
  assert.deepEqual(locateCard(b, 'c'), { column: 'todo', index: 2 });
  assert.equal(locateCard(b, 'missing'), null);
  assert.deepEqual(doneToggleTarget(b, 'c'), { column: 'done', index: 1 }, 'checking appends to the done column');
  assert.deepEqual(doneToggleTarget(b, 'e'), { column: 'todo', index: 3 }, 'unchecking returns to the end of the first open column');
  const noDone = board();
  noDone.columns = noDone.columns.filter((column) => !column.done);
  noDone.columns[0].cardIds.push('e');
  assert.equal(doneToggleTarget(noDone, 'a'), null, 'without a done column there is nothing to check into');
});

test('optimistic move matches the server: final index in the destination column', () => {
  const b = board();
  const moved = applyBoardAction(b, 'board.card.move', { id: 'a', column: 'todo', index: 2 });
  assert.deepEqual(moved.columns[0].cardIds, ['b', 'c', 'a']);
  assert.deepEqual(b.columns[0].cardIds, ['a', 'b', 'c'], 'pure: the input is untouched');
  const across = applyBoardAction(b, 'board.card.move', { id: 'a', column: 'doing', index: 0 });
  assert.deepEqual(across.columns.map((column) => column.cardIds), [['b', 'c'], ['a', 'd'], ['e']]);
  const append = applyBoardAction(b, 'board.card.move', { id: 'a', column: 'done' });
  assert.deepEqual(append.columns[2].cardIds, ['e', 'a']);
  assert.equal(applyBoardAction(b, 'board.card.move', { id: 'a', column: 'nope' }), b, 'an impossible move changes nothing');
});

test('move undo round-trips exactly', () => {
  const b = board();
  const from = locateCard(b, 'b');
  const moved = applyBoardAction(b, 'board.card.move', { id: 'b', column: 'done', index: 0 });
  const back = applyBoardAction(moved, 'board.card.move', { id: 'b', column: from.column, index: from.index });
  assert.deepEqual(back.columns, b.columns);
});

test('archive and restore round-trip with the original position', () => {
  const b = board();
  const from = locateCard(b, 'b');
  const archived = applyBoardAction(b, 'board.card.archive', { id: 'b' });
  assert.equal(archived.cards.b, undefined);
  assert.deepEqual(archived.columns[0].cardIds, ['a', 'c']);
  assert.equal(archived.archived.at(-1).id, 'b');
  const restored = applyBoardAction(archived, 'board.card.restore', { id: 'b', column: from.column, index: from.index });
  assert.deepEqual(restored.columns, b.columns);
  assert.equal(restored.cards.b.title, b.cards.b.title);
  assert.equal(restored.archived.length, 1);
});

test('remove deletes from the board or the archive; edit patches only the given fields', () => {
  const b = board();
  assert.equal(applyBoardAction(b, 'board.card.remove', { id: 'c' }).cards.c, undefined);
  assert.deepEqual(applyBoardAction(b, 'board.card.remove', { id: 'z' }).archived, []);
  const edited = applyBoardAction(b, 'board.card.edit', { id: 'c', title: 'New', labels: ['x'] });
  assert.equal(edited.cards.c.title, 'New');
  assert.deepEqual(edited.cards.c.labels, ['x']);
  assert.equal(edited.cards.c.note, 'Chapter **3**');
  const checked = applyBoardAction(b, 'board.card.edit', { id: 'b', checklist: [{ id: 'i1', text: 'x', done: true }, { id: 'i2', text: 'y', done: true }] });
  assert.deepEqual(checklistProgress(checked.cards.b), { done: 2, total: 2 });
});

test('column rename and remove are mirrored for the optimistic view', () => {
  const b = board();
  assert.equal(applyBoardAction(b, 'board.column.rename', { id: 'doing', title: 'WIP' }).columns[1].title, 'WIP');
  assert.equal(applyBoardAction(b, 'board.column.remove', { id: 'doing' }), b, 'a column with cards is not removed');
  const empty = board();
  empty.columns[1].cardIds = []; delete empty.cards.d;
  assert.deepEqual(applyBoardAction(empty, 'board.column.remove', { id: 'doing' }).columns.map((column) => column.id), ['todo', 'done']);
});

test('unknown actions are ignored by the optimistic patch', () => {
  const b = board();
  assert.equal(applyBoardAction(b, 'board.card.add', { title: 'x' }), b, 'adds wait for the server id');
});
