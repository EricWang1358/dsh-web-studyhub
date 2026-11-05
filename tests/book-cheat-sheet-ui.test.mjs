/* 复习全书 S5 (#710) on the page: 「⋯ 更多」 › 速查表 stands in 整本书 only while the book has something for a sheet, it opens a view that takes the reading
   surface's place (like 翻看) with 「完成 · 回到阅读」, and the page it shows is the one that is printed and saved. Static markup, no browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { moreItems } from './ui/book/BookMore.jsx';
  export { CheatView } from './ui/book/book-views.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { cheatSheetPage } from './ui/book/cheat-sheet-file.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {};
const ids = items => items.filter(item => !item.heading).map(item => item.id);
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const BOOK = { status: 'ok', title: '体系结构', language: 'zh', unplaced: { title: '未归位', text: '' }, glossary: [],
  nodes: [{ hid: 'h2', title: '什么是架构', number: '1', depth: 1, leaf: true, gen: '', mine: '', qa: '', children: [],
    cards: [{ item: 'i00000000001', name: '架构', plain: '骨架', code: 'K001', hid: 'h2' }] }] };

test('更多 › 速查表 is in 整本书 next to 速查页…, and only when the book has a sheet', () => {
  assert.ok(!ids(ui.moreItems({})).includes('cheat'));
  const items = ui.moreItems({ cheat: true }), list = ids(items);
  assert.ok(list.indexOf('cheat') > list.indexOf('lookup') && list.indexOf('cheat') < list.indexOf('export'), 'between 速查页… and 导出…');
  assert.equal(items.find(item => item.id === 'cheat').label, '速查表');
  assert.ok(!items.find(item => item.id === 'cheat').label.endsWith('…'), 'it opens no dialog first, it takes the page');
});

test('the view: its name and the way back; the buttons wait for the page', () => {
  const html = render(h(ui.CheatView, { book: BOOK, onGo: noop, onDone: noop })), text = textOf(html);
  assert.match(text, /速查表/);
  assert.match(text, /完成 · 回到阅读/);
  assert.match(text, /打印 \/ 存为 PDF/);
  assert.match(text, /下载 \.html/);
  assert.doesNotMatch(html, /\btitle="[^"]*"[^>]*>[^<]/, 'no title= on text');
});

test('the page the view shows names the book\'s points as links, the page that is saved does not', async () => {
  const view = await ui.cheatSheetPage(BOOK, { links: true }), saved = await ui.cheatSheetPage(BOOK);
  assert.match(view.html, /data-go="h2"/);
  assert.doesNotMatch(saved.html, /data-go=/);
  assert.equal(saved.filename, '体系结构 速查表.html');
  assert.equal(await ui.cheatSheetPage({ status: 'ok', nodes: [], glossary: [] }), null);
});
