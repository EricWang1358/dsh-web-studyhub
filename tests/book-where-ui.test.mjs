/* 复习全书 S2, 「我在哪」 (docs/review-book.md "Where you are", "The contents", "Find in the book", "The end of a point"): the one order of ← → / ‹ › / the end
   button (routeOf), what a point's end button says (endState) and how it draws, the 目录's marks (易错 N over the suggestion dot over ✓, one slot kept on every
   row), its 今天 and 全书 heads, and 在书里找 over the whole book in memory (AI blocks and points not on screen included; a typed code jumps). Static markup and
   pure functions, fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { routeOf } from './ui/book/route.js';
  export { endState } from './ui/book/point-end.js';
  export { default as PointEnd } from './ui/book/PointEnd.jsx';
  export { markOf, tocMarks } from './ui/book/toc-marks.js';
  export { default as BookToc } from './ui/book/BookToc.jsx';
  export { default as PointBody } from './ui/book/PointBody.jsx';
  export { PointEndContext } from './ui/book/point-end.js';
  export { bookCorpus, findInBook, codeJump } from './ui/book/book-find.js';
  export { bookSteps } from './ui/book/reading.js';
  export { tocEntries, goneSet } from './ui/book/model.js';
  export { aiBlock } from './lib/course-book-ai-text.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
globalThis.window ??= { innerWidth: 1280, addEventListener: noop, removeEventListener: noop };

const gen = title => [`**讲解**`, '', `${title}讲的是架构的取舍。它在每次评审里都会出现。`, '', '**要点清单**', '', '- 只在清单里的词：冗余', ''].join('\n');
const leaf = (n, extra = {}) => ({ hid: `h${n}`, key: `bk:p${n}`, title: `Point ${n}`, number: `1.${n}`, depth: 2, leaf: true, gen: gen(`Point ${n}`), mine: '', qa: '',
  files: { gen: `p${n}.gen.md`, mine: `p${n}.mine.md` }, questionTotal: 0, questions: [], qaCount: 0, children: [], ...extra });
const book = (nodes, extra = {}) => ({ status: 'ok', title: 'Book', language: 'zh', notes: true, unplaced: { title: '未归位', text: '', file: 'unplaced.md' }, files: {},
  answerCards: [], marks: { read: {}, seen: {} }, nodes: [{ hid: 'h1', key: 'bk:c1', title: 'Chapter', number: '1', depth: 1, leaf: false, children: nodes }], ...extra });

test('routeOf: on today\'s points today\'s order, after today\'s last the book\'s; elsewhere the book\'s order, 未归位 uncounted', () => {
  const steps = ['h2', 'h3', 'h4', 'h5', 'h6'].map(hid => ({ hid, node: {}, path: [] })).concat([{ hid: 'unplaced', node: {}, path: [] }]);
  const today = ['h5', 'h3'];
  assert.deepEqual(ui.routeOf(steps, today, 3), { kind: 'today', at: 1, total: 2, prev: 2, next: 1, last: false }, 'today\'s first: back by the book, on to today\'s second');
  assert.deepEqual(ui.routeOf(steps, today, 1), { kind: 'today', at: 2, total: 2, prev: 3, next: 2, last: true }, 'today\'s last: back to today\'s first, on by the book');
  assert.deepEqual(ui.routeOf(steps, today, 0), { kind: 'book', at: 1, total: 5, prev: null, next: 1, last: false });
  assert.deepEqual(ui.routeOf(steps, [], 4), { kind: 'book', at: 5, total: 5, prev: 3, next: 5, last: false });
  assert.deepEqual(ui.routeOf(steps, [], 5), { kind: 'book', at: 0, total: 5, prev: 4, next: null, last: false }, '未归位 has no count');
  assert.deepEqual(ui.routeOf(steps, ['gone'], 2).kind, 'book', 'an id the book no longer has is left out');
});

test('endState: wait (default, disabled) until the plan answers; then 已看 on a 翻看 day, 练 5 道 first on an unread point with questions, 今天的读完了 last, 下一个 once read', () => {
  assert.deepEqual(ui.endState({ ready: false, questions: true }), { primary: 'read', quiet: null, waiting: true, hasNext: true });
  assert.deepEqual(ui.endState({ ready: true }), { primary: 'read', quiet: null, waiting: false, hasNext: true });
  assert.equal(ui.endState({ ready: true, done: true }).primary, 'next');
  assert.deepEqual(ui.endState({ ready: true, questions: true }), { primary: 'practice', quiet: 'read', waiting: false, hasNext: true });
  assert.deepEqual(ui.endState({ ready: true, questions: true, done: true }), { primary: 'next', quiet: 'practice', waiting: false, hasNext: true }, 'a point with questions read: 下一个, 练 5 道 still there');
  assert.deepEqual(ui.endState({ ready: true, questions: true, lastToday: true }), { primary: 'practice', quiet: 'today', waiting: false, hasNext: true });
  assert.deepEqual(ui.endState({ ready: true, lastToday: true }), { primary: 'today', quiet: 'mock', waiting: false, hasNext: true });
  assert.equal(ui.endState({ ready: true, flip: true, questions: true }).primary, 'seen');
  assert.equal(ui.endState({ ready: true, flip: true, seen: true }).primary, 'next');
  assert.equal(ui.endState({ ready: true, hasNext: false }).hasNext, false);
});

test('PointEnd draws one primary button (disabled while it waits), at most one quiet one, and one quiet line; its words in English too', () => {
  const draw = (state, props = {}) => render(h(ui.PointEnd, { state, next: '1.3 Point 3', bridge: '', onAct: noop, ...props }));
  const waiting = draw(ui.endState({ ready: false }));
  assert.match(waiting, /data-book-end="read"[^>]*data-waiting=""/);
  assert.match(waiting, /<button[^>]*disabled=""[^>]*>[\s\S]*读完了，下一个/);
  assert.match(textOf(waiting), /接下来：1\.3 Point 3/);
  assert.match(waiting, /book-end__ghost/, 'the quiet slot is kept (a hidden stand-in) so the block keeps its height');
  const practice = draw(ui.endState({ ready: true, questions: true }));
  assert.match(practice, /data-book-end-action="practice"/);
  assert.match(practice, /data-book-end-action="read"/);
  assert.doesNotMatch(practice, /book-end__ghost/);
  assert.equal((practice.match(/sh-btn--primary/g) || []).length, 1, 'one primary button');
  const last = textOf(draw(ui.endState({ ready: true, lastToday: true })));
  assert.ok(last.includes('今天的读完了') && last.includes('出一套模拟卷…'), last);
  assert.ok(textOf(draw(ui.endState({ ready: true, flip: true }))).includes('已看，下一个'));
  assert.ok(textOf(draw(ui.endState({ ready: true, hasNext: false }), { next: '' })).startsWith('读完了'), 'the last point: 读完了 without 下一个');
  assert.ok(textOf(draw(ui.endState({ ready: true }), { bridge: '下一节讲风险。' })).includes('下一节讲风险。'), 'the leading-on sentence wins over 接下来');
  english(() => {
    for (const state of [ui.endState({ ready: true }), ui.endState({ ready: true, questions: true, lastToday: true }), ui.endState({ ready: true, lastToday: true }), ui.endState({ ready: true, flip: true })]) {
      const en = textOf(draw(state));
      assert.ok(!han.test(en), en);
    }
  });
});

test('a point on the reading surface ends in its end button: 练 5 道 leaves the closing row; 本节问答 shows only with items, its count known at first paint', () => {
  const handlers = { gone: ui.goneSet([]), qaOpen: () => false, toggleQa: noop, source: noop, card: noop, practice: noop, files: {}, choose: noop, busy: false, addHere: noop };
  const node = leaf(2, { questionTotal: 9, questions: [{ deckId: 'd', cardId: 'q', prompt: 'Q?' }] });
  const end = () => h(ui.PointEnd, { state: ui.endState({ ready: true, questions: true }), next: '', bridge: '', onAct: noop });
  const withEnd = render(h(ui.PointEndContext.Provider, { value: end }, h(ui.PointBody, { node, course: 'C', handlers })));
  assert.equal((withEnd.match(/>练 5 道</g) || []).length, 1, '练 5 道 once: in the end button');
  assert.doesNotMatch(withEnd, /book-point__practice/);
  assert.doesNotMatch(withEnd, /book-point__qa/, 'no 本节问答 without items');
  assert.ok(withEnd.indexOf('book-point__bar') < withEnd.indexOf('book-end'), 'the end button is the last thing');
  const counted = render(h(ui.PointEndContext.Provider, { value: end }, h(ui.PointBody, { node: { ...node, qaCount: 2 }, course: 'C', handlers })));
  assert.match(textOf(counted), /本节问答 \(2\)/);
  // Without an end (翻看), 练 5 道 stays in the row.
  assert.match(render(h(ui.PointBody, { node, course: 'C', handlers })), /book-point__practice/);
});

test('the 目录\'s mark: 易错 N over the suggestion dot over ✓, one slot on every row (empty too), each explained; the 今天 and 全书 heads', () => {
  assert.deepEqual(ui.markOf({ mistakes: 2, suggestion: true, read: true }), { kind: 'mistakes', count: 2 });
  assert.deepEqual(ui.markOf({ suggestion: true, read: true }), { kind: 'suggestion' });
  assert.deepEqual(ui.markOf({ read: true }), { kind: 'read' });
  assert.equal(ui.markOf({}), null);
  const b = book([leaf(2), leaf(3), leaf(4)], { files: { 'p3.gen.md': { version: 2, forked: true, suggestions: [{ id: 's', text: 'new', kind: 'generated' }] } } });
  const marks = ui.tocMarks(b, new Map([['h2', [{ kind: 'asked', text: 'x' }, { kind: 'pitfall', text: 'y' }]]]), new Set(['h2', 'h3', 'h4']));
  assert.deepEqual([...marks], [['h2', { kind: 'mistakes', count: 2 }], ['h3', { kind: 'suggestion' }], ['h4', { kind: 'read' }]]);
  const entries = ui.tocEntries(b);
  const today = { entries: entries.filter(entry => entry.id === 'h3' || entry.id === 'h4').map(entry => ({ ...entry, level: 2 })), count: 2, done: 1, flip: false };
  const html = render(h(ui.BookToc, { entries, here: 'h3', onGo: noop, narrow: false, onClose: noop, coverage: null, today, read: 1, points: 3, marks }));
  const text = textOf(html);
  for (const part of ['今天 2 个 · 已读完 1', '全书 · 已读完 1/3', '易错 2', '期末一周按考试日期和每天的分钟数排', '来自你问过的、答题卡的易错检查和你弄懂过的地方',
    '这个知识点有待处理的更新建议', '你点过读完了；期末一周里某一天答够这个知识点 5 道也算']) assert.ok(text.includes(part), part);
  const rows = html.match(/<li class="book-toc__item"[\s\S]*?<\/li>/g);
  assert.equal(rows.length, entries.length + 2, 'today\'s two rows, then every heading');
  assert.ok(rows.every(row => /class="book-toc__mark"/.test(row)), 'every row has its slot');
  assert.match(rows[2], /class="book-toc__mark" aria-hidden="true"><\/span>/, 'the chapter row keeps an empty slot');
  assert.ok(html.indexOf('data-book-today') < html.indexOf('全书 · 已读完'), '今天 on top of 全书');
  assert.match(textOf(render(h(ui.BookToc, { entries, here: 'h3', onGo: noop, narrow: false, onClose: noop, today: { ...today, flip: true }, read: 1, points: 3, marks }))), /今天 2 个 · 已看 1/);
  const plain = render(h(ui.BookToc, { entries, here: 'h3', onGo: noop, narrow: false, onClose: noop, today: null, read: 0, points: 3, marks: new Map() }));
  assert.doesNotMatch(plain, /data-book-today/, 'outside the 期末一周 no 今天');
  assert.doesNotMatch(render(h(ui.BookToc, { entries, here: 'h3', onGo: noop, narrow: false, onClose: noop, today, read: 1, points: 3, marks, searching: true })), /book-toc__group/,
    'while searching the matches take the groups\' place');
  english(() => {
    const en = textOf(render(h(ui.BookToc, { entries, here: 'h3', onGo: noop, narrow: false, onClose: noop, today, read: 1, points: 3, marks })));
    assert.ok(!han.test(en.replace(/Point \d|Chapter/g, '')), en);
  });
});

test('在书里找 searches the whole book in memory: points not on screen, the AI blocks (folded or not), 要点清单, the Q&A; a typed code jumps', () => {
  const block = ui.aiBlock({ id: 'w1', at: 'h:any', about: 'Point 4', body: '一段很长的 AI 讲解，里面提到了熔断器。', mode: 'here' }, 'zh');
  const b = book([leaf(2), leaf(3, { qa: '> **追问：** 什么是熔断器？\n>\n> **答：** 一种保护。' }), leaf(4, { mine: `我的笔记。\n\n${block}` })]);
  const corpus = ui.bookCorpus(b);
  assert.equal(corpus.length, 3);
  const found = ui.findInBook(corpus, '熔断器');
  assert.equal(found.total, 2);
  assert.deepEqual(found.hits.map(hit => [hit.hid, hit.block]), [['h3', null], ['h4', 'w1']], 'the Q&A of one point, the AI block of another');
  assert.equal(found.hits[1].match, '熔断器');
  assert.ok(found.hits[1].before.endsWith('里面提到了'));
  assert.equal(ui.findInBook(corpus, '冗余').total, 3, '要点清单 is searched (folded on the page)');
  assert.equal(ui.findInBook(corpus, 'POINT 3').hits[0].hid, 'h3', 'case and width ignored, the title searched');
  assert.equal(ui.findInBook(corpus, 'studyhub').total, 0, 'link targets and markers are not words');
  assert.equal(ui.findInBook(corpus, '  ').total, 0);
  const entries = ui.tocEntries(b);
  assert.deepEqual(ui.codeJump(entries, 'h3'), { id: 'h3', code: 'H3', title: '1.3 Point 3' });
  assert.deepEqual(ui.codeJump(entries, ' H4 ')?.id, 'h4');
  assert.equal(ui.codeJump(entries, 'H99'), null);
  assert.equal(ui.codeJump(entries, 'h3 risk'), null, 'a code typed alone only');
});
