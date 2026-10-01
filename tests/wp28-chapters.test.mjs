import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupSourcesByDocument } from '../lib/source-groups.js';

/* WP28: a converted textbook is chosen by chapter, not by hundreds of pages. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/SourcePicker.jsx'; export { default as SourcePicker } from './ui/SourcePicker.jsx';
  export { default as Sources } from './ui/Sources.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { SourcePicker, Sources, sourceFormatLabel, chapterState, toggleChapter, chapterLabel, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const HASH = 'a'.repeat(64);
const chapters = [{ index: 0, title: '第一章 进程', level: 1 }, { index: 1, title: '第二章 内存', level: 1 }, { index: 2, title: '第三章 文件', level: 1 }];
const book = Array.from({ length: 12 }, (_, i) => {
  const n = i + 1, chapter = chapters[Math.min(2, Math.floor(i / 4))];
  return { id: `bk-p${n}`, title: `操作系统 · p.${n}`, text: `第 ${n} 页`.repeat(40), createdAt: '2026-10-01T08:00:00.000Z', courses: ['OS'],
    document: { id: HASH, page: n, totalPages: 12, format: 'pdf', filename: 'os.md', bookTitle: '操作系统', origin: 'converted', converter: 'mineru', extractionVersion: 2, materialId: `document-${HASH}-md`, chapter } };
});
const [item] = groupSourcesByDocument(book);
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };

test('chapter selection works on whole chapters and reports partial ones', () => {
  const [first, second] = item.chapters;
  assert.equal(chapterState(first, []), 'none');
  assert.equal(chapterState(first, ['bk-p1']), 'some');
  assert.equal(chapterState(first, first.sourceIds), 'all');
  assert.deepEqual(toggleChapter(['x'], first, true), ['x', ...first.sourceIds]);
  assert.deepEqual(toggleChapter(['x', ...first.sourceIds, ...second.sourceIds], first, false), ['x', ...second.sourceIds]);
  assert.equal(chapterLabel(first), '第一章 进程 · 第 1–4 页');
  assert.equal(chapterLabel({ title: '', front: true, startPage: 1, endPage: 2 }), '前言与目录 · 第 1–2 页');
  assert.equal(chapterLabel({ title: 'Single', startPage: 7, endPage: 7 }), 'Single · 第 7 页');
});

test('a converted book is labelled as such, not as a PDF', () => {
  assert.equal(sourceFormatLabel(item), '转换文档 · 12 页');
  assert.equal(sourceFormatLabel(book[2]), '转换文档 · 第 3 页');
  setUiLanguage('en');
  try { assert.equal(sourceFormatLabel(item), 'Converted document · 12 pages'); } finally { setUiLanguage('zh'); }
});

test('the picker offers 选择章节 for a book with chapters and lists them with their page ranges', () => {
  const html = render(h(SourcePicker, { sources: book, selected: [], onChange() {}, defaultOpenKey: item.key }));
  assert.match(render(h(SourcePicker, { sources: book, selected: [], onChange() {} })), /选择章节/);
  assert.doesNotMatch(html, /旧版提取/, 'converted pages are never flagged for re-import');
  assert.match(html, /第一章 进程 · 第 1–4 页/);
  assert.match(html, /第三章 文件 · 第 9–12 页/);
  assert.equal((html.match(/data-chapter-index=/g) || []).length, 3);
  assert.doesNotMatch(html, /选择页面/, 'pages are the secondary way when there are chapters');
  const partial = render(h(SourcePicker, { sources: book, selected: book.slice(0, 4).map(source => source.id), onChange() {} }));
  assert.match(partial, /已选 4 \/ 12 页/);
  const closed = render(h(SourcePicker, { sources: book, selected: [], onChange() {} }));
  assert.doesNotMatch(closed, /data-chapter-index/, 'chapters stay folded until asked for');
  const plain = render(h(SourcePicker, { sources: book.map(({ document, ...source }) => ({ ...source, document: { ...document, chapter: undefined, origin: undefined, converter: undefined } })), selected: [], onChange() {} }));
  assert.match(plain, /选择页面/, 'a PDF without chapters keeps the page list');
});

test('the picker in English', () => {
  const html = render(h(SourcePicker, { sources: book, selected: [], onChange() {}, defaultOpenKey: item.key }), 'en');
  assert.match(render(h(SourcePicker, { sources: book, selected: [], onChange() {} }), 'en'), /Choose chapters/);
  assert.match(html, /Converted document/);
  assert.doesNotMatch(html.replace(/第一章 进程|第二章 内存|第三章 文件|操作系统|第 \d+ 页/g, ''), han);
});

const data = { root: '/lib', sources: book, focus: { courses: ['OS'] }, contexts: ['materials'] };
const sourcesPage = props => render(h(Sources, { data, busy: false, act() {}, call() {}, setModal() {}, onGenerate() {}, ...props }));

test('the 资料 page folds a book into chapters, each with its own 出题 button, and advises on a book over 300 pages', () => {
  const html = sourcesPage({});
  assert.match(html, /转换文档 · 12 页/);
  assert.match(html, /查看 3 章/);
  assert.doesNotMatch(html, /大教材建议/, 'a 12-page book needs no advice');
  const long = Array.from({ length: 320 }, (_, i) => ({ ...book[0], id: `lg-p${i + 1}`, title: `大书 · p.${i + 1}`, document: { ...book[0].document, id: 'b'.repeat(64), page: i + 1, totalPages: 320, chapter: undefined, bookTitle: '大书', materialId: `document-${'b'.repeat(64)}-md` } }));
  const advice = sourcesPage({ data: { ...data, sources: long } });
  assert.match(advice, /大教材建议/);
  assert.match(advice, /320 页/);
});
