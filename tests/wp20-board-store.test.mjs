/* WP20 · the board store: optimistic moves, ordered writes by revision,
   reconcile on conflict, and a poll that never fights a pending write. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoardStore } from '../ui/board/store.js';
import { applyBoardAction } from '../lib/board-model.js';

const card = (id) => ({ id, title: id, note: '', due: '', labels: [], createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', origin: { workspace: '/w', workspaceTitle: 'w' } });
const initial = () => ({ version: 1, revision: 1,
  columns: [{ id: 'todo', title: '待办', done: false, cardIds: ['a', 'b'] }, { id: 'doing', title: '进行中', done: false, cardIds: [] }, { id: 'done', title: '已完成', done: true, cardIds: [] }],
  cards: { a: card('a'), b: card('b') }, archived: [] });

/** A fake server: applies actions with the same pure model, enforces revisions, can be held. */
function fakeServer(start = initial()) {
  let board = start;
  const log = [];
  const gates = [];
  const call = async (action, args = {}) => {
    log.push({ action, args });
    if (gates.length) await gates.shift();
    if (action === 'board.get') return args.since === board.revision ? { unchanged: true, revision: board.revision } : structuredClone(board);
    if (args.revision !== board.revision) throw new Error(`Board revision conflict: expected ${args.revision}, current ${board.revision}. Call board.get, review the latest board, and retry with its revision.`);
    if (action === 'board.card.add') { // the pure model has no add: the server makes the id
      const id = `new-${log.length}`;
      board = { ...structuredClone(board), revision: board.revision + 1 };
      board.cards[id] = { ...card(id), title: args.title };
      board.columns.find((column) => column.id === (args.column ?? board.columns[0].id)).cardIds.push(id);
      return structuredClone(board);
    }
    const next = applyBoardAction(board, action, args);
    if (next === board) throw new Error('Card not found; refresh the board');
    board = { ...next, revision: board.revision + 1 };
    return structuredClone(board);
  };
  return { call, log, get board() { return board; }, set board(value) { board = value; },
    hold() { let release; gates.push(new Promise((resolve) => { release = resolve; })); return release; } };
}

test('refresh loads the board and polling with the same revision changes nothing', async () => {
  const server = fakeServer();
  const store = createBoardStore(server.call);
  await store.refresh();
  assert.equal(store.getState().board.revision, 1);
  const before = store.getState();
  await store.refresh();
  assert.equal(store.getState(), before, 'an unchanged poll does not produce a new state');
  assert.deepEqual(server.log.at(-1).args, { since: 1 });
});

test('a move shows immediately, before the server answers', async () => {
  const server = fakeServer();
  const store = createBoardStore(server.call);
  await store.refresh();
  const release = server.hold();
  const done = store.mutate('board.card.move', { id: 'a', column: 'doing', index: 0 });
  assert.deepEqual(store.getState().board.columns[1].cardIds, ['a'], 'patched locally while the write is in flight');
  assert.equal(store.getState().busy, true);
  release();
  assert.equal(await done, true);
  assert.equal(store.getState().busy, false);
  assert.equal(store.getState().board.revision, 2);
  assert.deepEqual(store.getState().board.columns[1].cardIds, ['a']);
});

test('quick successive writes are sent in order, each with the revision the last one produced', async () => {
  const server = fakeServer();
  const store = createBoardStore(server.call);
  await store.refresh();
  const release = server.hold();
  const first = store.mutate('board.card.move', { id: 'a', column: 'doing' });
  const second = store.mutate('board.card.move', { id: 'b', column: 'doing' });
  const third = store.mutate('board.card.archive', { id: 'a' });
  assert.deepEqual(store.getState().board.columns[1].cardIds, ['b'], 'all three are already visible');
  release();
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  const writes = server.log.filter((entry) => entry.action !== 'board.get');
  assert.deepEqual(writes.map((entry) => entry.args.revision), [1, 2, 3]);
  assert.equal(store.getState().board.revision, 4);
  assert.deepEqual(server.board.columns[1].cardIds, ['b']);
  assert.equal(store.getState().board.archived.length, 1);
});

