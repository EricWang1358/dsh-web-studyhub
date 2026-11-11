/* The reader's own marks (materials.marks.*): 下划线 / 加粗 / 荧光笔 and the 待出题 list, kept per document REVISION beside the document's records,
   exactly where the 批注 are kept; and a 词解 kept as a 批注 of kind explain. A fake store; no model, no network. The text, citations, selections and
   card links of a document are never touched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { MARK_LIMITS, markStyle } from '../lib/contexts/materials/mark-model.js';
import { normalizeNode } from '../lib/annotation.js';
import { markSchemas } from '../lib/contexts/materials/mark-contracts.js';

const A = 'Architecture includes the principles guiding a system design and evolution.';
const B = 'Quality attributes such as latency and availability shape which tactics a team selects.';
const C = 'A CQRS design separates the read model from the write model.';
const markdown = (...lines) => `# Notes\n\n${lines.join('\n\n')}\n`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'materials-marks-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
  const raw = (action, args = {}) => ops.handlers[action](args, {});
  const marks = (action, args = {}) => raw(`materials.marks.${action}`, args);
  const imported = async (body = markdown(A, B, C), filename = 'notes.md', documentId) => {
    const result = await raw('materials.document.import', { filename, ...(documentId ? { documentId } : {}), dataBase64: Buffer.from(body).toString('base64') });
    return { ...result, document: await raw('materials.document.get', { id: result.documentId }) };
  };
  /** A capture as the reader makes it: a quote and its source, with no offsets (the backend resolves it). */
  const capture = (document, quote) => ({ documentId: document.documentId, revision: document.revision, sourceId: document.sources[0].id, quote });
  return { store, raw, marks, imported, capture };
}

test('a passage is marked in each style once, listed in reading order and drawn from its own words', async t => {
  const f = await fixture(t), { document } = await f.imported(), id = { documentId: document.documentId, revision: document.revision };
  const later = await f.marks('save', { ...id, selection: f.capture(document, 'CQRS design'), style: 'underline' });
  assert.equal(later.status, 'saved'); assert.equal(later.item.style, 'underline'); assert.equal(later.item.selection.quote, 'CQRS design');
  await f.marks('save', { ...id, selection: f.capture(document, 'latency and availability'), style: 'bold' });
  await f.marks('save', { ...id, selection: f.capture(document, 'latency and availability'), style: 'highlight' });
  const again = await f.marks('save', { ...id, selection: f.capture(document, 'CQRS design'), style: 'underline' });
  assert.equal(again.status, 'unchanged', 'the same stroke twice is one mark');
  const list = await f.marks('list', id);
  assert.equal(list.count, 3); assert.equal(list.queued, 0);
  assert.deepEqual(list.items.map(item => [item.selection.quote, item.style, item.status]),
    [['latency and availability', 'bold', 'resolved'], ['latency and availability', 'highlight', 'resolved'], ['CQRS design', 'underline', 'resolved']]);
  assert.deepEqual(list.limits, { items: MARK_LIMITS.items, queue: MARK_LIMITS.queue });
  // The document as the reader gets it never carries the marks, and its text is untouched.
  const got = await f.raw('materials.document.get', { id: document.documentId });
  assert.ok(!('marks' in got.sources[0])); assert.ok(got.versions.every(version => !('marks' in version)));
  assert.equal(got.sources[0].text, document.sources[0].text);
});

