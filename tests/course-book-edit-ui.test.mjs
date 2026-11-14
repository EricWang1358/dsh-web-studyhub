/* 复习全书 M2 on the page (static zh and en): a changed generated file says 已改动, a waiting suggestion offers 采用 and 忽略 (书已更新 for the other text of a
   save), the preview of an edited file still draws the book's links, hides the heading ids and never renders raw HTML, and the 原文 editor shows one file
   with 保存, 放弃改动 and 回退到上一版. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorSelection, EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { loadUi } from './helpers/ui-module.mjs';
import {
  wrapOrUnwrapSelection,
  linkifyPastedUrl,
  toggleBold,
  toggleItalic,
  toggleInlineCode,
  handlePasteUrl,
  isSaveShortcut,
  handleSaveKeyDown,
  markdownEditorExtensions,
} from '../ui/editor/markdown-shortcuts.js';

const ui = await loadUi(`
  export { default as BookChapter, headingAnchor } from './ui/book/BookChapter.jsx';
  export { default as BookEditor } from './ui/book/BookEditor.jsx';
  export { default as BookSuggestion } from './ui/book/BookSuggestion.jsx';
  export * from './ui/book/model.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const mine = ['## My section <!-- sh:id h9 -->', '', 'See [练习：Q](studyhub://card/d1/q1) and [练 5 道：P](studyhub://practice?heading=h2&n=5).', '',
  '<script>alert(1)</script> <img src=x onerror=alert(2)> <iframe src="https://example.com"></iframe>'].join('\n');
const book = { status: 'ok', course: 'SA', title: '复习全书 · SA', notes: true, papers: 0, missing: [], unplaced: { title: '未归位', text: '', file: 'unplaced.md' }, history: { 'p1.mine.md': 2 },
  files: { 'p1.gen.md': { version: 3, forked: true, suggestions: [{ id: 'g1', text: 'A **newer** explanation.', kind: 'generated' }] }, 'p1.mine.md': { version: 2, forked: false, suggestions: [{ id: 't1', text: 'Their text.', kind: 'theirs' }] },
    'unplaced.md': { version: 1, forked: false, suggestions: [] } },
  nodes: [{ hid: 'h2', key: 'bk:p1', title: 'Entropy', number: '1', depth: 1, leaf: true, gen: 'My edited explanation.', mine, files: { gen: 'p1.gen.md', mine: 'p1.mine.md' },
    questionTotal: 1, questions: [{ deckId: 'd1', cardId: 'q1', prompt: 'Q?' }], children: [] }] };
const handlers = { gone: ui.goneSet([]), qaOpen: () => false, toggleQa: noop, source: noop, card: noop, practice: noop, create: noop, files: book.files, choose: noop, busy: false };

test('预览 of edited files: 已改动 and the waiting suggestions with 采用/忽略; links still drawn; ids hidden; no raw HTML', () => {
  const html = render(h(ui.BookChapter, { node: book.nodes[0], open: true, onToggle: noop, course: 'SA', handlers })), text = textOf(html);
  assert.match(text, /有新的生成内容 这段讲解你改过，所以新生成的内容没有直接替换，放在下面。/);
  assert.match(text, /书已更新 保存时这一段在别处也改过/);
  assert.equal((text.match(/采用/g) || []).length, 2);
  assert.equal((text.match(/忽略/g) || []).length, 2);
  assert.match(html, /data-book-link="card"/);
  assert.match(html, /data-book-link="practice"/);
  assert.doesNotMatch(html, /sh:id/, 'the heading id is the book\'s, not shown');
  assert.match(html, /<h\d[^>]*class="md-heading"[^>]*id="book-h9"[^>]*data-book-heading="h9"[^>]*>My section<\/h\d>/, 'a typed heading carries its id: the 目录 and the way back reach it');
  assert.deepEqual(ui.headingAnchor('Plain'), null);
  assert.match(text, /My section/);
  assert.doesNotMatch(html, /<script|<img src="x"|<img src=x|<iframe/i, 'no raw HTML element');
  assert.match(text, /<script>alert\(1\)<\/script>/, 'it stays visible as text');
  const forked = render(h(ui.BookSuggestion, { meta: { forked: true, suggestions: [] }, onChoose: noop }));
  assert.match(textOf(forked), /已改动 这段讲解你改过：重新生成时不会覆盖它。/);
  assert.equal(render(h(ui.BookSuggestion, { meta: { forked: false, suggestions: [] }, onChoose: noop })), '');
});

test('原文: one file of the book in the editor, the file picker in reading order, 保存 / 放弃改动 / 回退到上一版', () => {
  assert.deepEqual(ui.bookFiles(book).map(item => [item.file, item.kind]), [['p1.gen.md', 'gen'], ['p1.mine.md', 'mine'], ['unplaced.md', 'unplaced']]);
  assert.equal(ui.fileText(book, 'p1.mine.md'), mine);
  assert.equal(ui.defaultFile(book, 'h2'), 'p1.mine.md', 'the own file of the point being read opens first');
  const html = render(h(ui.BookEditor, { book, file: 'p1.gen.md', onPick: noop, onChanged: noop })), text = textOf(html);
  assert.match(text, /已改动/);
  assert.match(text, /保存/);
  assert.match(text, /放弃改动/);
  assert.match(text, /回退到上一版/);
  assert.match(html, /book-editor__revert[^>]*disabled/, 'no earlier version of this file: 回退 is off');
  assert.doesNotMatch(render(h(ui.BookEditor, { book, file: 'p1.mine.md', onPick: noop, onChanged: noop })), /book-editor__revert[^>]*disabled=""/, 'two earlier versions: 回退 is on');
});

test('English: the editing words are English', () => english(() => {
  const html = render(h(ui.BookChapter, { node: book.nodes[0], open: true, onToggle: noop, course: 'SA', handlers }));
  const editor = render(h(ui.BookEditor, { book, file: 'p1.gen.md', onPick: noop, onChanged: noop }));
  for (const [where, markup] of [['preview', html], ['editor', editor]]) {
    const own = textOf(markup).replace(/Entropy|My edited explanation\.|My section|See|练习：Q|练 5 道：P|and|A newer explanation\.|Their text\.|<script>alert\(1\)<\/script>|Q\?|未归位/g, '');
    assert.equal(han.test(own), false, `${where}: ${own}`);
  }
  assert.match(textOf(html), /New generated text[\s\S]*Take it[\s\S]*Ignore/);
  assert.match(textOf(editor), /Back to the previous version/);
}));

test('markdown shortcuts: wrap/unwrap, URL paste linkification, CodeMirror transactions, and Mod-s save handling (#21, #22)', () => {
  // 1. Pure wrap/unwrap helper for **, *, and `
  const wrappedBold = wrapOrUnwrapSelection('hello world', 6, 11, '**');
  assert.equal(wrappedBold.doc, 'hello **world**');
  assert.equal(wrappedBold.from, 8);
  assert.equal(wrappedBold.to, 13);
  const unwrappedInner = wrapOrUnwrapSelection(wrappedBold.doc, wrappedBold.from, wrappedBold.to, '**');
  assert.equal(unwrappedInner.doc, 'hello world');
  assert.equal(unwrappedInner.from, 6);
  assert.equal(unwrappedInner.to, 11);
  const unwrappedOuterSel = wrapOrUnwrapSelection('hello **world**', 6, 15, '**');
  assert.equal(unwrappedOuterSel.doc, 'hello world');
  assert.equal(unwrappedOuterSel.from, 6);
  assert.equal(unwrappedOuterSel.to, 11);

  // Empty caret toggles symmetric markers
  const caretWrap = wrapOrUnwrapSelection('ab', 1, 1, '`');
  assert.equal(caretWrap.doc, 'a``b');
  assert.deepEqual([caretWrap.from, caretWrap.to], [2, 2]);
  const caretUnwrap = wrapOrUnwrapSelection(caretWrap.doc, caretWrap.from, caretWrap.to, '`');
  assert.equal(caretUnwrap.doc, 'ab');
  assert.deepEqual([caretUnwrap.from, caretUnwrap.to], [1, 1]);

  // Bold vs italic distinction: * inside **bold** wraps to ***bold***, and * unwraps ***bold*** -> **bold**
  const italicOnBold = wrapOrUnwrapSelection('**word**', 2, 6, '*');
  assert.equal(italicOnBold.doc, '***word***');
  assert.deepEqual([italicOnBold.from, italicOnBold.to], [3, 7]);
  const unwrapItalicOnBoth = wrapOrUnwrapSelection(italicOnBold.doc, italicOnBold.from, italicOnBold.to, '*');
  assert.equal(unwrapItalicOnBoth.doc, '**word**');
  assert.deepEqual([unwrapItalicOnBoth.from, unwrapItalicOnBoth.to], [2, 6]);
  // Multi-span selection isn't corrupted by naive edge stripping
  assert.equal(wrapOrUnwrapSelection('*a* and *b*', 0, 11, '*').doc, '**a* and *b**');

  // 2. linkifyPastedUrl helper
  assert.equal(linkifyPastedUrl('React docs', '  https://react.dev/learn \n'), '[React docs](https://react.dev/learn)');
  assert.equal(linkifyPastedUrl('local', 'http://localhost:3000/page'), '[local](http://localhost:3000/page)');
  assert.equal(linkifyPastedUrl('', 'https://example.com'), null);
  assert.equal(linkifyPastedUrl('   ', 'https://example.com'), null);
  assert.equal(linkifyPastedUrl('line1\nline2', 'https://example.com'), null);
  assert.equal(linkifyPastedUrl('https://old.example', 'https://new.example'), null);
  assert.equal(linkifyPastedUrl('plain words', 'not a url'), null);

  // 3. CodeMirror EditorState commands & paste transaction
  let savedCalls = 0;
  const extensions = markdownEditorExtensions({ onSave: () => { savedCalls += 1; } });
  let state = EditorState.create({
    doc: 'alpha beta',
    selection: EditorSelection.create([EditorSelection.range(0, 5), EditorSelection.range(6, 10)]),
    extensions: [extensions, EditorState.allowMultipleSelections.of(true)],
  });
  const target = { get state() { return state; }, dispatch(tr) { state = tr.state; } };
  assert.equal(toggleBold(target), true);
  assert.equal(state.doc.toString(), '**alpha** **beta**');
  assert.equal(toggleBold(target), true);
  assert.equal(state.doc.toString(), 'alpha beta');
  assert.equal(toggleItalic(target), true);
  assert.equal(state.doc.toString(), '*alpha* *beta*');
  assert.equal(toggleInlineCode(target), true);
  assert.equal(state.doc.toString(), '*`alpha`* *`beta`*');
  assert.equal(toggleInlineCode(target), true);
  assert.equal(state.doc.toString(), '*alpha* *beta*');
  assert.equal(toggleItalic(target), true);
  assert.equal(state.doc.toString(), 'alpha beta');

  // Keymap facet carries Mod-b, Mod-i, Mod-`, Mod-s
  const registered = state.facet(keymap).flat();
  const keys = registered.map(binding => binding.key);
  for (const key of ['Mod-b', 'Mod-i', 'Mod-`', 'Mod-s']) assert.ok(keys.includes(key), `missing ${key}`);
  registered.find(binding => binding.key === 'Mod-s').run();
  assert.equal(savedCalls, 1);

  // Paste URL replaces selected text with [sel](url) and calls preventDefault()
  let pasteState = EditorState.create({ doc: 'read guide now', selection: EditorSelection.range(5, 10), extensions });
  let pastePrevented = false;
  const pasteHandled = handlePasteUrl(
    { clipboardData: { getData: type => (type === 'text/plain' ? 'https://studyhub.test/guide' : '') }, preventDefault() { pastePrevented = true; } },
    { get state() { return pasteState; }, dispatch(tr) { pasteState = tr.state; } },
  );
  assert.equal(pasteHandled, true);
  assert.equal(pastePrevented, true);
  assert.equal(pasteState.doc.toString(), 'read [guide](https://studyhub.test/guide) now');

  // Read-only state refuses mutation commands & paste
  const roState = EditorState.create({ doc: 'read only', selection: EditorSelection.range(0, 4), extensions: [extensions, EditorState.readOnly.of(true)] });
  assert.equal(toggleBold({ state: roState, dispatch() { throw new Error('must not dispatch'); } }), false);
  assert.equal(handlePasteUrl({ clipboardData: { getData: () => 'https://example.com' } }, { state: roState }), false);

  // 4. Container Ctrl/Cmd+S helper & English locale fragment
  assert.equal(isSaveShortcut({ ctrlKey: true, key: 's' }), true);
  assert.equal(isSaveShortcut({ metaKey: true, key: 'S' }), true);
  assert.equal(isSaveShortcut({ ctrlKey: true, altKey: true, key: 's' }), false);
  assert.equal(isSaveShortcut({ ctrlKey: true, shiftKey: true, key: 's' }), false);

  let handlerPrevented = false, containerSaves = 0;
  assert.equal(handleSaveKeyDown({ ctrlKey: true, key: 's', preventDefault() { handlerPrevented = true; } }, () => { containerSaves += 1; }), true);
  assert.equal(handlerPrevented, true);
  assert.equal(containerSaves, 1);
  assert.equal(handleSaveKeyDown({ ctrlKey: true, key: 's', defaultPrevented: true, preventDefault() {} }, () => { containerSaves += 1; }), false);
  assert.equal(handleSaveKeyDown({ ctrlKey: true, key: 's', target: { closest: sel => sel === 'dialog' }, preventDefault() {} }, () => { containerSaves += 1; }), false);
  assert.equal(containerSaves, 1);

  const polishEn = JSON.parse(readFileSync(new URL('../ui/locales/en.polish-notes.json', import.meta.url), 'utf8'));
  assert.equal(polishEn['已是最新'], 'Up to date');
});
