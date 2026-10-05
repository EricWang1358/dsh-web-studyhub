/* 看原页 on a scanned book (2.6.1). A large scanned textbook showed a nearly blank page in the peek while the 原始 PDF tab was perfect:
   scans are JBIG2 / CCITT / JPX images and the browser-side pdf.js was opened without its wasm decoders, its CMaps and its standard
   fonts, so it dropped every such image without a word. DSH serves a plugin's client.*.js chunks only, so the assets travel as
   lazily loaded chunks and reach pdf.js through a BinaryDataFactory. This file checks: the pure parts (which asset a request is,
   the factory, the options pdf.js is opened with, which images failed, what the popover says), that the committed asset modules are
   exactly what pdfjs-dist ships, and that the main bundle did not grow. The real decoding is checked in a browser:
   tests/page-peek-decode.test.mjs. No network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const han = /[㐀-鿿]/;
// pdf.js itself is not needed to check the wiring: a stub stands in for it (and for its worker) in this bundle.
const stubPdfjs = { name: 'stub-pdfjs', setup(builder) {
  builder.onResolve({ filter: /^pdfjs-dist\// }, args => ({ path: args.path, namespace: 'stub-pdfjs' }));
  builder.onLoad({ filter: /.*/, namespace: 'stub-pdfjs' }, () => ({ contents: 'export const getDocument = () => { throw new Error("stub"); }; export const WorkerMessageHandler = {};', loader: 'js' }));
} };
const compiled = await build({ stdin: { contents: `
  export * from './ui/document-preview/peek/peek-logic.js';
  export * from './ui/document-preview/peek/pdf-assets.js';
  export * from './ui/document-preview/peek/renderer.js';
  export { default as PagePeekView } from './ui/document-preview/peek/PagePeekView.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, plugins: [stubPdfjs], logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const lib = module.exports;
const h = React.createElement, noop = () => {};
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const inLanguage = (language, run) => { try { lib.setUiLanguage(language); return run(); } finally { lib.setUiLanguage('zh'); } };

/* ---------- which asset is a request ---------- */

test('pdf.js asks for wasm decoders, CMaps and standard fonts by file name; only what is shipped is answered', () => {
  const { assetRequest } = lib;
  assert.deepEqual(assetRequest('wasmUrl', 'jbig2.wasm'), { type: 'wasm', name: 'jbig2' }, 'JBIG2 and CCITT scans');
  assert.deepEqual(assetRequest('wasmUrl', 'openjpeg.wasm'), { type: 'wasm', name: 'openjpeg' }, 'JPX scans');
  assert.equal(assetRequest('wasmUrl', 'qcms_bg.wasm'), null, 'ICC colour is not shipped: pdf.js falls back to the alternate colour space');
  assert.equal(assetRequest('wasmUrl', '../jbig2.wasm'), null);
  assert.deepEqual(assetRequest('cMapUrl', 'UniGB-UCS2-H.bcmap'), { type: 'cmap', name: 'UniGB-UCS2-H', group: 'gb' });
  assert.deepEqual(assetRequest('cMapUrl', 'Adobe-Japan1-UCS2.bcmap'), { type: 'cmap', name: 'Adobe-Japan1-UCS2', group: 'japan' });
  assert.equal(assetRequest('cMapUrl', 'UniGB-UTF8-H.bcmap'), null, 'the UTF8 and UTF32 CMaps are not PDF predefined CMaps');
  assert.equal(assetRequest('cMapUrl', 'UniGB-UCS2-H'), null, 'only the packed .bcmap files');
  assert.equal(assetRequest('cMapUrl', '../../secret.bcmap'), null);
  assert.deepEqual(assetRequest('standardFontDataUrl', 'FoxitSymbol.pfb'), { type: 'font', name: 'FoxitSymbol.pfb' });
  assert.deepEqual(assetRequest('standardFontDataUrl', 'FoxitDingbats.pfb'), { type: 'font', name: 'FoxitDingbats.pfb' });
  assert.equal(assetRequest('standardFontDataUrl', 'LiberationSans-Regular.ttf'), null, 'with system fonts on, only Symbol and ZapfDingbats are ever asked for');
  assert.equal(assetRequest('somethingElse', 'jbig2.wasm'), null);
});

test('every CMap belongs to exactly one script group, so one scanned Chinese book loads only the Chinese CMaps', () => {
  const { cmapGroup, shipsCMap, CMAP_GROUPS } = lib;
  assert.deepEqual([...CMAP_GROUPS], ['gb', 'cns', 'japan', 'korea']);
  const samples = { 'GBK-EUC-H': 'gb', 'GBpc-EUC-V': 'gb', 'UniGB-UTF16-H': 'gb', 'Adobe-GB1-UCS2': 'gb', 'Adobe-GB1-5': 'gb',
    'UniCNS-UCS2-H': 'cns', 'ETen-B5-H': 'cns', 'B5pc-V': 'cns', 'HKscs-B5-H': 'cns', 'CNS-EUC-H': 'cns', 'Adobe-CNS1-3': 'cns',
    'UniJIS-UCS2-H': 'japan', '90ms-RKSJ-H': 'japan', 'EUC-H': 'japan', 'H': 'japan', 'V': 'japan', 'Katakana': 'japan', 'Adobe-Japan1-UCS2': 'japan', 'NWP-H': 'japan',
    'UniKS-UCS2-H': 'korea', 'KSCms-UHC-H': 'korea', 'Adobe-Korea1-0': 'korea' };
  for (const [name, group] of Object.entries(samples)) { assert.equal(shipsCMap(name), true, name); assert.equal(cmapGroup(name), group, name); }
  for (const name of ['UniGB-UTF8-H', 'UniGB-UTF32-V', 'UniJIS2004-UTF8-H', 'UniKS-UTF32-H', 'UniCNS-UTF8-V']) assert.equal(shipsCMap(name), false, name);
  for (const name of ['', '../x', 'a/b', 'a b', 'UniGB-UCS2-H.bcmap']) assert.equal(shipsCMap(name), false, JSON.stringify(name));
});

/* ---------- the factory pdf.js asks for bytes ---------- */

test('the binary data factory answers pdf.js from the loaders, a fresh copy each time, and refuses what it does not ship', async () => {
  const calls = [], jbig2 = new Uint8Array([0, 97, 115, 109, 1]);
  const Factory = lib.createBinaryDataFactory({
    wasm: async request => { calls.push(['wasm', request.name]); return jbig2; },
    cmap: async request => { calls.push(['cmap', request.name, request.group]); return new Uint8Array([1, 2, 3]); },
    font: async request => { calls.push(['font', request.name]); return new Uint8Array([4]); },
  });
  const factory = new Factory({ cMapUrl: null, standardFontDataUrl: null, wasmUrl: null });
  const wasm = await factory.fetch({ kind: 'wasmUrl', filename: 'jbig2.wasm' });
  assert.deepEqual([...wasm], [...jbig2]);
  assert.notEqual(wasm, jbig2, 'a copy: pdf.js may transfer what it gets, and the loaders keep theirs');
  assert.deepEqual([...await factory.fetch({ kind: 'cMapUrl', filename: 'GBK-EUC-H.bcmap' })], [1, 2, 3]);
  assert.deepEqual([...await factory.fetch({ kind: 'standardFontDataUrl', filename: 'FoxitSymbol.pfb' })], [4]);
  assert.deepEqual(calls, [['wasm', 'jbig2'], ['cmap', 'GBK-EUC-H', 'gb'], ['font', 'FoxitSymbol.pfb']]);
  await assert.rejects(factory.fetch({ kind: 'wasmUrl', filename: 'qcms_bg.wasm' }), /qcms_bg\.wasm/);
  await assert.rejects(factory.fetch({ kind: 'cMapUrl', filename: 'UniGB-UTF8-H.bcmap' }), /UniGB-UTF8-H/);
  assert.equal(calls.length, 3, 'a refused request never reaches a loader');
  const broken = new (lib.createBinaryDataFactory({ wasm: async () => { throw new Error('chunk failed'); } }))({});
  await assert.rejects(broken.fetch({ kind: 'wasmUrl', filename: 'openjpeg.wasm' }), /openjpeg\.wasm.*chunk failed|chunk failed/);
  await assert.rejects(new (lib.createBinaryDataFactory({ wasm: async () => 'not bytes' }))({}).fetch({ kind: 'wasmUrl', filename: 'jbig2.wasm' }), /jbig2\.wasm/);
});

test('base64 asset text is decoded to the same bytes', () => {
  assert.deepEqual([...lib.decodeBase64('AGFzbQE=')], [0, 97, 115, 109, 1]);
  assert.deepEqual([...lib.decodeBase64('')], []);
  assert.deepEqual([...lib.decodeBase64(Buffer.from([255, 0, 128, 7]).toString('base64'))], [255, 0, 128, 7]);
});

test('pdf.js is opened with the data factory (never worker fetch, which would need real URLs), and keeps the light options', () => {
  class Factory {}
  const options = lib.peekDocumentOptions(new Uint8Array([1, 2]), Factory);
  assert.equal(options.BinaryDataFactory, Factory);
  assert.equal(options.useWorkerFetch, false, 'the host serves no static files: the bytes come through the factory');
  assert.equal(options.useWasm, true);
  assert.deepEqual([options.isEvalSupported, options.useSystemFonts, options.enableXfa], [false, true, false]);
  assert.deepEqual([...options.data], [1, 2]);
  for (const url of ['wasmUrl', 'cMapUrl', 'standardFontDataUrl', 'iccUrl']) assert.equal(options[url], undefined, `${url} points nowhere`);
  assert.ok(options.verbosity <= 1, 'quiet');
});

/* ---------- the renderer: a fake pdf.js ---------- */

function fakePdfjs({ objs = [], commonObjs = [] } = {}) {
  const seen = { options: null, rendered: 0, cleaned: 0, destroyed: 0 };
  const page = {
    objs, commonObjs, getViewport: ({ scale }) => ({ width: 100 * scale, height: 200 * scale }), cleanup() { seen.cleaned += 1; },
    render() { seen.rendered += 1; return { promise: Promise.resolve(), cancel() {} }; },
  };
  const pdfjs = { getDocument(options) { seen.options = options; return { promise: Promise.resolve({ numPages: 3, getPage: async () => page }), destroy: async () => { seen.destroyed += 1; } }; } };
  return { pdfjs, seen };
}

test('the renderer opens the document with the factory that carries the decoders', async () => {
  const { pdfjs, seen } = fakePdfjs();
  const renderer = await lib.createPeekRenderer(new Uint8Array([9]), { pdfjs });
  assert.equal(renderer.numPages, 3);
  assert.equal(typeof seen.options.BinaryDataFactory, 'function');
  assert.equal(typeof seen.options.BinaryDataFactory.prototype.fetch, 'function');
  assert.equal(seen.options.useWorkerFetch, false);
  assert.equal(seen.options.wasmUrl, undefined);
  await renderer.destroy();
  assert.equal(seen.destroyed, 1);
});

test('the renderer reports the images pdf.js could not decode (it keeps null for them and draws nothing), page and shared ones', () => {
  const { undecodedImages } = lib;
  assert.deepEqual(undecodedImages([['img_p0_1', {}], ['img_p0_2', null]]), ['img_p0_2']);
  assert.deepEqual(undecodedImages([['img_p0_1', null]], [['g_d0_img_1', null], ['g_d0_f1', 'a font error text'], ['g_d0_f2', {}]]), ['img_p0_1', 'g_d0_img_1'],
    'a font that failed is a string, not a failed image');
  assert.deepEqual(undecodedImages([['a', {}], ['b', { width: 1 }]], []), []);
  assert.deepEqual(undecodedImages(undefined, null), [], 'nothing to look at is nothing failed');
  assert.deepEqual(undecodedImages(new Map([['x', null]])), ['x'], 'any iterable of pairs, like pdf.js\'s own object store');
});

test('render() tells the caller how many images of the page did not decode, before the page is let go', async () => {
  globalThis.document = { createElement: () => ({ getContext: () => ({}), width: 0, height: 0 }) };
  globalThis.createImageBitmap = async () => ({ width: 10, height: 20, close() {} });
  try {
    const bad = fakePdfjs({ objs: [['img_p0_1', null]], commonObjs: [['g_d0_img_2', null]] });
    const first = await lib.createPeekRenderer(new Uint8Array([9]), { pdfjs: bad.pdfjs });
    const reports = [];
    const bitmap = await first.render(1, { scale: 1, onReport: report => reports.push({ ...report, cleaned: bad.seen.cleaned }) });
    assert.equal(bitmap.width, 10);
    assert.deepEqual(reports, [{ undecoded: 2, cleaned: 0 }], 'read while the page still holds its objects');
    const good = fakePdfjs({ objs: [['img_p0_1', {}]] });
    const second = await lib.createPeekRenderer(new Uint8Array([9]), { pdfjs: good.pdfjs });
    const clean = [];
    await second.render(1, { scale: 1, onReport: report => clean.push(report) });
    assert.deepEqual(clean, [{ undecoded: 0 }]);
    await second.render(1, { scale: 1 });
  } finally { delete globalThis.document; delete globalThis.createImageBitmap; }
});

/* ---------- what the popover says ---------- */

test('only an image that failed makes the popover say so; the words and the button are fixed', () => {
  const { peekNotice } = lib;
  assert.equal(peekNotice({ undecoded: 0 }), null);
  assert.equal(peekNotice(undefined), null);
  assert.equal(peekNotice({ undecoded: -1 }), null);
  assert.deepEqual(peekNotice({ undecoded: 1 }), { kind: 'undecoded-images', count: 1 });
  assert.deepEqual(peekNotice({ undecoded: 7 }), { kind: 'undecoded-images', count: 7 });
});

const base = { page: 3, total: 12, zoom: 1, onClose: noop, onPrev: noop, onNext: noop, onZoom: noop, onFit: noop, onAttach: noop, onRetry: noop };
const view = props => renderToStaticMarkup(h(lib.PagePeekView, { ...base, ...props }));

test('a page with an image that could not be drawn says so and offers the 原始 PDF tab, instead of looking blank', () => {
  const html = view({ phase: 'ready', undecoded: 2, onShowOriginal: noop });
  assert.match(text(html), /这一页的图像无法在预览中显示，请在「原始 PDF」里查看/);
  assert.match(html, /<canvas/, 'what did draw stays visible');
  assert.match(html, /role="status"[^>]*data-peek-notice="undecoded-images"|data-peek-notice="undecoded-images"[^>]*role="status"/);
  assert.match(html, /<button[^>]*>[^<]*(?:<[^>]+>)*查看原始 PDF/, 'a button, not just words');
  assert.doesNotMatch(view({ phase: 'ready', undecoded: 0, onShowOriginal: noop }), /无法在预览中显示|data-peek-notice/);
  assert.doesNotMatch(view({ phase: 'ready', onShowOriginal: noop }), /无法在预览中显示/);
  assert.doesNotMatch(view({ phase: 'error', message: 'x', undecoded: 3 }), /无法在预览中显示/, 'only a page that is showing');
  assert.doesNotMatch(view({ phase: 'ready', undecoded: 2 }), /<button[^>]*>[^<]*查看原始 PDF/, 'without a way to switch there is no button, only the words');
  assert.match(text(view({ phase: 'ready', undecoded: 2 })), /这一页的图像无法在预览中显示/);
});

test('the notice and its button have English words and no Chinese left', () => {
  inLanguage('en', () => {
    const html = view({ phase: 'ready', undecoded: 1, onShowOriginal: noop });
    assert.match(text(html), /The images on this page cannot be shown in the preview\. Please look at it in the (?:"|&quot;)Original PDF(?:"|&quot;) tab\./);
    assert.match(html, /View original PDF/);
    assert.doesNotMatch(text(html), han);
    for (const attribute of html.match(/aria-label="[^"]*"|title="[^"]*"/g) || []) assert.doesNotMatch(attribute, han, attribute);
  });
});

/* ---------- the committed assets are what pdfjs-dist ships ---------- */

const peekDir = new URL('../ui/document-preview/peek/', import.meta.url);

test('the asset modules in ui/document-preview/peek/assets are exactly what scripts/pdf-assets.mjs makes from pdfjs-dist', async () => {
  const { assetModules } = await import('../scripts/pdf-assets.mjs');
  const modules = await assetModules();
  assert.deepEqual([...modules.keys()].sort(), ['cmaps-cns.js', 'cmaps-gb.js', 'cmaps-japan.js', 'cmaps-korea.js', 'fonts.js', 'wasm-jbig2.js', 'wasm-openjpeg.js']);
  for (const [name, expected] of modules) {
    const actual = await readFile(new URL(`assets/${name}`, peekDir), 'utf8');
    assert.equal(actual, expected, `${name} is out of date: run node scripts/pdf-assets.mjs --write after upgrading pdfjs-dist`);
  }
  const listed = (await readdir(new URL('assets/', peekDir))).sort();
  assert.deepEqual(listed, [...modules.keys()].sort(), 'no stray file in the assets directory');
});

test('the shipped CMaps are the PDF predefined ones, and every CMap one of them continues from (usecmap) is shipped too', async () => {
  const dir = join(process.cwd(), 'node_modules', 'pdfjs-dist', 'cmaps');
  const all = (await readdir(dir)).filter(file => file.endsWith('.bcmap')).map(file => basename(file, '.bcmap'));
  const shipped = all.filter(lib.shipsCMap);
  assert.ok(shipped.length > 100 && shipped.length < all.length, `${shipped.length} of ${all.length}`);
  const left = all.filter(name => !lib.shipsCMap(name));
  assert.ok(left.length > 0 && left.every(name => /-UTF(8|32)-[HV]$/.test(name)), 'only UTF8 and UTF32 are left out');
  for (const name of shipped) {
    const bytes = await readFile(join(dir, `${name}.bcmap`));
    const latin = bytes.toString('latin1');
    for (const other of left) assert.ok(!latin.includes(other), `${name} continues from ${other}, which is not shipped`);
  }
});

/* ---------- the main bundle did not grow ---------- */

test('the assets are separate chunks loaded on demand: nothing of pdf.js or its assets is in what the host loads at start', async () => {
  const { buildHostClient } = await import('../scripts/build.mjs');
  const result = await buildHostClient({ write: false });
  const outputs = new Map(Object.entries(result.metafile.outputs).map(([path, output]) => [basename(path), output]));
  const sizeOf = name => result.outputFiles.find(file => basename(file.path) === name).contents.length;
  const staticClosure = new Set();
  const visit = name => {
    if (staticClosure.has(name)) return;
    staticClosure.add(name);
    for (const edge of outputs.get(name).imports) if (!edge.external && edge.kind === 'import-statement') visit(basename(edge.path));
  };
  visit('client.js');
  const inputsOf = name => Object.keys(outputs.get(name).inputs);
  const assetInput = path => /document-preview[\\/]peek[\\/]assets[\\/]/.test(path);
  const assetChunks = [...outputs.keys()].filter(name => inputsOf(name).some(assetInput));
  assert.ok(assetChunks.length >= 7, `the wasm, font and CMap modules are chunks of their own (${assetChunks.length})`);
  for (const name of staticClosure) {
    assert.ok(!inputsOf(name).some(path => assetInput(path) || /node_modules[\\/]pdfjs-dist/.test(path)), `${name} loads at start but holds pdf.js or its assets`);
  }
  for (const name of assetChunks) assert.ok(!staticClosure.has(name), `${name} is loaded at start`);
  // Only the peek reaches the assets, and through dynamic imports: the reader's own chunks gain nothing.
  const peekChunk = [...outputs.keys()].find(name => inputsOf(name).some(path => /peek[\\/]PagePeek\.jsx$/.test(path)));
  assert.ok(peekChunk, 'the peek is its own chunk');
  const reachedStatically = new Set();
  const walk = name => { if (reachedStatically.has(name)) return; reachedStatically.add(name); for (const edge of outputs.get(name).imports) if (!edge.external && edge.kind === 'import-statement') walk(basename(edge.path)); };
  walk(peekChunk);
  for (const name of assetChunks) assert.ok(!reachedStatically.has(name), `${name} is statically imported by the peek: it must load only when pdf.js asks`);
  const startBytes = [...staticClosure].reduce((sum, name) => sum + sizeOf(name), 0);
  const peekOwn = [...reachedStatically].reduce((sum, name) => sum + sizeOf(name), 0);
  const assetBytes = assetChunks.reduce((sum, name) => sum + sizeOf(name), 0);
  assert.ok(assetBytes > 1_000_000, `the assets are real data (${assetBytes} bytes)`);
  assert.ok(peekOwn < 3_000_000, `the peek's own static chunks stay about pdf.js's size, without the assets (${peekOwn} bytes)`);
  console.log(`# start closure ${startBytes} bytes; peek chunks ${peekOwn} bytes; asset chunks ${assetBytes} bytes in ${assetChunks.length} files`);
});
