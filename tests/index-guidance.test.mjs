import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { loadUi } from './helpers/ui-module.mjs';

/* Owner 2026-11-06, building the index of a 513-page book: "is it not said that this uses tokens?... the entry is too hidden and nobody knows what it is for".
   The index runs on this computer with a local model (no tokens, nothing leaves the computer; only the first build downloads about 90 MB), and its use is that
   a whole-book run then reads only the relevant pages. The panel says so in one line; a book of 150 pages or more that has no index gets one quiet hint with a
   direct button wherever 深度定制 or a whole-book run is offered; the finder says where it is and what it does. */
const m = await loadUi(`
  export { default as IndexHint, useIndexLink } from './ui/IndexHint.jsx';
  export { default as IndexNote } from './ui/IndexNote.jsx';
  export { default as ExtensionPanel } from './ui/ExtensionPanel.jsx';
  export { default as IndexBadge, IndexGapLine } from './ui/IndexBadge.jsx';
  export { moreItems } from './ui/book/BookMore.jsx';
  export { indexHintFor, hintDocOf, goIndex, indexHinted, markIndexHinted, INDEX_HINT_PAGES } from './ui/index-hint.js';
  export { peekIndexCourse, clearIndexCourse } from './ui/index-focus.js';
  export { FINDER_ENTRIES } from './ui/finder/entries.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const han = /[㐀-鿿]/;
const render = (element, language = 'zh') => { m.setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { m.setUiLanguage('zh'); } };
const ids = (from, count) => Array.from({ length: count }, (_, index) => `${from}-${index}`);
const book = (key, pages, extra = {}) => ({ key, sourceIds: ids(key, pages), pages, courses: ['操作系统'], ...extra });
const none = (canIndex = true) => ({ indexed: [], stale: [], missing: [], hasIndex: false, canIndex, building: false });
const done = (doc) => ({ ...none(), indexed: doc.sourceIds });

/* ---------- which book gets the hint ---------- */

test('a book of 150 pages or more with no index gets the hint; shorter, indexed or unknown get nothing', () => {
  assert.equal(m.INDEX_HINT_PAGES, 150, 'the same threshold as 深度定制这本书');
  const big = book('big', 513);
  assert.equal(m.indexHintFor([big], none())?.doc.key, 'big');
  assert.equal(m.indexHintFor([book('small', 149)], none()), null, 'below the 深度定制 threshold');
  assert.equal(m.indexHintFor([book('exact', 150)], none())?.doc.key, 'exact');
  assert.equal(m.indexHintFor([big], done(big)), null, 'already indexed: nothing');
  assert.equal(m.indexHintFor([big], null), null, 'coverage not known (or no search component): nothing');
  assert.equal(m.indexHintFor([], none()), null);
  const part = { ...none(), indexed: big.sourceIds.slice(0, 10), missing: big.sourceIds.slice(10) };
  assert.equal(m.indexHintFor([big], part)?.doc.key, 'big', 'a half-built index is still worth finishing');
  assert.equal(m.indexHintFor([big], { ...none(), building: true }), null, 'while it is being built there is nothing to ask for');
});

test('without the extension the hint is still there and says so (canIndex false)', () => {
  const big = book('big', 300);
  assert.equal(m.indexHintFor([big], none(false))?.canIndex, false);
  assert.equal(m.indexHintFor([big], none(true))?.canIndex, true);
});

test('the first unindexed book is the one named; an indexed big book before it is skipped', () => {
  const a = book('a', 400), b = book('b', 300);
  assert.equal(m.indexHintFor([a, b], done(a))?.doc.key, 'b');
});

test('the hint is made once per document: after it was used or dismissed it is not offered again', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
  try {
    const big = book('once', 200);
    assert.equal(m.indexHinted('once'), false);
    assert.ok(m.indexHintFor([big], none()));
    m.markIndexHinted('once');
    assert.equal(m.indexHinted('once'), true);
    assert.equal(m.indexHintFor([big], none()), null);
    assert.ok(m.indexHintFor([book('other', 200)], none()), 'another book is not affected');
  } finally { delete globalThis.localStorage; }
});

test('hintDocOf reads a grouped material (key, source ids, pages with text, courses)', () => {
  const doc = m.hintDocOf({ key: 'k', documentId: 'd1', sourceIds: ['a', 'b'], pages: [{}, {}], courses: ['C'] });
  assert.deepEqual(doc, { key: 'd1', sourceIds: ['a', 'b'], pages: 2, courses: ['C'] });
  assert.equal(m.hintDocOf({ key: 'k', sourceIds: [], pages: [] }).key, 'k');
});

/* ---------- the click goes to the right place ---------- */

test('the button opens 设置 › 检索扩展 with the course of the book chosen, and counts as the one offer', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
  try {
    const opened = [];
    const hint = m.indexHintFor([book('go', 200, { courses: ['数据库'] })], none());
    m.goIndex((...args) => opened.push(args), hint);
    assert.deepEqual(opened, [['settings-extensions']], 'the settings-anchor navigation the badge already uses');
    assert.equal(m.peekIndexCourse(), '数据库', 'the panel opens with this book’s course chosen');
    assert.equal(m.indexHinted('go'), true);
  } finally { m.clearIndexCourse(); delete globalThis.localStorage; }
});

/* ---------- the line ---------- */

test('the hint line: what to do, why, that it is local and free of tokens, and a direct button', () => {
  const big = book('big', 513);
  const html = render(h(m.IndexHint, { docs: [big], initialCoverage: none(), onOpenSettings: () => {} }));
  assert.match(html, /data-index-hint/);
  assert.match(html, /先建立检索索引：整本出题时只读相关页面，本机计算、不耗 token/);
  assert.match(html, />建立索引</, 'the button');
  assert.match(html, /role="tooltip"[^>]*>[^]*90 MB[^]*只下载一次/, 'the hover has the one-time download');
  assert.match(html, /role="tooltip"[^>]*>[^]*资料不离开这台电脑/);
  assert.doesNotMatch(html, /<[a-z]+[^>]*\stitle="/, 'no title= on text');
});

test('nothing is drawn for an indexed, short or unknown book', () => {
  const big = book('big', 513);
  assert.equal(render(h(m.IndexHint, { docs: [big], initialCoverage: done(big), onOpenSettings: () => {} })), '');
  assert.equal(render(h(m.IndexHint, { docs: [book('s', 40)], initialCoverage: none(), onOpenSettings: () => {} })), '');
  assert.equal(render(h(m.IndexHint, { docs: [big], onOpenSettings: () => {} })), '', 'coverage not read yet');
  assert.equal(render(h(m.IndexHint, { docs: [big], initialCoverage: none(), onOpenSettings: () => {}, hidden: true })), '', 'the page can hold it back');
  assert.equal(render(h(m.IndexHint, { docs: [big], initialCoverage: none() })), '', 'with no way to go there is nothing to offer');
});

test('without the extension the button says 安装扩展', () => {
  const html = render(h(m.IndexHint, { docs: [book('big', 513)], initialCoverage: none(false), onOpenSettings: () => {} }));
  assert.match(html, />安装扩展</);
  assert.doesNotMatch(html, />建立索引</);
});

test('English: the line, the button and the hover carry no Chinese', () => {
  const html = render(h(m.IndexHint, { docs: [book('big', 513)], initialCoverage: none(), onOpenSettings: () => {} }), 'en');
  assert.match(html, /Build the search index first: a whole-book run then reads only the relevant pages\. It runs on this computer and uses no tokens/);
  assert.match(html, />Build index</);
  assert.match(html, /about 90 MB/);
  assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), han);
  const install = render(h(m.IndexHint, { docs: [book('big', 513)], initialCoverage: none(false), onOpenSettings: () => {} }), 'en');
  assert.match(install, />Install extension</);
});

test('the quiet link for a card or a history row: its label and hover, only while the book needs it', () => {
  const Probe = ({ doc, coverage }) => {
    const link = m.useIndexLink({ docs: [doc], onOpenSettings: () => {}, initialCoverage: coverage });
    return link ? h('a', { 'data-link': true, title: link.tip }, link.label) : h('i', null, 'none');
  };
  const big = book('big', 513);
  const shown = render(h(Probe, { doc: big, coverage: none() }));
  assert.match(shown, /data-link/);
  assert.match(shown, />先建立检索索引</);
  assert.match(shown, /本机计算、不耗 token/);
  assert.match(render(h(Probe, { doc: big, coverage: none(false) })), />先安装检索扩展</);
  assert.match(render(h(Probe, { doc: big, coverage: done(big) })), /none/);
  assert.match(render(h(Probe, { doc: book('s', 20), coverage: none() })), /none/);
  assert.match(render(h(Probe, { doc: big, coverage: none() }), 'en'), />Build the index first</);
});

/* ---------- the panel and the badge say it too ---------- */

test('the panel note: local, no tokens, what it is for, and the one-time download; the English-model remark is only a hover', () => {
  const html = render(h(m.IndexNote, { firstRun: true, modelMb: 90 }));
  assert.match(html, /在这台电脑上建索引：不调用 AI、不耗 token，资料不离开电脑。建好后，整本书出题只读相关页面。/);
  assert.match(html, /首次需要下载约 90 MB 的检索模型，只下载一次，之后可以离线使用。/);
  const visible = html.replace(/<span[^>]*role="tooltip"[\s\S]*?<\/span>/g, '');
  assert.doesNotMatch(visible, /主要针对英文/, 'not in the visible line');
  assert.match(html, /role="tooltip"[^>]*>[^]*主要针对英文/, 'in the hover');
  const later = render(h(m.IndexNote, { firstRun: false, modelMb: 90 }));
  assert.doesNotMatch(later, /首次需要下载/, 'the model is already on this computer');
  assert.match(later, /不耗 token/);
  const english = render(h(m.IndexNote, { firstRun: true, modelMb: 90 }), 'en');
  assert.match(english, /uses no tokens/);
  assert.match(english, /about 90 MB/);
  assert.doesNotMatch(english.replace(/<[^>]+>/g, ' '), han);
});

test('the extension panel carries the note whether or not the extension is installed yet', () => {
  const base = { selected: 'builtin', effective: 'builtin', hostCanSearch: false, providers: [], otherTools: [], companion: { id: 'x', running: false } };
  const fresh = { ...base, extension: { canInstall: true, installed: false, enabled: false, desktop: false } };
  const running = { ...base, extension: { canInstall: true, installed: true, enabled: true, version: '2.1.1', desktop: false }, companion: { id: 'x', running: true }, hostCanSearch: true };
  const plan = { course: '操作系统', pages: 48, toIndex: 48, unchanged: 0, toRemove: 0, chars: 24000, firstRun: true, modelMb: 90, canIndex: true };
  const before = render(h(m.ExtensionPanel, { call: () => {}, status: fresh, courses: ['操作系统'] }));
  assert.match(before, /不耗 token/, 'said before installing, where the decision is made');
  const html = render(h(m.ExtensionPanel, { call: () => {}, status: running, courses: ['操作系统'], defaultCourse: '操作系统', initialPlan: plan }));
  assert.match(html, /data-index-note/);
  assert.match(html, /整本书出题只读相关页面/);
  assert.match(html, /首次需要下载约 90 MB/);
});

test('the badge’s hover on the way to the builder says it runs here and costs no tokens', () => {
  const html = render(h(m.IndexBadge, { info: { state: 'missing', total: 88 }, coverage: { canIndex: true }, onIndex: () => {} }));
  assert.match(html, /点这里去建立索引（本机计算，不耗 token）/);
  const english = render(h(m.IndexBadge, { info: { state: 'missing', total: 88 }, coverage: { canIndex: true }, onIndex: () => {} }), 'en');
  assert.match(english, /runs on this computer, no tokens/);
});

test('the shortcut line above a list (创建题组 and 资料) says why in its hover: what it is for, local, no tokens, the one-time download', () => {
  const html = render(h(m.IndexGapLine, { count: 1, canIndex: true, onGo: () => {} }));
  assert.match(html, /有 1 份资料的索引还没建完/);
  assert.match(html, /role="tooltip"[^>]*>[^]*先建立检索索引：整本出题时只读相关页面，本机计算、不耗 token[^]*约 90 MB[^]*主要针对英文/);
  const english = render(h(m.IndexGapLine, { count: 1, canIndex: true, onGo: () => {} }), 'en');
  assert.match(english, /uses no tokens/);
  assert.doesNotMatch(english.replace(/<[^>]+>/g, ' '), han);
});

/* ---------- the finder ---------- */

test('the finder says where the index is, what it does, that it is local and token-free, the one-time download and where the hints are', () => {
  const entry = m.FINDER_ENTRIES.find((item) => item.id === 'retrieval');
  assert.ok(entry);
  assert.deepEqual(entry.path, ['设置', '检索扩展']);
  for (const part of [/检索：只让 AI 看相关页面/, /本机/, /不耗 token/, /90 MB/, /150 页/, /深度定制/, /生成|出题/]) assert.match(entry.what, part);
  assert.ok(entry.aliases.includes('token'), 'asking about tokens finds it');
});

/* ---------- the sites that offer 深度定制 or a whole-book run draw the hint (the 创建题组 and 资料 pages already have the shortcut line above their list, which carries the reason) ---------- */

test('更多 › 整本书 offers 先建立检索索引… just before 深度定制…, only while a big book of the course has no index', () => {
  const labels = (state) => m.moreItems(state).filter((item) => !item.heading).map((item) => item.label);
  assert.ok(!labels({}).includes('先建立检索索引…'));
  const withIndex = m.moreItems({ index: true }).filter((item) => !item.heading);
  const at = withIndex.findIndex((item) => item.id === 'index');
  assert.ok(at >= 0);
  assert.equal(withIndex[at + 1].id, 'custom');
  assert.equal(withIndex[at].hint, '本机 · 不耗 token');
  m.setUiLanguage('en');
  try { assert.equal(m.moreItems({ index: true }).find((item) => item.id === 'index').label, 'Build the search index first…'); } finally { m.setUiLanguage('zh'); }
});

test('the import list, the finished card, the history row and the book menu use the one shared hint, and the book page wires its menu item to the settings', async () => {
  const read = (path) => readFile(path, 'utf8');
  const [importHub, card, actions, page, views] = await Promise.all(['ui/ImportHub.jsx', 'ui/PdfConvertJob.jsx', 'ui/book/more-actions.js', 'ui/book/BookPage.jsx', 'ui/app/page-views.jsx'].map(read));
  assert.match(importHub, /<IndexHint docs=/, 'the import file list');
  assert.match(card, /useIndexLink\(/, 'the finished import card');
  assert.match(card, /<IndexHint variant="link"/, 'the 解析历史 row');
  assert.match(actions, /id === 'index'\) onBuildIndex\?\.\(course\)/, '更多 › 整本书');
  assert.match(page, /index=\{needsIndex\}/);
  assert.match(views, /onBuildIndex=\{\(name\) => openIndexBuilder\(settingsEntry\.openSettings, name\)\}/);
});
