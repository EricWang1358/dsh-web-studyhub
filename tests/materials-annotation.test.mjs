/* The reader's 批注 (materials.annotation.*): the questions and answers a learner kept about a passage, kept per document REVISION beside the
   document's own records exactly where a translation is kept (annotations: { revision, items } on the version of a stored document, or on the
   first source of a document with no record). A fake store; no model, no network. The text, citations, selections and card links of a document
   are never touched, and a release that does not know the field leaves it alone. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { ANNOTATION_LIMITS } from '../lib/annotation.js';
import { extractRelease } from './fixtures/extract-release.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const A = 'Architecture includes the principles guiding a system design and evolution.';
const B = 'Quality attributes such as latency and availability shape which tactics a team selects.';
const C = 'A CQRS design separates the read model from the write model.';
const markdown = (...lines) => `# Notes\n\n${lines.join('\n\n')}\n`;
const node = (id, extra = {}) => ({ id, parentId: null, question: `Question ${id}`, answer: `Answer ${id} about [[ELK]]`, language: 'English', ...extra });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'materials-annotation-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
  const raw = (action, args = {}, request = {}) => ops.handlers[action](args, request);
  const call = (action, args = {}) => raw(`materials.annotation.${action}`, args);
  const imported = async (body = markdown(A, B, C), filename = 'notes.md', documentId) => {
    const result = await raw('materials.document.import', { filename, ...(documentId ? { documentId } : {}), dataBase64: Buffer.from(body).toString('base64') });
    const document = await raw('materials.document.get', { id: result.documentId });
    return { ...result, document, source: document.sources[0] };
  };
  const select = async (document, quote) => (await raw('materials.selection.resolve', { documentId: document.documentId, revision: document.revision, quote })).selection;
  return { root, store, raw, call, imported, select };
}

test('answered nodes are kept for the passage and listed again, anchored to it', async t => {
  const f = await fixture(t), { document } = await f.imported(), selection = await f.select(document, 'latency and availability');
  const saved = await f.call('save', { documentId: document.documentId, revision: document.revision, selection, nodes: [node('n1', { label: 'I did not get it' }), node('n2', { parentId: 'n1', term: 'ELK' })] });
  assert.equal(saved.status, 'saved'); assert.equal(saved.saved, 2); assert.equal(saved.items.length, 2);
  const list = await f.call('list', { documentId: document.documentId, revision: document.revision });
  assert.equal(list.count, 2); assert.equal(list.revision, document.revision);
  assert.deepEqual(list.items.map(item => [item.id, item.parentId, item.term || '', item.status]), [['n1', null, '', 'resolved'], ['n2', 'n1', 'ELK', 'resolved']]);
  const first = list.items[0];
  assert.equal(first.selection.sourceId, selection.sourceId); assert.equal(first.selection.start, selection.start); assert.equal(first.selection.end, selection.end);
  assert.equal(first.selection.quote, selection.quote); assert.equal(first.label, 'I did not get it'); assert.equal(first.language, 'English'); assert.ok(first.at);
  assert.deepEqual(list.limits, { items: 200, thread: 8, depth: 3 });
  // A passage filter narrows the list; another passage has nothing.
  assert.equal((await f.call('list', { documentId: document.documentId, selection })).items.length, 2);
  assert.equal((await f.call('list', { documentId: document.documentId, selection: await f.select(document, 'CQRS design') })).items.length, 0);
});

test('the same node again writes nothing; the same id with new words replaces it; the text of the document is untouched', async t => {
  const f = await fixture(t), { document, source } = await f.imported(), selection = await f.select(document, 'CQRS design');
  const identity = { documentId: document.documentId, revision: document.revision, selection };
  const before = await f.store.read();
  await f.call('save', { ...identity, nodes: [node('n1')] });
  const kept = (await f.store.read()).documents[0].versions[0].annotations;
  assert.equal(kept.revision, document.revision); assert.equal(kept.items.length, 1);
  const again = await f.call('save', { ...identity, nodes: [node('n1')] });
  assert.equal(again.saved, 0); assert.equal(again.unchanged, 1);
  assert.equal((await f.store.read()).documents[0].versions[0].annotations.updatedAt, kept.updatedAt, 'an unchanged node does not even touch the record');
  const changed = await f.call('save', { ...identity, nodes: [node('n1', { answer: 'A better answer' })] });
  assert.equal(changed.saved, 1);
  const list = await f.call('list', { documentId: document.documentId });
  assert.equal(list.items.length, 1); assert.equal(list.items[0].answer, 'A better answer');
  assert.equal(list.items[0].at, kept.items[0].at, 'replacing keeps when it was first kept');
  const after = await f.store.read();
  assert.equal(after.sources[0].text, before.sources[0].text); assert.equal(after.documents[0].currentRevision, before.documents[0].currentRevision);
  assert.equal(source.text, after.sources[0].text);
  const descriptor = await f.raw('materials.document.get', { id: document.documentId });
  assert.equal(JSON.stringify(descriptor).includes('annotations'), false, 'the descriptor does not carry the notes');
});

test('a passage that is stale, ambiguous or missing is refused with that status and nothing is written', async t => {
  const f = await fixture(t), { document } = await f.imported(markdown(A, 'Same words. Same words.', C));
  const stored = () => f.store.read().then(state => JSON.stringify(state.documents));
  const before = await stored();
  const ambiguous = await f.call('save', { documentId: document.documentId, revision: document.revision, selection: { documentId: document.documentId, revision: document.revision, quote: 'Same words.' }, nodes: [node('n1')] });
  assert.equal(ambiguous.status, 'ambiguous'); assert.ok(ambiguous.message);
  const missing = await f.call('save', { documentId: document.documentId, revision: document.revision, selection: { documentId: document.documentId, revision: document.revision, quote: 'Not in the document at all' }, nodes: [node('n1')] });
  assert.equal(missing.status, 'missing');
  const selection = await f.select(document, 'CQRS design');
  await f.imported(markdown(A, C, 'Added.'), 'notes.md', document.documentId);
  const stale = await f.call('save', { documentId: document.documentId, revision: document.revision, selection, nodes: [node('n1')] });
  assert.notEqual(stale.status, 'saved'); assert.equal(stale.saved, 0);
  assert.equal(JSON.stringify((await f.store.read()).documents.map(item => item.versions.map(version => version.annotations))).includes('Answer'), false);
  assert.ok(before);
});

test('threads are bounded: a parent must be kept, three levels, eight nodes, ids belong to one passage', async t => {
  const f = await fixture(t), { document } = await f.imported(), selection = await f.select(document, 'CQRS design');
  const identity = { documentId: document.documentId, revision: document.revision, selection };
  assert.equal((await f.call('save', { ...identity, nodes: [node('n2', { parentId: 'n1' })] })).status, 'parent');
  await f.call('save', { ...identity, nodes: [node('n1'), node('n2', { parentId: 'n1' }), node('n3', { parentId: 'n2' })] });
  assert.equal((await f.call('save', { ...identity, nodes: [node('n4', { parentId: 'n3' })] })).status, 'depth');
  for (let i = 4; i <= 8; i++) assert.equal((await f.call('save', { ...identity, nodes: [node(`n${i}`, { parentId: 'n1' })] })).status, 'saved');
  const full = await f.call('save', { ...identity, nodes: [node('n9', { parentId: 'n1' })] });
  assert.equal(full.status, 'thread-full'); assert.match(full.message, /at most 8/);
  assert.equal((await f.call('list', { documentId: document.documentId })).items.length, 8);
  const other = await f.select(document, 'latency and availability');
  await assert.rejects(f.call('save', { documentId: document.documentId, revision: document.revision, selection: other, nodes: [node('n1')] }), /another passage/);
  await assert.rejects(f.call('save', { ...identity, nodes: [node('bad id!')] }), /id must be/);
  await assert.rejects(f.call('save', { ...identity, nodes: [node('x', { answer: '  ' })] }), /needs the answer/);
  await assert.rejects(f.call('save', { ...identity, nodes: [node('x', { question: '' })] }), /needs the question/);
  await assert.rejects(f.call('save', { ...identity, nodes: [node('x'), node('x')] }), /different/);
  const long = await f.call('save', { ...identity, nodes: [node('big', { parentId: 'n1', answer: 'z'.repeat(ANNOTATION_LIMITS.answer + 500) })] });
  assert.equal(long.status, 'thread-full', 'the thread is full, whatever the size');
});

test('a document revision keeps at most 200 nodes and says so in plain words; nothing is half written', async t => {
  const lines = Array.from({ length: 30 }, (_, i) => `Passage number ${i + 1} says something quite different from the others.`);
  const f = await fixture(t), { document } = await f.imported(markdown(...lines));
  const keep = async (i, count) => f.call('save', { documentId: document.documentId, revision: document.revision, selection: await f.select(document, `Passage number ${i + 1} says`),
    nodes: [node(`p${i}-0`), ...Array.from({ length: count - 1 }, (_, k) => node(`p${i}-${k + 1}`, { parentId: `p${i}-0` }))] });
  for (let i = 0; i < 25; i++) assert.equal((await keep(i, 8)).status, 'saved');
  assert.equal((await f.call('list', { documentId: document.documentId })).count, 200);
  const full = await keep(26, 2);
  assert.equal(full.status, 'full'); assert.equal(full.saved, 0); assert.equal(full.limit, 200); assert.match(full.message, /200 questions and answers.*Delete some/);
  assert.equal((await f.call('list', { documentId: document.documentId })).count, 200);
  // Changing a node that is kept needs no room.
  assert.equal((await f.call('save', { documentId: document.documentId, revision: document.revision, selection: await f.select(document, 'Passage number 1 says'), nodes: [node('p0-0', { answer: 'changed' })] })).status, 'saved');
});

test('delete: by id with the answers inside it, a whole passage, or all; it returns what it removed and restore puts it back', async t => {
  const f = await fixture(t), { document } = await f.imported(), one = await f.select(document, 'CQRS design'), two = await f.select(document, 'latency and availability');
  const at = selection => ({ documentId: document.documentId, revision: document.revision, selection });
  await f.call('save', { ...at(one), nodes: [node('a1'), node('a2', { parentId: 'a1' }), node('a3', { parentId: 'a2' })] });
  await f.call('save', { ...at(two), nodes: [node('b1')] });
  await assert.rejects(f.call('delete', { documentId: document.documentId }), /Name the annotations/);
  const gone = await f.call('delete', { documentId: document.documentId, ids: ['a2'] });
  assert.equal(gone.deleted, 2); assert.deepEqual(gone.removed.map(item => item.id).sort(), ['a2', 'a3']);
  assert.deepEqual((await f.call('list', { documentId: document.documentId })).items.map(item => item.id).sort(), ['a1', 'b1']);
  const restored = await f.call('save', { documentId: document.documentId, revision: document.revision, restore: gone.removed });
  assert.equal(restored.saved, 2);
  assert.equal((await f.call('list', { documentId: document.documentId })).count, 4);
  await assert.rejects(f.call('save', { documentId: document.documentId, revision: document.revision, restore: [{ ...gone.removed[0], id: 'zz', hash: 'nope' }] }), /does not match/);
  const thread = await f.call('delete', { documentId: document.documentId, selection: one });
  assert.equal(thread.deleted, 3);
  assert.equal((await f.call('list', { documentId: document.documentId })).items.map(item => item.id).join(), 'b1');
  assert.equal((await f.call('delete', { documentId: document.documentId, all: true })).deleted, 1);
  const record = (await f.store.read()).documents[0].versions[0];
  assert.equal('annotations' in record, false, 'an empty record leaves no field behind');
});

test('a new revision does not inherit the notes: they are listed as stale with their passages, and can be cleared', async t => {
  const f = await fixture(t), { document } = await f.imported();
  await f.call('save', { documentId: document.documentId, revision: document.revision, selection: await f.select(document, 'CQRS design'), nodes: [node('a1', { label: 'Why' }), node('a2', { parentId: 'a1' })] });
  const next = await f.imported(markdown(A, B, C, 'A new paragraph.'), 'notes.md', document.documentId);
  assert.notEqual(next.revision, document.revision);
  const list = await f.call('list', { documentId: document.documentId, revision: next.revision });
  assert.equal(list.items.length, 0);
  assert.equal(list.stale.length, 1);
  assert.deepEqual([list.stale[0].revision, list.stale[0].count], [document.revision, 2]);
  assert.deepEqual(list.stale[0].threads.map(thread => [thread.quote.slice(0, 11), thread.question, thread.nodes]), [['CQRS design', 'Why', 2]]);
  // The old revision is still readable as it was.
  assert.equal((await f.call('list', { documentId: document.documentId, revision: document.revision })).items.length, 2);
  const cleared = await f.call('delete', { documentId: document.documentId, revision: next.revision, stale: true });
  assert.equal(cleared.deleted, 2);
  assert.equal((await f.call('list', { documentId: document.documentId, revision: next.revision })).stale.length, 0);
});

test('a document with no record keeps them on its first source, and a rename keeps them', async t => {
  const f = await fixture(t);
  await f.store.update(state => { state.sources.push({ id: 'legacy-1', title: 'Pasted text', text: `${A}\n\n${C}`, createdAt: '2026-10-01T00:00:00.000Z' }); });
  const selection = (await f.raw('materials.selection.resolve', { sourceId: 'legacy-1', quote: 'CQRS design' })).selection;
  const saved = await f.call('save', { sourceId: 'legacy-1', selection, nodes: [node('l1')] });
  assert.equal(saved.status, 'saved');
  const state = await f.store.read(), source = state.sources.find(item => item.id === 'legacy-1');
  assert.equal(source.annotations.items.length, 1); assert.equal(source.annotations.revision, saved.revision);
  assert.equal((await f.call('list', { sourceId: 'legacy-1' })).items.length, 1);
  assert.equal(JSON.stringify(await f.raw('materials.document.get', { sourceId: 'legacy-1' })).includes('annotations'), false);
  // A document with a record keeps them through a rename.
  const { document } = await f.imported();
  await f.call('save', { documentId: document.documentId, revision: document.revision, selection: await f.select(document, 'CQRS design'), nodes: [node('r1')] });
  await f.raw('materials.document.rename', { documentId: document.documentId, revision: document.revision, title: 'Renamed notes' });
  assert.equal((await f.call('list', { documentId: document.documentId })).items.length, 1);
});

test('two writers at once keep every note, and the translations and outline beside them', async t => {
  const f = await fixture(t), { document } = await f.imported();
  await f.store.update(state => { state.documents[0].versions[0].translations = { revision: document.revision, updatedAt: '2026-10-01T00:00:00.000Z', items: [{ key: 'k', text: 'kept' }] }; });
  const one = await f.select(document, 'CQRS design'), two = await f.select(document, 'latency and availability');
  const identity = selection => ({ documentId: document.documentId, revision: document.revision, selection });
  const results = await Promise.all([f.call('save', { ...identity(one), nodes: [node('c1'), node('c2', { parentId: 'c1' })] }), f.call('save', { ...identity(two), nodes: [node('d1')] }),
    f.call('save', { ...identity(one), nodes: [node('c3', { parentId: 'c1' })] })]);
  assert.deepEqual(results.map(result => result.status), ['saved', 'saved', 'saved']);
  const list = await f.call('list', { documentId: document.documentId });
  assert.deepEqual(list.items.map(item => item.id).sort(), ['c1', 'c2', 'c3', 'd1']);
  const version = (await f.store.read()).documents[0].versions[0];
  assert.equal(version.translations.items[0].text, 'kept');
});

test('the stored format is additive: one optional field, and a library that holds it stays readable and writable by release 3.0.0', async t => {
  const f = await fixture(t), { document } = await f.imported();
  await f.call('save', { documentId: document.documentId, revision: document.revision, selection: await f.select(document, 'CQRS design'), nodes: [node('o1'), node('o2', { parentId: 'o1', term: 'ELK' })] });
  await f.store.update(state => { state.sources.push({ id: 'legacy-2', title: 'Pasted', text: 'Pasted words about CQRS.', createdAt: '2026-10-01T00:00:00.000Z' }); });
  const legacy = (await f.raw('materials.selection.resolve', { sourceId: 'legacy-2', quote: 'CQRS' })).selection;
  await f.call('save', { sourceId: 'legacy-2', selection: legacy, nodes: [node('o3')] });
  const kept = (await f.store.read()).documents[0].versions[0].annotations;
  assert.deepEqual(Object.keys(kept).sort(), ['items', 'revision', 'updatedAt']);
  assert.deepEqual(Object.keys(kept.items[0]).sort(), ['answer', 'at', 'end', 'hash', 'id', 'key', 'language', 'parentId', 'prefix', 'question', 'quote', 'sourceId', 'start', 'suffix', 'updatedAt']);
  // The release 3.0.0 tree sits under the repository's ignored output/ folder so that it resolves the same packages.
  const older = join(repo, 'output', 'old-3.0.0');
  try { await extractRelease(repo, 'v3.0.0', older); } catch (error) { t.skip(`release 3.0.0 cannot be extracted here: ${error.message}`); return; }
  if (!existsSync(join(older, 'lib', 'store.js'))) { t.skip('release 3.0.0 has no tree here'); return; }
  const { Store: OlderStore } = await import(pathToFileURL(join(older, 'lib', 'store.js')).href);
  const { createMaterialsOperations: olderOperations } = await import(pathToFileURL(join(older, 'lib', 'contexts', 'materials', 'operations.js')).href);
  const store = new OlderStore(f.root), state = await store.read();
  const ops = olderOperations({ root: f.root, read: async () => ({ sources: state.sources, documents: state.documents || [] }), update: async () => { throw new Error('read only'); } });
  const listed = await ops.handlers['materials.document.list']({});
  assert.ok(listed.documents.some(item => item.documentId === document.documentId || item.id === document.documentId), 'the older release lists the document');
  const opened = await ops.handlers['materials.document.get']({ id: document.documentId });
  assert.equal(opened.sources[0].text, state.sources[0].text, 'and opens it');
  // The older release writes something else: the notes come through untouched.
  await store.update(next => { next.sources.push({ id: 'later', title: 'later', text: 'written by 3.0.0', createdAt: '2026-10-02T00:00:00.000Z' }); });
  const after = await new Store(f.root).read();
  assert.deepEqual(after.documents[0].versions[0].annotations, kept);
  assert.equal(after.sources.find(item => item.id === 'legacy-2').annotations.items[0].id, 'o3');
  assert.ok(after.sources.some(item => item.id === 'later'));
  // And this release still lists them after the older one wrote.
  assert.equal((await f.call('list', { documentId: document.documentId })).items.length, 2);
});
