import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';

// P18 / P22: the generation picker lists documents (a PDF is one row with an
// expandable page list), counts documents, and labels formats through one
// helper so fresh Markdown is never called a legacy extraction.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/SourcePicker.jsx'; export { default } from './ui/SourcePicker.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { default: SourcePicker, sourceFormatLabel, selectionState, toggleDocument, selectDocuments, setUiLanguage } = module.exports;
const han = /[㐀-鿿]/;
const SHA = 'd'.repeat(64);
const page = (n, extra = {}) => ({ id: `pdf-${SHA}-text2-p${n}`, title: `slides.pdf · p.${n}`, text: `page ${n} text`, createdAt: '2026-09-30T08:00:00.000Z', courses: ['Databases'],
  document: { id: SHA, filename: 'slides.pdf', page: n, totalPages: 3, extractionVersion: 2, warnings: [], materialId: `document-${SHA}-pdf`, format: 'pdf' }, ...extra });
const md = { id: 'md-1', title: 'notes.md', text: '# Notes', createdAt: '2026-09-30T08:00:00.000Z', courses: ['Systems'],
  document: { materialId: 'document-e-md', materialRevision: 'r', format: 'md', filename: 'notes.md' } };
const pasted = { id: 'paste-1', title: 'Pasted notes', text: 'Plain text', createdAt: '2026-09-29T08:00:00.000Z', courses: [] };
const legacy = { id: `pdf-${SHA}-p9`, title: 'old.pdf · p.9', text: 'old', document: { id: 'f'.repeat(64), filename: 'old.pdf', page: 9 } };
const sources = [page(1), page(2), page(3), md, pasted];
const render = props => renderToStaticMarkup(React.createElement(SourcePicker, { sources, selected: [], onChange() {}, ...props }));
const rows = html => html.match(/data-document-key="/g)?.length || 0;

test('sourceFormatLabel names formats and only flags old PDF extractions', () => {
  setUiLanguage('zh');
  assert.equal(sourceFormatLabel(md), 'Markdown');
  assert.doesNotMatch(sourceFormatLabel(md), /旧版/);
  for (const format of ['html', 'txt']) assert.doesNotMatch(sourceFormatLabel({ ...md, document: { ...md.document, format } }), /旧版/);
  assert.match(sourceFormatLabel(page(1)), /^PDF/);
  assert.doesNotMatch(sourceFormatLabel(page(1)), /旧版|v2/);
  assert.match(sourceFormatLabel(legacy), /旧版提取，建议重新导入/);
  assert.match(sourceFormatLabel(pasted), /文本/);
  // A grouped document says how many pages it has.
  assert.equal(sourceFormatLabel({ format: 'pdf', sourceIds: ['a', 'b', 'c'], pages: [{}, {}, {}] }), 'PDF · 3 页');
  setUiLanguage('en');
  try {
    for (const source of [md, page(1), legacy, pasted]) assert.doesNotMatch(sourceFormatLabel(source), han);
    assert.equal(sourceFormatLabel({ format: 'pdf', sourceIds: ['a', 'b'], pages: [{}, {}] }), 'PDF · 2 pages');
  } finally { setUiLanguage('zh'); }
});

test('selection works on whole documents and reports partial page choices', () => {
  const item = { sourceIds: ['p1', 'p2', 'p3'] };
  assert.equal(selectionState(item, []), 'none');
  assert.equal(selectionState(item, ['p2']), 'some');
  assert.equal(selectionState(item, ['p1', 'p2', 'p3', 'x']), 'all');
  assert.deepEqual(toggleDocument(['x', 'p2'], item, true), ['x', 'p2', 'p1', 'p3']);
  assert.deepEqual(toggleDocument(['x', 'p2', 'p1'], item, false), ['x']);
  assert.deepEqual(selectDocuments(['x'], [item, { sourceIds: ['q'] }]), ['x', 'p1', 'p2', 'p3', 'q']);
});

test('the picker lists one row per document and counts documents, not pages', () => {
  setUiLanguage('zh');
  const html = render({ selected: [page(1).id, page(2).id, page(3).id] });
  assert.equal(rows(html), 3, 'a 3-page PDF, a Markdown file and pasted text');
  assert.match(html, /已选择 1 \/ 3 份资料/);
  assert.match(html, /slides\.pdf/);
  assert.doesNotMatch(html, /slides\.pdf · p\.2/, 'pages stay inside the document until expanded');
  assert.match(html, /PDF · 3 页/);
  assert.doesNotMatch(html, /排版提取 v2|旧版提取/);
  assert.match(html, /aria-expanded="false"/, 'a multi-page document offers its page list');
  const partial = render({ selected: [page(2).id] });
  assert.match(partial, /已选 1 \/ 3 页/);
  assert.match(partial, /已选择 1 \/ 3 份资料/);
});

test('course scope filters documents and offers select-all for the scope', () => {
  setUiLanguage('zh');
  const html = render({ scope: 'Databases', onScopeChange() {}, courses: [{ name: 'Databases' }, { name: 'Systems' }] });
  assert.equal(rows(html), 1);
  assert.match(html, /选择当前范围/);
  assert.match(html, /<select/);
  const outside = render({ scope: 'Databases', onScopeChange() {}, courses: [{ name: 'Databases' }], selected: ['md-1'] });
  assert.match(outside, /已选资料包含其他范围/);
});

test('an empty picker points at adding material, in either language', () => {
  setUiLanguage('zh');
  const empty = renderToStaticMarkup(React.createElement(SourcePicker, { sources: [], selected: [], onChange() {}, onAdd() {} }));
  assert.match(empty, /添加资料/);
  setUiLanguage('en');
  try {
    const html = render({ scope: 'Databases', onScopeChange() {}, courses: [{ name: 'Databases' }], selected: [page(1).id], onAdd() {} });
    assert.doesNotMatch(html.replace(/<[^>]+>/g, ' ').replace(/slides\.pdf|Databases/g, ''), han);
    assert.match(html, /1 \/ 3 pages selected|selected 1 \/ 3/i);
  } finally { setUiLanguage('zh'); }
});
