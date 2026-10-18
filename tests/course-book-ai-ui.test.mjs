/* 复习全书 AI on the page (static zh and en; docs/review-book.md "Ask AI", "AI blocks"): an AI block about words sits right after the paragraph that holds them
   (the words dashed in it), says what it is about, offers 保留 (until kept) / 重新生成 / 删除 and a follow-up field, and folds to one row (AI, its first real
   sentence, its size, ⋯ with 保留 / 重新生成 / 复制 / 删除); one whose words are gone is marked 原位置已变 at the end of 我的; no 整理 menu, no 新 badge. The 问 AI
   panel: one box, the five presets, 写进这个知识点 (secondary) and 发给主会话, the model gate for 写进这个知识点 only. The line a task or a deletion leaves:
   「AI 正在写 · 约 1 分钟 · 取消」, a failure with its reason and 重试, 「已删除这段 · 撤销」; the selection toolbar's 弄懂 is secondary. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`
  export { default as BookChapter } from './ui/book/BookChapter.jsx';
  export { default as PointBody } from './ui/book/PointBody.jsx';
  export { default as BookAsk, AskForm, AskButton, PRESETS } from './ui/book/BookAsk.jsx';
  export { default as BookAiLine } from './ui/book/BookAiLine.jsx';
  export * from './ui/book/model.js';
  export { aiBlock, aiBlocks } from './lib/course-book-ai-text.js';
  export { AiFoldContext, BookAiContext } from './ui/book/ai-fold.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
globalThis.window ??= { innerWidth: 1280, addEventListener: noop, removeEventListener: noop };

const gen = 'First paragraph.\n\nThe architect records each decision and its reasons.\n\nThird paragraph.';
const block = ui.aiBlock({ id: 'ai1', at: 'x', about: 'records each decision', body: 'An **explanation** of it.' }, 'zh');
const gone = ui.aiBlock({ id: 'ai2', at: 'y', about: 'words that are nowhere', body: 'Orphan.', state: 'kept' }, 'zh');
const node = { hid: 'h2', key: 'bk:p1', title: 'Entropy', number: '1', depth: 1, leaf: true, gen, mine: `My note.\n\n${block}\n\n${gone}`, qa: '',
  files: { gen: 'p1.gen.md', mine: 'p1.mine.md' }, questionTotal: 0, questions: [], children: [] };
const handlers = { gone: ui.goneSet([]), qaOpen: () => false, toggleQa: noop, source: noop, card: noop, practice: noop, create: noop, files: {}, choose: noop, busy: false,
  ask: noop, aiAction: noop, aiFollow: noop };
const chapterOf = (point, extra = {}, lines = null) => render(h(ui.BookAiContext.Provider, { value: lines }, h(ui.BookChapter, { node: point, open: true, onToggle: noop, course: 'SA', handlers: { ...handlers, ...extra } })));
const chapter = () => chapterOf(node);
const rowOf = (html, id) => { const from = html.indexOf(`data-ai-block="${id}"`); return html.slice(from, html.indexOf('</aside>', from)); };

test('an AI block about words sits right after its paragraph, with 保留 / 重新生成 / 删除 and a follow-up; one whose words are gone is marked 原位置已变 at the end of 我的', () => {
  const html = chapter(), text = textOf(html);
  assert.ok(text.indexOf('The architect records each decision and its reasons.') < text.indexOf('关于：「records each decision」'), 'after the paragraph that holds its words');
  assert.ok(text.indexOf('关于：「records each decision」') < text.indexOf('Third paragraph.'), 'and before the paragraph that follows it, not at the end of the point');
  assert.ok(text.indexOf('Third paragraph.') < text.indexOf('My note.'), 'the learner\'s notes come after the point\'s text');
  assert.match(text, /我的 你的笔记、AI 段落和加进书里的问答都在这里 My note\./, 'under the divider 我的');
  assert.match(html, /data-ai-block="ai1" data-ai-state="new"/);
  assert.doesNotMatch(text, /(?:^| )新(?= |$)/, 'no 新 badge');
  assert.match(text, /关于：「records each decision」 An explanation of it\./);
  assert.match(text, /保留 重新生成 删除 删除后几秒内可以撤销。/, 'quiet actions; 删除 says on hover that it can be undone');
  assert.match(html, /placeholder="接着问…"/);
  assert.ok(text.indexOf('Orphan.') > text.indexOf('My note.'), 'a block whose words are gone is at the end of 我的');
  assert.match(text, /AI 原位置已变 /);
  assert.doesNotMatch(text, /约 7 字/, 'an open short block has no size on its row');
  assert.doesNotMatch(html, /sh:ai/, 'no marker shown');
  assert.doesNotMatch(text, /在这里加一段|发给主会话/, 'the row of actions has neither: 问 AI is at the title');
  assert.doesNotMatch(rowOf(html, 'ai1'), /book-ai__more/, 'an open block has its actions under its text, no ⋯');
});

const folding = (folded, element) => h(ui.AiFoldContext.Provider, { value: { folded: id => folded.includes(id), fold: noop, foldAll: noop } }, element);
const folded = (list, point = node, extra = {}) => render(folding(list, h(ui.BookChapter, { node: point, open: true, onToggle: noop, course: 'SA', handlers: { ...handlers, ...extra } })));

test('a folded block: one row, the caret, AI, the first real sentence and its size, and ⋯; no body, actions or follow-up; open: all of them', () => {
  const open = folded([]), shut = folded(['ai1']);
  assert.match(open, /aria-expanded="true"[^>]*>[\s\S]*?AI/);
  assert.doesNotMatch(open, /book-ai__summary/);
  const block1 = rowOf(shut, 'ai1');
  assert.match(block1, /data-ai-folded="true"/);
  assert.match(block1, /aria-expanded="false"/);
  assert.match(textOf(block1), / AI An explanation of it\. 约 25 字$/);
  assert.match(block1, /<button[^>]*aria-label="这段 AI 段落的操作"[^>]*aria-haspopup="menu"/, '⋯ holds the actions of a folded row');
  assert.doesNotMatch(block1, /book-ai__actions|book-ai__follow|book-ai__body|关于/, 'what it is about waits for the open block (and the dashed words)');
  assert.match(rowOf(shut, 'ai2'), /book-ai__actions/, 'the other block is still open');
});

test('the ⋯ menu of a folded row: 保留 (a new block only) / 重新生成 / 复制 / 删除, 删除 says it can be undone', async () => {
  const menuItems = await loadUi(`export { default as BookAiBlock } from './ui/book/BookAiBlock.jsx'; export { aiBlocks, aiBlock } from './lib/course-book-ai-text.js'; export { setUiLanguage } from './ui/i18n.js';`);
  // Its own bundle has its own language state, which follows the machine's locale (English on CI): the asserts read Chinese.
  menuItems.setUiLanguage('zh');
  const item = state => ({ block: menuItems.aiBlocks(menuItems.aiBlock({ id: 'ai9', at: 'x', about: 'w', body: 'Text.', state }, 'zh'))[0], status: 'same' });
  // The Menu draws its list only when open; its items are read from the trigger's own render with the menu open by default.
  const html = state => renderToStaticMarkup(h(menuItems.BookAiBlock, { item: item(state), folded: true, onAction: noop, onFollow: noop }));
  assert.match(html('new'), /aria-label="这段 AI 段落的操作"/);
  const source = (await import('node:fs')).readFileSync(new URL('../ui/book/BookAiBlock.jsx', import.meta.url), 'utf8');
  assert.match(source, /block\.state === 'new' && \{ id: 'keep'[\s\S]*id: 'again'[\s\S]*id: 'copy'[\s\S]*id: 'delete'[^}]*hint: ui\('可以撤销'\)/, 'the four items in that order, 保留 only while new');
  assert.doesNotMatch(source, /danger/, '删除 in the menu\'s normal ink: it can be undone');
  const flip = (await import('node:fs')).readFileSync(new URL('../ui/book/BookFlip.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(flip, /AskButton|handlers\.ask/, '翻看\'s cards have no 问 AI of their own (the selection toolbar covers them)');
});

test('nothing of its own in 我的: no divider and no fold-all, even with blocks in the text; the blocks whose words are gone come after the suggestions', () => {
  const second = ui.aiBlock({ id: 'ai3', at: 'z', about: 'Third paragraph', body: 'More.' }, 'zh');
  const text = textOf(folded([], { ...node, mine: `${block}\n\n${second}` }));
  assert.doesNotMatch(text, /我的|你的笔记、AI 段落和加进书里的问答都在这里|收起这个知识点的 AI 段落|展开这个知识点的 AI 段落/, 'two blocks in the text and nothing else: no divider');
  const withSuggestion = { ...handlers, files: { 'p1.mine.md': { suggestions: [{ id: 's1', kind: 'generated', text: 'New text.' }] } } };
  const lastText = textOf(render(h(ui.BookChapter, { node, open: true, onToggle: noop, course: 'SA', handlers: withSuggestion })));
  assert.ok(lastText.indexOf('有新的生成内容') > lastText.indexOf('My note.'), 'the suggestion follows the notes');
  assert.ok(lastText.indexOf('Orphan.') > lastText.indexOf('有新的生成内容'), 'and the lost block is the last thing in 我的');
  assert.match(textOf(folded([])), /我的 你的笔记、AI 段落和加进书里的问答都在这里 收起这个知识点的 AI 段落/, 'two blocks in the point: one quiet link folds them');
});

test('the lines in a point: 「AI 正在写 · 约 1 分钟 · 取消」 right after the paragraph; a failure with its reason and 重试; 「已删除这段 · 撤销」 where the block was', () => {
  const writing = { key: 'l1', kind: 'writing', id: 'ai7', jobId: 'job-7', heading: 'h2', mode: 'explain', words: 'records each decision', title: 'Entropy' };
  const html = chapterOf({ ...node, mine: '' }, {}, [writing]), text = textOf(html);
  assert.match(html, /data-ai-line="writing"/);
  assert.match(text, /The architect records each decision and its reasons\. AI 正在写 · 约 1 分钟 · 取消 停下这个任务，这里什么也不会写进书里。 Third paragraph\./, 'right after its paragraph, with 取消 (its hover words)');
  assert.match(html, /role="status"/);
  const failed = textOf(chapterOf({ ...node, mine: '' }, {}, [{ ...writing, kind: 'failed', error: '没有找到这几句话' }]));
  assert.match(failed, /AI 没写成：没有找到这几句话 没有找到这几句话 重试 关闭 Third paragraph\./, 'a failure in the same place: the reason (one line, the whole of it on hover), 重试, 关闭');
  const deleted = ui.aiBlocks(block)[0];
  const undo = chapterOf({ ...node, mine: gone }, {}, [{ key: 'u', kind: 'undo', id: 'ai1', heading: 'h2', index: 0, block: deleted }]);
  assert.match(textOf(undo), /its reasons\. 已删除这段 · 撤销 只能撤销最近一次删除，几秒后这一行会消失。 Third paragraph\./, 'where the block was, its hover says only the latest can come back');
  assert.match(undo, /data-book-ai="undo"/);
  // Past its seconds the line fades out and keeps its room: hidden from the screen reader, its 撤销 off.
  const faded = chapterOf({ ...node, mine: gone }, {}, [{ key: 'u', kind: 'undo', id: 'ai1', heading: 'h2', index: 0, block: deleted, faded: true }]);
  assert.match(faded, /data-ai-line="undo" data-ai-faded="" aria-hidden="true"/);
  assert.match(faded, /disabled=""[^>]*data-book-ai="undo"/);
  assert.doesNotMatch(faded, /role="status"/);
  // A line drawn before the host answered has 取消 too (it stops the task as soon as its id is known).
  assert.match(textOf(chapterOf({ ...node, mine: '' }, {}, [{ ...writing, jobId: undefined }])), /AI 正在写 · 约 1 分钟 · 取消/);
  // A block that just landed is drawn folded, whatever its size (it stands as high as the line did).
  const landed = chapterOf({ ...node, mine: block }, {}, [{ ...writing, id: 'ai1', kind: 'done' }]);
  assert.match(rowOf(landed, 'ai1'), /data-ai-folded="true"/);
  assert.doesNotMatch(landed, /data-ai-line/, 'and the line is gone');
  // 重新生成 running: the old text stays, the row says so and can stop it.
  const again = chapterOf({ ...node, mine: block }, {}, [{ ...writing, id: 'ai1', replace: 'ai1' }]);
  assert.match(rowOf(again, 'ai1'), /data-ai-rewriting=""/);
  assert.match(textOf(rowOf(again, 'ai1')), /正在重新生成 取消 关于：「records each decision」 An explanation of it\./);
});

test('问 AI: a quiet button at a point\'s title; the panel has one box, the five presets, 写进这个知识点 (secondary) and 发给主会话, each with its rule on hover', () => {
  assert.match(render(h(ui.AskButton, { onAsk: noop })), /class="sh-btn sh-btn--quiet sh-btn--sm book-ask-open"[^>]*aria-haspopup="dialog"[^>]*>[\s\S]*问 AI/);
  const panel = render(h(ui.BookAsk, { target: { heading: 'h2', anchor: null }, model: { ready: true }, onWrite: noop, onSend: noop, onClose: noop }));
  const text = textOf(panel);
  assert.match(panel, /role="dialog" aria-label="问 AI" data-book-ask-panel="point"/);
  assert.deepEqual(ui.PRESETS, ['讲细点', '加个例子', '润色成大白话', '加过渡', '还漏了哪些小知识点、要不要补进来']);
  for (const preset of ui.PRESETS) assert.match(panel, new RegExp(`data-book-ask-preset="${preset}"[^>]*>${preset}<`));
  assert.equal((panel.match(/<textarea/g) || []).length, 1, 'one box');
  assert.match(panel, /placeholder="想在这个知识点里加点什么？"/);
  assert.match(panel, /class="sh-btn sh-btn--secondary sh-btn--sm"[^>]*disabled=""[^>]*data-book-ask="write"/, '写进这个知识点 is secondary, off while the box is empty (about the whole point it needs something to write)');
  assert.match(panel, /sh-btn--quiet[^>]*data-book-ask="chat"/);
  assert.doesNotMatch(panel, /sh-btn--primary/, 'no primary in the panel: the page keeps its one');
  assert.match(text, /写进这个知识点 用你设置的模型写，约 1 分钟；写好后收成一行，放在它针对的那段后面。/);
  assert.match(text, /发给主会话 只填进主对话的输入框，由你按发送；没有主对话时复制到剪贴板。/);
  const over = render(h(ui.BookAsk, { target: { heading: 'h2', words: 'records each decision', anchor: null }, model: { ready: true }, onWrite: noop, onSend: noop, onClose: noop }));
  assert.match(over, /data-book-ask-panel="selection"/);
  assert.match(textOf(over), /「records each decision」/, 'the words it is about, on top');
  assert.match(over, /data-book-ask="write"(?![^>]*disabled)/, 'over selected words an empty box is 弄懂: 写进 is on');
  assert.match(over, /placeholder="想让它怎么讲？留空就是弄懂这几句"/);
});

test('without a model: the gate for 写进这个知识点 only; 发给主会话 and the box still work', () => {
  const off = render(h(ui.BookAsk, { target: { heading: 'h2', words: 'records', anchor: null }, model: { ready: false, status: 'missing' }, onWrite: noop, onSend: noop, onClose: noop }));
  assert.match(off, /disabled=""[^>]*data-book-ask="write"/);
  assert.match(off, /data-book-ask="chat"(?![^>]*disabled)/, '发给主会话 needs no model');
  assert.doesNotMatch(off, /<textarea[^>]*disabled/, 'the box can be typed in');
  assert.match(textOf(off), /弄懂和写进这个知识点需要先配置模型|发给主会话、读书页照常能用/);
  const book = render(h(ui.AskForm, { scope: 'book', onSend: noop }));
  assert.doesNotMatch(book, /data-book-ask="write"/, 'the whole book: 发给主会话 only');
  assert.match(book, /sh-btn--secondary[^>]*data-book-ask="chat"/);
  assert.doesNotMatch(book, /book-model-gate|sh-gate/, 'and no gate');
  assert.match(textOf(book), /也可以直接在主对话里说你想怎么改，主会话会按 study-book 改书，每次改动都能回退/);
});

test('the selection toolbar\'s 弄懂 is secondary and its words never carry the 角标 digits (the source pins both)', async () => {
  const fs = await import('node:fs');
  const bar = fs.readFileSync(new URL('../ui/book/BookSelectBar.jsx', import.meta.url), 'utf8'), words = fs.readFileSync(new URL('../ui/book/ask-visibility.js', import.meta.url), 'utf8');
  assert.match(bar, /variant="secondary" icon="sparkle" data-book-select="explain"/);
  assert.doesNotMatch(bar, /variant="primary"/);
  assert.match(bar, /addEventListener\('selectionchange'/, 'it listens to selectionchange (keyboard and touch selections count)');
  assert.match(words, /querySelectorAll\('\.md-cite'\)\.forEach\(mark => mark\.remove\(\)\)/);
});

test('English: the page\'s own words', () => english(() => {
  const html = chapter(), panel = render(h(ui.BookAsk, { target: { heading: 'h2', words: 'records', anchor: null }, model: { ready: true }, onWrite: noop, onSend: noop, onClose: noop }));
  const line = render(h(ui.BookAiLine, { line: { kind: 'writing', jobId: 'j' } })) + render(h(ui.BookAiLine, { line: { kind: 'undo' } })) + render(h(ui.BookAiLine, { line: { kind: 'failed', error: 'x' } }));
  const own = `${textOf(html)} ${textOf(panel)} ${textOf(line)}`.replace(/Entropy|First paragraph\.|The architect records each decision and its reasons\.|Third paragraph\.|My note\.|An explanation of it\.|Orphan\.|关于：「records each decision」|关于：「words that are nowhere」/g, '');
  assert.equal(han.test(own.replace(/「records」/g, '')), false, own);
  assert.match(textOf(html), /Keep Regenerate Delete/);
  assert.match(textOf(panel), /Ask AI .*Explain in more detail Add an example Polish into plain language Add transitions Which smaller points are missing, and should they be added\?/);
  assert.match(textOf(panel), /Write into this point/);
  assert.match(textOf(line), /Writing · about 1 minute .*Cancel.*Paragraph deleted .*Undo.*Not written: x .*Retry/);
}));
