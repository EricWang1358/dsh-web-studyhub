/* 复习全书 S4 (#710): the exam answer kit on the book page, reached from 「⋯ 更多」 › 答题模板… next to 速查页… (only when the book has a kit): the template cards
   T01… with their [slots] marked, each past question's fill named by paper and number (its words on hover, never a title=), and the question-signal matrix
   (trigger words → what is tested → template → points → past papers); every point code opens the book there. Static markup, no browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { moreItems } from './ui/book/BookMore.jsx';
  export { default as BookExamKit } from './ui/book/BookExamKit.jsx';
  export { fillParts, templateParts } from './ui/book/exam-kit-model.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement;
const ids = items => items.filter(item => !item.heading).map(item => item.id);

const KIT = { language: 'en', types: [
  { code: 'T01', name: 'Ecosystem mapping', family: 'design', signals: ['grow its ecosystem', 'seeds'], asks: '平台四要素 + 闭环交互链',
    template: '1. Given the seeds ([Seed A & Seed B]), a crucial aspect is [Core Capability].\n2. This introduces [Key Trade-off].',
    fills: [{ ref: 'PAST3 Q1a', quote: 'How can ONE Health grow its ecosystem?', fill: 'Seeds: prescriptions ｜ Capability: open APIs' }],
    anchors: ['PAST2 Q1a', 'PAST3 Q1a'], hids: ['h3', 'h7'] },
  { code: 'T02', name: 'Compare', family: 'compare', signals: [], asks: '', template: 'Compare [A] with [B].', fills: [], anchors: ['PAST1 Q2'], hids: [] }] };

test('更多 › 答题模板… stands next to 速查页… only when the book has an answer kit', () => {
  assert.ok(!ids(ui.moreItems({})).includes('kit'), 'no kit: no item');
  const list = ids(ui.moreItems({ kit: true }));
  assert.equal(list[list.indexOf('lookup') + 1], 'kit');
  assert.equal(ui.moreItems({ kit: true }).find(item => item.id === 'kit').label, '答题模板…');
});

test('a template\'s slots and a fill\'s slot names are told apart from the words around them', () => {
  assert.deepEqual(ui.templateParts('Use [A] and [B].'), [{ text: 'Use ' }, { text: '[A]', slot: true }, { text: ' and ' }, { text: '[B]', slot: true }, { text: '.' }]);
  assert.deepEqual(ui.templateParts('No slot.'), [{ text: 'No slot.' }]);
  assert.deepEqual(ui.fillParts('Seeds: prescriptions ｜ Capability: open APIs'), [{ slot: 'Seeds', value: 'prescriptions' }, { slot: 'Capability', value: 'open APIs' }]);
  assert.deepEqual(ui.fillParts('just words'), [{ value: 'just words' }]);
});

test('the kit page: cards T01… with slots marked, fills by paper and number with the question as a tip, the matrix, codes that open the book', () => {
  const html = renderToStaticMarkup(h(ui.BookExamKit, { kit: KIT, onGo: () => {} }));
  assert.match(html, /按题型的答题模板/);
  assert.match(html, /题干信号矩阵/);
  assert.match(html, /id="book-kit-T01"/);
  assert.match(html, /<mark class="book-kit__slot">\[Seed A &amp; Seed B\]<\/mark>/);
  assert.equal((html.match(/class="book-kit__slot"/g) || []).length, 5, 'every slot of the two templates (3 + 2), none elsewhere');
  assert.match(html, /PAST3 Q1a/);
  assert.doesNotMatch(html, /\stitle="/, 'the question is a Tooltip, never a title=');
  assert.match(html, /<table class="book-kit__matrix"/);
  assert.equal((html.match(/<tr class="book-kit__row"/g) || []).length, 2, 'one row per type');
  assert.match(html, /grow its ecosystem · seeds/);
  assert.match(html, /PAST2 Q1a · PAST3 Q1a/);
  assert.equal((html.match(/data-book-code="h3"/g) || []).length, 2, 'a point code on the card and in the matrix');
  assert.match(html, /data-kit-jump="T02"/, 'the matrix\'s template code jumps to its card');
});

test('the kit page in English', () => {
  ui.setUiLanguage('en');
  try {
    const html = renderToStaticMarkup(h(ui.BookExamKit, { kit: KIT, onGo: () => {} }));
    assert.match(html, /Templates by question type/);
    assert.match(html, /Question signals/);
    assert.doesNotMatch(html.replace(/平台四要素 \+ 闭环交互链/g, ''),/[㐀-鿿]/, 'no Chinese but the kit\'s own words');
    assert.equal(ui.moreItems({ kit: true }).find(item => item.id === 'kit').label, 'Answer templates…');
  } finally { ui.setUiLanguage('zh'); }
});
