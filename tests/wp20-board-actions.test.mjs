/* WP20 · board.js: checklist validation and migration, title validation,
   restore at an exact position and exact undelete. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardAction } from '../lib/board.js';

async function isolated(run) {
  const home = await mkdtemp(join(tmpdir(), 'study-board-wp20-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try { await run(home); }
  finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}
const stepper = async () => {
  let board = await boardAction('board.get');
  return { get board() { return board; }, async run(action, args, cwd) { return board = await boardAction(action, { ...args, revision: board.revision }, cwd); } };
};

test('an old board without checklists loads unchanged and stays editable', () => isolated(async (home) => {
  await mkdir(join(home, 'study'), { recursive: true });
  const old = { version: 1, revision: 3, columns: [{ id: 'todo', title: '待办', done: false, cardIds: ['a'] }, { id: 'done', title: '已完成', done: true, cardIds: [] }],
    cards: { a: { id: 'a', title: 'Old card', note: 'n', due: '', labels: ['x'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', origin: { workspace: '/w', workspaceTitle: 'w' } } }, archived: [] };
  const path = join(home, 'study', 'board.json');
  await writeFile(path, JSON.stringify(old));
  const loaded = await boardAction('board.get');
  assert.equal(loaded.readOnly, undefined, 'a pre-checklist board is not read-only');
  assert.deepEqual(loaded, old, 'reading never rewrites or reshapes the stored board');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1);
  const edited = await boardAction('board.card.edit', { revision: 3, id: 'a', checklist: [{ text: 'first' }] });
  assert.equal(edited.cards.a.checklist.length, 1);
  assert.equal(edited.cards.a.checklist[0].done, false);
  assert.match(edited.cards.a.checklist[0].id, /^[a-zA-Z0-9_-]+$/, 'items get ids');
}));

test('checklist items are validated: at most 50, text 1-200 characters, boolean done, unique ids', () => isolated(async () => {
  const s = await stepper();
  await s.run('board.card.add', { title: 'With list', checklist: [{ id: 'one', text: 'First', done: true }, { text: '  Second  ' }] });
  const id = s.board.columns[0].cardIds[0];
  assert.deepEqual(s.board.cards[id].checklist.map((item) => [item.id === 'one', item.text, item.done]), [[true, 'First', true], [false, 'Second', false]]);
  const fifty = Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, text: `item ${i}`, done: false }));
  await s.run('board.card.edit', { id, checklist: fifty });
  assert.equal(s.board.cards[id].checklist.length, 50);
  const before = JSON.stringify(s.board);
  const invalid = [
    [...fifty, { id: 'extra', text: 'one too many', done: false }],
    [{ id: 'a', text: '', done: false }],
    [{ id: 'a', text: '   ', done: false }],
    [{ id: 'a', text: 'x'.repeat(201), done: false }],
    [{ id: 'a', text: 'ok', done: 'yes' }],
    [{ id: 'a', text: 'ok' }, { id: 'a', text: 'dup' }],
    [{ id: '__proto__', text: 'unsafe' }],
    'not a list',
    [null],
  ];
  for (const checklist of invalid) {
    await assert.rejects(boardAction('board.card.edit', { revision: s.board.revision, id, checklist }), /checklist|text|done|id/i);
    assert.equal(JSON.stringify(await boardAction('board.get')), before, 'rejected edits change nothing');
  }
  const exact = await s.run('board.card.edit', { id, checklist: [{ id: 'a', text: 'x'.repeat(200), done: true }] });
  assert.equal(exact.cards[id].checklist[0].text.length, 200);
  await s.run('board.card.edit', { id, checklist: [] });
  assert.deepEqual(s.board.cards[id].checklist, []);
}));

test('titles that are empty or only punctuation are rejected on add and edit, but old cards still load', () => isolated(async (home) => {
  const s = await stepper();
  for (const title of ['?', '？？', '...', ' ', '']) await assert.rejects(boardAction('board.card.add', { revision: 0, title }), /title/);
  await s.run('board.card.add', { title: 'Real task' });
  const id = s.board.columns[0].cardIds[0];
  await assert.rejects(boardAction('board.card.edit', { revision: 1, id, title: '?!' }), /title/);
  // A board stored before the rule may hold such a title; it stays readable and editable.
  const path = join(home, 'study', 'board.json');
  const stored = JSON.parse(await readFile(path, 'utf8'));
  stored.cards[id].title = '?';
  await writeFile(path, JSON.stringify(stored));
  const loaded = await boardAction('board.get');
  assert.equal(loaded.readOnly, undefined);
  assert.equal(loaded.cards[id].title, '?');
  const fixed = await boardAction('board.card.edit', { revision: loaded.revision, id, title: 'Fixed' });
  assert.equal(fixed.cards[id].title, 'Fixed');
}));

test('restore can put an archived card back at its exact position', () => isolated(async () => {
  const s = await stepper();
  for (const title of ['A', 'B', 'C']) await s.run('board.card.add', { title });
  const [a, b, c] = s.board.columns[0].cardIds;
  await s.run('board.card.archive', { id: b });
  assert.deepEqual(s.board.columns[0].cardIds, [a, c]);
  await s.run('board.card.restore', { id: b, column: 'todo', index: 1 });
  assert.deepEqual(s.board.columns[0].cardIds, [a, b, c]);
  await s.run('board.card.archive', { id: a });
  await s.run('board.card.restore', { id: a });
  assert.deepEqual(s.board.columns[0].cardIds, [b, c, a], 'without an index it still appends');
  await s.run('board.card.archive', { id: c });
  await assert.rejects(boardAction('board.card.restore', { revision: s.board.revision, id: c, column: 'todo', index: 9 }), /index/);
}));

test('undelete brings back exactly the card that was removed', () => isolated(async () => {
  const s = await stepper();
  await s.run('board.card.add', { title: 'Keep me', note: '**n**', due: '2030-01-02', labels: ['x'], checklist: [{ id: 'k1', text: 'step', done: true }] }, 'C:\\courses\\one');
  await s.run('board.card.add', { title: 'Neighbour' });
  const [id, other] = s.board.columns[0].cardIds;
  const snapshot = structuredClone(s.board.cards[id]);
  await s.run('board.card.remove', { id });
  assert.equal(s.board.cards[id], undefined);
  await s.run('board.card.undelete', { card: snapshot, column: 'todo', index: 0 });
  assert.deepEqual(s.board.columns[0].cardIds, [id, other]);
  assert.deepEqual(s.board.cards[id], snapshot, 'origin, timestamps and checklist survive the round trip');
  await assert.rejects(boardAction('board.card.undelete', { revision: s.board.revision, card: snapshot, column: 'todo' }), /exists|duplicate/i);
  await assert.rejects(boardAction('board.card.undelete', { revision: s.board.revision, card: { ...snapshot, id: 'new1', title: '' }, column: 'todo' }), /title/);
  await assert.rejects(boardAction('board.card.undelete', { revision: s.board.revision, card: { ...snapshot, id: 'new2', studyRef: { root: 'relative', kind: 'course', course: 'x' } }, column: 'todo' }), /root|reference/i);
}));

test('add accepts a checklist and keeps studyRef validation', () => isolated(async () => {
  const s = await stepper();
  const ref = { root: 'C:\\study\\lib', kind: 'course', course: 'Platform Engineering' };
  await s.run('board.card.add', { title: 'Linked', studyRef: ref, labels: ['a', 'b'], due: '2030-05-06' });
  const id = s.board.columns[0].cardIds[0];
  assert.deepEqual(s.board.cards[id].studyRef, ref);
  assert.equal(s.board.cards[id].due, '2030-05-06');
  assert.equal(s.board.cards[id].checklist, undefined, 'cards without a checklist stay lean');
}));
