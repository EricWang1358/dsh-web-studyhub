import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';

/* A 资料 row has the title, one line of facts and the status line. The facts are the course, the format, the pages and the characters; a reminder the learner has
   to act on (文字偏少，核对正文) is its own warning Badge beside the title, not a grey phrase inside the facts; the start of the text is not in the row at all (#676). */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as Sources } from './ui/Sources.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { Sources, setUiLanguage } = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { setUiLanguage('zh'); } };
const text = html => html.replace(/<span[^>]*role="tooltip"[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const EXCERPT = '索引是一种额外维护的数据结构，它让数据库在查询时不必逐行扫描整张表';
const now = new Date().toISOString();
const scanned = (extra = {}) => Array.from({ length: 3 }, (_, index) => ({ id: `idx-p${index + 1}`, title: `数据库索引入门 · p.${index + 1}`, text: `${EXCERPT}${'。第'.repeat(20)}`, createdAt: now,
  courses: [], document: { id: 'a'.repeat(64), page: index + 1, totalPages: 3, format: 'pdf', filename: 'idx.pdf', bookTitle: '数据库索引入门', extractionVersion: 2, materialId: `document-${'a'.repeat(64)}-pdf`, ...extra } }));
const plain = { id: 'note-1', title: '观察者模式笔记', text: '观察者模式定义了一种一对多的依赖关系。'.repeat(10), createdAt: now, courses: [] };
const page = (sources, language = 'zh') => render(h(Sources, { data: { root: '/lib', sources, focus: { courses: [] }, contexts: ['materials'] }, busy: false, act() {}, call() {}, setModal() {}, onGenerate() {} }), language);
/** The markup of one row: from its <article> to the next one. */
const rows = html => html.split('<article ').slice(1).map(row => `<article ${row.split('</article>')[0]}`);
/** The facts line: from its span to the status line that follows it. */
const factsOf = row => row.split('<span class="source-doc__meta">')[1]?.split('<span class="source-doc__status">')[0] ?? '';

test('the facts line holds the course, format, pages and characters, and nothing the learner has to act on or read', () => {
  const [row] = rows(page(scanned({ sparseText: true })));
  const facts = text(factsOf(row));
  assert.ok(facts.length > 0, 'the facts line is there');
  assert.match(facts, /未分类/);
  assert.match(facts, /PDF/);
  assert.match(facts, /3 页/);
  assert.match(facts, /字符/);
  assert.doesNotMatch(facts, /文字偏少|核对正文/, 'the reminder is not a grey phrase among the facts');
  assert.doesNotMatch(row, new RegExp(EXCERPT.slice(0, 12)), 'the start of the text is not in the row');
  const [note] = rows(page([plain]));
  assert.doesNotMatch(note, /观察者模式定义了/, 'neither is it for a pasted note');
});

test('a reminder is a warning Badge beside the title, one for each thing to check', () => {
  const [row] = rows(page(scanned({ sparseText: true, warnings: ['layout'] })));
  const title = row.match(/<strong class="source-title"[\s\S]*?<\/strong>/)[0];
  const badges = [...title.matchAll(/<span class="sh-badge[^"]*"[^>]*data-tone="warning"[^>]*>([\s\S]*?)<\/span>/g)].map(match => text(match[1]).trim());
  assert.ok(badges.some(label => label.includes('文字偏少，核对正文')), `the sparse-text reminder is a Badge in the title line: ${JSON.stringify(badges)}`);
  assert.ok(badges.some(label => label.includes('排版复杂，建议对照原文')), `so is the layout one: ${JSON.stringify(badges)}`);
});

test('renaming a row in place says nothing more: the row shows the new name when the field closes (#677)', async () => {
  const source = await readFile(new URL('../ui/Sources.jsx', import.meta.url), 'utf8');
  const rename = source.slice(source.indexOf('const renameFor ='), source.indexOf('const selectedItems'));
  assert.ok(rename.includes('renameDocument'), 'the rename is still sent');
  assert.doesNotMatch(rename, /toast/, 'but no toast repeats the name the row now shows');
});

test('a row with nothing to check has no warning Badge, and the English rows are English', () => {
  const [row] = rows(page([plain]));
  assert.doesNotMatch(row, /data-tone="warning"/);
  const [english] = rows(page(scanned({ sparseText: true }), 'en'));
  const title = english.match(/<strong class="source-title"[\s\S]*?<\/strong>/)[0];
  assert.match(title, /data-tone="warning"/);
  assert.doesNotMatch(text(english.replace(/数据库索引入门/g, '').replace(new RegExp(EXCERPT, 'g'), '')), han);
});
