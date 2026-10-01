import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// P53: notices must appear in the visible study viewport (or inside the open
// dialog), carry a success tone, auto-dismiss only when nothing needs reading
// twice, and stay on the page where they were raised.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/components/Feedback.jsx';
  export { default as ActionFeedback, useNotice, reviewNoticeScope, pageOfScope, bindNotice, noticeVisible } from './ui/ActionFeedback.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const han = /[㐀-鿿]/;
const h = React.createElement;
const html = (type, props = {}, ...children) => renderToStaticMarkup(h(type, props, ...children));

test('only info and success toasts dismiss themselves', () => {
  assert.equal(m.shouldAutoDismiss({ tone: 'info' }), true);
  assert.equal(m.shouldAutoDismiss({ tone: 'success' }), true);
  assert.equal(m.shouldAutoDismiss({}), true, 'info is the default tone');
  assert.equal(m.shouldAutoDismiss({ tone: 'warning' }), false);
  assert.equal(m.shouldAutoDismiss({ tone: 'error' }), false);
  assert.equal(m.shouldAutoDismiss({ tone: 'success', action: { label: '撤销', onClick() {} } }), false, 'an undo must not vanish');
  assert.equal(m.shouldAutoDismiss({ tone: 'info', persistent: true }), false);
  assert.ok(m.TOAST_TIMEOUT >= 5000);
});

test('a toast has a tone, an optional action and a labelled close button', () => {
  m.setUiLanguage('zh');
  const out = html(m.Toast, { tone: 'success', action: { label: '撤销', onClick() {} }, onDismiss() {} }, '资料已保存');
  assert.match(out, /sh-toast--success/);
  assert.match(out, /资料已保存/);
  assert.match(out, /<button[^>]*>撤销<\/button>/);
  assert.match(out, /aria-label="关闭提示"/);
  assert.match(out, /<svg/);
});

test('the toast region keeps one polite and one assertive live region', () => {
  const out = html(m.ToastRegion, { toasts: [
    { id: 'a', tone: 'success', message: '已保存' }, { id: 'b', tone: 'error', message: '保存失败' }, { id: 'c', tone: 'warning', message: '注意' },
  ], onDismiss() {} });
  const polite = out.match(/<div[^>]*role="status"[^>]*aria-live="polite"[^>]*>(.*?)<\/div><div[^>]*role="alert"/s);
  assert.ok(polite, 'polite region precedes the alert region');
  assert.match(polite[1], /已保存/);
  assert.match(polite[1], /注意/);
  assert.doesNotMatch(polite[1], /保存失败/);
  const assertive = out.match(/<div[^>]*role="alert"[^>]*aria-live="assertive"[^>]*>(.*)$/s);
  assert.match(assertive[1], /保存失败/);
  assert.match(out, /sh-toasts--page/);
  assert.match(html(m.ToastRegion, { toasts: [], placement: 'inline' }), /sh-toasts--inline/);
});

test('inline messages sit next to the control with an id for aria-describedby', () => {
  const out = html(m.InlineMessage, { tone: 'error', id: 'name-error', action: { label: '去设置', onClick() {} } }, '缺少密钥');
  assert.match(out, /role="alert"/);
  assert.match(out, /id="name-error"/);
  assert.match(out, /sh-inline--error/);
  assert.match(out, /<button[^>]*>去设置<\/button>/);
  assert.doesNotMatch(html(m.InlineMessage, { tone: 'info' }, '提示'), /role="alert"/);
});

test('banners show a title, body and actions in their tone', () => {
  const out = html(m.Banner, { tone: 'warning', title: '还没有配置模型', action: { label: '去设置', onClick() {} }, onDismiss() {} }, '生成题目需要一个可用的模型。');
  assert.match(out, /sh-banner--warning/);
  assert.match(out, /还没有配置模型/);
  assert.match(out, /生成题目需要一个可用的模型/);
  assert.match(out, /去设置/);
  assert.match(out, /aria-label="关闭提示"/);
});

test('ActionFeedback keeps its props and renders notices as viewport toasts', () => {
  m.setUiLanguage('zh');
  const out = html(m.ActionFeedback, { error: '保存失败', notice: { text: '已斩这道题', action: { label: '撤销', run() {} } }, busy: true, onCloseError() {}, onCloseNotice() {} });
  assert.match(out, /sh-toasts/);
  assert.match(out, /role="alert"[^>]*>.*保存失败/s);
  assert.match(out, /role="status"[^>]*>.*已斩这道题/s);
  assert.match(out, /<button[^>]*disabled=""[^>]*>撤销<\/button>/, 'a busy app disables the action');
  assert.match(out, /aria-label="关闭错误"/);
  assert.match(out, /aria-label="关闭提示"/);
  assert.match(html(m.ActionFeedback, { notice: '题组顺序已保存' }), /题组顺序已保存/);
  assert.match(html(m.ActionFeedback, { notice: { text: '已保存', tone: 'success' } }), /sh-toast--success/);
  const empty = html(m.ActionFeedback, {});
  assert.match(empty, /sh-toasts/, 'the live regions exist before the first message');
  assert.doesNotMatch(empty, /sh-toast /);
});

test('notices belong to the page where they first appeared', () => {
  const library = m.reviewNoticeScope('/lib', 'library', null);
  const sources = m.reviewNoticeScope('/lib', 'sources', null);
  assert.equal(m.pageOfScope(library), m.pageOfScope(m.reviewNoticeScope('/lib', 'library', { id: 'r1' })));
  assert.notEqual(m.pageOfScope(library), m.pageOfScope(sources));
  assert.notEqual(m.pageOfScope(library), m.pageOfScope(m.reviewNoticeScope('/other', 'library', null)));
  const fresh = { id: 1, value: '已保存' };
  assert.equal(m.noticeVisible(fresh, sources), true, 'an unbound notice shows on the page that renders it first');
  const bound = m.bindNotice(fresh, library);
  assert.notEqual(bound, fresh);
  assert.equal(bound.page, m.pageOfScope(library));
  assert.equal(m.noticeVisible(bound, library), true);
  assert.equal(m.noticeVisible(bound, m.reviewNoticeScope('/lib', 'library', { id: 'r2' })), true);
  assert.equal(m.noticeVisible(bound, sources), false, 'it does not leak to the next page');
  const scoped = m.bindNotice({ id: 2, value: { text: '已斩', scope: m.reviewNoticeScope('/lib', 'review', { id: 'r', card: { id: 'c' } }) } }, library);
  assert.equal(m.noticeVisible(scoped, m.reviewNoticeScope('/lib', 'review', { id: 'r', card: { id: 'c' } })), true);
  assert.equal(m.noticeVisible(scoped, m.reviewNoticeScope('/lib', 'review', { id: 'r', card: { id: 'd' } })), false);
  assert.equal(m.bindNotice(bound, sources), bound, 'binding happens once');
});

test('English feedback chrome contains no Chinese', () => {
  m.setUiLanguage('en');
  const out = html(m.ActionFeedback, { error: 'Failed', notice: { text: 'Saved', action: { label: 'Undo', run() {} } } })
    + html(m.Banner, { tone: 'info', title: 'T', onDismiss() {} }, 'Body')
    + html(m.Toast, { tone: 'warning', onDismiss() {} }, 'Careful');
  assert.doesNotMatch(out, han);
  m.setUiLanguage('zh');
});
