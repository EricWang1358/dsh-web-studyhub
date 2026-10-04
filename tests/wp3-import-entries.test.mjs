import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// P20 / P25: every remaining file entry is the shared FileDrop (localized
// button, drag and drop, per-file status) instead of a native input whose
// text follows the browser language, and the PDF summary no longer says
// “0 pages have too little text” next to “pages 2–4 have very little text”.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as DocumentImport } from './ui/document-preview/DocumentImport.jsx';
  export { default as ImportHub, itemDetail } from './ui/ImportHub.jsx'; export { default as JsonImport } from './ui/JsonImport.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { DocumentImport, ImportHub, itemDetail, JsonImport, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const data = { root: 'lib', sources: [], decks: [], drafts: [], focus: { course: 'Systems', courses: [{ name: 'Systems' }] } };
const h = React.createElement;
const visibleText = html => html.replace(/<[^>]+>/g, ' ');

test('document, hub and JSON entries use the shared drop zone with a localized button', () => {
  setUiLanguage('zh');
  const documents = renderToStaticMarkup(h(DocumentImport, { act() {}, call: async () => ({}) }));
  const pdf = renderToStaticMarkup(h(ImportHub, { data, call: async () => ({}) }));
  const json = renderToStaticMarkup(h(JsonImport, { data, act() {}, call: async () => ({}), openDraft() {}, setNotice() {} }));
  for (const [name, html] of [['document', documents], ['pdf', pdf], ['json', json]]) {
    assert.match(html, /class="[^"]*sh-drop/, `${name} uses FileDrop`);
    assert.match(html, /<input[^>]*type="file"[^>]*hidden/, `${name} keeps its native input hidden`);
    assert.match(visibleText(html), /选择/, `${name} has a real, localized button`);
  }
  assert.match(documents, /multiple/, 'several documents at once');
  assert.match(documents, /accept="\.pdf,\.md,\.markdown,\.html,\.htm,\.txt"/);
  assert.match(pdf, /accept="\.pdf,\.docx,\.pptx,/);
  assert.match(json, /accept="\.json,\.txt"/);
  setUiLanguage('en');
  try {
    const english = [renderToStaticMarkup(h(DocumentImport, { act() {}, call: async () => ({}) })),
      renderToStaticMarkup(h(ImportHub, { data, call: async () => ({}) }))];
    for (const html of english) assert.doesNotMatch(visibleText(html).replace(/Systems/g, ''), han);
  } finally { setUiLanguage('zh'); }
});

test('a document import reports its skipped pages once, next to what was saved (P25, moved from the retired PdfImport)', () => {
  setUiLanguage('zh');
  const pdf = (skippedPages) => ({ status: 'done', kind: 'document', result: { kind: 'document', format: 'pdf', sourceIds: ['a', 'b'], skippedPages } });
  const skipped = itemDetail(pdf([3, 5]));
  assert.match(skipped, /第 3、5 页没有文字，已跳过/);
  assert.match(skipped, /PDF/);
  const clean = itemDetail(pdf([]));
  assert.match(clean, /已保存到资料/);
  assert.doesNotMatch(clean, /跳过/);
  setUiLanguage('en');
  try {
    assert.doesNotMatch(itemDetail(pdf([3])), han);
    assert.doesNotMatch(itemDetail(pdf([])), han);
  } finally { setUiLanguage('zh'); }
});
