/* Byte-range PDF transport (materials.document.range + pdfjs-dist PDFDataRangeTransport + 32-chunk LRU)
   and paged slow-page deadlock fix (PdfOriginal.jsx + paged-renderer.js). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { DEFAULT_RANGE_CHUNK_BYTES, MAX_RANGE_CHUNK_BYTES, createRangeSource, pageSource } from '../lib/contexts/materials/original-pages.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { makeTextPdf } from './helpers/text-pdf.mjs';

const h = React.createElement;
const MB = 1024 * 1024;
const han = /[\u4e00-\u9fff]/;

const compiledUi = await build({
  stdin: {
    contents: `
      export * from './ui/document-preview/peek/paged-original.js';
      export { createPagedRenderer, createRangeTransport, RANGE_CHUNK_SIZE, RANGE_LRU_CHUNKS } from './ui/document-preview/peek/paged-renderer.js';
      export { createPeekRenderer } from './ui/document-preview/peek/renderer.js';
      export { default as PdfOriginal } from './ui/document-preview/reader/PdfOriginal.jsx';
      export { setUiLanguage } from './ui/i18n.js';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  loader: { '.css': 'text', '.json': 'json' },
  external: ['react', 'react-dom', 'pdfjs-dist/*'],
  logLevel: 'silent',
});
const uiMod = { exports: {} };
const localRequire = createRequire(import.meta.url);
new Function('require', 'module', 'exports', 'globalThis', compiledUi.outputFiles[0].text)(
  id => (id === 'react' ? React : localRequire(id)),
  uiMod,
  uiMod.exports,
  globalThis,
);
const uiLib = uiMod.exports;

const inLanguage = (lang, fn) => {
  uiLib.setUiLanguage(lang);
  try { return fn(); }
  finally { uiLib.setUiLanguage('zh'); }
};

function opsFor(root) {
  const store = new Store(root);
  const ops = createMaterialsOperations({
    root,
    read: async () => {
      const state = await store.read();
      return structuredClone({ sources: state.sources, documents: state.documents || [] });
    },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own);
      state.sources = own.sources;
      state.documents = own.documents;
      return result;
    }),
  });
  return (action, args = {}) => ops.handlers[action](args, {});
}

async function attachBigPdf(t, { pages = 12, padBytes = 4 * MB } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pdf-range-store-'));
  const outside = await mkdtemp(join(tmpdir(), 'pdf-range-files-'));
  t.after(async () => {
    pageSource.release();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const call = opsFor(root);
  const pageLines = Array.from({ length: pages }, (_, i) => [`Textbook page ${i + 1}`, `Range transport verification content for page ${i + 1}.`]);
  const small = await makeTextPdf(pageLines);
  const imported = await call('materials.document.import', { dataBase64: small.toString('base64'), filename: 'BigTextbook.pdf' });
  await call('materials.original.detach', { documentId: imported.documentId });
  const big = await makeTextPdf(pageLines, { padBytes });
  assert.ok(big.length > 40 * MB, `fixture exceeds copy limit (${big.length})`);
  const pdfPath = join(outside, 'BigTextbook.pdf');
  await writeFile(pdfPath, big);
  const attached = await call('materials.original.attach', { documentId: imported.documentId, path: pdfPath, mode: 'reference', confirm: true });
  assert.equal(attached.status, 'attached');
  return { call, documentId: imported.documentId, pdfPath, size: big.length, sampleHead: big.subarray(0, 1024), sampleTail: big.subarray(big.length - 1024) };
}

test('materials.document.range is declared read-only in domain-contracts', () => {
  assert.deepEqual(writesFor('materials', 'materials.document.range'), []);
});

test('materials.document.range serves exact bounded slices via FileHandle.read without loading pdf-lib or holding the file in memory', async t => {
  pageSource.release();
  const loadsBefore = pageSource.state().loads;
  const { call, documentId, pdfPath, size, sampleHead, sampleTail } = await attachBigPdf(t);

  const served = await call('materials.document.bytes', { documentId });
  assert.equal(served.status, 'paged');
  assert.equal(served.paged.bytes, size);
  assert.equal(served.paged.rangeSupported, true);
  assert.equal(served.paged.rangeChunkSize, DEFAULT_RANGE_CHUNK_BYTES);

  const head = await call('materials.document.range', { documentId, begin: 0, end: 1024, expectedBytes: size });
  assert.equal(head.status, 'ok');
  assert.equal(head.begin, 0);
  assert.equal(head.end, 1024);
  assert.equal(head.totalBytes, size);
  assert.deepEqual(Buffer.from(head.dataBase64, 'base64'), sampleHead);

  const tail = await call('materials.document.range', { documentId, begin: size - 1024, end: size, expectedBytes: size });
  assert.equal(tail.status, 'ok');
  assert.deepEqual(Buffer.from(tail.dataBase64, 'base64'), sampleTail);

  // Never loads the big PDF into pdf-lib memory.
  assert.equal(pageSource.state().files, 0);
  assert.equal(pageSource.state().loads, loadsBefore);

  // Validation & bounds guards.
  await assert.rejects(call('materials.document.range', { documentId, begin: -1, end: 100 }), /safe integers/i);
  await assert.rejects(call('materials.document.range', { documentId, begin: 100, end: 100 }), /safe integers/i);
  await assert.rejects(call('materials.document.range', { documentId, begin: size, end: size + 10 }), /outside the file size/i);
  await assert.rejects(call('materials.document.range', { documentId, begin: size - 10, end: size + 1 }), /outside the file size/i);
  await assert.rejects(call('materials.document.range', { documentId, begin: 0, end: MAX_RANGE_CHUNK_BYTES + 1 }), /exceeds/i);

  // Identity/size mismatch & deleted file return explicit unavailable status.
  const wrongSize = await call('materials.document.range', { documentId, begin: 0, end: 64, expectedBytes: size + 1 });
  assert.equal(wrongSize.status, 'unavailable');
  assert.equal(wrongSize.reason, 'changed');

  // Verify handle was closed immediately (Windows allows removing the file right away).
  await rm(pdfPath);
  const missing = await call('materials.document.range', { documentId, begin: 0, end: 64 });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.reason, 'missing');
});

test('createRangeSource detects mid-read file mutations (mtime/size drift)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'range-drift-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'sample.pdf');
  await writeFile(file, Buffer.from('%PDF-1.4\nhello world\n'));
  const info = await stat(file);
  const src = createRangeSource();
  const ok = await src.read({ path: file, bytes: info.size, mtimeMs: info.mtimeMs }, 0, 8);
  assert.equal(ok.bytes.toString('utf8'), '%PDF-1.4');
  // Mutate file size on disk while passing stale stat metadata.
  await writeFile(file, Buffer.from('%PDF-1.4\nchanged size content!!\n'));
  await assert.rejects(
    src.read({ path: file, bytes: info.size, mtimeMs: info.mtimeMs }, 0, 8),
    error => error?.code === 'changed',
  );
});

test('createRangeTransport aligns to 64 KB chunks, caches up to 32 blocks in LRU, deduplicates concurrent reads, and copies delivered buffers', async () => {
  const totalBytes = 40 * 65536;
  const fetches = [];
  const backing = new Uint8Array(totalBytes);
  for (let i = 0; i < 40; i += 1) backing.fill((i + 1) & 0xff, i * 65536, (i + 1) * 65536);

  const delivered = [];
  class FakeBaseTransport {
    constructor(length, initialData) { this.length = length; this.initialData = initialData; }
    onDataRange(begin, chunk) { delivered.push({ begin, chunk }); }
    abort() {}
  }

  const transport = uiLib.createRangeTransport(
    { PDFDataRangeTransport: FakeBaseTransport },
    {
      bytes: totalBytes,
      async fetchRange(begin, end) {
        fetches.push([begin, end]);
        await new Promise(resolve => setTimeout(resolve, 2));
        return backing.slice(begin, end);
      },
    },
    { chunkSize: 65536, maxCachedChunks: 32 },
  );

  // Two concurrent requests for the same block trigger only one backend fetch.
  transport.requestDataRange(0, 65536);
  transport.requestDataRange(0, 65536);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fetches.length, 1);
  assert.equal(delivered.length, 2);
  // Mutating delivered buffer must not corrupt cached block.
  delivered[0].chunk[0] = 0x99;
  transport.requestDataRange(0, 65536);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fetches.length, 1, 'second read hits LRU cache');
  assert.equal(delivered[2].chunk[0], 1, 'cached buffer is isolated from caller mutations');

  // Reading 35 distinct blocks caps cache at 32 (LRU eviction).
  for (let i = 0; i < 35; i += 1) {
    transport.requestDataRange(i * 65536, (i + 1) * 65536);
  }
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(transport.stats().cachedChunks, 32);

  // Abort suppresses late range delivery.
  const countBeforeAbort = delivered.length;
  transport.requestDataRange(36 * 65536, 37 * 65536);
  transport.abort();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(delivered.length, countBeforeAbort);
});

test('createPeekRenderer streams a real PDF through pdfjs-dist PDFDataRangeTransport with disableAutoFetch and falls back cleanly on unsupported hosts', async () => {
  const pages = Array.from({ length: 8 }, (_, i) => [`Real range PDF page ${i + 1}`, `Payload ${i + 1}`]);
  const pdfBytes = await makeTextPdf(pages, { padBytes: 96 * 1024 });
  const rangeCalls = [];

  const call = async (action, args) => {
    if (action === 'materials.document.range') {
      rangeCalls.push([args.begin, args.end]);
      const slice = pdfBytes.subarray(args.begin, args.end);
      return { status: 'ok', dataBase64: slice.toString('base64'), begin: args.begin, end: args.end, totalBytes: pdfBytes.length };
    }
    throw new Error(`Unexpected action ${action}`);
  };

  const url = uiLib.pagedFileUrl(call, {
    documentId: 'doc-real',
    revision: 'rev-1',
    totalPages: 8,
    bytes: pdfBytes.length,
    rangeSupported: true,
    rangeChunkSize: 65536,
  });
  const source = await uiLib.originalBytes(url);
  assert.equal(typeof source.fetchRange, 'function');

  // Open via real pdfjs-dist (legacy Node build) using PDFDataRangeTransport.
  const renderer = await uiLib.createPeekRenderer(source, { pdfjs });
  try {
    assert.equal(renderer.numPages, 8);
    const size = await renderer.pageSize(5);
    assert.ok(size.width > 0 && size.height > 0);
    assert.ok(rangeCalls.length > 0, 'pdf.js fetched byte ranges via transport');
    assert.ok(rangeCalls.every(([begin, end]) => end - begin <= 65536), 'every range fetch stayed within 64 KB');
    const fetchedTotal = rangeCalls.reduce((sum, [begin, end]) => sum + (end - begin), 0);
    assert.ok(fetchedTotal < pdfBytes.length, `on-demand fetch transferred ${fetchedTotal} < full ${pdfBytes.length} bytes`);
    assert.equal(typeof renderer.assetStats().totalMs, 'number');
    assert.ok(renderer.rangeStats().misses >= 1);
  } finally {
    await renderer.destroy();
  }

  // Backward-compatible fallback to materials.document.pages when host does not know materials.document.range.
  const fallbackAsked = [];
  const legacyHost = async (action, args) => {
    fallbackAsked.push(action);
    if (action === 'materials.document.range') throw new Error('Unknown action: materials.document.range');
    return { status: 'ok', dataBase64: Buffer.from(`page-${args.from}`).toString('base64'), numPages: 8 };
  };
  const fallbackUrl = uiLib.pagedFileUrl(legacyHost, {
    documentId: 'doc-legacy',
    revision: 'rev-1',
    totalPages: 8,
    bytes: 512 * 1024,
    rangeSupported: true,
  });
  const fallbackSource = await uiLib.originalBytes(fallbackUrl);
  const fakePdfjs = {
    PDFDataRangeTransport: class {
      constructor(length) { this.length = length; }
      onDataRange() {}
      abort() {}
    },
    getDocument(opts) {
      if (opts.range) {
        opts.range.requestDataRange(0, 65536);
        return { promise: new Promise(() => {}), destroy: async () => {} };
      }
      return { promise: Promise.resolve({ numPages: 1 }), destroy: async () => {} };
    },
  };
  const openedFallback = await uiLib.createPeekRenderer(fallbackSource, { pdfjs: fakePdfjs });
  assert.equal(openedFallback.numPages, 8);
  assert.ok(fallbackAsked.includes('materials.document.range'));
  assert.ok(fallbackAsked.includes('materials.document.pages'));
  await openedFallback.destroy();
});

test('createPagedRenderer reports live active and accumulated assetStats during fetch and active page rendering', async () => {
  let resolveFetch;
  const source = {
    total: 5,
    numPages: 5,
    fetchPage: number => new Promise(resolve => {
      if (number === 1) { resolve(new Uint8Array([1])); return; }
      resolveFetch = () => resolve(new Uint8Array([number]));
    }),
  };
  let activeAssetCount = 0;
  const open = async bytes => ({
    numPages: 1,
    assetStats: () => ({ totalMs: 42, active: bytes[0] === 1 ? activeAssetCount : 0 }),
    pageSize: async () => ({ width: 600, height: 800 }),
    render: async () => ({ id: bytes[0] }),
    textLayer: async () => null,
    destroy: async () => {},
  });
  const renderer = await uiLib.createPagedRenderer(source, open);
  // Active page 1's asset time is visible immediately (not only after eviction!).
  activeAssetCount = 1;
  assert.equal(renderer.assetStats().active, 1);
  assert.ok(renderer.assetStats().totalMs >= 42);
  activeAssetCount = 0;

  // In-flight fetchPage is reported as active I/O.
  const page2Promise = renderer.pageSize(2);
  await Promise.resolve();
  assert.equal(renderer.assetStats().active, 1);
  resolveFetch();
  await page2Promise;
  assert.equal(renderer.assetStats().active, 0);
  await renderer.destroy();
});

test('PdfOriginal shows actionable slow-page recovery UI for paged originals instead of deadlocking silently', () => {
  const pagedUrl = uiLib.pagedFileUrl(async () => ({ status: 'ok' }), { documentId: 'doc-big', revision: 'rev-1', totalPages: 120, bytes: 100 * MB });

  const zhHtml = renderToStaticMarkup(h(uiLib.PdfOriginal, {
    fileUrl: pagedUrl,
    title: 'Big.pdf',
    page: 5,
    total: 120,
    onPage: () => {},
    settings: { zoom: 1, native: false, slow: true, keepSinglePage: false },
    onSettings: () => {},
  }));
  assert.doesNotMatch(zhHtml, /<iframe/, 'paged originals never switch to a broken iframe');
  assert.match(zhHtml, /这一页绘制太慢/);
  assert.match(zhHtml, /继续绘制这一页/);
  assert.match(zhHtml, /重试/);

  inLanguage('en', () => {
    const enHtml = renderToStaticMarkup(h(uiLib.PdfOriginal, {
      fileUrl: pagedUrl,
      title: 'Big.pdf',
      page: 5,
      total: 120,
      onPage: () => {},
      settings: { zoom: 1, native: false, slow: true, keepSinglePage: false },
      onSettings: () => {},
    }));
    assert.match(enHtml, /Keep drawing this page/);
    assert.match(enHtml, /Retry/);
    assert.doesNotMatch(enHtml.replace(/<[^>]*>/g, ''), han);
  });

  // Once the learner opts in (`keepSinglePage: true`), the slow warning clears.
  const liftedHtml = renderToStaticMarkup(h(uiLib.PdfOriginal, {
    fileUrl: pagedUrl,
    title: 'Big.pdf',
    page: 5,
    total: 120,
    onPage: () => {},
    settings: { zoom: 1, native: false, slow: false, keepSinglePage: true },
    onSettings: () => {},
  }));
  assert.doesNotMatch(liftedHtml, /这一页绘制太慢/);
});
