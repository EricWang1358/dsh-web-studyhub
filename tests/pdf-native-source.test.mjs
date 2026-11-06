/* A big PDF for the local converters goes by PATH when the host has a native file dialog (host.pickFile): nothing is copied through the browser, the plan and the import
   take the path, and the finished book is linked to that very file as its original (lib/contexts/audio/pdf/keep-original.js). Without a native dialog the browser file is
   uploaded in pieces, as before. Pure logic and static markup; the whole flow in the real host is not testable here. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const compiled = await build({ stdin: { contents: `
  export * from './ui/pdf-source.js';
  export { default as PdfConversion } from './ui/PdfConversion.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const lib = module.exports;
const h = React.createElement, text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const MB = 1024 * 1024;
const BOOK = 'D:\\Books\\Software Engineering.pdf';

/** A backend that records what it is asked, and answers a plan. */
function backend() {
  const calls = [];
  const call = async (action, args = {}) => {
    calls.push([action, args]);
    if (action === 'mineru.upload.start') return { uploadId: 'up-1', chunkBytes: 1024 * 1024 };
    if (action === 'mineru.plan') return { pages: 513, bytes: 485 * MB, windows: [] };
    return {};
  };
  return { calls, call, actions: () => calls.map(([action]) => action) };
}

test('a host with a native file dialog is asked for a PDF path; the answer is a source that is a path, never a copy', async () => {
  assert.equal(lib.canPickNative({ pickFile() {} }), true);
  assert.equal(lib.canPickNative({}), false);
  assert.equal(lib.canPickNative(undefined), false);
  const asked = [];
  const source = await lib.pickNativePdf({ pickFile: async options => { asked.push(options); return { path: `"${BOOK}"`, size: 485 * MB }; } });
  assert.deepEqual(asked, [{ extensions: ['pdf'] }]);
  assert.deepEqual(source, { path: BOOK, name: 'Software Engineering.pdf', size: 485 * MB, native: true });
  assert.equal(lib.isNativeSource(source), true);
  assert.equal(lib.isNativeSource({ name: 'x.pdf', size: 1 }), false, 'a browser file is not a path');
  assert.deepEqual(await lib.pickNativePdf({ pickFile: async () => BOOK }), { path: BOOK, name: 'Software Engineering.pdf', size: undefined, native: true }, 'a host that answers with the bare path');
  assert.equal(await lib.pickNativePdf({ pickFile: async () => null }), null, 'the learner closed the dialog');
});

test('a path source is planned by its path: no upload at all', async () => {
  const world = backend();
  const prepared = await lib.prepareSource(world.call, { path: BOOK, name: 'Software Engineering.pdf', size: 485 * MB, native: true });
  assert.deepEqual(world.calls, [['mineru.plan', { path: BOOK }]]);
  assert.equal(prepared.uploadId, '');
  assert.equal(prepared.plan.pages, 513);
  assert.deepEqual(lib.sourceArgs({ path: BOOK, native: true }, prepared.uploadId), { path: BOOK });
});

test('a browser file is uploaded in pieces and planned by its upload id', async () => {
  const world = backend();
  const file = { name: 'Book.pdf', size: 10, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(10) }), arrayBuffer: async () => new ArrayBuffer(10) };
  const prepared = await lib.prepareSource(world.call, file, {});
  assert.equal(world.actions()[0], 'mineru.upload.start');
  assert.ok(world.actions().includes('mineru.upload.finish'));
  assert.deepEqual(world.calls.at(-1), ['mineru.plan', { uploadId: 'up-1' }]);
  assert.equal(prepared.uploadId, 'up-1');
  assert.deepEqual(lib.sourceArgs(file, prepared.uploadId), { uploadId: 'up-1' });
});

test('a browser file stopped before it was planned does not stay in the DSH home', async () => {
  const world = backend();
  const controller = new AbortController();
  const seen = [];
  const file = { name: 'Book.pdf', size: 10, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(10) }), arrayBuffer: async () => new ArrayBuffer(10) };
  const done = await lib.prepareSource(world.call, file, { signal: controller.signal, onUploaded: id => { seen.push(id); controller.abort(); } });
  assert.equal(done, null);
  assert.deepEqual(seen, ['up-1']);
  assert.ok(world.actions().includes('mineru.upload.cancel'));
  assert.ok(!world.actions().includes('mineru.plan'));
});

const services = host => ({ call: async () => ({}), busy: false, host });
const panel = (props, host) => renderToStaticMarkup(h(lib.StudyServicesContext.Provider, { value: services(host) },
  h(lib.PdfConversion, { available: true, initialLocal: { state: 'ready', tier: 'basic', estimates: {} }, ...props })));

test('the panel shows a chosen path by its name and size, with no reading bar (nothing is read through the browser)', () => {
  lib.setUiLanguage('zh');
  const source = { path: BOOK, name: 'Software Engineering.pdf', size: 485 * MB, native: true };
  const html = panel({ file: source, initialPlan: { pages: 513, bytes: 485 * MB, windows: [] } }, { pickFile() {} });
  const words = text(html);
  assert.match(words, /Software Engineering\.pdf/);
  assert.match(words, /485 MB/);
  assert.doesNotMatch(words, /正在读取这份 PDF/);
  assert.match(words, /开始本地解析/);
});

test('with a native dialog the first press is the native picker; without one it is the browser\'s', () => {
  lib.setUiLanguage('zh');
  const withDialog = panel({}, { pickFile() {} });
  assert.match(withDialog, /data-pick="native"/);
  assert.doesNotMatch(withDialog, /<input[^>]*type="file"/, 'no hidden browser input to copy a file through');
  const without = panel({}, undefined);
  assert.match(without, /data-pick="browser"/);
  assert.match(without, /<input[^>]*type="file"[^>]*accept="\.pdf/);
});

test('a browser file in the panel with a native dialog offers one quiet way to use the path instead; without a dialog it does not', () => {
  lib.setUiLanguage('zh');
  const file = { name: 'Book.pdf', size: 485 * MB };
  assert.match(text(panel({ file, initialPlan: { pages: 513, bytes: 485 * MB, windows: [] } }, { pickFile() {} })), /不复制这个文件：选择本机文件…/);
  assert.doesNotMatch(text(panel({ file, initialPlan: { pages: 513, bytes: 485 * MB, windows: [] } }, undefined)), /选择本机文件/);
  lib.setUiLanguage('en');
  assert.match(text(panel({ file, initialPlan: { pages: 513, bytes: 485 * MB, windows: [] } }, { pickFile() {} })), /Don(?:'|&#x27;)t copy this file: choose it on this computer…/);
  lib.setUiLanguage('zh');
});
