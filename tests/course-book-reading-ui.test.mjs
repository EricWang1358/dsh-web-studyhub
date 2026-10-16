/* 复习全书 reading on the page (static zh and en; docs/review-book.md "Reading modes" and "Reading a point"): a point reads takeaway first (type only,
   no 「一句话」), then 讲解 without that sentence with the AI blocks about its words right after their paragraphs, 例子, 要点清单 and 补充 folded, 我的 (a hairline and a
   label: notes, whole-point blocks, Q&A), the questions and 出处 behind one chip; one toolbar row (练 5 道, 本节问答; 问 AI is at the title; no 出题 without questions, no
   整理, no 暂无题); an AI block is one row (open below 1,500 characters or when kept, else folded: AI, its first real sentence, its size, 多为重复, no 新);
   逐节读 shows one point under its path with 上一节 / 下一节; 整章滚动 folds a point to its title and one line. Fakes only. */
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
// The no-wrap unit around a 角标 (ui/Markdown.jsx md-cite-keep) holds the character before it: it is not a word break in the text.
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<span class="md-cite-keep">/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
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
  ask: noop, aiAction: noop, aiFollow: noop };
const fold = ({ shut = [], open = [] } = {}) => ({ folded: (id, byDefault) => shut.includes(id) || (byDefault && !open.includes(id)), fold: noop, foldAll: noop });
const body = (node = point(), folding = fold()) => render(h(ui.AiFoldContext.Provider, { value: folding }, h(ui.PointBody, { node, course: 'SA', handlers, level: 3 })));
const row = (html, id) => { const from = html.indexOf(`data-ai-block="${id}"`); return html.slice(from, html.indexOf('</aside>', from)); };

test('a point reads takeaway first (type only), then 讲解 without it, the AI block about its words right after the paragraph, 例子, 要点清单 and 补充 folded, 我的, the questions, 出处 behind a chip', () => {
  const html = body(), text = textOf(html);
  const order = ['熵是系统无序程度的度量', '讲解 它在孤立系统里只增不减。', '关于：「只增不减」 A kept explanation.', '例子 冰块融化。', '要点清单', '补充（资料以外）', '我的', 'My note.', '多为重复', '本节的题', '出处 1', '练 5 道'];
  const at = order.map(part => text.indexOf(part));
  assert.ok(at.every((value, index) => value >= 0 && (index === 0 || value > at[index - 1])), `in reading order: ${JSON.stringify(at)} in ${text}`);
  const story = text.slice(0, text.indexOf('我的 你的笔记'));
  assert.equal(story.split('熵是系统无序程度的度量').length - 1, 1, 'the takeaway sentence is said once in the point\'s text');
  assert.match(html, /<h3 class="book-point__label">讲解<\/h3>/, 'the part labels sit one level under the point');
  assert.match(html, /<details class="sh-disclosure book-point__fold" data-book-part="points">/, '要点清单 folded');
  assert.match(html, /<details class="sh-disclosure book-point__fold" data-book-part="extra">/, '补充 folded');
  assert.doesNotMatch(text, /练 5 道：熵|本节问答：熵|课本/, 'no line of links at the end, and the 出处 list waits behind its chip');
  assert.match(html, /data-book-link="practice"/);
  assert.match(text, /练 5 道 本节问答$/, 'the row of actions closes the point');
  assert.doesNotMatch(text, /在这里加一段|发给主会话/, '问 AI is at the title: no 在这里加一段 nor 发给主会话 in the row');
  assert.doesNotMatch(text, /整理|只留我写的|暂无题|一句话/, 'no 整理 menu, no 只留我写的, no badge for no questions, no label on the takeaway');
  assert.doesNotMatch(html, /book-point__takeaway|book-point__eyebrow/, 'the takeaway has no box and no eyebrow');
  assert.match(html, /class="md book-file book-point__gist"/, 'the takeaway is type: its own class and nothing around it');
  // The block about words is inside 讲解 (its section), not in 我的.
  const explain = html.slice(html.indexOf('book-point__part'), html.indexOf('data-book-part="points"'));
  assert.match(explain, /data-ai-block="b2"/);
  assert.doesNotMatch(html.slice(html.indexOf('data-book-layer')), /data-ai-block="b2"/);
});

