import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { Store } from '../lib/store.js';

async function attachmentFiles(root) {
  try { return (await readdir(join(root, 'attachments', 'materials'))).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

test('permanently deleting a material prunes its orphan document shard, disk attachment, and backup payload', async t => {
  const root = await mkdtemp(join(tmpdir(), 'source-remove-gc-'));
  const runtime = createStudyRuntime(root);
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });

  const bytes = Buffer.from('# Lecture 1\n\nThermodynamics first law and internal energy.\n');
  const imported = await runtime.call('materials.document.import', {
    filename: 'lecture-1.md',
    dataBase64: bytes.toString('base64'),
  });
  const selected = await runtime.call('materials.selection.resolve', {
    documentId: imported.documentId,
    revision: imported.revision,
    quote: 'Thermodynamics first law',
  });
  await runtime.call('materials.annotation.save', {
    documentId: imported.documentId,
    revision: imported.revision,
    selection: selected.selection,
    nodes: [{ id: 'note-1', question: 'What is covered?', answer: 'Important exam concept' }],
  });
  assert.equal((await attachmentFiles(root)).length, 1);
  assert.equal((await runtime.call('export')).portableMaterials.attachments.length, 1);

  await runtime.call('source.archive', { sourceIds: imported.sourceIds, archived: true });
  await runtime.call('source.remove', { sourceIds: imported.sourceIds, confirm: true });

  const state = await new Store(root).read();
  assert.deepEqual(state.sources, []);
  assert.deepEqual(state.documents || [], []);
  assert.deepEqual(await attachmentFiles(root), []);
  const backup = await runtime.call('export');
  assert.equal(backup.portableMaterials, undefined, 'deleted material attachments must not leak into portable backups');
});

test('deleting one document preserves a content-addressed original still shared by another document', async t => {
  const root = await mkdtemp(join(tmpdir(), 'source-remove-shared-'));
  const runtime = createStudyRuntime(root);
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });

  const sharedBytes = Buffer.from('# Shared\n\nIdentical content across two logical documents.\n');
  const first = await runtime.call('materials.document.import', {
    filename: 'copy-a.md',
    dataBase64: sharedBytes.toString('base64'),
  });
  const secondSeed = await runtime.call('materials.document.import', {
    filename: 'copy-b.md',
    dataBase64: Buffer.from('# Initial B\n\nDifferent seed bytes.\n').toString('base64'),
  });
  const second = await runtime.call('materials.document.attach', {
    documentId: secondSeed.documentId,
    filename: 'copy-b.md',
    dataBase64: sharedBytes.toString('base64'),
  });
  assert.equal((await attachmentFiles(root)).length, 2);

  await runtime.call('source.archive', { sourceIds: first.sourceIds, archived: true });
  await runtime.call('source.remove', { sourceIds: first.sourceIds, confirm: true });

  assert.equal((await attachmentFiles(root)).length, 2, 'shared file and B seed revision remain');
  await runtime.call('source.archive', { sourceIds: secondSeed.sourceIds, archived: true });
  await runtime.call('source.remove', { sourceIds: secondSeed.sourceIds, confirm: true });
  assert.equal((await attachmentFiles(root)).length, 1, 'unreferenced seed revision is reclaimed while shared current file remains');

  const backup = await runtime.call('export');
  assert.equal(backup.portableMaterials.attachments.length, 1);
  const kept = await runtime.call('materials.document.get', { documentId: second.documentId });
  assert.equal(kept.originalAvailable, true);
});

test('selection-only card references block deletion and unrelated empty-projection documents stay untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'source-remove-edges-'));
  const store = new Store(root);
  store.registerCollection('documents');
  const runtime = createStudyRuntime(root);
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); });

  const cited = await runtime.call('materials.document.import', {
    filename: 'cited.md',
    dataBase64: Buffer.from('# Cited\n\nSelection linked passage.\n').toString('base64'),
  });
  const resolved = await runtime.call('materials.selection.resolve', {
    documentId: cited.documentId,
    revision: cited.revision,
    quote: 'Selection linked passage.',
  });
  const disposable = await runtime.call('materials.document.import', {
    filename: 'disposable.md',
    dataBase64: Buffer.from('# Disposable\n\nTemporary reading note.\n').toString('base64'),
  });
  await store.update(state => {
    state.decks.push({ id: 'deck-sel', title: 'Selection deck', cards: [{ id: 'c1', kind: 'flashcard', prompt: 'Q', answer: 'A', selections: [resolved.selection] }] });
    state.documents.push({ id: 'document-scanned-stub', format: 'pdf', filename: 'scan.pdf', title: 'Scan', currentRevision: 'rev-scan', versions: [{ revision: 'rev-scan', sourceIds: [], importedAt: new Date().toISOString() }] });
  });

  await runtime.call('source.archive', { sourceIds: cited.sourceIds, archived: true });
  await assert.rejects(runtime.call('source.remove', { sourceIds: cited.sourceIds, confirm: true }), /referenced/);

  await runtime.call('source.archive', { sourceIds: disposable.sourceIds, archived: true });
  await runtime.call('source.remove', { sourceIds: disposable.sourceIds, confirm: true });

  const after = await store.read();
  assert.ok(after.documents.some(doc => doc.id === 'document-scanned-stub'), 'untouched empty-source stub document is preserved');
  assert.ok(!after.documents.some(doc => doc.id === disposable.documentId), 'deleted document is removed');
});
