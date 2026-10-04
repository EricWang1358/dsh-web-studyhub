import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

// UI wave 2 · WP-F (#91 #90): one toast context, one feedback region, and Board's undo goes through it.
const m = await loadUi(`export { ToastContext, useToast, createToastApi, shouldAutoDismiss } from './ui/components/index.js'; export * from './ui/components/Feedback.jsx';
  export { noticeToToast, errorToToast } from './ui/ActionFeedback.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
const read = async (path) => (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');

test('useToast without a provider is silent, so a component can render alone (tests, previews)', () => {
  let api;
  const Probe = () => { api = m.useToast(); return null; };
  renderToStaticMarkup(React.createElement(Probe));
  for (const name of ['show', 'success', 'info', 'warning', 'error', 'dismiss']) assert.equal(typeof api[name], 'function', name);
  assert.doesNotThrow(() => { api.show({ message: 'x' }); api.success('x'); api.error(new Error('x')); api.dismiss(); });
});

test('the context hands the provider\'s api to every consumer', () => {
  const api = { marker: true };
  let seen;
  const Probe = () => { seen = m.useToast(); return null; };
  renderToStaticMarkup(React.createElement(m.ToastContext.Provider, { value: api }, React.createElement(Probe)));
  assert.equal(seen, api);
});

const recorder = () => {
  const log = [];
  return { log, api: m.createToastApi({ setNotice: (value) => log.push(['notice', value]), setError: (value) => log.push(['error', value]) }) };
};

test('success, info and warning are notices with their tone', () => {
  const { log, api } = recorder();
  api.success('已保存'); api.info('提示'); api.warning('注意', { persistent: true });
  assert.deepEqual(log, [
    ['notice', { text: '已保存', tone: 'success' }],
    ['notice', { text: '提示', tone: 'info' }],
    ['notice', { text: '注意', tone: 'warning', persistent: true }],
  ]);
});

test('show carries action, undo, timeout and scope through to the notice protocol', () => {
  const { log, api } = recorder();
  const undo = () => {};
  api.show({ tone: 'success', message: '已删除', action: { label: '撤销', onClick: undo }, undo: true, timeout: 8000, scope: 's' });
  assert.deepEqual(log[0], ['notice', { text: '已删除', tone: 'success', undo: true, timeout: 8000, scope: 's', action: { label: '撤销', run: undo } }]);
  api.show({ message: 'plain' });
  assert.deepEqual(log[1], ['notice', { text: 'plain', tone: 'info' }], 'no empty fields');
  api.dismiss();
  assert.deepEqual(log[2], ['notice', '']);
});

test('error reads the message of whatever was thrown and offers a retry', () => {
  const { log, api } = recorder();
  api.error(new Error('磁盘已满'));
  api.error('plain text');
  const retry = () => {};
  api.error({ message: 'nope' }, { retry });
  assert.deepEqual(log[0], ['error', { text: '磁盘已满' }]);
  assert.deepEqual(log[1], ['error', { text: 'plain text' }]);
  assert.deepEqual(log[2], ['error', { text: 'nope', action: { label: '重试', run: retry } }]);
  api.error(undefined);
  assert.equal(log[3][1].text, '出了点问题，请重试。');
});

test('the region shows an undo notice as a toast that may leave by itself but is held while hovered', () => {
  const toast = m.noticeToToast({ text: '已删除', tone: 'success', undo: true, timeout: 8000, action: { label: '撤销', run() {} }, key: 7 }, false);
  assert.equal(toast.undo, true);
  assert.equal(toast.timeout, 8000);
  assert.equal(m.shouldAutoDismiss(toast), true, 'an undo offer expires, like Board\'s eight seconds');
  assert.equal(toast.action.label, '撤销');
  assert.equal(m.shouldAutoDismiss(m.noticeToToast({ text: 'x', tone: 'success', action: { label: 'go', run() {} } }, false)), false, 'any other action toast stays');
  assert.equal(m.noticeToToast({ text: 'x', action: { label: 'a', run() {} } }, true).action.disabled, true, 'busy disables the action');
  assert.equal(m.errorToToast({ text: 'bad' }, false).tone, 'error');
});

test('Board no longer owns a toast region or a timer: its undo goes through the shared toast', async () => {
  const board = await read('ui/Board.jsx');
  assert.doesNotMatch(board, /ToastRegion/, 'no second page-level toast stack');
  assert.doesNotMatch(board, /setTimeout\(/);
  assert.doesNotMatch(board, /const \[toast, setToast\]/);
  assert.match(board, /useToast\(\)/);
});

test('App renders the single feedback region and offers the toast api to every page', async () => {
  const app = await read('ui/App.jsx');
  assert.equal((app.match(/<ActionFeedback\b/g) || []).length, 1, 'one ActionFeedback in App.jsx');
  assert.match(app, /ToastContext\.Provider/);
});
