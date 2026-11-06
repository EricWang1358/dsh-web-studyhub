/* The reader's seam for an original too big to send whole: the file URL it holds is either a blob of the whole file, or a marker for a PAGED original; whatever draws a page
   (the 原始 PDF view, 看原页, the picture for 发给主会话) asks the seam for "the bytes", and for a paged original gets a page source, drawn one page at a time through
   materials.document.pages. Pure logic with stand-ins for the backend and for pdf.js. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: `
  export * from './ui/document-preview/peek/paged-original.js';
  export { createPagedRenderer } from './ui/document-preview/peek/paged-renderer.js';
  export { createPeekRenderer } from './ui/document-preview/peek/renderer.js';
  export { renderPageImages } from './ui/document-preview/peek/page-image.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', 'globalThis', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports, globalThis);
const lib = module.exports;

const PAGED = { documentId: 'doc-1', revision: 'rev-1', mime: 'application/pdf', filename: 'Textbook.pdf', totalPages: 513 };

/** A backend that answers materials.document.pages with the page number as the "PDF". */
function backend() {
  const asked = [];
  const call = async (action, args) => {
    asked.push([action, args]);
    if (args.from === 99999) return { status: 'unavailable', reason: 'missing' };
    return { status: 'ok', dataBase64: Buffer.from(`page-${args.from}`).toString('base64'), mime: 'application/pdf', pages: { from: args.from, to: args.to }, numPages: 513 };
  };
  return { asked, call };
}

/** A stand-in for createPeekRenderer: opens bytes that say which page they are, draws a "bitmap" naming it. */
function fakeOpen() {
  const opened = [], destroyed = [];
  const open = async bytes => {
    const name = Buffer.from(bytes).toString();
    opened.push(name);
    return { numPages: 1, assetStats: () => ({ totalMs: 5, active: 0 }), cachedPageSize: () => null,
      pageSize: async () => ({ width: 612, height: 792, of: name }), render: async (number, options) => ({ bitmap: name, number, scale: options?.scale }),
      textLayer: async (number, options) => ({ layer: name, number, options }), destroy: async () => { destroyed.push(name); } };
  };
  return { open, opened, destroyed };
}

test('a paged original is a marker URL that gives back a page source, not bytes; a normal URL still gives its bytes', async () => {
  const { call } = backend();
  const url = lib.pagedFileUrl(call, PAGED);
  assert.equal(lib.isPagedUrl(url), true);
  assert.equal(lib.isPagedUrl('blob:http://localhost/abc'), false);
  assert.equal(lib.isPagedUrl(''), false);
  const source = await lib.originalBytes(url);
  assert.equal(source.kind, 'pages');
  assert.equal(source.total, 513);
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  try { assert.deepEqual([...await lib.originalBytes('blob:http://localhost/abc')], [1, 2, 3]); } finally { globalThis.fetch = previous; }
  assert.equal(await lib.originalBytes('studyhub-pages:forgotten'), null, 'a marker nobody registered has no bytes');
});

test('a page of the source is asked for by number, one page at a time, and comes back as bytes', async () => {
  const world = backend();
  const source = await lib.originalBytes(lib.pagedFileUrl(world.call, PAGED));
  const bytes = await source.fetchPage(42);
  assert.equal(Buffer.from(bytes).toString(), 'page-42');
  assert.deepEqual(world.asked, [['materials.document.pages', { documentId: 'doc-1', revision: 'rev-1', from: 42, to: 42 }]]);
  await assert.rejects(source.fetchPage(99999), /original/i, 'a missing original is said, not drawn blank');
});

test('the paged renderer answers like the one of a whole file: the page count, the size, the drawing, the words; each page opens its own small PDF', async () => {
  const world = backend(), fake = fakeOpen();
  const source = await lib.originalBytes(lib.pagedFileUrl(world.call, PAGED));
  const renderer = await lib.createPagedRenderer(source, fake.open);
  assert.equal(renderer.numPages, 513);
  assert.deepEqual(await renderer.render(7, { scale: 1.5 }), { bitmap: 'page-7', number: 1, scale: 1.5 }, 'the single-page PDF is drawn as its page 1');
  assert.deepEqual(await renderer.pageSize(7), { width: 612, height: 792 });
  assert.deepEqual(renderer.cachedPageSize(7), { width: 612, height: 792 });
  const words = await renderer.textLayer(7, { scale: 1 });
  assert.equal(words.number, 1);
  assert.deepEqual(world.asked.map(([, args]) => args.from), [7], 'one request served the drawing, the size and the words of page 7');
  assert.deepEqual(fake.opened, ['page-7']);
  assert.equal(typeof renderer.assetStats().totalMs, 'number');
});

test('only a few pages stay open: the oldest is closed, and everything is closed with the renderer', async () => {
  const world = backend(), fake = fakeOpen();
  const renderer = await lib.createPagedRenderer(await lib.originalBytes(lib.pagedFileUrl(world.call, PAGED)), fake.open);
  for (const page of [1, 2, 3, 4, 5, 6]) await renderer.render(page, {});
  assert.ok(fake.opened.length === 6);
  assert.ok(fake.destroyed.length >= 3, `older pages are closed (${fake.destroyed.length})`);
  assert.ok(fake.opened.length - fake.destroyed.length <= 3, 'never many pages open at once');
  await renderer.render(6, {});
  assert.equal(fake.opened.length, 6, 'a page just drawn is not fetched again');
  await renderer.destroy();
  assert.equal(fake.opened.length, fake.destroyed.length);
});

test('two draws of one page at the same moment fetch it once', async () => {
  const world = backend(), fake = fakeOpen();
  const renderer = await lib.createPagedRenderer(await lib.originalBytes(lib.pagedFileUrl(world.call, PAGED)), fake.open);
  await Promise.all([renderer.render(9, {}), renderer.pageSize(9), renderer.textLayer(9, {})]);
  assert.equal(world.asked.length, 1);
  assert.equal(fake.opened.length, 1);
});

test('createPeekRenderer takes a page source as it takes bytes (the 原始 PDF view, 看原页 and the picture of a page all open it this way)', async () => {
  const world = backend();
  const source = await lib.originalBytes(lib.pagedFileUrl(world.call, PAGED));
  const opened = await lib.createPeekRenderer(source, {});
  assert.equal(opened.numPages, 513);
  await opened.destroy();
});

test('the picture of a page for 发给主会话 is drawn from a paged original too', async () => {
  const world = backend(), fake = fakeOpen();
  const source = await lib.originalBytes(lib.pagedFileUrl(world.call, PAGED));
  const encoded = [];
  const files = await lib.renderPageImages({ pages: [218], totalPages: 513, loadBytes: async () => source,
    openRenderer: async given => lib.createPagedRenderer(given, fake.open),
    encode: async (bitmap, name) => { encoded.push(bitmap); return { name }; } });
  assert.equal(files.length, 1);
  assert.deepEqual(encoded.map(item => item.bitmap), ['page-218']);
});