test('the takeaway is shown without 「一句话：」, and the file is as it was', () => {
  const labelled = point({ gen: gen.replace('熵是系统无序程度的度量[^1]。', '一句话：熵是系统无序程度的度量[^1]。'), mine: '' });
  const text = textOf(body(labelled));
  assert.match(text, /^熵是系统无序程度的度量/, 'the point starts with its takeaway (its actions close it)');
  assert.doesNotMatch(text, /一句话/);
  assert.match(labelled.gen, /一句话：熵/, 'the text of the file keeps it');
});

test('我的: a hairline and a small label (not a toggle) with its explanation; the notes, the whole-point blocks; 收起这个知识点的 AI 段落 / 展开这个知识点的 AI 段落 from two blocks', () => {
  const html = body(), layer = html.slice(html.indexOf('data-book-layer'));
  assert.match(layer, /^data-book-layer="h2"/);
  assert.match(html, /aria-label="我的" data-book-layer="h2"/);
  assert.match(html, /<span class="book-layer__label" tabindex="0"[^>]*>我的<\/span>/, 'the label can take focus (its words show on hover and on focus)');
  assert.doesNotMatch(html, /book-layer__toggle|我的笔记与 AI 解释/, 'no toggle, no old title');
  assert.ok(layer.indexOf('My note.') < layer.indexOf('data-ai-block="b1"'), 'notes, then the whole-point block');
  assert.doesNotMatch(layer, /data-ai-block="b2"/, 'a block about words is not in 我的');
  assert.match(textOf(layer), /我的 你的笔记、AI 段落和加进书里的问答都在这里 收起这个知识点的 AI 段落 My note\./, 'two blocks in the point: one link folds them all, the label has its words');
  assert.match(textOf(body(point(), fold({ shut: ['b1', 'b2'] }))), /我的 你的笔记、AI 段落和加进书里的问答都在这里 展开这个知识点的 AI 段落/, 'all folded: it opens them');
  assert.doesNotMatch(textOf(body(point({ mine: `My note.\n\n${mine}` }))), /收起这个知识点的 AI 段落|展开这个知识点的 AI 段落/, 'one block: no link');
  assert.doesNotMatch(body(point({ mine: '', qa: '' })), /data-book-layer/, 'nothing of the learner\'s: no divider');
  assert.match(body(point({ mine: '', qa: 'Q and A put into the book.' })), /data-book-layer[\s\S]*Q and A put into the book\./, 'a Q&A put into the book is in 我的');
  const lostBlock = ui.aiBlock({ id: 'b9', at: 'z', about: 'words that are nowhere', body: 'Orphan.', state: 'kept' }, 'zh'), after = body(point({ mine: `${here}\n\n${lostBlock}`, qa: 'The Q and A.' }));
  assert.ok(after.indexOf('The Q and A.') < after.indexOf('data-ai-block="b9"'), 'a block whose words are gone is at the end of 我的');
  assert.match(textOf(row(after, 'b9')), /原位置已变/);
});