test('a conflict puts the latest server board back and reports it once', async () => {
  const server = fakeServer();
  const store = createBoardStore(server.call);
  await store.refresh();
  // Someone else archives card b and bumps the revision.
  server.board = { ...applyBoardAction(server.board, 'board.card.archive', { id: 'b' }), revision: 5 };
  const ok = await store.mutate('board.card.move', { id: 'a', column: 'doing' });
  assert.equal(ok, false);
  const state = store.getState();
  assert.equal(state.conflict, true);
  assert.match(state.error, /revision conflict/);
  assert.equal(state.board.revision, 5, 'refetched');
  assert.deepEqual(state.board.columns[0].cardIds, ['a'], 'the optimistic move was rolled back to the server truth');
  assert.equal(state.board.cards.b, undefined);
  assert.equal(state.busy, false);
  store.clearError();
  assert.equal(store.getState().error, '');
  assert.equal(store.getState().conflict, false);
});

test('after a failure the writes queued behind it are dropped, not replayed on stale assumptions', async () => {
  const server = fakeServer();
  const store = createBoardStore(server.call);
  await store.refresh();
  server.board = { ...server.board, revision: 9 };
  const release = server.hold();
  const first = store.mutate('board.card.move', { id: 'a', column: 'doing' });
  const second = store.mutate('board.card.move', { id: 'b', column: 'doing' });
  release();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(server.log.filter((entry) => entry.action === 'board.card.move').length, 1, 'only the first write reached the server');
  assert.equal(store.getState().board.revision, 9);
  assert.deepEqual(store.getState().board.columns[0].cardIds, ['a', 'b']);
});

test('polling is skipped while a write is pending so it cannot undo the optimistic view', async () => {
  const server = fakeServer();
  const store = createBoardStore(server.call);
  await store.refresh();
  const release = server.hold();
  const write = store.mutate('board.card.move', { id: 'a', column: 'doing' });
  const reads = server.log.filter((entry) => entry.action === 'board.get').length;
  await store.refresh();
  assert.equal(server.log.filter((entry) => entry.action === 'board.get').length, reads, 'no read was issued');
  release();
  await write;
  await store.refresh();
  assert.deepEqual(store.getState().board.columns[1].cardIds, ['a']);
});

test('optimistic: false waits for the server (adds need the server-made id)', async () => {
  const server = fakeServer();
  const store = createBoardStore(server.call);
  await store.refresh();
  const release = server.hold();
  const edit = store.mutate('board.card.edit', { id: 'a', title: 'Changed' }, { optimistic: false });
  assert.equal(store.getState().board.cards.a.title, 'a', 'not patched locally');
  release();
  await edit;
  assert.equal(store.getState().board.cards.a.title, 'Changed');
});

test('a read-only board never sends writes', async () => {
  const server = fakeServer({ ...initial(), readOnly: true, error: 'Cannot read board: …' });
  const store = createBoardStore(server.call);
  await store.refresh();
  assert.equal(await store.mutate('board.card.move', { id: 'a', column: 'doing' }), false);
  assert.equal(server.log.some((entry) => entry.action === 'board.card.move'), false);
});

test('subscribers hear about every change and can unsubscribe', async () => {
  const server = fakeServer();
  const store = createBoardStore(server.call);
  let heard = 0;
  const stop = store.subscribe(() => { heard++; });
  await store.refresh();
  assert.ok(heard >= 1);
  const seen = heard;
  stop();
  await store.mutate('board.card.move', { id: 'a', column: 'doing' });
  assert.equal(heard, seen);
});

