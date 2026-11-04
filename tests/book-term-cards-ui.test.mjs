/* 术语卡 on screen (#710; static zh and en): under a point's explanation a folded 「术语卡 K001–K002」 list, each card its code, name and other name, the plain
   line, the 考场原句 and its relations grouped by kind, a relation to a carded concept a link that goes to that card; the 速查页 lists the A–Z with each card's
   code and other names, the cards by chapter and the formula page. A book without cards shows none of it. No title= on text. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { default as TermCards } from './ui/book/TermCards.jsx';
  export { default as PointBody } from './ui/book/PointBody.jsx';
  export { default as BookLookup } from './ui/book/BookLookup.jsx';
  export { AiFoldContext } from './ui/book/ai-fold.js';
  export { goneSet } from './ui/book/model.js';
  export { bookLookup } from './lib/course-book-lookup.js';
  export { withCardNumbers } from './lib/course-book-card-numbers.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
globalThis.window ??= { innerWidth: 1280, addEventListener: noop, removeEventListener: noop };

const ID = n => `i${String(n).padStart(11, '0')}`;
const card = (n, name, extra = {}) => ({ item: ID(n), name, plain: `${name}：一句白话。`, pitch: `${name} is what the exam asks for.`, ...extra });
const nodes = () => ui.withCardNumbers([{ hid: 'h1', title: '基础', number: '1', depth: 1, leaf: false, children: [
  { hid: 'h2', key: 'bk:p1', title: '什么是架构', number: '1.1', depth: 2, leaf: true, gen: '讲解正文。', mine: '', qa: '', files: { gen: 'p1.gen.md', mine: 'p1.mine.md' },
    questionTotal: 0, questions: [], children: [],
    cards: [card(1, '软件架构', { alt: 'Software Architecture', relations: [{ kind: 'related', item: ID(2), name: '耦合' }, { kind: 'opposite', name: '大泥球' },
      { kind: 'part', name: '组件' }] }), card(2, '耦合', { alt: 'Coupling' })] }] },
{ hid: 'h3', title: '性能', number: '2', depth: 1, leaf: false, children: [
  { hid: 'h4', key: 'bk:p2', title: '排队', number: '2.1', depth: 2, leaf: true, gen: '另一段。', mine: '', qa: '', files: { gen: 'p2.gen.md', mine: 'p2.mine.md' },
    questionTotal: 0, questions: [], children: [] }] }]);

test('a point\'s cards: folded under its explanation, each its code, names, plain line, 考场原句 and relations; a carded relation is a link to that card', () => {
  const point = nodes()[0].children[0], went = [];
  const html = render(h(ui.TermCards, { cards: point.cards, onCard: (hid, code) => went.push([hid, code]) })), text = textOf(html);
  assert.match(html, /<details[^>]*book-cards/, 'one fold, like 要点清单');
  assert.match(text, /术语卡 K001–K002/);
  assert.match(text, /K001 软件架构 Software Architecture 软件架构：一句白话。 考场原句 软件架构 is what the exam asks for\./);
  assert.match(text, /相关概念 耦合 K002/);
  assert.match(text, /对立概念 大泥球/);
  assert.match(text, /子概念 组件/);
  assert.match(html, /data-term-card="K002"/);
  assert.doesNotMatch(html, /\btitle="/, 'no title= on text');
  const links = html.match(/data-term-link="K\d{3}"/g) || [];
  assert.deepEqual(links, ['data-term-link="K002"'], 'only a relation whose target has a card is a link');
  const en = english(() => textOf(render(h(ui.TermCards, { cards: point.cards, onCard: noop }))));
  assert.match(en, /Term cards K001–K002/);
  assert.match(en, /Exam pitch/);
  assert.match(en, /Related 耦合 K002/);
  assert.doesNotMatch(en.replace(/软件架构|耦合|大泥球|组件|一句白话|：|。/g, ''), han);
  assert.equal(render(h(ui.TermCards, { cards: [], onCard: noop })), '', 'no cards, nothing');
});

const handlers = { gone: ui.goneSet([]), qaOpen: () => false, toggleQa: noop, source: noop, card: noop, practice: noop, create: noop, files: {}, choose: noop, busy: false,
  ask: noop, aiAction: noop, aiFollow: noop, goCard: noop };
const fold = { folded: () => false, fold: noop, foldAll: noop };
const body = node => render(h(ui.AiFoldContext.Provider, { value: fold }, h(ui.PointBody, { node, course: 'SA', handlers, level: 3 })));

test('the point body shows its cards after the explanation; a point without cards shows none', () => {
  const [first, second] = [nodes()[0].children[0], nodes()[1].children[0]];
  const html = body(first);
  assert.ok(html.indexOf('讲解正文') < html.indexOf('data-term-card="K001"'), 'under the explanation');
  assert.doesNotMatch(body(second), /book-cards|术语卡/);
});

test('the 速查页: A–Z with card codes and other names, the cards by chapter, the formula page', () => {
  const book = { status: 'ok', title: '复习全书', language: 'zh', unplaced: { title: '未归位', text: '' }, nodes: nodes(),
    glossary: [{ term: '软件架构', item: ID(1), gist: '骨架决策', kind: 'definition', hid: 'h2', material: 'L1', page: 2 },
      { term: '利特尔法则', item: ID(9), gist: 'L = λW', kind: 'formula', hid: 'h4', material: 'L2', page: 9 }] };
  const lookup = ui.bookLookup(book, {}), html = render(h(ui.BookLookup, { lookup, onGo: noop, onCard: noop })), text = textOf(html);
  assert.match(text, /Software Architecture → 软件架构 K001/, 'an other name points to the same card');
  assert.match(text, /软件架构 ：骨架决策 K001 H2/);
  assert.match(text, /术语卡（按章）/);
  assert.match(text, /1 基础 K001 软件架构 · K002 耦合/);
  assert.match(text, /公式/);
  assert.match(text, /利特尔法则 ：L = λW H4 第 9 页/);
  const en = english(() => textOf(render(h(ui.BookLookup, { lookup, onGo: noop, onCard: noop }))));
  assert.match(en, /Term cards by chapter/);
  assert.match(en, /Formulas/);
  const plain = render(h(ui.BookLookup, { lookup: ui.bookLookup({ ...book, nodes: [{ hid: 'h9', title: 'x', number: '1', depth: 1, leaf: true, gen: 'y', mine: '', qa: '', children: [] }], glossary: [] }, {}), onGo: noop }));
  assert.doesNotMatch(plain, /术语卡|book-lookup-cards|book-lookup-formulas/, 'a book without cards or formulas: no empty parts');
});
