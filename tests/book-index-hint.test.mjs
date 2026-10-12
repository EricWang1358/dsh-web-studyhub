/* The 复习全书's line about the course's search index (ui/book/BookIndexHint.jsx, static zh and en): not built (with the shortcut to 设置 › 检索扩展, or
   去安装检索扩展 without the extension), N pages missing (去补建), a build going (no link), ready (nothing, or an empty slot of the same line when reserved);
   its hover says where the index is built, that it costs no tokens and which materials have pages missing (the settings' own words); the 弄懂 panel's
   muted line; the main chat's message names the index in one line. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { default as BookIndexHint, hintWords, hintTip } from './ui/book/BookIndexHint.jsx';
  export { bookIndexState, indexReady } from './ui/book/book-index.js';
  export { default as BookAiAsk } from './ui/book/BookAiAsk.jsx';
  export { bookEditPrompt } from './ui/agent-prompts/book.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
globalThis.window ??= { innerWidth: 1280, addEventListener: noop, removeEventListener: noop };

const plan = (over = {}) => ({ course: 'ArchSS', pages: 870, toIndex: 870, unchanged: 0, toRemove: 0, documents: 14, missing: [{ title: '04. Design Secure Architecture v4.7', pages: 198 }], missingDocuments: 9, canIndex: true, ...over });
const hint = (state, props = {}) => render(h(ui.BookIndexHint, { state, plan: props.plan ?? plan(), course: 'ArchSS', ...props }));

test('the state of a course\'s index from the plan and a running build', () => {
  assert.equal(ui.bookIndexState(null, null, 'A'), null, 'unknown until the plan is read');
  assert.deepEqual(ui.bookIndexState(plan(), null, 'ArchSS'), { kind: 'missing', canIndex: true });
  assert.deepEqual(ui.bookIndexState(plan({ unchanged: 800, toIndex: 70 }), null, 'ArchSS'), { kind: 'partial', missing: 70, canIndex: true });
  assert.deepEqual(ui.bookIndexState(plan({ unchanged: 870, toIndex: 0 }), null, 'ArchSS'), { kind: 'ready', canIndex: true });
  assert.deepEqual(ui.bookIndexState(plan(), { status: 'running', course: 'ArchSS', done: 18, total: 870 }, 'ArchSS'), { kind: 'building', done: 18, total: 870, canIndex: true });
  assert.equal(ui.bookIndexState(plan(), { status: 'running', course: 'Other', done: 1, total: 2 }, 'ArchSS').kind, 'missing', 'another course\'s build is not this one');
  assert.equal(ui.bookIndexState(plan({ pages: 0, unchanged: 0, toIndex: 0 }), null, 'ArchSS').kind, 'ready', 'a course without pages has nothing to say');
  assert.ok(ui.indexReady({ kind: 'ready' }) && !ui.indexReady(null) && !ui.indexReady({ kind: 'partial' }));
});

test('not built, partly built, building, ready: the words, the link, the hover (zh)', () => {
  const missing = hint({ kind: 'missing', canIndex: true });
  assert.match(textOf(missing), /^这门课的资料还没建索引。建好后，弄懂、加一段和主会话改书都会先找到相关的页，覆盖率也更高 这门课的资料还没建索引 .* · 去建立索引$/,
    'the full words, the short ones, the hover (hidden until hover or focus), the link');
  assert.match(missing, /data-book-index="missing"/);
  assert.match(missing, /data-book-index-go/);
  const tip = ui.hintTip({ kind: 'missing', canIndex: true }, plan(), 'ArchSS');
  assert.match(tip, /在本机把还没编目录的页编好，不调用 AI，不花 token。/, 'local, no tokens: the settings\' own sentence');
  assert.match(tip, /其中 870 页还没建索引，来自《04\. Design Secure Architect…》（198 页）等 9 份/, 'which pages are missing: the course line of 检索扩展');
  assert.match(tip, /点这里去建立索引/);
  assert.match(missing, /role="tooltip"/, 'a Tooltip, not a title attribute');
  assert.doesNotMatch(missing, / title="/);
  const install = hint({ kind: 'missing', canIndex: false }, { plan: plan({ canIndex: false }) });
  assert.match(textOf(install), /· 去安装检索扩展/);
  assert.match(ui.hintTip({ kind: 'missing', canIndex: false }, plan({ canIndex: false }), 'ArchSS'), /点这里去安装检索扩展/);
  const partial = hint({ kind: 'partial', missing: 70, canIndex: true }, { plan: plan({ unchanged: 800, toIndex: 70 }) });
  assert.match(textOf(partial), /^索引还差 70 页（新加的资料） 索引还差 70 页 .* · 去补建$/);
  const building = hint({ kind: 'building', done: 18, total: 870, canIndex: true });
  assert.match(textOf(building), /正在建立索引 18\/870 页/);
  assert.doesNotMatch(building, /data-book-index-go/, 'no link while a build is going');
  assert.equal(hint({ kind: 'ready', canIndex: true }), '', 'ready: nothing');
  assert.equal(hint(null), '', 'unknown and not reserved: nothing');
  assert.match(hint(null, { reserve: true }), /class="book-index-hint book-index-hint--slot" aria-hidden="true" data-book-index="slot"/, 'reserved: an empty line of the same height');
  assert.match(hint({ kind: 'ready' }, { reserve: true }), /data-book-index="slot"/, 'once shown, its room stays');
});

test('the same in English, with no Chinese left', () => english(() => {
  const missing = textOf(hint({ kind: 'missing', canIndex: true }));
  assert.match(missing, /This course's materials have no search index yet\. With one, Explain, Add a paragraph and the main chat's edits find the relevant pages first/);
  assert.doesNotMatch(missing, han, missing);
  assert.doesNotMatch(textOf(hint({ kind: 'partial', missing: 70, canIndex: true })), han);
  assert.match(textOf(hint({ kind: 'building', done: 18, total: 870 })), /Building the index: 18\/870 pages/);
  assert.doesNotMatch(ui.hintTip({ kind: 'partial', missing: 70, canIndex: true }, plan({ unchanged: 800, toIndex: 70 }), 'ArchSS').replace(/《[^》]*》|“[^”]*”|"[^"]*"/g, ''), han);
}));

test('the 弄懂 panel carries one muted line when the index is not ready', () => {
  const muted = h(ui.BookIndexHint, { state: { kind: 'partial', missing: 3, canIndex: true }, plan: plan({ unchanged: 867, toIndex: 3 }), course: 'ArchSS', variant: 'muted' });
  const html = render(h(ui.BookAiAsk, { target: { heading: 'h1', words: 'CIA', top: 10, left: 10 }, model: { ready: true }, onStart: noop, onClose: noop, indexHint: muted }));
  assert.match(html, /book-index-hint--muted/);
  assert.match(textOf(html), /索引还差 3 页/);
  const none = render(h(ui.BookAiAsk, { target: { heading: 'h1', words: 'CIA', top: 10, left: 10 }, model: { ready: true }, onStart: noop, onClose: noop }));
  assert.doesNotMatch(none, /book-index-hint/);
});

test('the main chat\'s message names the index in one short line', () => {
  const base = { course: 'SA', hid: 'h12', title: 'T', files: ['p12.gen.md'], version: 3, coverage: { opened: 2, pages: 5 }, scope: 'point' };
  assert.match(ui.bookEditPrompt({ ...base, index: { status: 'ok', missing: 0 } }, 'zh'), /检索索引：已建好，先用 book\.search 找相关的页再读。\n/);
  assert.match(ui.bookEditPrompt({ ...base, index: { status: 'partial', missing: 70 } }, 'zh'), /检索索引：还差 70 页没建/);
  assert.match(ui.bookEditPrompt({ ...base, index: { status: 'building', building: { done: 18, total: 870 } } }, 'zh'), /检索索引：正在建（18\/870 页）/);
  for (const status of ['no-index', 'no-extension']) assert.match(ui.bookEditPrompt({ ...base, index: { status } }, 'zh'), /检索索引：还没建，按 book\.coverage 的 readNext 读；「设置 › 检索扩展」可以建（本机，不花 token）。/);
  assert.doesNotMatch(ui.bookEditPrompt(base, 'zh'), /检索索引/, 'not known: no line');
  assert.match(ui.bookEditPrompt({ ...base, scope: 'book', hid: '', index: { status: 'ok' } }, 'en'), /Search index: ready; find the relevant pages with book\.search before reading\./);
});
