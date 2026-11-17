import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* #565: entering 创建题组 with 300 materials drew about 1,900 elements and blocked the page for 120–180 ms. Half of them were the
   参考样题 picker inside the shut 更多选项 fold (a shut <details> still holds its body), the rest a first chunk of 120 rows where a
   window shows about six. The page now draws the evidence picker's first rows only, and a shut lazy fold draws no body. */

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as Generate } from './ui/Generate.jsx';
  export { default as SourcePicker, SOURCE_PICKER_FIRST_ROWS, inScope, scopeFilter } from './ui/SourcePicker.jsx';
  export { Disclosure } from './ui/components/index.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { Generate, SourcePicker, SOURCE_PICKER_FIRST_ROWS, inScope, scopeFilter, Disclosure, setUiLanguage } = module.exports;
const h = React.createElement;
const elements = html => (html.match(/<[a-z][^>]*>/g) || []).length;
const rows = html => (html.match(/data-document-key="/g) || []).length;

const courses = Array.from({ length: 8 }, (_, index) => ({ name: `Course ${index + 1}` }));
const note = index => ({ id: `s${index}`, title: `Lecture ${index + 1}.md`, text: 'x'.repeat(200), createdAt: '2026-09-30T08:00:00.000Z', courses: [courses[index % 8].name],
  document: { materialId: `document-${index}-md`, materialRevision: 'r', format: 'md', filename: `l${index}.md` } });
const library = Array.from({ length: 300 }, (_, index) => note(index));
const noop = () => {};
const generate = (extra = {}, course = 'Course 1') => renderToStaticMarkup(h(Generate, {
  data: { root: 'lib', decks: [], drafts: [], jobs: [], sources: library, modelReady: true, model: { ready: true, reason: 'ok' }, focus: { course, courses } },
  busy: false, running: false, act: noop, call: noop, openDraft: noop, setPage: noop, setNotice: noop, genSource: 'files', setGenSource: noop,
  gen: { kind: 'mixed', count: 10, difficulty: 'mixed', language: '中文', focus: '', role: '' }, setGen: noop,
  selectedSources: [], setSelectedSources: noop, setModal: noop, askInChat: noop, openModelSettings: noop, ...extra }));

test('a lazy Disclosure draws its body only once it is open; a plain one always does', () => {
  const shut = renderToStaticMarkup(h(Disclosure, { summary: 'More', lazy: true }, h('p', { id: 'inside' }, 'body')));
  assert.match(shut, /<details[^>]*class="sh-disclosure"/);
  assert.match(shut, /More/, 'the summary is there to open it');
  assert.doesNotMatch(shut, /id="inside"/, 'shut, the body is not drawn');
  assert.match(renderToStaticMarkup(h(Disclosure, { summary: 'More', lazy: true, defaultOpen: true }, h('p', { id: 'inside' }, 'body'))), /id="inside"/);
  assert.match(renderToStaticMarkup(h(Disclosure, { summary: 'More', lazy: true, open: true, onToggle: noop }, h('p', { id: 'inside' }, 'body'))), /id="inside"/);
  assert.match(renderToStaticMarkup(h(Disclosure, { summary: 'More' }, h('p', { id: 'inside' }, 'body'))), /id="inside"/, 'without lazy nothing changes');
});

test('创建题组 with 300 materials draws one picker of first rows, not a hidden second list (#565)', () => {
  setUiLanguage('zh');
  // The current course (38 materials, as in the issue's library) and 全部课程 (all 300).
  for (const [course, total] of [['Course 1', 38], ['*', 300]]) {
    const html = generate({}, course);
    assert.equal((html.match(/class="source-picker[ "]/g) || []).length, 1, 'the 参考样题 picker waits until its fold is opened');
    assert.match(html, /参考样题（可选）/, 'its fold is still there to open');
    assert.equal(rows(html), SOURCE_PICKER_FIRST_ROWS, `${course}: the evidence picker draws its first rows`);
    assert.match(html, new RegExp(`共 ${total} 项`), 'the count is still every material in the scope');
    // Measured in Chromium on this page before the change: about 1,900 elements (2,650 with 全部课程), half of them the hidden picker.
    assert.ok(elements(html) < 700, `${course}: the generation form drew ${elements(html)} elements`);
  }
});

test('a chosen sample opens the 参考样题 fold, so its picker is drawn with the ticks', () => {
  setUiLanguage('zh');
  const html = generate({ gen: { kind: 'mixed', count: 10, difficulty: 'mixed', language: '中文', focus: '', role: '', referenceSourceIds: ['s5'] } });
  assert.equal((html.match(/class="source-picker[ "]/g) || []).length, 2);
});

