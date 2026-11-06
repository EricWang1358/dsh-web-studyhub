/* A referenced original over the copy limit is never sent whole: the reader asks for the PAGES it shows (materials.document.pages), and the host copies just those pages
   into a small PDF with pdf-lib. The one big file being read is held in memory for a short while (never more than one) and let go when idle. Generated PDFs only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { createPageSource, pageSource } from '../lib/contexts/materials/original-pages.js';
import { openPdfDocument } from '../lib/documents.js';
import { pageText } from '../lib/pdf-text.js';
import { makeTextPdf } from './helpers/text-pdf.mjs';
import { collectGarbage, settledMemory } from '../scripts/qa/perf-probe.mjs';

const MB = 1024 * 1024;
const PAGES = 50;
const lines = number => [`Chapter page ${number} of the big book`, `Figure ${number} is drawn on this page and cannot be read from the converted text.`];
const pagesOf = count => Array.from({ length: count }, (_, index) => lines(index + 1));

/** A converted book (its text only) whose original is a 50-page, 50+ MB PDF referenced by path. */
async function bigBook(t, { name = 'Textbook.pdf', pages = PAGES } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'original-pages-'));
  const outside = await mkdtemp(join(tmpdir(), 'original-pages-files-'));
  t.after(async () => { pageSource.release(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
  const call = (action, args = {}) => ops.handlers[action](args, {});
  const small = await makeTextPdf(pagesOf(pages));
  const imported = await call('materials.document.import', { dataBase64: small.toString('base64'), filename: name });
  await call('materials.original.detach', { documentId: imported.documentId });
  const big = await makeTextPdf(pagesOf(pages), { padBytes: MB });
  assert.ok(big.length > 40 * MB, `the original is over the copy limit (${big.length})`);
  const path = join(outside, name);
  await writeFile(path, big);
  const attached = await call('materials.original.attach', { documentId: imported.documentId, path, mode: 'reference', confirm: true });
  assert.equal(attached.status, 'attached');
  return { call, root, path, documentId: imported.documentId, size: big.length };
}

const textOf = async base64 => {
  const loading = await openPdfDocument(Buffer.from(base64, 'base64'));
  try {
    const pdf = await loading.promise;
    const page = await pdf.getPage(1);
    return { numPages: pdf.numPages, text: pageText((await page.getTextContent()).items, page.getViewport({ scale: 1 })).text };
  } finally { await loading.destroy(); }
};

test('the reader is told the original is there and is paged, not sent the file', async t => {
  const { call, documentId, path } = await bigBook(t);
  const document = await call('materials.document.get', { documentId });
  assert.equal(document.originalAvailable, true, 'the reader opens it, page by page');
  assert.equal(document.original.tooLargeForReader, true);
  assert.equal(document.original.path, path);
  const served = await call('materials.document.bytes', { documentId });
  assert.equal(served.dataBase64, undefined, 'the whole file is never sent');
  assert.equal(served.status, 'paged');
  assert.equal(served.paged.documentId, documentId);
  assert.equal(served.paged.totalPages, PAGES);
  assert.equal(served.paged.mime, 'application/pdf');
});

test('a page of the original comes as a small PDF holding just that page, with its own text', async t => {
  const { call, documentId, size } = await bigBook(t);
  const answer = await call('materials.document.pages', { documentId, from: 7 });
  assert.equal(answer.status, 'ok');
  assert.deepEqual(answer.pages, { from: 7, to: 7 });
  assert.equal(answer.numPages, PAGES);
  const bytes = Buffer.from(answer.dataBase64, 'base64');
  assert.ok(bytes.length < 3 * MB && bytes.length < size / 10, `one page is small (${bytes.length} of ${size})`);
  const drawn = await textOf(answer.dataBase64);
  assert.equal(drawn.numPages, 1);
  assert.match(drawn.text, /Chapter page 7 of the big book/);
  const last = await textOf((await call('materials.document.pages', { documentId, from: PAGES })).dataBase64);
  assert.match(last.text, /Chapter page 50 of the big book/);
});

test('a range of pages is one small PDF in order; ranges and pages out of bounds are refused plainly', async t => {
  const { call, documentId } = await bigBook(t);
  const range = await call('materials.document.pages', { documentId, from: 3, to: 5 });
  const loading = await openPdfDocument(Buffer.from(range.dataBase64, 'base64'));
  try { assert.equal((await loading.promise).numPages, 3); } finally { await loading.destroy(); }
  await assert.rejects(call('materials.document.pages', { documentId, from: 0 }), /page/i);
  await assert.rejects(call('materials.document.pages', { documentId, from: PAGES + 1 }), /no page|past the end|page/i);
  await assert.rejects(call('materials.document.pages', { documentId, from: 5, to: 2 }), /page/i);
  await assert.rejects(call('materials.document.pages', { documentId, from: 1, to: 20 }), /at most/i);
  await assert.rejects(call('materials.document.pages', { documentId }), /page/i);
});

test('a document with no original, or whose file moved, is told so, not given a page', async t => {
  const { call, documentId, path, root } = await bigBook(t);
  await rm(path);
  const gone = await call('materials.document.pages', { documentId, from: 1 });
  assert.equal(gone.status, 'unavailable');
  assert.ok(['missing', 'unreadable', 'changed'].includes(gone.reason), gone.reason);
  await call('materials.original.detach', { documentId });
  assert.equal((await call('materials.document.pages', { documentId, from: 1 })).status, 'unavailable');
  assert.ok(root);
});

test('the one big file is held between pages and let go: never two at once, and the memory comes back', async t => {
  const first = await bigBook(t, { name: 'First.pdf' });
  assert.equal(collectGarbage(), true, 'retained-memory measurement requires collection');
  const before = settledMemory().arrayBuffers;
  await first.call('materials.document.pages', { documentId: first.documentId, from: 1 });
  const held = pageSource.state();
  assert.equal(held.files, 1);
  assert.ok(held.key.includes('First.pdf'));
  const during = settledMemory().arrayBuffers;
  assert.ok(during - before >= 40, `the file is held while pages are asked (${during - before} MiB)`);
  // Another page of the same file reuses it; another file replaces it.
  await first.call('materials.document.pages', { documentId: first.documentId, from: 2 });
  assert.equal(pageSource.state().files, 1);
  const second = await bigBook(t, { name: 'Second.pdf' });
  await second.call('materials.document.pages', { documentId: second.documentId, from: 1 });
  assert.equal(pageSource.state().files, 1, 'never more than one big file');
  assert.ok(pageSource.state().key.includes('Second.pdf'));
  pageSource.release();
  assert.equal(pageSource.state().files, 0);
  assert.equal(collectGarbage(), true);
  const after = settledMemory().arrayBuffers;
  assert.ok(after - before < 20, `the memory is given back (${after - before} MiB more than before)`);
});

test('an idle source lets the file go by itself', async t => {
  const { documentId, root, path } = await bigBook(t);
  const source = createPageSource({ idleMs: 30 });
  const { stat } = await import('node:fs/promises');
  const info = await stat(path);
  await source.extract({ path, bytes: info.size, mtimeMs: info.mtimeMs }, 1, 1);
  assert.equal(source.state().files, 1);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(source.state().files, 0, 'released after it sat idle');
  assert.ok(documentId && root);
});

test('two pages asked at the same moment load the file once', async t => {
  const { path } = await bigBook(t);
  const { stat } = await import('node:fs/promises');
  const info = await stat(path);
  const source = createPageSource({ idleMs: 10_000 });
  const file = { path, bytes: info.size, mtimeMs: info.mtimeMs };
  const [a, b] = await Promise.all([source.extract(file, 1, 1), source.extract(file, 2, 2)]);
  assert.equal(a.pages.from, 1); assert.equal(b.pages.from, 2);
  assert.equal(source.state().loads, 1);
  source.release();
});
