/* 易混概念 on screen (#710 S3; static zh and en): in the 速查页 next to the term-card indexes and the formula page, a comparison per pair (C001, the two cards' codes as
   links that go to the cards, a row each for what it is, when to use it, the key difference and the common mistake, the cells under the names); a book without
   comparisons shows nothing of it; no title= on text. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { default as BookLookup } from './ui/book/BookLookup.jsx';
  export { bookLookup } from './lib/course-book-lookup.js';
  export { withCardNumbers } from './lib/course-book-card-numbers.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {};
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const ID = n => `i${String(n).padStart(11, '0')}`;
const card = (n, name, extra = {}) => ({ item: ID(n), name, plain: `${name}：一句白话。`, pitch: `${name} in an answer.`, ...extra });
const nodes = () => ui.withCardNumbers([
  { hid: 'h1', title: '基础', number: '1', depth: 1, leaf: false, children: [
    { hid: 'h2', title: '缓存', number: '1.1', depth: 2, leaf: true, gen: '正文。', mine: '', qa: '', children: [], cards: [card(1, '缓存', { relations: [{ kind: 'opposite', item: ID(2), name: '缓冲' }] }), card(2, '缓冲')] }] },
  { hid: 'h3', title: '网络', number: '2', depth: 1, leaf: false, children: [
    { hid: 'h4', title: '传输层', number: '2.1', depth: 2, leaf: true, gen: '正文。', mine: '', qa: '', children: [], cards: [card(3, 'TCP', { relations: [{ kind: 'parallel', item: ID(4), name: 'UDP' }] }), card(4, 'UDP')] }] }]);
const confusables = [
  { id: 'C001', items: ['K001', 'K002'], names: ['缓存', '缓冲'], rows: [{ aspect: 'what', cells: ['缓存是副本', '缓冲是中转'] }, { aspect: 'when', cells: ['读多时', '速率不匹配时'] },
    { aspect: 'difference', cells: ['为了再次读取', '为了平滑速度'] }, { aspect: 'mistake', cells: ['当成缓冲', '当成缓存'] }] },
  { id: 'C002', items: ['K003', 'K004'], names: ['TCP', 'UDP'], rows: [{ aspect: 'difference', cells: ['可靠有序', '无连接'] }] }];
const bookOf = extra => ({ status: 'ok', title: '复习全书', language: 'zh', unplaced: { title: '未归位', text: '' }, nodes: nodes(), glossary: [], ...extra });

test('the lookup carries the comparisons with the heading of each card, and none without them', () => {
  const lookup = ui.bookLookup(bookOf({ confusables }), {});
  assert.deepEqual(lookup.confusables.map(each => [each.id, each.hids]), [['C001', ['h2', 'h2']], ['C002', ['h4', 'h4']]]);
  assert.deepEqual(lookup.confusables[0].rows, confusables[0].rows);
  assert.deepEqual(ui.bookLookup(bookOf(), {}).confusables, []);
});

test('the 速查页 page: a comparison per pair, the cards as links, the four rows in order under the two names; nothing for a book without them', () => {
  const lookup = ui.bookLookup(bookOf({ confusables }), {}), went = [];
  const html = renderToStaticMarkup(h(ui.BookLookup, { lookup, onGo: noop, onCard: (hid, code) => went.push([hid, code]) })), text = textOf(html);
  assert.match(text, /易混概念/);
  assert.match(text, /C001 缓存 K001 · 缓冲 K002/);
  assert.match(text, /是什么 缓存是副本 缓冲是中转 什么时候用 读多时 速率不匹配时 关键区别 为了再次读取 为了平滑速度 常见误区 当成缓冲 当成缓存/);
  assert.match(text, /C002 TCP K003 · UDP K004/);
  assert.match(html, /data-confusable="C001"/);
  const part = html.slice(html.indexOf('id="book-lookup-confusables"'), html.indexOf('id="book-lookup-concepts"'));
  assert.deepEqual(part.match(/data-term-link="K\d{3}"/g), ['data-term-link="K001"', 'data-term-link="K002"', 'data-term-link="K003"', 'data-term-link="K004"']);
  assert.ok(html.indexOf('术语卡（按章）') < html.indexOf('易混概念'), 'after the term-card indexes');
  assert.doesNotMatch(html, /\btitle="/, 'no title= on text');
  // Every cell says whose it is, so a narrow screen can put the name beside it.
  assert.match(html, /data-head="缓存"/);
  const none = renderToStaticMarkup(h(ui.BookLookup, { lookup: ui.bookLookup(bookOf(), {}), onGo: noop, onCard: noop }));
  assert.doesNotMatch(none, /易混概念|data-confusable/);
  const en = english(() => textOf(renderToStaticMarkup(h(ui.BookLookup, { lookup, onGo: noop, onCard: noop }))));
  assert.match(en, /Confusable concepts/);
  assert.match(en, /What it is .* When to use it .* Key difference .* Common mistake/);
  for (const word of ['易混概念', '是什么', '什么时候用', '关键区别', '常见误区']) assert.ok(!en.includes(word), `${word} is translated`);
});
