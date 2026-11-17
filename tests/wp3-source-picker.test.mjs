import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('the facts lines are one decision for the whole scope, from the words and the line\'s room: which names, which sizes (#1084 round 8 review, #1134, #1135, round 11)', async () => {
  const names = await build({ stdin: { contents: `export { decideFacts, SIZE_GROUPS, sizeGroup } from './ui/picker-names.js';`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], logLevel: 'silent' });
  const scope = { exports: {} };
  new Function('require', 'module', 'exports', names.outputFiles[0].text)(require, scope, scope.exports);
  const { decideFacts } = scope.exports;
  // widths in px: the format; its pages with their 「 · 」 (0: none); its characters with their 「 · 」; the first name; the names after it; whether the
  // course may be shortened; whether the row has 选择页面; its size group (the rows with pages, or its format); its characters in the short words
  const row = (kind, pages, size, first, later = [], shortened = false, multi = false, group = pages ? 'paged' : 'text', short = size) => ({ kind, pages, size, short, first, later, shortened, multi, group });
  const fit = { room: () => 200, gap: 4, em: 12 };
  // names / the size groups that leave their characters out ('-': none) / the short words where the list says them
  const decide = (rows, extra = {}) => { const { names, unit, off } = decideFacts(rows, { ...fit, ...extra }); return `${names}/${off.join('+') || '-'}${unit === 'short' ? '/short' : ''}`; };
  assert.equal(decide([row(40, 0, 60, 40, [30]), row(40, 0, 40, 40)]), 'all/-', 'every row says every name and its size whole');
  assert.equal(decide([row(40, 0, 60, 40, [60]), row(40, 0, 40, 40)]), 'first/-', 'one row has no room for a later name: no row says one');
  assert.equal(decide([row(40, 0, 80, 150, [], true)]), 'first/-', 'a course that may be shortened needs 6em at most');
  assert.equal(decide([row(40, 0, 150, 40), row(10, 0, 10, 40)]), 'none/-', 'in a course scope, one row without room for its other course: no row says one');
  assert.equal(decide([row(40, 0, 60, 0)]), '/-', 'no row has a name');
  assert.equal(decide([row(40, 0, 60, 40)], { room: line => (line.multi ? 120 : 200) }), 'all/-');
  assert.equal(decide([row(40, 30, 60, 40, [], false, true)], { room: line => (line.multi ? 120 : 200) }), 'all/paged', 'a row with 选择页面 has less room');
  // #1134, #1135: a size is said whole or not at all, by one rule for the rows of a kind; a document with pages says its size in pages first
  assert.equal(decide([row(40, 40, 80, 40, [20]), row(40, 0, 60, 40, [20])]), 'all/paged', 'a PDF without room for its characters says its pages; a note keeps its characters');
  assert.equal(decide([row(60, 0, 150, 0), row(40, 30, 40, 0)]), '/text/short', 'one note without room for its characters: no note says them; a PDF with room still says its own (in the short words, as the list says them while a note has no room for the long)');
  assert.equal(decide([row(60, 0, 100, 40), row(40, 0, 40, 40)]), 'none/-', 'in a course scope the other course gives way before a note\'s characters');
  assert.equal(decide([row(60, 0, 100, 40), row(40, 0, 40, 40)], { everyCourse: true }), 'first/text/short', 'in 全部课程 every row keeps its course and its format, a note gives its characters way');
  assert.equal(decide([row(40, 40, 80, 40), row(40, 0, 40, 40)], { everyCourse: true }), 'all/paged');
  assert.equal(decide([row(100, 60, 40, 100, [], true)], { everyCourse: true }), 'kind/paged', 'in 全部课程 with no room for the format with its pages and 6em of the course: the format without its pages, then the course');
  assert.equal(decide([row(150, 30, 40, 100, [], true)], { everyCourse: true }), 'alone/paged', 'no room even for the format and 6em of the course: the course alone, rather than cut to two characters');
  // round 11 (rv30): the characters are decided for the rows of a kind. en 420 全部课程: one Markdown note took the characters of eleven Text notes.
  const course = 121, em = 13, wide = { room: () => 219, em, everyCourse: true };
  const sample = [row(65, 0, 103, course, [], true, false, 'md', 80), row(26, 0, 103, course, [], true, false, 'text', 73), row(26, 0, 101, course, [], true, false, 'text', 71),
    row(25, 60, 109, course, [], true, true, 'paged', 79)];
  assert.equal(decide(sample, wide), 'first/paged+md/short', 'a Markdown note without room for its characters leaves them out; the Text notes keep theirs, in the short words while a kind has no room for the long');
  assert.equal(decide(sample.slice(1), wide), 'first/paged', 'the long words where every note has room for them');
  // en 320 course scope: 「Text · 267 characters」 has no room beside the badge; 「Text · 267 chars」 has
  const narrow = { room: () => 119, em };
  assert.equal(decide(sample.map(item => ({ ...item, first: 0 })), narrow), '/paged+md/short', 'the short words keep the notes\' characters where the long ones have no room');
  assert.equal(decide([row(26, 0, 103, 0, [], false, false, 'text', 73)], { room: () => 160 }), '/-', 'the long words where they fit');
  assert.equal(decide([row(26, 0, 70, 0), row(25, 60, 120, 0, [], false, true, 'paged', 80)], { room: () => 200 }), '/paged',
    'a document with pages does not take the short words for its characters: its pages say its size');
  assert.equal(decide([row(26, 0, 120, 0, [], false, false, 'text', 70), row(25, 40, 60, 0, [], false, true, 'paged', 40)], { room: () => 140 }), '/-/short',
    'in the short words, a document with pages says its characters where the long ones fit');
  assert.equal(decide([row(26, 0, 120, 0, [], false, false, 'text', 115), row(60, 0, 50, 0, [], false, false, 'md', 30)], { room: () => 140 }), '/text/short',
    'while one kind has no room for its long words, the list says the short ones: the words change once as the line widens');
  // a wider line never says less (round 11: 532 px): the names never go down, and with the same names no group stops saying its characters
  const lists = [sample, sample.map(item => ({ ...item, first: 0 })), [...sample, row(80, 0, 150, 60, [40], false, false, 'docx', 110), row(30, 0, 60, 140, [90, 50], true, false, 'text', 45)]];
  for (const everyCourse of [false, true]) for (const [at, list] of lists.entries()) {
    if (everyCourse && !list.some(item => item.first)) continue; // in 全部课程 every row has a course (or 未分类)
    const order = everyCourse ? ['alone', 'kind', 'first', 'all'] : ['none', 'first', 'all'];
    let before = null;
    for (let room = 60; room <= 720; room++) {
      const { names: said, unit, off } = decideFacts(list, { room: () => room, gap: 4, em, everyCourse });
      const now = { rank: list.some(item => item.first) ? order.indexOf(said) : 0, on: new Set(list.map(item => item.group).filter(group => !off.includes(group))), unit };
      // with the same names, the short words give way to the long ones once, never back
      if (before && now.rank === before.rank) assert.ok(!(before.unit === 'long' && unit === 'short'), `list ${at}${everyCourse ? ' 全部课程' : ''}: back to the short words at ${room}`);
      if (before) {
        assert.ok(now.rank >= before.rank, `list ${at}${everyCourse ? ' 全部课程' : ''}: the names went down at ${room}`);
        if (now.rank === before.rank) for (const group of before.on) assert.ok(now.on.has(group), `list ${at}${everyCourse ? ' 全部课程' : ''}: ${group} stopped saying its characters at ${room}`);
      }
      before = now;
    }
  }
  // every size group is one the CSS hides by name; a format without pages that is not listed is said as 文本 and goes with the text
  const { SIZE_GROUPS, sizeGroup } = scope.exports, css = readFileSync(new URL('../ui/source-picker.css', import.meta.url), 'utf8');
  for (const group of SIZE_GROUPS) assert.ok(css.includes(`[data-chars-off~="${group}"] [data-size-group="${group}"]`), `the CSS hides the characters of ${group}`);
  assert.deepEqual(['pdf', 'md', 'audio', 'docx', 'nope'].map(format => sizeGroup(format, format === 'pdf')), ['paged', 'md', 'audio', 'docx', 'text']);
});

