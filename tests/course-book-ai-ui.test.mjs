/* 复习全书 M4 on the page (static zh and en): an AI block about words sits right after the paragraph that holds them (the words dashed in it), says what
   it is about, offers 保留 (until kept) / 重新生成 / 删除 and a follow-up field, and folds to one row (AI, its first real sentence, its size); one whose words are
   gone is marked 原位置已变 at the end of 我的; no 整理 menu, no 新 badge; the panel over selected words offers 弄懂 and an instruction, under a heading only the instruction; without a model the shared gate. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { default as BookChapter } from './ui/book/BookChapter.jsx';
  export { default as BookAiAsk } from './ui/book/BookAiAsk.jsx';
  export * from './ui/book/model.js';
  export { aiBlock } from './lib/course-book-ai-text.js';
  export { AiFoldContext } from './ui/book/ai-fold.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
globalThis.window ??= { innerWidth: 1280, addEventListener: noop, removeEventListener: noop };

const gen = 'First paragraph.\n\nThe architect records each decision and its reasons.\n\nThird paragraph.';
const block = ui.aiBlock({ id: 'ai1', at: 'x', about: 'records each decision', body: 'An **explanation** of it.' }, 'zh');
const gone = ui.aiBlock({ id: 'ai2', at: 'y', about: 'words that are nowhere', body: 'Orphan.', state: 'kept' }, 'zh');
const node = { hid: 'h2', key: 'bk:p1', title: 'Entropy', number: '1', depth: 1, leaf: true, gen, mine: `My note.\n\n${block}\n\n${gone}`, qa: '',
  files: { gen: 'p1.gen.md', mine: 'p1.mine.md' }, questionTotal: 0, questions: [], children: [] };
const handlers = { gone: ui.goneSet([]), qaOpen: () => false, toggleQa: noop, source: noop, card: noop, practice: noop, create: noop, files: {}, choose: noop, busy: false,
  addHere: noop, aiAction: noop, aiFollow: noop };
const chapterOf = point => render(h(ui.BookChapter, { node: point, open: true, onToggle: noop, course: 'SA', handlers }));
const chapter = () => chapterOf(node);

test('an AI block about words sits right after its paragraph, with 保留 / 重新生成 / 删除 and a follow-up; one whose words are gone is marked 原位置已变 at the end of 我的', () => {
  const html = chapter(), text = textOf(html);
  assert.ok(text.indexOf('The architect records each decision and its reasons.') < text.indexOf('关于：「records each decision」'), 'after the paragraph that holds its words');
  assert.ok(text.indexOf('关于：「records each decision」') < text.indexOf('Third paragraph.'), 'and before the paragraph that follows it, not at the end of the point');
  assert.ok(text.indexOf('Third paragraph.') < text.indexOf('My note.'), 'the learner\'s notes come after the point\'s text');
  assert.match(text, /我的 你的笔记、AI 段落和加进书里的问答都在这里 My note\./, 'under the divider 我的');
  assert.doesNotMatch(text, /我的笔记与 AI 解释/, 'the old title is gone');
  assert.match(html, /data-ai-block="ai1" data-ai-state="new"/);
  assert.doesNotMatch(text, /(?:^| )新(?= |$)/, 'no 新 badge');
  assert.match(text, /关于：「records each decision」 An explanation of it\./);
  assert.match(text, /保留 重新生成 删除/);
  assert.match(html, /placeholder="接着问…"/);
  assert.ok(text.indexOf('Orphan.') > text.indexOf('My note.'), 'a block whose words are gone is at the end of 我的');
  assert.match(text, /AI 原位置已变 /);
  assert.doesNotMatch(text, /约 7 字/, 'an open short block has no size on its row');
  assert.match(text, /关于：「words that are nowhere」 Orphan\./);
  assert.doesNotMatch(html, /sh:ai/, 'no marker shown');
  assert.match(text, /在这里加一段/, 'a point offers 在这里加一段');
  assert.match(html, /data-book-point="h2"/);
});

test('the panel: 弄懂 and an instruction over selected words; only the instruction under a heading; without a model the gate', () => {
  const over = render(h(ui.BookAiAsk, { target: { heading: 'h2', words: 'records', top: 10, left: 10 }, model: { ready: true }, onStart: noop, onClose: noop }));
  assert.match(over, /data-book-ai="explain"[^>]*>[\s\S]*弄懂/);
  assert.match(over, /placeholder="让 AI 写一段…（讲细点、加个例子、对比做个表）"/);
  const here = render(h(ui.BookAiAsk, { target: { heading: 'h2', top: 10, left: 10 }, model: { ready: true }, onStart: noop, onClose: noop }));
  assert.doesNotMatch(here, /data-book-ai="explain"/);
  assert.match(here, /placeholder="在这里加一段：写什么？"/);
  const off = render(h(ui.BookAiAsk, { target: { heading: 'h2', words: 'records', top: 10, left: 10 }, model: { ready: false }, onStart: noop, onClose: noop }));
  assert.match(off, /disabled="" data-book-ai="explain"/);
  assert.match(textOf(off), /弄懂和加一段需要先配置模型|读书页、改书页照常能用/);
});

test('the panel of a task not yet written shows its state and takes no second start; the × stays', () => {
  const props = { model: { ready: true }, onStart: noop, onClose: noop };
  const idle = render(h(ui.BookAiAsk, { ...props, target: { heading: 'h2', words: 'records', top: 10, left: 10 } }));
  assert.doesNotMatch(idle, /data-book-ai="state"/);
  const busy = render(h(ui.BookAiAsk, { ...props, target: { heading: 'h2', words: 'records', top: 10, left: 10, jobId: 'job-1' } }));
  assert.match(busy, /data-book-ai="state"[^>]*>正在写…/);
  assert.match(busy, /disabled="" data-book-ai="explain"/);
  assert.match(busy, /disabled="" data-book-ai="write"/);
  assert.match(busy, /aria-label="关闭"/, 'the × is still there');
  assert.match(english(() => textOf(render(h(ui.BookAiAsk, { ...props, target: { heading: 'h2', words: 'records', top: 10, left: 10, jobId: 'job-1' } })))), /Writing…/);
});

test('English: the page\'s own words', () => english(() => {
  const html = chapter(), panel = render(h(ui.BookAiAsk, { target: { heading: 'h2', words: 'records', top: 10, left: 10 }, model: { ready: true }, onStart: noop, onClose: noop }));
  const own = `${textOf(html)} ${textOf(panel)}`.replace(/Entropy|First paragraph\.|The architect records each decision and its reasons\.|Third paragraph\.|My note\.|An explanation of it\.|Orphan\.|关于：「records each decision」|关于：「words that are nowhere」/g, '');
  assert.equal(han.test(own), false, own);
  assert.match(textOf(html), /Keep Regenerate Delete/);
  assert.match(textOf(panel), /Explain/);
}));

const folding = (folded, element) => h(ui.AiFoldContext.Provider, { value: { folded: id => folded.includes(id), fold: noop, foldAll: noop } }, element);
const folded = (list, point = node) => render(folding(list, h(ui.BookChapter, { node: point, open: true, onToggle: noop, course: 'SA', handlers })));

test('a folded block: one row, the caret, AI, the first real sentence of the answer and its size; no body, actions or follow-up; open: all of them', () => {
  const open = folded([]), shut = folded(['ai1']);
  assert.match(open, /aria-expanded="true"[^>]*>[\s\S]*?AI/);
  assert.doesNotMatch(open, /book-ai__summary/);
  const from = shut.indexOf('data-ai-block="ai1"'), block1 = shut.slice(from, shut.indexOf('</aside>', from));
  assert.match(block1, /data-ai-folded="true"/);
  assert.match(block1, /aria-expanded="false"/);
  assert.match(textOf(block1), /AI An explanation of it\. 约 25 字$/);
  assert.doesNotMatch(block1, /book-ai__actions|book-ai__follow|book-ai__body|关于/, 'what it is about waits for the open block (and the dashed words)');
  assert.match(shut.slice(shut.indexOf('data-ai-block="ai2"')), /book-ai__actions/, 'the other block is still open');
});

test('no 整理 menu and no 只留我写的: the toolbar has 在这里加一段, 出题, 本节问答 and 发给主会话; 我的 folds all blocks from two of them', () => {
  assert.match(textOf(folded([])), /在这里加一段 出题 本节问答 发给主会话/);
  assert.doesNotMatch(textOf(folded([])), /整理|只留我写的|暂无题|已隐藏/);
  assert.doesNotMatch(textOf(chapter()), /整理/, 'without the page\'s fold');
  assert.match(textOf(folded([])), /我的 你的笔记、AI 段落和加进书里的问答都在这里 全部收起/, 'two blocks: one quiet link');
  assert.match(textOf(folded(['ai1', 'ai2'])), /全部展开/);
  assert.doesNotMatch(textOf(folded([], { ...node, mine: `My note.\n\n${block}` })), /全部收起|全部展开/, 'one block: none');
});

test('two blocks in the text and nothing of its own: 我的 is its divider and the one link; the blocks whose words are gone come after the suggestions', () => {
  const second = ui.aiBlock({ id: 'ai3', at: 'z', about: 'Third paragraph', body: 'More.' }, 'zh');
  const text = textOf(folded([], { ...node, mine: `${block}\n\n${second}` }));
  assert.match(text, /我的 你的笔记、AI 段落和加进书里的问答都在这里 全部收起$/, 'the divider alone, with the link');
  assert.doesNotMatch(textOf(folded([], { ...node, mine: block })), /我的/, 'one block in the text and nothing else: no 我的');
  const withSuggestion = { ...handlers, files: { 'p1.mine.md': { suggestions: [{ id: 's1', kind: 'generated', text: 'New text.' }] } } };
  const lastText = textOf(render(h(ui.BookChapter, { node, open: true, onToggle: noop, course: 'SA', handlers: withSuggestion })));
  assert.ok(lastText.indexOf('有新的生成内容') > lastText.indexOf('My note.'), 'the suggestion follows the notes');
  assert.ok(lastText.indexOf('Orphan.') > lastText.indexOf('有新的生成内容'), 'and the lost block is the last thing in 我的');
});

test('English: the fold words', () => english(() => {
  assert.match(textOf(folded(['ai1'])), /Add a paragraph here Question writing Questions and answers .*Mine .*Collapse all/);
  assert.match(folded([]), /aria-label="AI paragraph"/);
  assert.match(textOf(folded(['ai1'])), /AI An explanation of it\. about 25 characters/);
}));
