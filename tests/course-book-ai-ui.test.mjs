/* 复习全书 M4 on the page (static zh and en): an AI block sits right after the paragraph it is about, says what it is about, 新 until kept, 保留 / 重新生成 /
   删除 and a follow-up field; one whose words are gone is at the end marked 原位置已变; the panel over selected words offers 弄懂 and an instruction, under a
   heading only the instruction; without a model the shared gate. Fakes only. */
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
const chapter = () => render(h(ui.BookChapter, { node, open: true, onToggle: noop, course: 'SA', handlers }));

test('an AI block right after its paragraph, with 保留 / 重新生成 / 删除 and a follow-up; one whose words are gone at the end, 原位置已变', () => {
  const html = chapter(), text = textOf(html);
  assert.ok(text.indexOf('its reasons.') < text.indexOf('关于：「records each decision」') && text.indexOf('关于：「records each decision」') < text.indexOf('Third paragraph.'), 'after its paragraph');
  assert.match(html, /data-ai-block="ai1" data-ai-state="new"/);
  assert.match(text, /关于：「records each decision」 新/);
  assert.match(text, /保留 重新生成 删除/);
  assert.match(html, /placeholder="接着问…"/);
  assert.ok(text.indexOf('Orphan.') > text.indexOf('My note.'), 'the lost one at the end');
  assert.match(text, /关于：「words that are nowhere」 原位置已变/);
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
  const own = `${textOf(html)} ${textOf(panel)}`.replace(/Entropy|First paragraph\.|The architect records each decision and its reasons\.|Third paragraph\.|My note\.|An explanation of it\.|Orphan\.|关于：「records each decision」|关于：「words that are nowhere」|这一节还没有题。|出题/g, '');
  assert.equal(han.test(own), false, own);
  assert.match(textOf(html), /Keep Regenerate Delete/);
  assert.match(textOf(panel), /Explain/);
}));