test('a shortened course ends on a whole word: before a space, an opening bracket or a figure after a Chinese word, never inside a figure (round 11)', () => {
  const { nameWords } = module.exports;
  assert.deepEqual(nameWords('· 分布式系统与网络协议（2026 秋季学期 · 周三晚班）'), ['· 分布式系统与网络协议', '（2026', ' 秋季学期', ' · 周三晚班）']);
  assert.deepEqual(nameWords('· 示例课程 · 设计模式'), ['· 示例课程', ' · 设计模式']);
  assert.deepEqual(nameWords('· 操作系统2026秋季学期回顾'), ['· 操作系统', '2026秋季学期回顾']);
  assert.deepEqual(nameWords('· Distributed systems (CS5223)'), ['· Distributed', ' systems', ' (CS5223)'], 'a code is one word, and a space before a bracket starts it');
  assert.deepEqual(nameWords('· 第2讲 · （重点）课程 1,234'), ['· 第2讲', ' · （重点）课程', ' 1,234'], 'a word is two characters at least; a figure keeps its comma');
  for (const name of ['分布式系统与网络协议（2026 秋季学期 · 周三晚班）', 'Distributed systems (CS5223)', '第2讲 · （重点）课程 1,234']) assert.equal(nameWords(`· ${name}`).join(''), `· ${name}`);
});
