import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, emptyState } from '../lib/store.js';

test('first scoped commits detach retained nested values on both empty and version-one libraries', async t => {
  for (const legacy of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'study-first-projection-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    if (legacy) await writeFile(join(root, 'study-workspace.json'), JSON.stringify({ ...emptyState(), version: 1 }));
    const store = new Store(root);
    let retained;
    await store.scoped(['decks']).update(state => {
      retained = { id: 'saved', cards: [{ id: 'card', answer: 'committed' }] };
      state.decks.push(retained);
    });
    retained.cards[0].answer = 'changed after commit';
    assert.equal((await store.read()).decks[0].cards[0].answer, 'committed', legacy ? 'migration cache' : 'initial cache');
    await store.scoped(['settings']).update(state => { state.settings.first_interval_days = 7; });
    assert.equal((await new Store(root).read()).decks[0].cards[0].answer, 'committed');
  }
});

test('scoped writes skip unrelated shard parsing and preserve committed data despite cached reader mutation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-projection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const detach = store.registerCollection('extensionRecords', { mode: 'chunk', chunkSize: 2 });
  await store.update(state => {
    state.decks = [{ id: 'deck', cards: [{ id: 'card', answer: 'UNRELATED_COMMITTED_CARD' }] }];
    state.extensionRecords = [{ id: 'plugin-record', value: 7 }];
  });
  detach();
  const before = JSON.parse(await readFile(store.path, 'utf8'));
  (await store.read()).decks[0].cards[0].answer = 'poisoned reader';
  let unrelatedParses = 0;
  const parse = JSON.parse;
  JSON.parse = (text, ...args) => {
    if (text.includes('UNRELATED_COMMITTED_CARD')) unrelatedParses++;
    return parse(text, ...args);
  };
  try {
    await store.scoped(['settings']).update(state => { state.settings.first_interval_days = 9; });
  } finally { JSON.parse = parse; }
  assert.equal(unrelatedParses, 0, 'a settings transaction must not decode any deck shard');
  const after = JSON.parse(await readFile(store.path, 'utf8'));
  assert.deepEqual(after.shards.decks, before.shards.decks);
  assert.deepEqual(after.shards.extensionRecords, before.shards.extensionRecords);
  assert.equal((await store.read()).decks[0].cards[0].answer, 'UNRELATED_COMMITTED_CARD');
  assert.deepEqual((await store.read()).extensionRecords, [{ id: 'plugin-record', value: 7 }]);
});

test('scoped transactions roll back failures and detach retained mutation objects from later reads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-projection-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.update(state => { state.decks = [{ id: 'deck', cards: [] }]; });
  const scoped = store.scoped(['decks']);
  const before = await readFile(store.path, 'utf8');
  await assert.rejects(scoped.update(state => { state.decks[0].cards.push({ id: 'failed' }); throw new Error('rollback'); }), /rollback/);
  assert.equal(await readFile(store.path, 'utf8'), before);
  let retained;
  const returned = await scoped.update(state => { retained = state.decks; state.decks[0].cards.push({ id: 'saved' }); return state.decks; });
  retained[0].cards[0].id = 'retained mutation';
  returned[0].cards[0].id = 'returned mutation';
  assert.equal((await store.read()).decks[0].cards[0].id, 'saved');
  const view = await scoped.read();
  view.decks[0].cards[0].id = 'scoped reader mutation';
  assert.equal((await scoped.read()).decks[0].cards[0].id, 'saved');
});

test('scoped writes migrate old libraries and serialize concurrent owners without losing either field', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-projection-compat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = { ...emptyState(), version: 1, decks: [{ id: 'old-deck', cards: [{ id: 'old-card' }] }] };
  delete legacy.workflowTemplates;
  delete legacy.workflowSessions;
  await writeFile(join(root, 'study-workspace.json'), JSON.stringify(legacy));
  const first = new Store(root), second = new Store(root);
  await first.scoped(['settings']).update(state => { state.settings.first_interval_days = 4; });
  assert.equal((await second.read()).decks[0].cards[0].id, 'old-card');
  assert.deepEqual((await second.read()).workflowTemplates, []);
  await Promise.all([
    first.scoped(['settings']).update(state => { state.settings.first_interval_days = 8; }),
    second.scoped(['decks']).update(state => { state.decks[0].cards.push({ id: 'new-card' }); }),
  ]);
  const committed = await new Store(root).read();
  assert.equal(committed.settings.first_interval_days, 8);
  assert.deepEqual(committed.decks[0].cards.map(card => card.id), ['old-card', 'new-card']);
  assert.equal(committed.revision, 3);
});

test('a scoped update still rejects unrelated corrupt shards before committing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-projection-corrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.update(state => { state.decks = [{ id: 'deck', cards: [] }]; });
  const manifest = JSON.parse(await readFile(store.path, 'utf8'));
  manifest.shards.decks[0] = 'decks/corrupt.json';
  await writeFile(join(root, 'shards', 'decks', 'corrupt.json'), '{');
  await writeFile(store.path, JSON.stringify(manifest));
  const before = await readFile(store.path, 'utf8');
  await assert.rejects(new Store(root).scoped(['settings']).update(state => { state.settings.first_interval_days = 10; }), /损坏文件/);
  assert.equal(await readFile(store.path, 'utf8'), before);
});
