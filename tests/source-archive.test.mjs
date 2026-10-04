import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { Store } from '../lib/store.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'source-archive-'));
  const runtime = createStudyRuntime(root);
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });
  const call = (action, args = {}) => runtime.call(action, args);
  await call('source.add', { id: 'a', title: 'A', text: 'Retained evidence A' });
  await call('source.add', { id: 'b', title: 'B', text: 'Retained evidence B' });
  return { call, root };
}

test('deletion requires prior archive and explicit permanent confirmation; restore retains evidence', async t => {
  const { call, root } = await fixture(t);
  await assert.rejects(call('source.remove', { id: 'a', confirm: true }), /Archive/);
  await call('source.archive', { id: 'a', archived: true });
  assert.equal((await new Store(root).read()).sources.find(source => source.id === 'a').archived, true);
  await assert.rejects(call('source.remove', { id: 'a' }), /Confirm/);
  assert.equal((await call('source.get', { id: 'a' })).text, 'Retained evidence A');
  assert.equal((await call('source.list')).sources.some(source => source.id === 'a'), false);
  assert.equal((await call('materials.document.list')).documents.some(document => document.sourceIds.includes('a')), false);
  assert.equal((await call('materials.document.list', { includeArchived: true })).documents.some(document => document.sourceIds.includes('a')), true);
  assert.equal((await call('source.list', { includeArchived: true })).sources.find(source => source.id === 'a').archived, true);
  await call('source.archive', { id: 'a', archived: false });
  assert.equal((await call('source.list')).sources.some(source => source.id === 'a'), true);
  await call('source.archive', { id: 'a', archived: true });
  await call('source.remove', { id: 'a', confirm: true });
  assert.equal((await call('export')).sources.some(source => source.id === 'a'), false);
});

test('bulk deletion checks every source before removing any evidence', async t => {
  const { call } = await fixture(t);
  await call('source.archive', { id: 'a', archived: true });
  await assert.rejects(call('source.remove', { sourceIds: ['a', 'b'], confirm: true }), /Archive/);
  assert.equal((await call('export')).sources.length, 2);
  await call('source.archive', { id: 'b', archived: true });
  await call('source.remove', { sourceIds: ['a', 'b'], confirm: true });
  assert.equal((await call('export')).sources.length, 0);
});

test('archive expands a PDF page to its entire document and preserves identities', async t => {
  const { archiveSources } = await import('../lib/source-archive.js');
  const sources = [1, 2].map(page => ({ id: `p${page}`, title: `Book · p. ${page}`, text: `Page ${page}`, document: { id: 'book', page } }));
  const state = { sources, documents: [] };
  archiveSources(state, { id: 'p1', archived: true });
  assert.deepEqual(sources.map(source => source.archived), [true, true]);
  assert.equal(groupSourcesByDocument(sources)[0].archived, true);
  archiveSources(state, { id: 'p2', archived: false });
  assert.deepEqual(sources.map(source => source.archived), [false, false]);
  assert.deepEqual(sources.map(source => source.text), ['Page 1', 'Page 2']);
});

test('archiving cited evidence preserves questions; a referenced member blocks the entire bulk delete', async t => {
  const { call, root } = await fixture(t);
  await new Store(root).update(state => {
    state.decks.push({ id: 'deck', title: 'Retained questions', cards: [{ id: 'q', kind: 'flashcard', prompt: 'Question', answer: 'Answer', citations: [{ sourceId: 'b', quote: 'Retained evidence B' }] }] });
  });
  const before = (await call('export')).decks;
  await call('source.archive', { sourceIds: ['a', 'b'], archived: true });
  assert.deepEqual((await call('export')).decks, before);
  await assert.rejects(call('source.remove', { sourceIds: ['a', 'b'], confirm: true }), /referenced/);
  assert.equal((await call('export')).sources.length, 2);
  await call('source.archive', { id: 'b', archived: false });
  assert.equal((await call('source.get', { id: 'b' })).text, 'Retained evidence B');
});

test('archiving a versioned document covers retained revisions and refresh stays archived', async t => {
  const { call } = await fixture(t);
  const first = await call('materials.document.import', { filename: 'notes.txt', format: 'txt', dataBase64: Buffer.from('First revision').toString('base64') });
  await call('source.archive', { id: first.sourceIds[0], archived: true });
  const next = await call('materials.document.import', { documentId: first.documentId, filename: 'notes.txt', format: 'txt', dataBase64: Buffer.from('Second revision').toString('base64') });
  assert.equal((await call('source.get', { id: next.sourceIds[0] })).archived, true);
  await call('source.archive', { id: next.sourceIds[0], archived: false });
  const sources = (await call('export')).sources;
  assert.equal(sources.find(source => source.id === first.sourceIds[0]).archived, false);
  assert.equal(sources.find(source => source.id === next.sourceIds[0]).archived, false);
});
