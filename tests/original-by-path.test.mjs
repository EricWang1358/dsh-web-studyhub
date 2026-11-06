/* A converted book keeps no original, and the original can be a very big file (a 500-page textbook is hundreds of MB). Here the original is
   referenced BY PATH, with no size limit: nothing is copied and nothing big is read into memory. A file over the 40 MB copy limit is not checked
   page by page (it is not loaded), so it is accepted without a confirmation only when the conversion record says it is the file that was converted
   (same hash, or the same name and size), otherwise after the learner confirms. No network, no model; generated PDFs and sparse files only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { materialsSchemas } from '../lib/contexts/materials/contracts.js';
import { closeRecord, openRecord } from '../lib/mineru-history.js';
import { makeTextPdf, LECTURE_PAGES } from './helpers/text-pdf.mjs';

const MB = 1024 * 1024;
const BIG = 45 * MB;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'original-by-path-'));
  const outside = await mkdtemp(join(tmpdir(), 'original-by-path-files-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
  const call = (action, args = {}) => ops.handlers[action](args, {});
  // A text-only document: what a converted book is (its original was never kept).
  const bytes = await makeTextPdf(LECTURE_PAGES);
  const imported = await call('materials.document.import', { dataBase64: bytes.toString('base64'), filename: 'book.pdf' });
  await store.update(state => { for (const document of state.documents) for (const version of document.versions) version.attachment = null; });
  const big = join(outside, 'Textbook.pdf');
  await writeFile(big, '%PDF-1.7\n'); await truncate(big, BIG);
  return { root, outside, store, call, big, documentId: imported.documentId };
}

/** A finished conversion of `documentId`, as the history keeps it. */
async function converted(root, documentId, facts) {
  const id = `conv-${Math.random().toString(16).slice(2, 10)}`;
  await openRecord(root, { id, route: 'local', converter: 'mineru', pages: 3, pieces: 1, ...facts });
  await closeRecord(root, id, { status: 'complete', documentId, importedPages: 3 });
}

test('a file over the copy limit is referenced by its path: not read, not copied, and the learner confirms it is the right one', async t => {
  const { call, big, documentId } = await fixture(t);
  const probed = await call('materials.original.probe', { documentId, path: big });
  assert.equal(probed.verdict, 'unchecked');
  assert.equal(probed.accepted, false);
  assert.equal(probed.bytes, BIG);
  assert.deepEqual(probed.reasons, ['too-large']);
  const asked = await call('materials.original.attach', { documentId, path: big, mode: 'reference' });
  assert.equal(asked.status, 'needs-confirmation');
  const attached = await call('materials.original.attach', { documentId, path: big, mode: 'reference', confirm: true });
  assert.equal(attached.status, 'attached');
  assert.equal(attached.original.mode, 'reference');
  assert.equal(attached.original.status, 'ok');
  assert.equal(attached.original.bytes, BIG);
});

test('copying such a file into the library is still refused at the copy limit', async t => {
  const { call, big, documentId } = await fixture(t);
  await assert.rejects(call('materials.original.attach', { documentId, path: big, mode: 'copy', confirm: true }), /at most 40 MB/);
});

test('a big referenced original is there for the main chat (path, size) but not served to the reader, which says why instead of loading it', async t => {
  const { call, big, documentId } = await fixture(t);
  await call('materials.original.attach', { documentId, path: big, mode: 'reference', confirm: true });
  const document = await call('materials.document.get', { documentId });
  assert.equal(document.original.status, 'ok');
  assert.equal(document.original.path, big);
  assert.equal(document.original.tooLargeForReader, true);
  assert.equal(document.originalAvailable, false, 'the reader has no file to open, so it keeps the extracted text without a false notice');
  const served = await call('materials.document.bytes', { documentId });
  assert.equal(served.status, 'unavailable');
  assert.equal(served.reason, 'too-large');
  assert.equal(served.path, big);
});

test('the conversion record that names this file (same name, same size) passes the check without a confirmation', async t => {
  const { call, root, big, documentId } = await fixture(t);
  await converted(root, documentId, { filename: 'Textbook.pdf', bytes: BIG });
  const probed = await call('materials.original.probe', { documentId, path: big });
  assert.equal(probed.verdict, 'match');
  assert.equal(probed.accepted, true);
  assert.equal(probed.basis, 'conversion-record');
  const attached = await call('materials.original.attach', { documentId, path: big, mode: 'reference' });
  assert.equal(attached.status, 'attached');
});

test('a record of another name or size does not vouch for the file', async t => {
  const { call, root, big, outside, documentId } = await fixture(t);
  await converted(root, documentId, { filename: 'Other.pdf', bytes: BIG });
  assert.equal((await call('materials.original.probe', { documentId, path: big })).verdict, 'unchecked');
  const near = join(outside, 'Other.pdf');
  await writeFile(near, '%PDF-1.7\n'); await truncate(near, BIG + 1);
  assert.equal((await call('materials.original.probe', { documentId, path: near })).verdict, 'unchecked');
});

test('the hash the conversion was made from is the same document whatever the file is called', async t => {
  const { call, root, big, documentId } = await fixture(t);
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  for await (const part of createReadStream(big)) hash.update(part);
  await converted(root, documentId, { filename: 'something-else.pdf', bytes: BIG, sourceHash: hash.digest('hex') });
  const probed = await call('materials.original.probe', { documentId, path: big });
  assert.equal(probed.verdict, 'identical');
  assert.equal(probed.accepted, true);
});

test('a document whose conversion remembers the file is offered it once, while the file is still there and the size is the same', async t => {
  const { call, root, big, outside, documentId } = await fixture(t);
  assert.equal((await call('materials.original.status', { documentId })).convertedFrom, undefined, 'no record, no offer');
  await converted(root, documentId, { filename: 'Textbook.pdf', bytes: BIG, sourcePath: big });
  const offer = (await call('materials.original.status', { documentId })).convertedFrom;
  assert.deepEqual(offer, { path: big, bytes: BIG, filename: 'Textbook.pdf' });
  await truncate(big, BIG + 5);
  assert.equal((await call('materials.original.status', { documentId })).convertedFrom, undefined, 'a file of another size is not the one that was converted');
  await truncate(big, BIG);
  await call('materials.original.attach', { documentId, path: big, mode: 'reference' });
  assert.equal((await call('materials.original.status', { documentId })).convertedFrom, undefined, 'nothing to offer once it is attached');
  assert.ok(outside);
});

test('the offer never appears for a conversion that kept no path (an upload, or a conversion before paths were remembered)', async t => {
  const { call, root, documentId } = await fixture(t);
  await converted(root, documentId, { filename: 'Textbook.pdf', bytes: BIG });
  assert.equal((await call('materials.original.status', { documentId })).convertedFrom, undefined);
});

test('the shared contracts are unchanged: no new argument lets a caller skip the check', () => {
  assert.deepEqual(Object.keys(materialsSchemas['materials.original.attach'].input.properties).sort(),
    ['confirm', 'dataBase64', 'documentId', 'filename', 'format', 'id', 'mode', 'path', 'revision', 'sourceId']);
});
