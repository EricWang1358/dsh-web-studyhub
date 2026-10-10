/* 复习全书 page M1 (static zh and en; docs/plans/review-book.md): a closed chapter is only its heading (I8), an open one renders a point's generated file
   with its question links drawn by the book, 这道题已被删除 for a gone question and plain text for an unknown studyhub:// link (I5); a point without
   questions offers 出题; the live 目录 marks 你在这里; the 总纲 page offers 打开书页 only when the book is written. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { default as BookChapter } from './ui/book/BookChapter.jsx';
  export { default as BookToc } from './ui/book/BookToc.jsx';
  export * from './ui/book/model.js';
  export { CourseOutlineView } from './ui/outline/CourseOutline.jsx';
  export { emptyPick } from './ui/outline/model.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const gen = ['**知识梳理**', '', '- Entropy measures disorder [^1]', '', '**出处**', '', '[^1]: [「Entropy measures disorder」](studyhub://source/tb-p3) · Textbook', '',
  '**本节的题**', '', '- [练习：What is entropy?](studyhub://card/d1/q1)', '- [练习：A deleted one](studyhub://card/d1/gone)', '- [Strange](studyhub://delete/d1/q1)', '- [Web](https://example.com)', '',
  '[练 5 道：Entropy](studyhub://practice?heading=h2&n=5) · [本节问答：Entropy](studyhub://qa?heading=h2)'].join('\n');
const book = { status: 'ok', title: '复习全书 · SA', notes: true, papers: 0, missing: ['d1|gone'], unplaced: { title: '未归位', text: '' },
  nodes: [{ hid: 'h1', key: 'bk:c1', title: 'Thermodynamics', number: '1', depth: 1, leaf: false, children: [
    { hid: 'h2', key: 'bk:p1', title: 'Entropy', number: '1.1', depth: 2, leaf: true, gen, mine: '', questions: 2, children: [] },
    { hid: 'h3', key: 'bk:p2', title: 'Enthalpy', number: '1.2', depth: 2, leaf: true, gen: '这一节还没有题。', mine: 'My note.', questions: 0, children: [] }] },
  { hid: 'h4', key: 'bk:c2', title: 'Kinetics', number: '2', depth: 1, leaf: true, gen: 'Rates.', mine: '', questions: 1, children: [] }] };
const handlers = { gone: ui.goneSet(book.missing), qaOpen: () => false, toggleQa: noop, source: noop, card: noop, practice: noop, create: noop };
const chapter = (node, open) => render(h(ui.BookChapter, { node, open, onToggle: noop, course: 'SA', handlers }));

test('a closed chapter is its heading only; an open one renders its points with the book\'s links (I5, I8)', () => {
  const closed = chapter(book.nodes[0], false);
  assert.match(closed, /id="book-h1"/);
  assert.match(closed, /aria-expanded="false"/);
  assert.doesNotMatch(closed, /Entropy measures disorder/, 'nothing of a closed chapter is rendered');
  const html = chapter(book.nodes[0], true), text = textOf(html);
  assert.match(html, /id="book-h2"[^>]*data-book-heading="h2"/);
  assert.match(text, /1\.1 Entropy/);
  assert.match(html, /data-book-link="card"[^>]*>[^<]*练习：What is entropy\?/);
  assert.match(text, /这道题已被删除/, 'a gone question says so in its place');
  assert.doesNotMatch(text, /A deleted one/);
  assert.match(html, /data-book-link="practice"/);
  assert.match(html, /data-book-link="qa"[^>]*aria-expanded="false"/);
  assert.match(html, /data-book-link="source"/);
  assert.doesNotMatch(html, /href="studyhub:/, 'a studyhub:// link never becomes a raw link');
  assert.match(html, /<span class="md-link">Strange<\/span>/, 'an unknown studyhub:// link is plain text');
  assert.match(html, /href="https:\/\/example\.com"[^>]*rel="noopener noreferrer"/, 'an ordinary link opens normally');
  assert.match(html, /class="md-cite"/, 'the 角标 is a button');
  assert.match(text, /这一节还没有题。/);
  assert.match(text, /出题/, 'a point without questions offers the 出题 entry');
  assert.match(html, /book-file--mine[\s\S]*My note\./, 'the learner\'s file follows the generated one');
});

test('the live 目录 lists the stitched headings with their chapter and marks 你在这里', () => {
  const entries = ui.tocEntries(book);
  assert.deepEqual(entries.map(entry => [entry.id, entry.title, entry.chapter]), [['h1', '1 Thermodynamics', 'h1'], ['h2', '1.1 Entropy', 'h1'], ['h3', '1.2 Enthalpy', 'h1'], ['h4', '2 Kinetics', 'h4']]);
  const html = render(h(ui.BookToc, { entries, here: 'h3', onGo: noop }));
  assert.match(html, /aria-current="location"[^>]*>1\.2 Enthalpy/);
  assert.match(textOf(html), /1\.2 Enthalpy 你在这里/);
  assert.deepEqual(ui.rowOf(ui.bookRows(book.nodes), 'bk:p2'), { ...ui.bookRows(book.nodes)[2] });
  assert.equal(ui.bookRows(book.nodes)[2].chapter, 0);
  assert.deepEqual([...ui.citesOf(gen)], [[1, { sourceId: 'tb-p3', quote: 'Entropy measures disorder' }]]);
});

test('English: the page\'s own words are English (the book\'s text is the book\'s)', () => english(() => {
  const html = chapter(book.nodes[0], true), toc = render(h(ui.BookToc, { entries: ui.tocEntries(book), here: 'h2', onGo: noop }));
  assert.match(textOf(html), /This question was deleted/);
  assert.match(textOf(toc), /You are here/);
  const own = textOf(html).replace(/Thermodynamics|Entropy|Enthalpy|练习：What is entropy\?|练 5 道：Entropy|本节问答：Entropy|「Entropy measures disorder」|知识梳理|出处|本节的题|这一节还没有题。|My note\.|Strange|Web|Textbook|disorder/g, '');
  assert.equal(han.test(own), false, `no Chinese of the page left: ${own}`);
}));

test('the 总纲 page offers 打开书页 once the book is written, and on an opened point', () => {
  const summary = total => ({ total, counts: { new: total, weak: 0, learning: 0, familiar: 0, mastered: 0 }, due: 0, weak: 0, fresh: total, inactive: 0, percent: null, state: total ? 'new' : 'none' });
  const outline = notes => ({ status: 'ok', course: 'SA', total: 1, placed: 1, summary: summary(1), draftCards: 0, limit: 200, decks: [], deckId: null, documents: [],
    unplaced: { key: 'unplaced', total: 0, summary: summary(0), reasons: { none: 0, uncategorised: 0, elsewhere: 0, missing: 0 }, materials: [] }, open: {},
    book: { id: 'o1', title: '总纲', createdAt: null, supersedes: null, papers: 0, stale: false, orderBasis: { codes: ['logic'] }, counts: {}, other: null, notes,
      nodes: [{ key: 'bk:c1', id: 'c1', title: 'Thermodynamics', total: 1, summary: summary(1), deckCount: 1, depth: 1, children: [{ key: 'bk:p1', id: 'p1', title: 'Entropy', total: 1,
        summary: summary(1), deckCount: 1, depth: 2, anchors: 1, opensRows: false }] }] } });
  const actions = { onBack: noop, onCreate: noop, onOpenSources: noop, onOpenTask: noop, onOpenSource: noop, onOpenBook: noop, organise: noop, writeBook: noop, retry: noop, toggle: noop,
    onPick: noop, onPickCard: noop, onPracticeRow: noop, clearPick: noop, practisePicked: noop, chooseDeck: noop };
  const notes = { id: 'n1', createdAt: null, supersedes: null, language: 'zh', leaves: 1, papers: false, stale: false, missing: 0, changed: 0 };
  const view = (withNotes, open) => render(h(ui.CourseOutlineView, { course: 'SA', outline: outline(withNotes ? notes : null), details: { 'bk:p1': { cards: [], more: 0 } }, open, pick: ui.emptyPick(), actions }));
  assert.equal(textOf(view(true, new Set(['bk:c1']))).split('打开书页').length - 1, 1, 'one on the book line');
  assert.equal(textOf(view(true, new Set(['bk:c1', 'bk:p1']))).split('打开书页').length - 1, 2, 'and one on the opened point');
  assert.doesNotMatch(textOf(view(false, new Set(['bk:c1', 'bk:p1']))), /打开书页/, 'no book written: no 打开书页');
  assert.match(english(() => textOf(view(true, new Set(['bk:c1'])))), /Open the book page/);
});
