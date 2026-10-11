import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { loadUi } from './helpers/ui-module.mjs';

/* The badge on a material row says WHERE the index is built: a quiet 建立索引 after a badge that is partial, stale or missing (it opens
   设置 › 检索扩展 with the course of that material chosen), and one line above a list when some materials are not fully indexed.
   Owner report: the badge was a passive label and nobody could find where to build the index. */
const m = await loadUi(`
  export { default as IndexBadge, IndexGapLine } from './ui/IndexBadge.jsx';
  export { default as SourcePicker } from './ui/SourcePicker.jsx';
  export { indexGap, indexGoTip, indexGoLabel, NEEDS_INDEX } from './ui/index-scope.js';
  export { openIndexBuilder, peekIndexCourse, requestIndexCourse, clearIndexCourse } from './ui/index-focus.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const html = (element) => renderToStaticMarkup(element);
const badge = (info, coverage, onIndex) => html(h(m.IndexBadge, { info, coverage, onIndex }));
const go = () => {};

test('the badge gets 建立索引 when the index is partial, stale or missing, and only with a way to go', () => {
  for (const info of [{ state: 'partial', indexed: 2, total: 88, stale: 0 }, { state: 'stale', indexed: 80, total: 88, stale: 8 }, { state: 'missing', total: 88 }]) {
    const withAction = badge(info, { canIndex: true }, go);
    assert.match(withAction, /data-index-action/, `${info.state}: the action`);
    assert.match(withAction, /role="button"[^>]*tabindex="0"/, `${info.state}: reachable by keyboard`);
    assert.match(withAction, />建立索引</);
    assert.match(withAction, /点这里去建立索引/, `${info.state}: the hover says where it goes`);
    assert.match(withAction, /这里只数这份资料自己的页/, `${info.state}: and keeps the scope explanation`);
    assert.doesNotMatch(badge(info, { canIndex: true }), /data-index-action|点这里去/, `${info.state}: no way to go, no action`);
  }
});

test('an indexed or a building document has nothing to ask for, and its badge is unchanged', () => {
  for (const info of [{ state: 'indexed', indexed: 88, total: 88 }, { state: 'building', indexed: 3, total: 88 }]) {
    const a = badge(info, { canIndex: true }, go), b = badge(info, { canIndex: true });
    assert.equal(a, b, `${info.state}: same markup with and without the handler`);
    assert.doesNotMatch(a, /data-index-action/);
  }
});

test('without the extension the label says so and the action goes to its install step', () => {
  const missing = badge({ state: 'missing', total: 88 }, { canIndex: false }, go);
  assert.match(missing, /还没建索引（需要先安装检索扩展）/);
  assert.match(missing, />安装扩展</);
  assert.match(missing, /点这里去安装检索扩展/);
  assert.doesNotMatch(missing, /点这里去建立索引/);
  const partial = badge({ state: 'partial', indexed: 2, total: 88 }, { canIndex: false }, go);
  assert.match(partial, />安装扩展</);
});

test('English: the action, the hover and the shortcut line carry no Chinese', () => {
  m.setUiLanguage('en');
  try {
    const partial = badge({ state: 'partial', indexed: 2, total: 88, stale: 0 }, { canIndex: true }, go);
    assert.match(partial, />Build index</);
    assert.match(partial, /Click to go and build the index/);
    assert.doesNotMatch(partial, /[㐀-鿿]/);
    const install = badge({ state: 'missing', total: 4 }, { canIndex: false }, go);
    assert.match(install, />Install extension</);
    assert.match(install, /Click to go and install the search extension/);
    const line = html(h(m.IndexGapLine, { count: 3, canIndex: true, onGo: go }));
    assert.match(line, /The index of 3 material\(s\) is not finished/);
    assert.match(line, /Go and build the index/);
    assert.doesNotMatch(line, /[㐀-鿿]/);
  } finally { m.setUiLanguage('zh'); }
});

test('indexGap counts the materials that are not fully indexed and names the course when they share one', () => {
  const item = (...courses) => ({ courses });
  const info = (state) => ({ state });
  assert.equal(m.indexGap([]), null);
  assert.equal(m.indexGap(null), null);
  assert.equal(m.indexGap([{ item: item('A'), info: info('indexed') }, { item: item('A'), info: info('building') }, { item: item('A'), info: null }]), null, 'built, building or unknown: nothing to build');
  assert.deepEqual(m.indexGap([{ item: item('A'), info: info('partial') }, { item: item('A'), info: info('stale') }, { item: item('B'), info: info('indexed') }]), { count: 2, course: 'A' });
  assert.deepEqual(m.indexGap([{ item: item('A'), info: info('missing') }, { item: item('B'), info: info('partial') }]), { count: 2, course: '' }, 'two courses: the build panel opens on 全部资料');
  assert.deepEqual(m.indexGap([{ item: item(), info: info('missing') }]), { count: 1, course: '' }, 'no course');
  assert.equal(m.indexGoLabel(false), '安装扩展');
  assert.equal(m.indexGoLabel(true), '建立索引');
  assert.equal(m.indexGoLabel(undefined), '建立索引');
});

test('the shortcut line says how many and where to go; the install wording when the extension is missing; nothing for none', () => {
  assert.match(html(h(m.IndexGapLine, { count: 3, canIndex: true, onGo: go })), /有 3 份资料的索引还没建完[\s\S]*去建立索引/);
  assert.match(html(h(m.IndexGapLine, { count: 3, canIndex: false, onGo: go })), /去安装检索扩展/);
  assert.equal(html(h(m.IndexGapLine, { count: 0, canIndex: true, onGo: go })), '');
  assert.equal(html(h(m.IndexGapLine, { count: 2, canIndex: true })), '', 'no way to go: no line');
});

test('the course of the click is kept for the Settings pane, which reads it and clears it', () => {
  m.clearIndexCourse();
  const opened = [];
  m.openIndexBuilder((section) => opened.push([section, m.peekIndexCourse()]), '操作系统');
  assert.deepEqual(opened, [['settings-extensions', '操作系统']], 'the course is already asked for when Settings opens');
  assert.equal(m.peekIndexCourse(), '操作系统', 'a pane that draws twice reads it twice');
  m.clearIndexCourse();
  assert.equal(m.peekIndexCourse(), '');
  m.requestIndexCourse(undefined);
  assert.equal(m.peekIndexCourse(), '');
  assert.doesNotThrow(() => m.openIndexBuilder(undefined, 'x'));
  m.clearIndexCourse();
});

const source = (id, filename, page, totalPages, courses = ['操作系统']) => ({ id, title: `${filename} · ${page}`, text: `page ${page}`, createdAt: '2026-10-01T00:00:00Z', courses,
  document: { id: filename.padEnd(64, '0'), filename, page, totalPages, extractionVersion: 2, format: 'pdf' } });
const sources = [source('a1', 'book.pdf', 1, 2), source('a2', 'book.pdf', 2, 2), source('b1', 'slides.pdf', 1, 1)];
const picker = (props) => html(h(m.SourcePicker, { sources, selected: [], courses: ['操作系统'], ...props }));
const coverage = (extra) => ({ indexed: [], stale: [], missing: [], hasIndex: true, canIndex: true, building: null, ...extra });

test('the picker: one line when some materials are not fully indexed, a 建立索引 on those rows, only with the way to go', () => {
  const partial = coverage({ indexed: ['a1', 'b1'], missing: ['a2'] });
  const out = picker({ indexCoverage: partial, indexSlot: true, onIndex: go });
  assert.match(out, /data-index-gap/);
  assert.match(out, /有 1 份资料的索引还没建完/);
  assert.match(out, /去建立索引/);
  assert.equal((out.match(/data-index-action/g) || []).length, 1, 'the partly built book gets the action, the built slides do not');
  assert.doesNotMatch(picker({ indexCoverage: partial, indexSlot: true }), /data-index-gap|data-index-action/, 'no handler: the old passive badge');
  assert.doesNotMatch(picker({ indexCoverage: coverage({ indexed: ['a1', 'a2', 'b1'] }), indexSlot: true, onIndex: go }), /data-index-gap|data-index-action/, 'everything indexed: no line');
  assert.doesNotMatch(picker({ indexCoverage: null, indexSlot: true, onIndex: go }), /data-index-gap|data-index-action/, 'no coverage (the extension is not applicable): nothing');
  assert.match(picker({ indexCoverage: coverage({ indexed: ['a1', 'b1'], missing: ['a2'], canIndex: false }), indexSlot: true, onIndex: go }), /去安装检索扩展/, 'not installed: the line says install');
});

test('the page and the picker wire the entry: 设置 › 检索扩展 with the course, no silent build', async () => {
  const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const [views, generate, pane, sources] = await Promise.all(['ui/app/page-views.jsx', 'ui/Generate.jsx', 'ui/settings/RetrievalPane.jsx', 'ui/Sources.jsx'].map(read));
  assert.match(views, /onBuildIndex=\{\(course\) => openIndexBuilder\(settingsEntry\.openSettings, course\)\}/, '资料 page');
  assert.match(generate, /onIndex=\{\(course\) => openIndexBuilder\(openLargeDocumentSettings, course\)\}/, '创建题组 picker');
  assert.match(pane, /defaultCourse=\{asked \|\| data\.focus\?\.course\}/, 'the pane opens on the asked course');
  assert.doesNotMatch(generate + sources + views, /retrieval\.index\.start/, 'the click starts nothing');
});
