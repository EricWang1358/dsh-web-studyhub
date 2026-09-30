import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.js';
import { StudyService } from '../lib/service.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';

test('the full backup restores original documents, versions and card backlinks into a fresh library', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-portable-original-'));
  const target = await mkdtemp(join(tmpdir(), 'study-portable-restored-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); });
  const store = new Store(root);
  store.registerCollection('documents');
  const { handlers: materials } = createMaterialsOperations({ root, ...store.scoped(['sources', 'documents']) });
  const bytes = Buffer.from('# Original\n\nArchitecture principles guide design and evolution.\n');
  const imported = await materials['materials.document.import']({ filename: 'original.md', dataBase64: bytes.toString('base64') });
  const selected = await materials['materials.selection.resolve']({ documentId: imported.documentId, revision: imported.revision, quote: 'Architecture principles guide design and evolution.' });
  await store.update(state => { state.decks.push({ id: 'd', title: 'Existing', cards: [{ id: 'c', selections: [selected.selection], explanation: 'Preserved', review: { repetitions: 5 }, future: 9 }] }); });
  const backup = await new StudyService(root).call('export');
  assert.equal(backup.portableMaterials.attachments.length, 1);
  await new StudyService(target).call('restore', { state: JSON.parse(JSON.stringify(backup)) });
  const restored = new Store(target);
  restored.registerCollection('documents');
  const { handlers: api } = createMaterialsOperations({ root: target, ...restored.scoped(['sources', 'documents']), bankCards: async () => (await restored.read()).decks.flatMap(deck => deck.cards.map(card => ({ ...card, deckId: deck.id }))) });
  const document = await api['materials.document.get']({ documentId: imported.documentId });
  assert.equal(document.originalAvailable, true);
  assert.deepEqual(await readFile(document.preview.path), bytes);
  assert.equal(document.revision, imported.revision);
  assert.deepEqual((await restored.read()).decks[0].cards[0].review, { repetitions: 5 });
  assert.equal((await restored.read()).portableMaterials, undefined, 'encoded backup bytes are not persisted as domain state');
  const links = await api['materials.links.list']({ documentId: imported.documentId });
  assert.equal(links.length ?? links.links?.length, 1);
});

test('an incomplete portable backup cannot replace the destination library', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-portable-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  await service.call('source.add', { title: 'Existing', text: 'Retain this content.' });
  const before = await service.call('export');
  const malformed = { ...before, documents: [{ id: 'd', versions: [{ attachment: { path: 'attachments/materials/missing.md' } }] }],
    portableMaterials: { format: 'study-materials-backup/v1', attachments: [] } };
  await assert.rejects(service.call('restore', { state: malformed }), /missing a material original/);
  assert.deepEqual(await service.call('export'), before);
});
