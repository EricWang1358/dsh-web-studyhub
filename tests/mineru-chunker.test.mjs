import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CHUNK_BYTES, MAX_PAGES_PER_CHUNK, PdfChunkError, inspectPdf, planChunks, readOutline, splitPdf } from '../lib/pdf-chunker.js';
import { makeEncryptedPdf, makePdf, pageCount } from './helpers/pdf.mjs';

/* Splitting a PDF into pieces MinerU accepts: at most 200 pages and 180 MB each (its hard limits are 200 pages / 200 MB).
   The page plan is pure; bytes are checked on the real pieces and an oversize one is halved. */

const summary = chunks => chunks.map(chunk => [chunk.startPage, chunk.endPage]);

test('the limits are the numbers the owner and the API document', () => {
  assert.equal(MAX_PAGES_PER_CHUNK, 200);
  assert.equal(MAX_CHUNK_BYTES, 180 * 1024 * 1024);
});

/* ---------- planChunks (pure) ---------- */

test('a book of at most 200 pages is one piece', () => {
  assert.deepEqual(summary(planChunks({ totalPages: 1 })), [[1, 1]]);
  assert.deepEqual(summary(planChunks({ totalPages: 200 })), [[1, 200]]);
  assert.deepEqual(summary(planChunks({ totalPages: 200, outline: [{ level: 1, title: 'A', page: 1 }, { level: 1, title: 'B', page: 90 }] })), [[1, 200]]);
});

test('without an outline the cuts are fixed 200-page cuts: 450 pages make three pieces', () => {
  const plan = planChunks({ totalPages: 450 });
  assert.deepEqual(summary(plan), [[1, 200], [201, 400], [401, 450]]);
  assert.deepEqual(plan.map(chunk => chunk.index), [0, 1, 2]);
  assert.ok(plan.every(chunk => chunk.cut === 'fixed'));
  assert.deepEqual(summary(planChunks({ totalPages: 201 })), [[1, 200], [201, 201]]);
});

test('with an outline, pieces end at chapter boundaries whenever a chapter fits', () => {
  const outline = [1, 120, 260, 300, 420].map((page, index) => ({ level: 1, title: `Chapter ${index + 1}`, page }));
  const plan = planChunks({ totalPages: 500, outline });
  assert.deepEqual(summary(plan), [[1, 119], [120, 299], [300, 419], [420, 500]]);
  assert.ok(plan.every(chunk => chunk.cut === 'chapter'));
  assert.ok(plan.every(chunk => chunk.endPage - chunk.startPage + 1 <= MAX_PAGES_PER_CHUNK));
});

test('a chapter longer than a piece is cut at 200 pages, and the rest of it joins what follows', () => {
  const outline = [{ level: 1, title: 'A', page: 1 }, { level: 1, title: 'B', page: 101 }, { level: 1, title: 'C', page: 451 }];
  assert.deepEqual(summary(planChunks({ totalPages: 500, outline })), [[1, 100], [101, 300], [301, 500]]);
});

test('front matter before the first chapter stays with it; unsorted, duplicate and out-of-range bookmarks are ignored', () => {
  const outline = [{ level: 1, title: 'B', page: 150 }, { level: 1, title: 'A', page: 5 }, { level: 1, title: 'A again', page: 5 },
    { level: 1, title: 'Gone', page: 9999 }, { level: 1, title: 'Zero', page: 0 }, { level: 1, title: 'C', page: 330 }];
  assert.deepEqual(summary(planChunks({ totalPages: 400, outline })), [[1, 149], [150, 329], [330, 400]]);
  const plan = planChunks({ totalPages: 400, outline });
  assert.equal(plan[0].startPage, 1);
  assert.equal(plan.at(-1).endPage, 400);
  for (let i = 1; i < plan.length; i++) assert.equal(plan[i].startPage, plan[i - 1].endPage + 1, 'no gap, no overlap');
  assert.ok(plan.every(chunk => chunk.endPage - chunk.startPage + 1 <= 200));
});

test('a custom page limit is respected', () => {
  assert.deepEqual(summary(planChunks({ totalPages: 25, maxPages: 10 })), [[1, 10], [11, 20], [21, 25]]);
});

test('an empty book cannot be planned', () => {
  assert.throws(() => planChunks({ totalPages: 0 }), PdfChunkError);
});

/* ---------- inspect / split real PDFs ---------- */

test('inspectPdf reads the page count and the bookmarks', async () => {
  const bytes = await makePdf({ pages: 12, outline: [{ title: 'One', page: 1 }, { title: 'Two', page: 5 }, { title: 'Three', page: 9 }] });
  const info = await inspectPdf(bytes);
  assert.equal(info.pages, 12);
  assert.equal(info.bytes, bytes.length);
  assert.deepEqual((await readOutline(bytes)).map(entry => [entry.title, entry.page, entry.level]), [['One', 1, 1], ['Two', 5, 1], ['Three', 9, 1]]);
});

