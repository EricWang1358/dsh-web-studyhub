import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 2 · WP-H: the reader's overlays use the shared primitives (#81 #88 #102 #79 #83 #146).
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { default as TranslationBlock } from './ui/document-preview/translation/TranslationBlock.jsx';
  export { default as FloatingTranslation } from './ui/document-preview/translation/FloatingTranslation.jsx';
  export { default as GlossaryDialog } from './ui/document-preview/translation/GlossaryDialog.jsx';
  export { default as PagePeekView } from './ui/document-preview/peek/PagePeekView.jsx';
  export { default as OutlinePanel } from './ui/document-preview/reader/OutlinePanel.jsx';
  export { default as Composer } from './ui/board/Composer.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const noop = () => {};
const html = (type, props = {}, ...children) => renderToStaticMarkup(h(type, props, ...children));
const item = { key: 'p1', kind: 'paragraph', text: '平台让两类用户找到彼此。', version: 1, history: [], warnings: [] };

test('a translation block\'s ⋯ is the shared Menu, and its warnings are InlineMessages (#79 #88)', () => {
  m.setUiLanguage('zh');
  const out = html(m.TranslationBlock, { state: 'ok', item: { ...item, warnings: ['numbers'], outdated: true }, target: 'zh', open: true, onToggle: noop, onCopy: noop, onDelete: noop,
    onRetranslate: noop, onGlossary: noop, onCancel: noop });
  assert.match(out, /<button[^>]*aria-haspopup="menu"[^>]*aria-label="这段译文的更多操作"|<button[^>]*aria-label="这段译文的更多操作"[^>]*aria-haspopup="menu"/);
  assert.doesNotMatch(out, /tr-menu__list|tr-iconbtn|class="tr-menu"/);
  assert.doesNotMatch(out, /is-warning/);
  assert.match(out, /sh-inline--warning[^]*译文里的数字和原文对不上/);
  assert.match(out, /sh-inline--warning[^]*术语表改过了，这段译文可能不一致/);
  const source = read('ui/document-preview/translation/TranslationBlock.jsx');
  assert.match(source, /<Menu/);
  assert.doesNotMatch(source, /pointerdown|role="menu"/);
});

test('a pending translation shows the shared Spinner and no private tr-spin keyframes remain (#102)', () => {
  m.setUiLanguage('zh');
  const pending = html(m.TranslationBlock, { state: 'pending', target: 'zh', onCancel: noop });
  assert.match(pending, /role="status"[^]*sh-spinner/);
  assert.doesNotMatch(read('ui/document-preview/translation/translation.css'), /tr-spin/);
  assert.match(read('ui/document-preview/translation/translation.css'), /animation: sh-spin/, 'the 译 mark spinner reuses the shared keyframes');
});

test('the floating translation card is a Popover with a CloseButton, not a bare ×  (#81 #83)', () => {
  m.setUiLanguage('zh');
  const out = html(m.FloatingTranslation, { onClose: noop }, h('p', null, '译文'));
  assert.match(out, /class="tr-float"/);
  assert.doesNotMatch(out, /class="tr-float"[^>]*style=/, 'the card is placed against the selection by the shared anchoring, not by coordinates in state (#231)');
  assert.match(out, /role="dialog"/);
  assert.match(out, /aria-label="关闭"/);
  assert.match(out, /sh-btn--icon/);
  assert.doesNotMatch(out, />×</);
  assert.match(out, /译文/);
  const source = read('ui/document-preview/translation/useBilingual.jsx');
  assert.match(source, /<FloatingTranslation/);
  assert.doesNotMatch(source, /tr-float__close/);
  assert.match(read('ui/document-preview/translation/FloatingTranslation.jsx'), /<Popover/);
});

test('the reader\'s other closes and steppers are icon buttons with names (#83 #145)', () => {
  m.setUiLanguage('zh');
  const peek = html(m.PagePeekView, { phase: 'ready', page: 2, total: 9, zoom: 1, onClose: noop, onPrev: noop, onNext: noop, onZoom: noop, onFit: noop });
  for (const name of ['上一页', '下一页', '缩小', '放大', '适合宽度', '关闭']) assert.match(peek, new RegExp(`aria-label="${name}"`), name);
  assert.doesNotMatch(peek, /[‹›−＋⤢×]/);
  assert.ok((peek.match(/<svg/g) || []).length >= 6);
  const glossary = html(m.GlossaryDialog, { glossary: [{ term: 'CQRS', to: '' }], target: 'zh', onSave: noop, onPrice: noop, onRetranslate: noop, onClose: noop });
  assert.match(glossary, /aria-label="删除术语 1"[^>]*>|<button[^>]*aria-label="删除术语 1"/);
  assert.doesNotMatch(glossary, />×</);
  const composer = html(m.Composer, { columnTitle: '待办', onSubmit: noop, onClose: noop, studyRef: { root: '/lib', deckId: 'd' }, onClearStudyRef: noop, library: {}, labelSuggestions: [] });
  assert.doesNotMatch(composer, />×</);
  assert.match(composer, /aria-label="取消关联"/);
});

test('outline twisties are named DisclosureToggles (#146)', () => {
  m.setUiLanguage('zh');
  const items = [{ id: 'a', title: '第一章', depth: 0, children: 1, parent: '' }, { id: 'b', title: '第一节', depth: 1, children: 0, parent: 'a' }];
  const out = html(m.OutlinePanel, { items, activeId: 'a', onJump: noop, id: 'o', initialOpen: ['a'] });
  assert.match(out, /<button[^>]*class="[^"]*sh-disclosure-toggle[^"]*reader-outline__twisty|<button[^>]*class="[^"]*reader-outline__twisty[^"]*sh-disclosure-toggle/);
  assert.match(out, /aria-expanded="true"/);
  assert.match(out, /aria-label="收起「第一章」"/);
  assert.doesNotMatch(read('ui/document-preview/reader/OutlinePanel.jsx'), /reader-turn/);
});

test('the viewer\'s notices are InlineMessages, not .is-warning paragraphs (#88)', () => {
  const source = read('ui/document-preview/DocumentViewer.jsx');
  assert.doesNotMatch(source, /is-warning/);
  assert.match(source, /<InlineMessage/);
  assert.doesNotMatch(read('ui/document-preview/reader/reader.css'), /\.is-warning/);
});

test('a Menu inside a dialog opens in that dialog, in the top layer with it', () => {
  assert.match(read('ui/components/Menu.jsx'), /closest\('dialog\[open\], \.study-app, \.study-seat'\)/);
});
