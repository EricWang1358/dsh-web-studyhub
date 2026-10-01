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
  export { default as PdfImport, pdfImportSummary } from './ui/PdfImport.jsx'; export { default as JsonImport } from './ui/JsonImport.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { DocumentImport, PdfImport, pdfImportSummary, JsonImport, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const data = { root: 'lib', sources: [], decks: [], drafts: [], focus: { course: 'Systems', courses: [{ name: 'Systems' }] } };
const h = React.createElement;
const visibleText = html => html.replace(/<[^>]+>/g, ' ');

test('document, PDF and JSON entries use the shared drop zone with a localized button', () => {
  setUiLanguage('zh');
  const documents = renderToStaticMarkup(h(DocumentImport, { act() {}, call: async () => ({}) }));
  const pdf = renderToStaticMarkup(h(PdfImport, { data, act() {}, onImported() {} }));
  const json = renderToStaticMarkup(h(JsonImport, { data, act() {}, call: async () => ({}), openDraft() {}, setNotice() {} }));
  for (const [name, html] of [['document', documents], ['pdf', pdf], ['json', json]]) {
    assert.match(html, /class="[^"]*sh-drop/, `${name} uses FileDrop`);
    assert.match(html, /<input[^>]*type="file"[^>]*hidden/, `${name} keeps its native input hidden`);
    assert.match(visibleText(html), /选择/, `${name} has a real, localized button`);
  }
  assert.match(documents, /multiple/, 'several documents at once');
  assert.match(documents, /accept="\.pdf,\.md,\.markdown,\.html,\.htm,\.txt"/);
  assert.match(pdf, /accept="\.pdf"/);
  assert.match(json, /accept="\.json,\.txt"/);
  setUiLanguage('en');
  try {
    const english = [renderToStaticMarkup(h(DocumentImport, { act() {}, call: async () => ({}) })),
      renderToStaticMarkup(h(PdfImport, { data, act() {}, onImported() {} }))];
    for (const html of english) assert.doesNotMatch(visibleText(html).replace(/Systems/g, ''), han);
  } finally { setUiLanguage('zh'); }
});

test('the PDF summary states extracted, sparse and skipped pages without contradicting itself (P25)', () => {
  setUiLanguage('zh');
  const sparse = pdfImportSummary({ selectedPages: [2, 3, 4], sourceIds: ['a', 'b', 'c'], skippedPages: [], sparsePages: [2, 3, 4], added: 0 });
  const text = sparse.join('\n');
  assert.doesNotMatch(text, /0 页文字不足/);
  assert.match(text, /3 页/);
  assert.match(text, /第 2、3、4 页/);
  assert.match(text, /文字很少/);
  const skipped = pdfImportSummary({ selectedPages: [1, 2, 3], sourceIds: ['a', 'b'], skippedPages: [3], sparsePages: [], added: 2 }).join('\n');
  assert.match(skipped, /第 3 页/);
  assert.match(skipped, /OCR/);
  assert.doesNotMatch(skipped, /文字很少/);
  setUiLanguage('en');
  try {
    assert.doesNotMatch(pdfImportSummary({ selectedPages: [2, 3, 4], sourceIds: ['a', 'b', 'c'], skippedPages: [1], sparsePages: [2], added: 3 }).join(' '), han);
  } finally { setUiLanguage('zh'); }
});