test('a PDF within both limits is not rewritten: the original bytes are the one piece', async () => {
  const bytes = await makePdf({ pages: 3 });
  const written = [];
  const chunks = await splitPdf({ bytes, writeChunk: async chunk => { written.push(chunk); } });
  assert.deepEqual(summary(chunks), [[1, 3]]);
  assert.equal(chunks[0].original, true);
  assert.equal(chunks[0].bytes, bytes.length);
  assert.equal(written.length, 1);
  assert.ok(Buffer.compare(written[0].data, bytes) === 0, 'the very same bytes');
});

test('450 pages are cut into three real PDFs of 200, 200 and 50 pages', async () => {
  const bytes = await makePdf({ pages: 450 });
  const pieces = [];
  const chunks = await splitPdf({ bytes, writeChunk: async chunk => { pieces.push({ ...chunk, data: Buffer.from(chunk.data) }); } });
  assert.deepEqual(summary(chunks), [[1, 200], [201, 400], [401, 450]]);
  assert.deepEqual(pieces.map(piece => piece.index), [0, 1, 2]);
  for (const piece of pieces) {
    assert.equal(await pageCount(piece.data), piece.endPage - piece.startPage + 1);
    assert.equal(piece.data.length, chunks[piece.index].bytes, 'the reported size is the real size');
  }
  assert.ok(chunks.every(chunk => chunk.original === false));
});

test('chapter bookmarks decide the cuts of a real PDF', async () => {
  const outline = [1, 120, 260, 300, 420].map((page, index) => ({ title: `Chapter ${index + 1}`, page }));
  const bytes = await makePdf({ pages: 500, outline });
  const chunks = await splitPdf({ bytes, writeChunk: async () => {} });
  assert.deepEqual(summary(chunks), [[1, 119], [120, 299], [300, 419], [420, 500]]);
});

test('a piece over the byte limit is halved until every piece fits', async () => {
  const bytes = await makePdf({ pages: 24, padBytes: 6000 });
  const sizes = new Map();
  const chunks = await splitPdf({ bytes, maxBytes: 40_000, writeChunk: async chunk => { sizes.set(chunk.index, chunk.data.length); } });
  assert.ok(chunks.length >= 4, `expected several pieces, got ${chunks.length}`);
  assert.ok(chunks.every(chunk => chunk.bytes <= 40_000));
  assert.equal(chunks[0].startPage, 1);
  assert.equal(chunks.at(-1).endPage, 24);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].startPage, chunks[i - 1].endPage + 1);
  assert.deepEqual(chunks.map(chunk => chunk.index), chunks.map((_, i) => i), 'indexes are renumbered in book order');
  assert.deepEqual([...sizes.keys()], chunks.map(chunk => chunk.index), 'pieces are handed over in book order');
});

test('a piece can be a single page, and a single page that is too big is a named error', async () => {
  const bytes = await makePdf({ pages: 4, padBytes: page => (page === 3 ? 30_000 : 100) });
  await assert.rejects(splitPdf({ bytes, maxBytes: 20_000, writeChunk: async () => {} }), error => {
    assert.ok(error instanceof PdfChunkError);
    assert.equal(error.code, 'page-too-large');
    assert.equal(error.page, 3);
    assert.match(error.message, /第 3 页/);
    return true;
  });
  const ok = await makePdf({ pages: 4, padBytes: 15_000 });
  const chunks = await splitPdf({ bytes: ok, maxBytes: 20_000, writeChunk: async () => {} });
  assert.ok(chunks.every(chunk => chunk.bytes <= 20_000));
  assert.ok(chunks.some(chunk => chunk.startPage === chunk.endPage), 'a one-page piece is allowed');
});

test('the whole file over the byte limit but within 200 pages is split too', async () => {
  const bytes = await makePdf({ pages: 10, padBytes: 5000 });
  const chunks = await splitPdf({ bytes, maxBytes: Math.floor(bytes.length * 0.6), writeChunk: async () => {} });
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every(chunk => !chunk.original));
});

test('a password-protected PDF gets a plain message, not a crash', async () => {
  const bytes = await makeEncryptedPdf();
  await assert.rejects(inspectPdf(bytes), error => error instanceof PdfChunkError && error.code === 'encrypted' && /密码/.test(error.message));
  await assert.rejects(splitPdf({ bytes, writeChunk: async () => {} }), error => error.code === 'encrypted');
});

test('files that are not PDFs, or are damaged, are named as such', async () => {
  await assert.rejects(inspectPdf(Buffer.from('hello world, not a pdf')), error => error instanceof PdfChunkError && error.code === 'not-pdf');
  const good = await makePdf({ pages: 3 });
  const truncated = good.subarray(0, Math.floor(good.length / 3));
  await assert.rejects(inspectPdf(truncated), error => error instanceof PdfChunkError && ['damaged', 'not-pdf'].includes(error.code));
  const garbage = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('this is not a real body '.repeat(50))]);
  await assert.rejects(inspectPdf(garbage), error => error instanceof PdfChunkError && error.code === 'damaged');
});

test('splitting stops promptly when the job is cancelled', async () => {
  const bytes = await makePdf({ pages: 450 });
  const controller = new AbortController();
  let written = 0;
  await assert.rejects(splitPdf({ bytes, signal: controller.signal, writeChunk: async () => { written++; controller.abort(new Error('cancelled')); } }), /cancelled/);
  assert.equal(written, 1, 'no further piece is written after the cancel');
});
