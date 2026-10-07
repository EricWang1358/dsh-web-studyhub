/* The board (board.json) and the notebook registry (notebooks.json) live in one folder, $DSH_HOME/study, behind one lock. Writers of one process take turns in the library lock's queue
   (lib/store-lock.js) instead of fighting for the file lock: many of both at once all succeed, nothing is lost. Fakes only; a private DSH_HOME. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardAction } from '../lib/board.js';
import { publishNotebook } from '../lib/notebooks.js';

async function isolated(t) {
  const home = await mkdtemp(join(tmpdir(), 'study-home-lock-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return home;
}

test('board edits and notebook publications at once all succeed and every one is kept', async t => {
  const home = await isolated(t);
  // A board edit names the revision it read; one that lost the race to another edit reads again and retries (that is the board's own protocol, not the lock's).
  const add = async index => {
    for (;;) {
      const { revision } = await boardAction('board.get');
      try { return await boardAction('board.card.add', { revision, title: `Card ${index}` }, join(home, `workspace-${index % 3}`)); }
      catch (error) { if (!/revision conflict/.test(error.message)) throw error; }
    }
  };
  const cards = Array.from({ length: 30 }, (_, index) => add(index));
  const books = Array.from({ length: 30 }, (_, index) => publishNotebook(join(home, `book-${index}`), join(home, `library-${index}`)));
  const settled = await Promise.allSettled([...cards, ...books]);
  assert.deepEqual(settled.filter(item => item.status === 'rejected').map(item => item.reason?.message), [], 'no write was refused for the lock');
  const board = JSON.parse(await readFile(join(home, 'study', 'board.json'), 'utf8'));
  assert.equal(Object.keys(board.cards).length, 30, 'every card is on the board');
  assert.equal(board.revision, 30, 'one revision per edit');
});

test('the notebook registry keeps every publication of a burst', async t => {
  await isolated(t);
  await Promise.all(Array.from({ length: 40 }, (_, index) => publishNotebook(join(tmpdir(), `book-${index}`), join(tmpdir(), `library-${index}`))));
  const registry = JSON.parse(await readFile(join(process.env.DSH_HOME, 'study', 'notebooks.json'), 'utf8'));
  assert.equal(registry.notebooks.length, 40, 'every publication is in the registry');
});