test('a shut row draws no page list, and stays a handful of elements (#565)', () => {
  setUiLanguage('zh');
  const SHA = 'a'.repeat(64);
  const page = n => ({ id: `pdf-${SHA}-text2-p${n}`, title: `book.pdf · p.${n}`, text: `page ${n}`, courses: ['Course 1'],
    document: { id: SHA, filename: 'book.pdf', page: n, totalPages: 40, extractionVersion: 2, warnings: [], materialId: `document-${SHA}-pdf`, format: 'pdf' } });
  const sources = Array.from({ length: 40 }, (_, index) => page(index + 1));
  const shut = renderToStaticMarkup(h(SourcePicker, { sources, selected: [], onChange: noop }));
  assert.doesNotMatch(shut, /source-picker__pages|source-picker__chapters/, 'the 40 pages are drawn when the row is opened');
  const row = shut.match(/<div class="source-picker__item[^"]*" data-document-key="[^"]+">[\s\S]*<\/button><\/div><\/div>/)?.[0] || '';
  assert.ok(row, 'one row with its 选择页面 button');
  assert.ok(elements(row) <= 16, `a shut row drew ${elements(row)} elements`);
  const open = renderToStaticMarkup(h(SourcePicker, { sources, selected: [], onChange: noop, defaultOpenKey: `pdf:${SHA}` }));
  if (/source-picker__pages/.test(open)) assert.equal((open.match(/<li><label><input type="checkbox"/g) || []).length, 40, 'opened, every page is listed');
});

test('scopeFilter is inScope for a whole list: all, unassigned, a course and its sub-courses', () => {
  const known = ['Cloud', 'Cloud / K8s', 'Math'];
  const items = [{ courses: [] }, { courses: ['Cloud'] }, { courses: ['Cloud / K8s'] }, { courses: ['Math'] }, { courses: ['Math', 'Cloud / K8s'] }];
  for (const scope of ['*', '', 'Cloud', 'Cloud / K8s', 'Math', 'Nope', undefined, null]) {
    const within = scopeFilter(scope, known);
    assert.deepEqual(items.map(within), items.map(item => inScope(item, scope, known)), String(scope));
  }
  assert.deepEqual(items.map(scopeFilter('Cloud', known)), [false, true, true, false, true], 'a parent takes in its sub-courses');
  assert.deepEqual(items.map(scopeFilter('', known)), [true, false, false, false, false]);
});

test('a course name said whole draws no hover card, so a shut row with a course stays a handful of elements (#565, #1084 round 8 review)', () => {
  setUiLanguage('zh');
  const SHA = 'b'.repeat(64);
  // a course longer than six characters is the one a row may shorten: its whole name is on hover only once it is cut, which a first draw never is
  const page = (n, courses) => ({ id: `pdf-${SHA}-text2-p${n}`, title: `deck.pdf · p.${n}`, text: `page ${n}`, courses,
    document: { id: SHA, filename: 'deck.pdf', page: n, totalPages: 3, extractionVersion: 2, warnings: [], materialId: `document-${SHA}-pdf`, format: 'pdf' } });
  const rowOf = html => html.match(/<div class="source-picker__item[^"]*" data-document-key="[^"]+">[\s\S]*<\/button><\/div><\/div>/)?.[0] || '';
  const one = rowOf(renderToStaticMarkup(h(SourcePicker, { sources: [1, 2, 3].map(n => page(n, ['分布式系统与网络协议'])), selected: [], onChange: noop })));
  assert.ok(one, 'one row');
  assert.doesNotMatch(one, /role="tooltip"/, 'no hover card on a name that is not cut');
  assert.ok(elements(one) <= 16, `a shut row with a course drew ${elements(one)} elements`);
  // round 11: a course with a figure and a 「 · 」 part is cut on whole words, with one word box more than round 8 at most
  const figured = rowOf(renderToStaticMarkup(h(SourcePicker, { sources: [1, 2, 3].map(n => page(n, ['分布式系统与网络协议（2026 秋季学期 · 周三晚班）'])), selected: [], onChange: noop })));
  assert.ok(figured, 'one row with a figured course');
  assert.ok(elements(figured) <= 16, `a shut row with a figured course drew ${elements(figured)} elements`);
  const three = rowOf(renderToStaticMarkup(h(SourcePicker, { sources: [1, 2, 3].map(n => page(n, ['分布式系统与网络协议', 'Course 2', 'Course 3'])), selected: [], onChange: noop })));
  assert.match(three.replace(/<[^>]+>/g, ''), /PDF · 3 页 · \S+ 字符 · 分布式系统与网络协议 · Course 2 · Course 3/, 'the facts read as one line of words, every course in them');
  assert.ok(elements(three) <= 18, `a shut row with three courses drew ${elements(three)} elements`);
});
