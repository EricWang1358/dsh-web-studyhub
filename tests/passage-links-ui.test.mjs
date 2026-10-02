/* The passage-links panel, the "save as flashcard" control and the display settings row, rendered in both
   languages. Interaction and layout are checked in the browser preview; this guards the markup, the copy and
   that untrusted text (passages, model answers, follow-ups) is shown as text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupPassageLinks } from '../ui/document-preview/selection.js';
import { buildLinkModel, groupTitle } from '../ui/document-preview/links/link-model.js';

const require = createRequire(import.meta.url);
const han = /[㐀-鿿]/;
const compiled = await build({ stdin: { contents: `export * from './ui/i18n.js';
  export { default as PassageLinksPanel, linkTitleWords } from './ui/document-preview/links/PassageLinksPanel.jsx';
  export { default as SaveAnswerAsCard, QaSavedLine } from './ui/document-preview/links/SaveAnswerAsCard.jsx';
  export { DisplayControls } from './ui/document-preview/reader/DisplaySettings.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
function load() {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const render = element => renderToStaticMarkup(element);

const quote = '原文引用保持中文';
const selection = { documentId: 'doc', revision: 'r1', sourceId: 's1', quote, prefix: '', suffix: '', start: 3, end: 11 };
const other = { ...selection, quote: 'Another passage in English', start: 40, end: 66 };
const stale = { ...selection, quote: 'An older passage', start: 90, end: 106 };
const links = [
  { deckId: 'd1', deckTitle: 'Deck one', cardId: 'q1', kind: 'quiz', prompt: 'What is the question?', answer: 'The answer', explanation: 'Because **reasons**.', selection, status: 'resolved', followups: [] },
  { deckId: 'd2', deckTitle: 'Source Q&A', cardId: 'qa1', kind: 'flashcard', sourceQa: true, prompt: `> ${quote}\n\nWhy does it matter?`, answer: 'It <script>alert(1)</script> matters.', selection, status: 'resolved',
    followups: [{ id: 'f2', question: 'Newest follow-up?', answer: 'Newest answer.' }, { id: 'f1', question: 'Older follow-up?', answer: 'Older answer.' }] },
  { deckId: 'd1', deckTitle: 'Deck one', cardId: 'q2', kind: 'flashcard', prompt: 'Second passage question', answer: 'x', selection: other, status: 'resolved', followups: [] },
  { deckId: 'd1', deckTitle: 'Deck one', cardId: 'q3', kind: 'quiz', prompt: 'Question on an older passage', selection: stale, status: 'stale', followups: [] },
];
const model = () => buildLinkModel(groupPassageLinks(links), { noteBadges: { q1: [{ noteId: 'n1', title: 'My study note', status: 'draft', url: null }] } });

test('the panel lists linked passages with their questions, Q&A cards, notes and the passages to select again (Chinese)', () => {
  const { setUiLanguage, PassageLinksPanel } = load();
  setUiLanguage('zh');
  const html = render(React.createElement(PassageLinksPanel, { model: model(), focusedKey: model().groups[0].key, onFocus() {}, onOpen() {} }));
  for (const text of ['原文关联题目与解析', quote, '打开这道题', '问答', '追问', '打开笔记', 'My study note', 'Deck one', 'Source Q&amp;A', 'Why does it matter?', 'What is the question?'])
    assert.ok(html.includes(text), text);
  assert.ok(!html.includes(`&gt; ${quote}`), 'a Q&A card shows its question, not its quoted front');
  const everything = render(React.createElement(PassageLinksPanel, { model: model(), focusedKey: null, onFocus() {}, onOpen() {} }));
  assert.match(everything, /需要重新选择 · 1/);
  assert.ok(!everything.includes('An older passage'), 'the stale list stays collapsed until opened');
});

test('English renders the whole panel without Chinese except the learner\'s own text', () => {
  const { setUiLanguage, PassageLinksPanel } = load();
  setUiLanguage('en');
  const model1 = model();
  const html = render(React.createElement(PassageLinksPanel, { model: model1, focusedKey: null, onFocus() {}, onOpen() {} }));
  assert.ok(html.includes(quote), 'the passage stays as the document wrote it');
  assert.doesNotMatch(html.replace(quote, ''), han);
  const focused = render(React.createElement(PassageLinksPanel, { model: model1, focusedKey: model1.groups[0].key, onFocus() {}, onOpen() {} }));
  assert.doesNotMatch(focused.replaceAll(quote, ''), han);
  for (const text of ['Open this question', 'Open note', 'Follow-ups', 'Q&amp;A', 'Needs re-selecting'])
    assert.ok(focused.includes(text) || html.includes(text), text);
  setUiLanguage('zh');
});

test('model text is shown as text: a script in an answer or a follow-up never becomes markup', () => {
  const { setUiLanguage, PassageLinksPanel } = load();
  setUiLanguage('en');
  const m = model();
  const html = render(React.createElement(PassageLinksPanel, { model: m, focusedKey: m.groups[0].key, onFocus() {}, onOpen() {} }));
  assert.ok(!html.includes('<script'), 'no script element');
  assert.ok(html.includes('&lt;script&gt;') || !html.includes('alert(1)'));
  setUiLanguage('zh');
});

test('a focused passage is shown alone with a way back to all of them; with none focused every passage is listed', () => {
  const { setUiLanguage, PassageLinksPanel } = load();
  setUiLanguage('en');
  const m = model();
  const all = render(React.createElement(PassageLinksPanel, { model: m, focusedKey: null, onFocus() {}, onOpen() {} }));
  assert.ok(all.includes('Another passage in English') && all.includes(quote));
  assert.ok(!all.includes('Show all citations'));
  const one = render(React.createElement(PassageLinksPanel, { model: m, focusedKey: m.groups[1].key, onFocus() {}, onOpen() {} }));
  assert.ok(one.includes('Another passage in English') && !one.includes(quote));
  assert.ok(one.includes('Show all citations'));
  setUiLanguage('zh');
});

test('with no links the panel says nothing at all', () => {
  const { PassageLinksPanel } = load();
  assert.equal(render(React.createElement(PassageLinksPanel, { model: { groups: [], stale: [] }, focusedKey: null, onFocus() {}, onOpen() {} })), '');
});

const saveProps = { call() {}, selection, question: 'Why?', answer: 'Because.', deckId: '', decks: [{ id: 'd1', title: 'Deck one' }], ready: true, onSaved() {}, onOpenCard() {} };

test('after an answer the learner can save it as a flashcard, in either language, and is told where it goes', () => {
  const { setUiLanguage, SaveAnswerAsCard } = load();
  setUiLanguage('zh');
  const zh = render(React.createElement(SaveAnswerAsCard, saveProps));
  assert.ok(zh.includes('存成闪卡'));
  assert.match(zh, /原文问答/, 'no deck chosen: the course\'s 原文问答 deck');
  assert.match(render(React.createElement(SaveAnswerAsCard, { ...saveProps, deckId: 'd1' })), /Deck one/);
  setUiLanguage('en');
  const en = render(React.createElement(SaveAnswerAsCard, saveProps));
  assert.ok(en.includes('Save as flashcard'));
  assert.doesNotMatch(en, han);
  assert.doesNotMatch(render(React.createElement(SaveAnswerAsCard, { ...saveProps, deckId: 'd1' })), han);
  setUiLanguage('zh');
});

test('saving needs the component that writes it: without it the button is off and says why', () => {
  const { setUiLanguage, SaveAnswerAsCard } = load();
  setUiLanguage('en');
  const html = render(React.createElement(SaveAnswerAsCard, { ...saveProps, ready: false }));
  assert.match(html, /<button[^>]*disabled/);
  assert.doesNotMatch(html, han);
  setUiLanguage('zh');
});

test('the result line reads "已存为闪卡 · 打开这道题" and offers the jump to the saved card', () => {
  const { setUiLanguage, QaSavedLine } = load();
  setUiLanguage('zh');
  const zh = render(React.createElement(QaSavedLine, { result: { status: 'complete', deckId: 'd', cardId: 'c' }, onOpenCard() {} }));
  assert.match(zh.replace(/<[^>]+>/g, ''), /已存为闪卡\s*·\s*打开这道题/);
  const duplicate = render(React.createElement(QaSavedLine, { result: { status: 'duplicate', deckId: 'd', cardId: 'c' }, onOpenCard() {} }));
  assert.match(duplicate, /已经存过/);
  setUiLanguage('en');
  const en = render(React.createElement(QaSavedLine, { result: { status: 'complete', deckId: 'd', cardId: 'c' }, onOpenCard() {} }));
  assert.match(en.replace(/<[^>]+>/g, ''), /Saved as a flashcard\s*·\s*Open this question/);
  assert.doesNotMatch(en, han);
  setUiLanguage('zh');
});

test('the display settings carry a fifth row for the link underlines: Show / Hide, with the current choice marked', () => {
  const { setUiLanguage, DisplayControls } = load();
  const settings = { size: 16, width: 'standard', face: 'sans', tone: 'auto', underline: 'show' };
  setUiLanguage('zh');
  const zh = render(React.createElement(DisplayControls, { settings, onChange() {}, onReset() {} }));
  for (const text of ['字号', '版心宽度', '字体', '背景', '下划线', '显示', '隐藏', '恢复默认']) assert.ok(zh.includes(text), text);
  setUiLanguage('en');
  const en = render(React.createElement(DisplayControls, { settings: { ...settings, underline: 'hide' }, onChange() {}, onReset() {} }));
  assert.doesNotMatch(en, han);
  for (const text of ['Link underlines', 'Show', 'Hide']) assert.ok(en.includes(text), text);
  const pressed = label => en.split('<button').find(part => part.includes(`>${label}<`) || part.includes(`${label}</`));
  assert.match(pressed('Hide'), /aria-pressed="true"/, 'the chosen option is announced');
  assert.match(pressed('Show'), /aria-pressed="false"/);
  setUiLanguage('zh');
});

test('the hover text of an underline has no plural to get wrong and no Chinese in English', () => {
  const { setUiLanguage, linkTitleWords } = load();
  const group = { counts: { question: 1, qa: 2 }, notes: [{ noteId: 'n' }] };
  setUiLanguage('en');
  assert.equal(groupTitle(group, linkTitleWords()), 'Questions 1 · Q&A cards 2 · Notes 1');
  setUiLanguage('zh');
  assert.equal(groupTitle(group, linkTitleWords()), '题目 1 · 问答卡 2 · 笔记 1');
});
