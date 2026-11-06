/* 补全原文件 for a very big file: a file dropped or picked in the browser is copied (base64), so over the copy limit it is not taken but the learner is pointed at the
   path (which copies nothing and has no limit); the checks that cannot read a big file say so plainly; a book converted from a path is offered its file again with one
   click. Pure logic and static markup, in Chinese and English; the focus move and the layout are checked in the browser (tests/original-by-path-browser.test.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const han = /[\u3400-\u9fff]/;
const compiled = await build({ stdin: { contents: `
  export * from './ui/document-preview/original-file.js';
  export { OriginalDialog } from './ui/document-preview/OriginalFile.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' } });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const lib = module.exports;
const h = React.createElement, text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const inLanguage = (language, run) => { try { lib.setUiLanguage(language); return run(); } finally { lib.setUiLanguage('zh'); } };
const noop = () => {};
const MB = 1024 * 1024;

const target = { documentId: 'document-1', title: 'Software Engineering', format: 'pdf' };
const none = { mode: null, status: 'none' };
const BOOK = 'D:\\Books\\Software Engineering.pdf';
const dialog = (initial, props = {}) => renderToStaticMarkup(h(lib.OriginalDialog, { target, call: noop, onClose: noop, onChanged: noop, initial, ...props }));

test('only a file the browser would have to copy is too big for it: over the copy limit, and the limit is the host\'s', () => {
  assert.equal(lib.tooBigForBrowser({ size: lib.ORIGINAL_MAX_BYTES }), false);
  assert.equal(lib.tooBigForBrowser({ size: lib.ORIGINAL_MAX_BYTES + 1 }), true);
  assert.equal(lib.tooBigForBrowser({ size: 485 * MB }), true);
  assert.equal(lib.tooBigForBrowser(null), false);
});

test('a file the checks could not read says so plainly, and the conversion record that names it is said as such', () => {
  const unchecked = { verdict: 'unchecked', accepted: false, pages: { stored: 513, supplied: null, match: null }, checked: 0, matched: 0, similarity: 0, reasons: ['too-large'], bytes: 485 * MB };
  const recorded = { verdict: 'match', accepted: true, basis: 'conversion-record', pages: { stored: 513, supplied: null, match: null }, checked: 0, matched: 0, similarity: 1, reasons: [], bytes: 485 * MB };
  assert.deepEqual(lib.reportHeadline(unchecked), { tone: 'warning', text: '文件太大，没有逐页核对文字。确认是同一份资料后，仍可以只记路径' });
  assert.deepEqual(lib.reportHeadline(recorded), { tone: 'success', text: '核对通过：文件名和大小与转换时的文件一致' });
  assert.deepEqual(lib.reportLines(unchecked), [], 'no figures that were never measured');
  assert.deepEqual(lib.reportLines(recorded), []);
  inLanguage('en', () => {
    assert.equal(lib.reportHeadline(unchecked).text, 'The file is too big to be checked page by page. Once you confirm it is the same material, you can still just remember its location');
    assert.equal(lib.reportHeadline(recorded).text, 'Check passed: the file name and size match the file that was converted');
  });
});

test('a copy is not offered for a file over the limit; remembering where it is stays the choice, with the reason', () => {
  const small = lib.modeOptions({ size: 20 * MB, hasPath: true });
  assert.equal(small[1].disabled, false);
  const big = lib.modeOptions({ size: 485 * MB, hasPath: true });
  assert.equal(big[0].disabled, false);
  assert.equal(big[1].disabled, true);
  assert.equal(big[1].note, '太大了，不能复制进资料库（最多 40 MB）；只记住位置就好。');
  assert.equal(lib.canAttach({ phase: 'verified', report: { accepted: true }, picked: { kind: 'path', path: BOOK }, mode: 'reference', confirmed: false }), true);
  inLanguage('en', () => assert.equal(lib.modeOptions({ size: 485 * MB, hasPath: true })[1].note, 'Too big to copy into the library (at most 40 MB); remembering the location is enough.'));
});

test('the copy limit is explained in the learner\'s words, and where the rule changed, the old words are gone', () => {
  assert.equal(lib.explainFailure('Document must be a file of at most 40 MB'), '复制进资料库最多 40 MB；更大的文件请只记住位置（填写完整路径）');
  inLanguage('en', () => assert.equal(lib.explainFailure('Document must be a file of at most 40 MB'), 'A copy in the library can be at most 40 MB; for a bigger file, remember its location instead (enter the full path)'));
});

test('a dropped file over the limit: one short sentence naming it, the path field and the picker still there, no extra rule in a title attribute', () => {
  const html = dialog({ info: none, tooBig: { name: 'Software Engineering.pdf', size: 485 * MB } }, { host: { pickFile: noop } });
  const words = text(html);
  assert.match(words, /Software Engineering\.pdf/);
  assert.match(words, /485 MB/);
  assert.match(words, /浏览器没法复制这么大的文件。请在上面填写路径，或点「选择文件…」，只记住它的位置/);
  assert.match(html, /<input[^>]*aria-label="原文件的完整路径"/, 'the path field is where the learner goes on');
  // without a native picker the only "选择文件…" is the browser's, which copies: it is not recommended
  assert.doesNotMatch(text(dialog({ info: none, tooBig: { name: 'a.pdf', size: 485 * MB } })), /或点「选择文件…」/);
  assert.match(text(dialog({ info: none, tooBig: { name: 'a.pdf', size: 485 * MB } })), /请在上面填写完整路径，只记住它的位置/);
  assert.match(html, /role="alert"/);
  // the long explanation lives in the hover card, not in a title attribute and not on the page
  assert.match(words, /拖入或从浏览器选择的文件要先整个复制一遍/);
  assert.doesNotMatch(html, /title="[^"]*复制/);
});

test('no message about a big file before one was dropped', () => {
  const words = text(dialog({ info: none }));
  assert.doesNotMatch(words, /浏览器没法复制/);
  assert.match(words, /或把文件拖到这里（浏览器不提供路径，只能复制）/);
  assert.match(words, /复制最多 40 MB/, 'the drop zone says its own limit up front');
});

test('a book that remembers the file it was converted from offers it with one button, until a file is chosen', () => {
  const info = { ...none, convertedFrom: { path: BOOK, bytes: 485 * MB, filename: 'Software Engineering.pdf' } };
  const html = dialog({ info });
  assert.match(text(html), /这本书是从 Software Engineering\.pdf（485 MB）转换来的，文件还在原处/);
  assert.match(html, /<button[^>]*>[^<]*使用转换时的原文件/);
  const chosen = dialog({ info, picked: { kind: 'path', path: BOOK, size: 485 * MB }, phase: 'verifying' });
  assert.doesNotMatch(text(chosen), /使用转换时的原文件/);
  assert.doesNotMatch(text(dialog({ info: none })), /使用转换时的原文件/, 'no record, no offer');
  assert.doesNotMatch(text(dialog({ info: { mode: 'reference', status: 'ok', path: BOOK, bytes: 1, format: 'pdf', convertedFrom: info.convertedFrom } })), /使用转换时的原文件/);
});

test('every new sentence has an English counterpart', () => {
  inLanguage('en', () => {
    const states = [{ info: none, tooBig: { name: 'Software Engineering.pdf', size: 485 * MB } },
      { info: { ...none, convertedFrom: { path: BOOK, bytes: 485 * MB, filename: 'Software Engineering.pdf' } } },
      { info: none, picked: { kind: 'path', path: BOOK, size: 485 * MB }, phase: 'verified', mode: 'reference', confirmed: false,
        report: { verdict: 'unchecked', accepted: false, pages: { stored: 513, supplied: null, match: null }, checked: 0, matched: 0, similarity: 0, reasons: ['too-large'], bytes: 485 * MB } },
      { info: none, picked: { kind: 'path', path: BOOK, size: 485 * MB }, phase: 'verified', mode: 'reference',
        report: { verdict: 'match', accepted: true, basis: 'conversion-record', pages: { stored: 513, supplied: null, match: null }, checked: 0, matched: 0, similarity: 1, reasons: [], bytes: 485 * MB } }];
    for (const state of states) assert.doesNotMatch(dialog(state).replaceAll(BOOK, ''), han, JSON.stringify(state).slice(0, 80));
    const words = text(dialog(states[0]));
    assert.match(words, /The browser cannot copy a file this big/);
    assert.match(text(dialog(states[0], { host: { pickFile: noop } })), /or use Choose file…/);
    assert.match(text(dialog(states[1])), /Use the file it was converted from/);
  });
});
