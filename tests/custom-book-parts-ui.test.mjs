/* 深度定制 S2 on the book page: the parts a course's 定制方案 leaves out are not offered. Without 公式 the 速查页 has no formula page, without 索引 no A–Z and no
   cards by chapter, without 速查表 更多 has no 速查表; ticked again in 「你的定制」 they come back. No plan (or a plan that makes no book): every entry, as before.
   On the 总纲, a chapter not built yet of an outline built by chapters says 未生成 with its pages. Static markup, no browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { bookParts, plannedLookup, showsPart } from './ui/book/book-parts.js';
  export { default as BookLookup } from './ui/book/BookLookup.jsx';
  export { partState } from './ui/outline/BookPick.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const course = parts => ({ name: 'C', custom: { version: 1, purpose: 'review', scope: { kind: 'all' }, book: { make: true, coverage: 'standard', parts } } });
const LOOKUP = { language: 'zh', toc: [], answerOrder: [], types: [], concepts: [], mistakes: [], places: [], confusables: [],
  glossary: [{ term: '架构', gist: '骨架', hid: 'h2' }], cardChapters: [{ hid: 'h1', number: '1', title: '总论', cards: [{ code: 'K001', hid: 'h2', name: '架构' }] }],
  formulas: [{ term: 'E = mc^2', gist: '质能', hid: 'h2' }] };
const headings = lookup => [...renderToStaticMarkup(h(ui.BookLookup, { lookup, onGo: () => {}, toc: false })).matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map(found => found[1]);

test('no plan, or a plan that makes no book: every part is offered, the 速查页 as it was', () => {
  for (const record of [null, { name: 'C' }, { name: 'C', custom: { ...course(['explain']).custom, book: { make: false, coverage: 'brief', parts: ['explain'] } } }]) {
    const parts = ui.bookParts(record);
    assert.equal(parts, null);
    for (const id of ['formulas', 'index', 'cheatSheet']) assert.equal(ui.showsPart(parts, id), true, id);
    assert.equal(ui.plannedLookup(LOOKUP, parts), LOOKUP, 'the same lookup, untouched');
  }
  assert.deepEqual(headings(LOOKUP), ['按题型', '生词与概念', '术语卡（按章）', '公式', '按概念', '易错点（按知识点）']);
});

test('a plan without 公式, 索引 and 速查表: no formula page, no A–Z, no cards by chapter, no 速查表; ticked again, they are back', () => {
  const off = ui.bookParts(course(['explain', 'terms']));
  assert.deepEqual([ui.showsPart(off, 'formulas'), ui.showsPart(off, 'index'), ui.showsPart(off, 'cheatSheet')], [false, false, false]);
  assert.deepEqual(headings(ui.plannedLookup(LOOKUP, off)), ['按题型', '按概念', '易错点（按知识点）']);
  assert.deepEqual(LOOKUP.formulas.length, 1, 'the book itself is not changed');
  const on = ui.bookParts(course(['explain', 'terms', 'formulas', 'index', 'cheatSheet']));
  assert.deepEqual([ui.showsPart(on, 'formulas'), ui.showsPart(on, 'index'), ui.showsPart(on, 'cheatSheet')], [true, true, true]);
  assert.deepEqual(headings(ui.plannedLookup(LOOKUP, on)), headings(LOOKUP));
  const formulasOnly = ui.bookParts(course(['explain', 'formulas']));
  assert.deepEqual(headings(ui.plannedLookup(LOOKUP, formulasOnly)), ['按题型', '公式', '按概念', '易错点（按知识点）']);
});

test('a chapter of an outline built by chapters that is not built yet: 未生成 with its pages, in both languages', () => {
  const pending = { id: 'doc#4', title: 'Chapter 5', points: 0, written: 0, pending: true, pages: [201, 250] };
  assert.equal(ui.partState(pending), '未生成 · 第 201–250 页');
  assert.equal(english(() => ui.partState(pending)), 'Not built · pages 201–250');
  assert.equal(ui.partState({ ...pending, pages: null }), '未生成');
  assert.equal(english(() => ui.partState({ ...pending, pages: null })), 'Not built');
  assert.equal(ui.partState({ id: 'c2', title: 'Kinetics', points: 3, written: 0 }), '未生成 · 3 个知识点', 'a chapter of the outline as before');
});