test('an AI block row: open below 1,500 characters, folded above unless kept; folded it is the caret, AI, the first real sentence and the size (多为重复); no 新', () => {
  const long = ui.aiBlock({ id: 'b3', at: 'h:h2', about: '熵', mode: 'here', body: ['这段在讲什么', '', '### 1. 小标题', '', '原文说：熵是无序度。', '', `意思就是：${'它只增不减。'.repeat(280)}`].join('\n') }, 'zh');
  const kept = ui.aiBlock({ id: 'b4', at: 'h:h2', about: '熵', mode: 'here', state: 'kept', body: `一段很长的话。${'它只增不减。'.repeat(300)}` }, 'zh');
  const html = body(point({ mine: `${long}\n\n${kept}\n\n${mine}` }));
  const shut = row(html, 'b3'), open = row(html, 'b4');
  assert.match(shut, /data-ai-folded="true"/);
  assert.match(shut, /aria-expanded="false"/);
  assert.match(textOf(shut), /AI 熵是无序度。 约 1,[0-9]00 字/, 'the first real sentence of the template, and the size');
  assert.doesNotMatch(shut, /book-ai__actions|book-ai__follow|book-ai__body/);
  assert.doesNotMatch(open, /data-ai-folded/, 'a block that was kept starts open, however long');
  assert.match(open, /book-ai__actions/);
  assert.doesNotMatch(textOf(html), /(?:^| )新(?= |$)/, 'no 新 badge');
  assert.doesNotMatch(row(html, 'b2'), /data-ai-folded/, 'a short block is open');
  assert.match(textOf(row(html, 'b2')), /AI 关于：「只增不减」 A kept explanation\. 重新生成 删除 删除后几秒内可以撤销。 问$/, 'open and short: the tag, what it is about, the text, quiet 重新生成 / 删除, the follow-up (no size: it is short)');
  assert.match(textOf(open), /AI 约 1,[0-9]00 字/, 'an open block that is long keeps its size on the row');
  // The learner's own fold or open wins over the default.
  assert.doesNotMatch(body(point({ mine: long }), fold({ open: ['b3'] })), /data-ai-folded/, 'a long block the learner opened stays open');
  assert.match(body(point({ mine: mine }), fold({ shut: ['b2'] })), /data-ai-block="b2"[^>]*data-ai-folded="true"/, 'a short block the learner folded stays folded');
  assert.match(textOf(row(body(point({ mine: mine }), fold({ shut: ['b2'] })), 'b2')), /AI A kept explanation\. 约 19 字$/, 'folded, a block about words says its text as the summary');
  // 保留 is one quiet click on a block that is new.
  const fresh = row(body(point({ mine: here })), 'b1');
  assert.match(textOf(fresh), /保留 重新生成 删除/);
  assert.match(fresh, /sh-btn--quiet[^>]*>保留/, '保留 is quiet');
  assert.match(fresh, /data-ai-state="new"/, 'the state stays in the file (and on the block for the agent)');
  assert.match(textOf(fresh), /多为重复/, 'a block that mostly restates the notes says so');
  assert.doesNotMatch(textOf(row(body(point({ mine: mine })), 'b2')), /多为重复/, 'a block about words never does');
  assert.doesNotMatch(textOf(row(body(point({ mine: mine })), 'b2')), /保留/, 'a kept block has no 保留');
});

test('a point without questions says nothing about it: no 出题 in the toolbar (it is 给这个知识点出题 in 更多), no standing line, no 本节的题', () => {
  const html = body(point({ questionTotal: 0, questions: [] })), text = textOf(html);
  assert.match(text, /出处 1 本节问答$/, 'the row of actions closes the point (出处 the first of them)');
  assert.doesNotMatch(html, /book-node__create/);
  assert.doesNotMatch(text, /暂无题|还没出题|这一节还没有题|本节的题|练 5 道/);
});

const book = { status: 'ok', title: 'B', unplaced: { title: '未归位', text: '' }, nodes: [{ hid: 'h1', key: 'bk:c1', title: '热力学', number: '1', depth: 1, leaf: false,
  children: [point(), { ...point(), hid: 'h3', key: 'bk:p2', title: '焓', number: '1.2', gen: '**讲解**\n\n焓是热含量。更多。', mine: '' }] }] };