test('an add the board moved under is sent once more on the latest revision, so the new card is not lost (#855)', async () => {
  const server = fakeServer();
  const store = createBoardStore(server.call);
  await store.refresh();
  // The app itself (the daily plan) writes the board; the page has not read it yet.
  server.board = { ...server.board, revision: 5 };
  const ok = await store.mutate('board.card.add', { column: 'todo', title: '做 10 道概念辨析' }, { optimistic: false });
  assert.equal(ok, true);
  const adds = server.log.filter((entry) => entry.action === 'board.card.add');
  assert.deepEqual(adds.map((entry) => entry.args.revision), [1, 5], 'refused on the old revision, then sent on the one just read');
  const state = store.getState();
  assert.equal(state.conflict, false);
  assert.equal(state.error, '');
  assert.equal(state.board.revision, 6);
  assert.equal(Object.values(state.board.cards).filter((entry) => entry.title === '做 10 道概念辨析').length, 1, 'added exactly once');
});

test('an add refused twice in a row reports the conflict instead of retrying again', async () => {
  const server = fakeServer();
  const busy = async (action, args) => {
    const value = await server.call(action, args);
    if (action === 'board.get') server.board = { ...server.board, revision: server.board.revision + 1 }; // someone writes after every read
    return value;
  };
  const store = createBoardStore(busy);
  await store.refresh();
  const ok = await store.mutate('board.card.add', { column: 'todo', title: 'c' }, { optimistic: false });
  assert.equal(ok, false);
  assert.equal(server.log.filter((entry) => entry.action === 'board.card.add').length, 2, 'one retry, no loop');
  assert.equal(store.getState().conflict, true);
});

test('a move or an edit on a stale revision is still refused, never replayed on a board the learner has not seen', async () => {
  const server = fakeServer();
  const store = createBoardStore(server.call);
  await store.refresh();
  server.board = { ...server.board, revision: 5 };
  assert.equal(await store.mutate('board.card.edit', { id: 'a', title: 'Mine' }, { optimistic: false }), false);
  assert.equal(await store.mutate('board.card.edit', { id: 'a', revision: 1, title: 'Pinned' }, { optimistic: false }), false);
  assert.equal(await store.mutate('board.card.add', { column: 'todo', revision: 1, title: 'Pinned add' }, { optimistic: false }), false, 'a revision the caller pinned is kept');
  assert.equal(server.log.filter((entry) => entry.action !== 'board.get').length, 3, 'each write was sent once');
  assert.equal(server.board.cards.a.title, 'a');
});

test('a write queued behind a resent add is dropped, so the change that made the add stale is not overwritten unseen', async () => {
  const server = fakeServer();
  const heard = [];
  const store = createBoardStore(server.call, { onBoard: (board) => heard.push(board.revision) });
  await store.refresh();
  // Another writer renames card a; the page still shows the old board.
  server.board = { ...structuredClone(server.board), revision: 5 };
  server.board.cards.a.title = 'Theirs';
  const add = store.mutate('board.card.add', { column: 'todo', title: 'new' }, { optimistic: false });
  const edit = store.mutate('board.card.edit', { id: 'a', title: 'Mine' });
  assert.equal(await add, true, 'the add itself still lands');
  assert.equal(await edit, false);
  assert.equal(server.board.cards.a.title, 'Theirs');
  assert.deepEqual(server.log.filter((entry) => entry.action !== 'board.get').map((entry) => `${entry.action}@${entry.args.revision}`),
    ['board.card.add@1', 'board.card.add@5'], 'the edit was never sent');
  assert.equal(store.getState().conflict, true, 'the page says the board changed');
  assert.equal(store.getState().board.cards.a.title, 'Theirs', 'and shows the latest board');
  assert.ok(heard.includes(5), 'the warm cache heard the board read for the resend');
});

test('a time-log add is not resent: replaying an undo could log the same minutes twice', async () => {
  const server = fakeServer();
  const store = createBoardStore(server.call);
  await store.refresh();
  server.board = { ...server.board, revision: 5 };
  assert.equal(await store.mutate('board.timeLog.add', { cardId: 'a', minutes: 25 }, { optimistic: false }), false);
  assert.equal(server.log.filter((entry) => entry.action === 'board.timeLog.add').length, 1);
  assert.equal(store.getState().conflict, true);
});
