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
  assert.match(html.replace(/<[^>]+>/g, ''), /PDF · 3 页/, 'the format and its pages (two boxes on the row, #1134)');
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

test('the facts lines are one decision for the whole scope, from the words and the line\'s room: which names, which sizes (#1084 round 8 review, #1134, #1135)', async () => {
  const names = await build({ stdin: { contents: `export { decideFacts } from './ui/picker-names.js';`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], logLevel: 'silent' });
  const scope = { exports: {} };
  new Function('require', 'module', 'exports', names.outputFiles[0].text)(require, scope, scope.exports);
  const { decideFacts } = scope.exports;
  // widths in px: the format; its pages with their 「 · 」 (0: none); its characters with their 「 · 」; the first name; the names after it; whether the
  // course may be shortened; whether the row has 选择页面
  const row = (kind, pages, size, first, later = [], shortened = false, multi = false) => ({ kind, pages, size, first, later, shortened, multi });
  const fit = { room: () => 200, gap: 4, em: 12 };
  const decide = (rows, extra = {}) => { const { names, chars } = decideFacts(rows, { ...fit, ...extra }); return `${names}/${chars}`; };
  assert.equal(decide([row(40, 0, 60, 40, [30]), row(40, 0, 40, 40)]), 'all/all', 'every row says every name and its size whole');
  assert.equal(decide([row(40, 0, 60, 40, [60]), row(40, 0, 40, 40)]), 'first/all', 'one row has no room for a later name: no row says one');
  assert.equal(decide([row(40, 0, 80, 150, [], true)]), 'first/all', 'a course that may be shortened needs 6em at most');
  assert.equal(decide([row(40, 0, 150, 40), row(10, 0, 10, 40)]), 'none/all', 'in a course scope, one row without room for its other course: no row says one');
  assert.equal(decide([row(40, 0, 60, 0)]), '/all', 'no row has a name');
  assert.equal(decide([row(40, 0, 60, 40)], { room: line => (line.multi ? 120 : 200) }), 'all/all');
  assert.equal(decide([row(40, 30, 60, 40, [], false, true)], { room: line => (line.multi ? 120 : 200) }), 'all/unpaged', 'a row with 选择页面 has less room');
  // #1134, #1135: a size is said whole or not at all, by one rule for the rows of a kind; a document with pages says its size in pages first
  assert.equal(decide([row(40, 40, 80, 40, [20]), row(40, 0, 60, 40, [20])]), 'all/unpaged', 'a PDF without room for its characters says its pages; a note keeps its characters');
  assert.equal(decide([row(60, 0, 150, 0), row(40, 30, 40, 0)]), '/none', 'one note without room for its characters: no row says characters, a PDF still its pages');
  assert.equal(decide([row(60, 0, 100, 40), row(40, 0, 40, 40)]), 'none/all', 'in a course scope the other course gives way before a note\'s characters');
  assert.equal(decide([row(60, 0, 100, 40), row(40, 0, 40, 40)], { everyCourse: true }), 'first/none', 'in 全部课程 every row keeps its course and its format, a note gives its characters way');
  assert.equal(decide([row(40, 40, 80, 40), row(40, 0, 40, 40)], { everyCourse: true }), 'all/unpaged');
  assert.equal(decide([row(100, 60, 40, 100, [], true)], { everyCourse: true }), 'kind/none', 'in 全部课程 with no room for the format with its pages and 6em of the course: the format without its pages, then the course');
  assert.equal(decide([row(150, 30, 40, 100, [], true)], { everyCourse: true }), 'alone/none', 'no room even for the format and 6em of the course: the course alone, rather than cut to two characters');
});