test('逐节读: one point under its path, 上一个知识点 / 下一个知识点 with the neighbour\'s title below it (the first card is off); where it is and ‹ › are the book bar\'s', () => {
  const steps = ui.bookSteps(book), html = render(h(ui.BookStep, { steps, at: 0, onGo: noop, course: 'SA', handlers })), text = textOf(html);
  assert.match(html, /data-book-step="h2"/);
  assert.match(html, /<h2 id="book-h2"[^>]*data-book-heading="h2"/);
  assert.match(text, /^1 热力学 1\.1 熵 问 AI 写进这个知识点，或发给主会话 熵是系统无序程度的度量/, 'the path, then the heading with 问 AI at its right (its hover says where it goes), then the takeaway (no 第 i / N 节, no ‹ ›, no printed code)');
  assert.match(html, /<div class="book-ask-top"><ol class="book-step__path"[\s\S]*?<\/ol><h2 id="book-h2"[\s\S]*?<\/h2><span class="sh-popover-anchor book-ask-tip"><button[^>]*class="sh-btn sh-btn--quiet sh-btn--sm book-ask-open"[^>]*data-book-ask-open/, '问 AI is a quiet button beside the title, outside the heading');
  assert.doesNotMatch(html, /book-step__back|book-step__jump/);
  assert.match(text, /上一个知识点 下一个知识点 1\.2 焓$/);
  assert.match(html, /disabled=""[^>]*><span class="book-step__dir">上一个知识点/);
  assert.doesNotMatch(html, /data-book-point="h3"/, 'only the point shown is drawn');
  const last = textOf(render(h(ui.BookStep, { steps, at: 1, onGo: noop, course: 'SA', handlers })));
  assert.match(last, /上一个知识点 1\.1 熵 下一个知识点$/);
});

test('整章滚动: a point is its title and one line, folded, unless it is open', () => {
  const read = expanded => ({ mode: 'scroll', expanded: new Set(expanded), expand: noop, only: noop });
  const chapter = expanded => render(h(ui.BookReadContext.Provider, { value: read(expanded) }, h(ui.BookChapter, { node: book.nodes[0], open: true, onToggle: noop, course: 'SA', handlers })));
  const html = chapter(['h3']), text = textOf(html);
  assert.match(html, /data-book-folded="true"><h3 id="book-h2"[^>]*><button[^>]*aria-expanded="false"/);
  assert.match(text, /1\.1 熵 熵是系统无序程度的度量。 1\.2 焓/, 'the folded point says its takeaway in one line');
  assert.doesNotMatch(html, /data-book-point="h2"/);
  assert.match(html, /data-book-point="h3"/, 'the open one shows its body');
});

test('English: the reading words are English (the book\'s own text stays as written)', () => english(() => {
  const steps = ui.bookSteps(book), text = `${textOf(body())} ${textOf(render(h(ui.BookStep, { steps, at: 0, onGo: noop, course: 'SA', handlers })))}`;
  assert.match(text, /Practise 5 Questions and answers/);
  assert.doesNotMatch(text, /Tidy up|In one sentence|My notes and AI explanations/);
  assert.match(text, /Checklist .*Mine Your notes, AI paragraphs and the Q&A you put into the book are here Collapse this point's AI paragraphs/);
  assert.match(text, /AI Mostly repeats/);
  assert.match(text, /Sources 1/);
  assert.match(text, /1\.1 熵 Ask AI Write into this point, or send it to the main chat 熵是系统无序程度的度量[\s\S]*Sources 1 Practise 5 Questions and answers Previous knowledge point Next knowledge point/);
  // What is left once the book's own words are taken out (its text, its labels, the blocks' first lines and summaries).
  const written = [restate, '熵是系统无序程度的度量。', '熵是系统无序程度的度量', '它在孤立系统里只增不减', '冰块融化', '它在孤立系统里只增不减。', '冰块融化。', '熵度量无序', '玻尔兹曼公式', '补充（资料以外）', '讲解', '例子', '关于：「熵」',
    '关于：「只增不减」', '热力学', '焓', '熵', '。'];
  const own = written.reduce((rest, words) => rest.split(words).join(' '), text);
  assert.equal(han.test(own), false, own);
}));