test('marks are removed by id, by passage (one style or all), by style, and refused for words the document does not hold', async t => {
  const f = await fixture(t), { document } = await f.imported(), id = { documentId: document.documentId, revision: document.revision };
  const bold = await f.marks('save', { ...id, selection: f.capture(document, 'principles guiding'), style: 'bold' });
  await f.marks('save', { ...id, selection: f.capture(document, 'principles guiding'), style: 'underline' });
  await f.marks('save', { ...id, selection: f.capture(document, 'read model'), style: 'queue' });
  await f.marks('save', { ...id, selection: f.capture(document, 'write model'), style: 'queue' });
  assert.equal((await f.marks('list', id)).queued, 2);
  assert.equal((await f.marks('delete', { ...id, ids: [bold.item.id] })).deleted, 1);
  assert.equal((await f.marks('delete', { ...id, selection: bold.item.selection, style: 'underline' })).deleted, 1);
  const emptied = await f.marks('delete', { ...id, style: 'queue' });
  assert.equal(emptied.deleted, 2, 'style alone empties the 待出题 list');
  assert.equal((await f.marks('list', id)).count, 0);
  const missing = await f.marks('save', { ...id, selection: f.capture(document, 'not in this document at all'), style: 'underline' });
  assert.equal(missing.status, 'missing'); assert.equal(missing.saved, 0);
  await assert.rejects(f.marks('save', { ...id, selection: f.capture(document, 'read model'), style: 'strike' }), /style must be one of/);
  await assert.rejects(f.marks('delete', id), /Name the marks/);
});

test('the 待出题 list has a limit of its own and says so plainly', async t => {
  const f = await fixture(t);
  const words = Array.from({ length: MARK_LIMITS.queue + 1 }, (_, index) => `Point number ${index + 100} matters.`);
  const { document } = await f.imported(markdown(...words)), id = { documentId: document.documentId, revision: document.revision };
  for (const word of words.slice(0, MARK_LIMITS.queue)) assert.equal((await f.marks('save', { ...id, selection: f.capture(document, word), style: 'queue' })).status, 'saved');
  const full = await f.marks('save', { ...id, selection: f.capture(document, words.at(-1)), style: 'queue' });
  assert.equal(full.status, 'queue-full'); assert.match(full.message, /At most 40 passages/);
  // Other styles still fit.
  assert.equal((await f.marks('save', { ...id, selection: f.capture(document, words.at(-1)), style: 'underline' })).status, 'saved');
});

test('a new revision does not draw the old marks; it counts them as stale and they can be cleared', async t => {
  const f = await fixture(t), first = await f.imported(markdown(A, B), 'notes.md');
  const old = first.document;
  await f.marks('save', { documentId: old.documentId, revision: old.revision, selection: f.capture(old, 'latency and availability'), style: 'underline' });
  const second = await f.imported(markdown(A, B, C), 'notes.md', old.documentId);
  const now = second.document;
  assert.notEqual(now.revision, old.revision);
  const list = await f.marks('list', { documentId: now.documentId, revision: now.revision });
  assert.equal(list.count, 0);
  assert.deepEqual(list.stale.map(entry => [entry.revision, entry.count]), [[old.revision, 1]]);
  assert.equal((await f.marks('delete', { documentId: now.documentId, revision: now.revision, stale: true })).deleted, 1);
  assert.deepEqual((await f.marks('list', { documentId: now.documentId, revision: now.revision })).stale, []);
});

test('a 词解 is an ordinary 批注 that says it is one; other kinds are dropped', async t => {
  assert.equal(normalizeNode({ id: 'e1', question: 'q', answer: 'a', kind: 'explain' }).kind, 'explain');
  assert.equal(normalizeNode({ id: 'e1', question: 'q', answer: 'a', kind: 'whatever' }).kind, undefined);
  const f = await fixture(t), { document } = await f.imported(), id = { documentId: document.documentId, revision: document.revision };
  const selection = (await f.raw('materials.selection.resolve', { ...id, quote: 'CQRS design' })).selection;
  const saved = await f.raw('materials.annotation.save', { ...id, selection, nodes: [{ id: 'e1', parentId: null, question: 'Explain CQRS', term: 'CQRS design', answer: 'Reads and writes use different models.', kind: 'explain' }] });
  assert.equal(saved.status, 'saved');
  const listed = await f.raw('materials.annotation.list', id);
  assert.equal(listed.items[0].kind, 'explain'); assert.equal(listed.items[0].status, 'resolved');
});

test('the contracts name the same styles the rules accept', () => {
  assert.deepEqual(markSchemas['materials.marks.save'].input.properties.style.enum, ['underline', 'bold', 'highlight', 'queue']);
  for (const style of markSchemas['materials.marks.save'].input.properties.style.enum) assert.equal(markStyle(style), style);
});
