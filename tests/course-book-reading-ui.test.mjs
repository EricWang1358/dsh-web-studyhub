/* 复习全书 reading on the page (static zh and en; docs/review-book.md "Reading modes" and "Reading a point"): a point reads takeaway first (一句话), then
   讲解 without that sentence, 例子, 要点清单 and 补充 folded, the learner's layer (我的笔记与 AI 解释 (N)), the questions and 出处 behind one chip; one toolbar
   row (练 5 道, 本节问答, 整理; 暂无题 and 出题 without questions); a whole-point block that restates the notes says so with 收起; 只留我写的 hides the new
   whole-point blocks and counts them; 逐节读 shows one point under its path with 上一节 / 下一节; 整章滚动 folds a point to its title and one line. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { default as PointBody } from './ui/book/PointBody.jsx';
  export { default as BookStep } from './ui/book/BookStep.jsx';
  export { default as BookChapter } from './ui/book/BookChapter.jsx';
  export { AiFoldContext } from './ui/book/ai-fold.js';
  export { BookReadContext, bookSteps } from './ui/book/reading.js';
  export { goneSet } from './ui/book/model.js';
  export { aiBlock } from './lib/course-book-ai-text.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
globalThis.window ??= { innerWidth: 1280, addEventListener: noop, removeEventListener: noop };

const gen = ['**知识梳理**', '', '- 熵度量无序 [^1]', '', '**讲解**', '', '熵是系统无序程度的度量[^1]。它在孤立系统里只增不减。', '', '**例子**', '', '冰块融化。', '',
  '**补充（资料以外）**', '', '- 玻尔兹曼公式', '', '**出处**', '', '[^1]: [「熵度量无序」](studyhub://source/tb-p3) · 课本', '',
  '[练 5 道：熵](studyhub://practice?heading=h2&n=5) · [本节问答：熵](studyhub://qa?heading=h2)'].join('\n');
const restate = '原文说：熵是系统无序程度的度量。意思就是：它在孤立系统里只增不减。原文说：冰块融化。熵度量无序，它在孤立系统里只增不减。';
const here = ui.aiBlock({ id: 'b1', at: 'h:h2', about: '熵', body: restate, mode: 'here' }, 'zh');
const mine = ui.aiBlock({ id: 'b2', at: 'x', about: '只增不减', body: 'A kept explanation.', mode: 'explain', state: 'kept' }, 'zh');
const point = (extra = {}) => ({ hid: 'h2', key: 'bk:p1', title: '熵', number: '1.1', depth: 2, leaf: true, gen, mine: `My note.\n\n${here}\n\n${mine}`, qa: '',
  files: { gen: 'p1.gen.md', mine: 'p1.mine.md' }, questionTotal: 7, questions: [{ deckId: 'd1', cardId: 'q1', prompt: 'What is entropy?' }], children: [], ...extra });
const handlers = { gone: ui.goneSet([]), qaOpen: () => false, toggleQa: noop, source: noop, card: noop, practice: noop, create: noop, files: {}, choose: noop, busy: false,
  addHere: noop, aiAction: noop, aiFollow: noop };
const fold = ({ shut = [], open = [], only = [] } = {}) => ({ folded: (id, byDefault) => shut.includes(id) || (byDefault && !open.includes(id)), fold: noop, foldAll: noop,
  mineOnly: hid => only.includes(hid), setMineOnly: noop });
const body = (node = point(), folding = fold()) => render(h(ui.AiFoldContext.Provider, { value: folding }, h(ui.PointBody, { node, course: 'SA', handlers, level: 3 })));

test('a point reads takeaway first, then 讲解 without that sentence, 例子, 要点清单 and 补充 folded, the layer, the questions, 出处 behind a chip', () => {
  const html = body(), text = textOf(html);
  const order = ['练 5 道', '一句话 熵是系统无序程度的度量', '讲解 它在孤立系统里只增不减。', '例子 冰块融化。', '要点清单', '补充（资料以外）', '我的笔记与 AI 解释 (3)', '本节的题', '出处 1'];
  const at = order.map(part => text.indexOf(part));
  assert.ok(at.every((value, index) => value >= 0 && (index === 0 || value > at[index - 1])), `in reading order: ${JSON.stringify(at)} in ${text}`);
  const story = text.slice(0, text.indexOf('我的笔记与 AI 解释'));
  assert.equal(story.split('熵是系统无序程度的度量').length - 1, 1, 'the takeaway sentence is said once in the point\'s text');
  assert.match(html, /<h3 class="book-point__label">讲解<\/h3>/, 'the part labels sit one level under the point');
  assert.match(html, /<details class="sh-disclosure book-point__fold" data-book-part="points">/, '要点清单 folded');
  assert.match(html, /<details class="sh-disclosure book-point__fold" data-book-part="extra">/, '补充 folded');
  assert.doesNotMatch(text, /练 5 道：熵|本节问答：熵|课本/, 'no line of links at the end, and the 出处 list waits behind its chip');
  assert.match(html, /data-book-link="practice"/);
  assert.match(text, /本节问答 整理/);
});

test('the layer: folded by default from three items (each block its header and summary); a restating whole-point block says so, with 收起', () => {
  const html = body();
  assert.match(html, /data-ai-block="b1"[^>]*data-ai-folded="true"/);
  assert.match(html, /data-ai-block="b2"[^>]*data-ai-folded="true"/);
  assert.match(textOf(html), /与上面的讲解重复度高/);
  const opened = body(point(), fold({ open: ['b1'] }));
  assert.doesNotMatch(opened, /data-ai-block="b1"[^>]*data-ai-folded/, 'a block the learner opened stays open');
  assert.match(textOf(opened), /与上面的讲解重复度高 收起/);
  assert.equal((textOf(opened).match(/(?:^| )新(?= |$)/g) || []).length, 1, '新 once, on the open block');
  assert.equal((textOf(html).match(/(?:^| )新(?= |$)/g) || []).length, 0, 'none on a folded one');
  const short = body(point({ mine: mine }));
  assert.doesNotMatch(short, /data-ai-folded/, 'one short block: open');
  assert.doesNotMatch(textOf(short), /重复度高/, 'a block about some words is never called a repeat');
});

test('只留我写的 hides the new whole-point blocks, counts them, and offers 全部显示; nothing else changes', () => {
  const html = body(point(), fold({ only: ['h2'] })), text = textOf(html);
  assert.doesNotMatch(html, /data-ai-block="b1"/);
  assert.match(html, /data-ai-block="b2"/, 'a kept block stays');
  assert.match(text, /我的笔记与 AI 解释 \(2\) 已隐藏 1 段 AI 写的 全部显示/);
});

test('a point without questions: 暂无题 and a quiet 出题 in the toolbar, no standing line, no 本节的题', () => {
  const text = textOf(body(point({ questionTotal: 0, questions: [] })));
  assert.match(text, /暂无题 出题 本节问答/);
  assert.doesNotMatch(text, /这一节还没有题|本节的题|练 5 道/);
});

const book = { status: 'ok', title: 'B', unplaced: { title: '未归位', text: '' }, nodes: [{ hid: 'h1', key: 'bk:c1', title: '热力学', number: '1', depth: 1, leaf: false,
  children: [point(), { ...point(), hid: 'h3', key: 'bk:p2', title: '焓', number: '1.2', gen: '**讲解**\n\n焓是热含量。更多。', mine: '' }] }] };
test('逐节读: one point under its path, its place in the book, 上一节 / 下一节 with the neighbour\'s title (the first has no 上一节)', () => {
  const steps = ui.bookSteps(book), html = render(h(ui.BookStep, { steps, at: 0, onGo: noop, course: 'SA', handlers })), text = textOf(html);
  assert.match(html, /data-book-step="h2"/);
  assert.match(html, /<h2 id="book-h2"[^>]*data-book-heading="h2"/);
  assert.match(text, /^1 热力学 第 1 \/ 2 节/);
  assert.match(text, /上一节 下一节 1\.2 焓$/);
  assert.match(html, /disabled=""[^>]*><span class="book-step__dir">上一节/);
  assert.doesNotMatch(html, /data-book-point="h3"/, 'only the point shown is drawn');
  const last = textOf(render(h(ui.BookStep, { steps, at: 1, onGo: noop, course: 'SA', handlers })));
  assert.match(last, /上一节 1\.1 熵 下一节$/);
});

test('整章滚动: a point is its title and one line, folded, unless it is open', () => {
  const read = expanded => ({ mode: 'scroll', expanded: new Set(expanded), expand: noop, only: noop });
  const chapter = expanded => render(h(ui.BookReadContext.Provider, { value: read(expanded) }, h(ui.BookChapter, { node: book.nodes[0], open: true, onToggle: noop, course: 'SA', handlers })));
  const html = chapter(['h3']), text = textOf(html);
  assert.match(html, /data-book-folded="true"><h3 id="book-h2"[^>]*><button[^>]*aria-expanded="false"/);
  assert.match(text, /1\.1 熵 H2 熵是系统无序程度的度量。 1\.2 焓/, 'the folded point says its takeaway in one line');
  assert.doesNotMatch(html, /data-book-point="h2"/);
  assert.match(html, /data-book-point="h3"/, 'the open one shows its body');
});

test('English: the reading words are English (the book\'s own text stays as written)', () => english(() => {
  const steps = ui.bookSteps(book), text = `${textOf(body())} ${textOf(render(h(ui.BookStep, { steps, at: 0, onGo: noop, course: 'SA', handlers })))}`;
  assert.match(text, /Practise 5 Questions and answers Tidy up In one sentence/);
  assert.match(text, /Checklist .*My notes and AI explanations \(3\)/);
  assert.match(text, /Mostly repeats the explanation above/);
  assert.match(text, /Sources 1/);
  assert.match(text, /Point 1 of 2 .*Previous section Next section/);
  // What is left once the book's own words are taken out (its text, its labels, the blocks' first lines and summaries).
  const written = [restate, '熵是系统无序程度的度量。', '熵是系统无序程度的度量', '它在孤立系统里只增不减', '冰块融化', '它在孤立系统里只增不减。', '冰块融化。', '熵度量无序', '玻尔兹曼公式', '补充（资料以外）', '讲解', '例子', '关于：「熵」',
    '关于：「只增不减」', '热力学', '焓', '熵', '。'];
  const own = written.reduce((rest, words) => rest.split(words).join(' '), text);
  assert.equal(han.test(own), false, own);
}));
