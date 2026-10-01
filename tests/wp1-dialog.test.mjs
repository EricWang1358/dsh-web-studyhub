import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// P04 / P54: every modal is a native <dialog> opened with showModal(), so it
// lives in the top layer above the DSH composer, with a footer that stays
// reachable and a slot where toasts appear while it is open.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/components/Dialog.jsx'; export { default } from './ui/components/Dialog.jsx';
  export * from './ui/components/dialog-stack.js';
  export { default as ModalFrame } from './ui/ModalFrame.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const han = /[㐀-鿿]/;

test('a dialog is a labelled native modal with header, scrolling body, toast slot and footer', () => {
  m.setUiLanguage('zh');
  const out = renderToStaticMarkup(h(m.default, { title: '添加资料', onClose() {}, size: 'md',
    footer: h('button', { type: 'button' }, '保存资料') }, h('p', null, '内容')));
  const open = out.match(/<dialog[^>]*>/)?.[0];
  assert.ok(open, 'renders a native dialog element');
  assert.match(open, /role="dialog"/, 'App\'s focus trap finds it with [role="dialog"]');
  assert.match(open, /aria-modal="true"/);
  assert.match(open, /sh-dialog--md/);
  assert.doesNotMatch(open, /\sopen=/, 'showModal() opens it at runtime; an open attribute would make it non-modal');
  const titleId = open.match(/aria-labelledby="([^"]+)"/)[1];
  assert.match(out, new RegExp(`<h2[^>]*id="${titleId}"[^>]*>添加资料</h2>`));
  assert.match(out, /aria-label="关闭"/);
  const order = ['sh-dialog__header', 'sh-dialog__body', 'sh-dialog__toasts', 'sh-dialog__footer'].map(name => out.indexOf(name));
  assert.ok(order.every(index => index > 0), order.join());
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'footer follows the body so it stays visible');
  assert.match(out, /保存资料/);
  assert.doesNotMatch(renderToStaticMarkup(h(m.default, { title: 'x', onClose() {} }, 'y')), /sh-dialog__footer/);
});

test('every size maps to a class and unknown sizes fall back to md', () => {
  for (const size of ['sm', 'md', 'lg', 'full']) {
    assert.match(renderToStaticMarkup(h(m.default, { title: 't', size, onClose() {} })), new RegExp(`sh-dialog--${size}`));
  }
  assert.match(renderToStaticMarkup(h(m.default, { title: 't', size: 'huge', onClose() {} })), /sh-dialog--md/);
});

test('ModalFrame keeps its props and is now a native dialog for both sizes', () => {
  m.setUiLanguage('zh');
  const plain = renderToStaticMarkup(h(m.ModalFrame, { title: '添加资料', onClose() {} }, '表单'));
  assert.match(plain, /<dialog[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.doesNotMatch(plain, /modal-backdrop/, 'the z-indexed div backdrop is gone');
  assert.match(plain, /sh-dialog--md/);
  assert.match(plain, /表单/);
  const full = renderToStaticMarkup(h(m.ModalFrame, { title: '第一章.pdf', fullscreen: true, onClose() {} }, '正文'));
  assert.match(full, /<dialog[^>]*class="[^"]*sh-dialog--full[^"]*source-preview/);
  assert.match(full, /aria-label="资料内容"/, 'the scrolling body is a labelled region');
});

test('the dialog stack reports the topmost open dialog to subscribers', () => {
  const seen = [];
  const stop = m.subscribeDialogs(() => seen.push(m.topDialog()));
  const first = { name: 'first' }, second = { name: 'second' };
  const removeFirst = m.pushDialog(first);
  const removeSecond = m.pushDialog(second);
  assert.equal(m.topDialog(), second);
  removeSecond();
  assert.equal(m.topDialog(), first);
  removeSecond();
  assert.equal(m.topDialog(), first, 'removing twice is harmless');
  removeFirst();
  assert.equal(m.topDialog(), null);
  stop();
  m.pushDialog({ name: 'unseen' })();
  assert.deepEqual(seen.map(entry => entry?.name ?? null), ['first', 'second', 'first', null]);
});

test('Escape closes exactly once and respects non-dismissible dialogs', () => {
  assert.equal(m.cancelDecision({ cancelable: true, dismissible: true }), 'close');
  assert.equal(m.cancelDecision({ cancelable: true, dismissible: false }), 'block');
  // A forced close (the browser refuses to cancel) is reported by the close
  // event instead, so onClose is not called twice.
  assert.equal(m.cancelDecision({ cancelable: false, dismissible: true }), 'defer');
});

test('only a click that starts and ends on the backdrop closes the dialog', () => {
  const dialog = { id: 'dialog' }, inner = { id: 'inner' };
  assert.equal(m.isBackdropClick({ target: dialog }, dialog, dialog), true);
  assert.equal(m.isBackdropClick({ target: dialog }, dialog, inner), false, 'a text selection dragged out of the dialog');
  assert.equal(m.isBackdropClick({ target: inner }, dialog, inner), false);
});

test('English dialog chrome contains no Chinese', () => {
  m.setUiLanguage('en');
  const out = renderToStaticMarkup(h(m.ModalFrame, { title: 'Add source', fullscreen: true, onClose() {} }, 'x'));
  assert.doesNotMatch(out, han);
  assert.match(out, /aria-label="Close"/);
  m.setUiLanguage('zh');
});
