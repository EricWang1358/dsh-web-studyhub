import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, emptyState } from '../lib/store.js';

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-extension-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new Store(root) };
}

test('an absent plugin retains its collection shards and unknown nested user values', async t => {
  const { root, store } = await library(t);
  store.registerCollection('documents', { mode: 'item' });
  store.registerCollection('extension.events', { mode: 'chunk', chunkSize: 2 });
  const document = { id: 'd', versions: [{ revision: 'a', future: { selected: true } }] };
  await store.update(s => {
    s.documents = [document];
    s['extension.events'] = [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }];
    s.futureConfiguration = { user: 'retained' };
    s.decks.push({ id: 'old', cards: [{ id: 'c', review: { due: '2030-01-01', interval: 31 }, unknown: 7 }] });
  });
  const absent = new Store(root);
  await absent.update(s => { s.settings.newSetting = true; }, { settings: true });
  const state = await absent.read();
  assert.deepEqual(state.documents, [document]);
  assert.deepEqual(state['extension.events'], [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]);
  assert.deepEqual(state.futureConfiguration, { user: 'retained' });
  assert.deepEqual(state.decks[0].cards[0], { id: 'c', review: { due: '2030-01-01', interval: 31 }, unknown: 7 });
  const manifest = JSON.parse(await readFile(absent.path, 'utf8'));
  assert.equal(manifest.collections.definitions['extension.events'].mode, 'chunk');
  assert.equal(manifest.shards['extension.events'].length, 2);
});

test('unknown collection shards from an older manifest survive a harmless write', async t => {
  const { root, store } = await library(t);
  await mkdir(join(root, 'shards', 'future'), { recursive: true });
  await writeFile(join(root, 'shards', 'future', 'x.json'), JSON.stringify({ id: 'x', extra: [1, 2] }));
  await writeFile(store.path, JSON.stringify({ ...emptyState(), format: 'study-sharded', shards: { futureRecords: ['future/x.json'] } }));
  await store.update(s => { s.settings.locale = 'en'; });
  assert.deepEqual((await store.read()).futureRecords, [{ id: 'x', extra: [1, 2] }]);
});

test('v3 scalar extension arrays and a user collections field survive discovery and writes', async t => {
  const { root, store } = await library(t);
  const extension = [{ id: 'keep-me', unknown: 7 }];
  const userCollections = { category: ['user value'], future: true };
  await writeFile(store.path, JSON.stringify({ ...emptyState(), format: 'study-sharded',
    extensionRecords: extension, collections: userCollections, shards: {} }));
  assert.deepEqual((await store.read()).extensionRecords, extension);
  assert.deepEqual((await store.read()).collections, userCollections);
  await store.scoped(['settings']).update(s => { s.settings.locale = 'zh'; });
  assert.deepEqual((await new Store(root).read()).extensionRecords, extension);
  assert.deepEqual((await new Store(root).read()).collections, userCollections);
});

test('scoped writes isolate ownership, detach reads and preserve concurrent domain commits', async t => {
  const { store } = await library(t);
  store.registerCollection('documents');
  const materials = store.scoped(['sources', 'documents']);
  const bank = store.scoped(['decks']);
  const own = await materials.read();
  assert.equal(own.decks, undefined);
  own.sources.push({ id: 'leak' });
  assert.deepEqual((await materials.read()).sources, []);
  await Promise.all([
    materials.update(s => { s.documents.push({ id: 'd' }); s.decks = [{ id: 'bad' }]; }),
    bank.update(s => { s.decks.push({ id: 'good', cards: [] }); }),
  ]);
  assert.deepEqual((await store.read()).decks, [{ id: 'good', cards: [] }]);
  assert.deepEqual((await store.read()).documents, [{ id: 'd' }]);
  await assert.rejects(materials.update(s => { s.documents = {}; }), /expected an array/);
  assert.deepEqual((await store.read()).documents, [{ id: 'd' }]);
});

test('v1 upgrades retain additive extension arrays and create an original backup', async t => {
  const { root, store } = await library(t);
  await writeFile(store.path, JSON.stringify({ version: 1, settings: {}, sources: [], decks: [], extensionRecords: [{ id: 'old', missingNewFields: true }] }));
  await store.scoped(['decks']).update(s => { s.decks.push({ id: 'new', cards: [] }); });
  assert.deepEqual((await new Store(root).read()).extensionRecords, [{ id: 'old', missingNewFields: true }]);
});

test('invalid persisted chunk sizes reject a write without replacing the committed library', async t => {
  const { store } = await library(t);
  const manifest = { ...emptyState(), format: 'study-sharded', shards: {},
    collections: { format: 'study-collections/v1', definitions: { pluginEvents: { mode: 'chunk', chunkSize: -1 } } } };
  const text = JSON.stringify(manifest);
  await writeFile(store.path, text);
  await assert.rejects(store.update(state => { state.pluginEvents = [{ id: 'e' }]; }), /Invalid collection chunk size/);
  assert.equal(await readFile(store.path, 'utf8'), text);
});
