import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 2, WP-M: the materials dialogs sit on the shared Dialog / ConfirmDialog (#67 #68 #72 #85).
const read = file => readFileSync(file, 'utf8');
const lacks = (file, ...patterns) => { const text = read(file); for (const pattern of patterns) assert.doesNotMatch(text, pattern, `${file} still has ${pattern}`); };
const has = (file, ...patterns) => { const text = read(file); for (const pattern of patterns) assert.match(text, pattern, `${file} lacks ${pattern}`); };
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { MergeDeckDialog } from './ui/Manage.jsx';
  export { default as ExtensionPanel } from './ui/ExtensionPanel.jsx';
  export { OriginalDialog } from './ui/document-preview/OriginalFile.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const html = (type, props = {}, ...children) => renderToStaticMarkup(h(type, props, ...children));

test('merging a deck asks in the app, not with window.confirm (#67)', () => {
  m.setUiLanguage('zh');
  const out = html(m.MergeDeckDialog, { deck: { title: '设计模式', cards: [{}, {}, {}] }, target: { title: '软件工程' }, onConfirm() {}, onClose() {} });
  assert.match(out, /<dialog/);
  assert.match(out, /软件工程/);
  assert.match(out, /3 道题/);
  assert.match(out, /来源题组会移除/);
  assert.ok(out.indexOf('取消') < out.lastIndexOf('合并'), 'cancel before confirm');
  assert.match(out, /sh-btn--danger/);
  lacks('ui/Manage.jsx', /window\.confirm|\bconfirm\(/);
  has('ui/Manage.jsx', /ConfirmDialog/);
});

test('the search extension asks and uninstalls through the shared dialogs (#68 #72)', () => {
  has('ui/ExtensionPanel.jsx', /ConfirmDialog/);
  lacks('ui/ExtensionPanel.jsx', /<Dialog\b/, /if \(!busy\) close\(\)/);
  const out = html(m.ExtensionPanel, { call: async () => ({}), status: { extension: { canInstall: true, installed: false }, companion: {} }, initialApproval: ['sharp'] });
  assert.match(out, /允许安装组件的脚本/);
  assert.match(out, /<code>sharp<\/code>/);
});

test('every busy dialog says so once, through Dialog (#72)', () => {
  has('ui/Sources.jsx', /<Dialog[^>]*\bbusy=\{busy\}/);
  lacks('ui/Sources.jsx', /if \(!busy\) onClose\(\)/);
  has('ui/document-preview/reader/SegmentDialog.jsx', /<Dialog[^>]*\bbusy=\{busy\}/);
  lacks('ui/document-preview/reader/SegmentDialog.jsx', /if \(!busy\) onClose\(\)/);
  has('ui/document-preview/OriginalFile.jsx', /<Dialog[^>]*\bbusy=\{phase === 'attaching'\}/);
  lacks('ui/document-preview/OriginalFile.jsx', /if \(phase !== 'attaching'\) onClose/);
  const attaching = html(m.OriginalDialog, { target: { sourceId: 's', title: 'Book', format: 'pdf' }, call() {}, onClose() {}, onChanged() {}, initial: { phase: 'attaching' } });
  assert.match(attaching.match(/<dialog[^>]*>/)[0], /aria-busy="true"/);
  const idle = html(m.OriginalDialog, { target: { sourceId: 's', title: 'Book', format: 'pdf' }, call() {}, onClose() {}, onChanged() {} });
  assert.doesNotMatch(idle.match(/<dialog[^>]*>/)[0], /aria-busy/);
});

test('one drop guard: the dialogs that hold a FileDrop ask Dialog for it (#85)', () => {
  has('ui/document-preview/OriginalFile.jsx', /<Dialog[^>]*\bguardDrops\b/);
  has('ui/app/modals/AddSourceDialog.jsx', /<Dialog[^>]*\bguardDrops\b/);
  lacks('ui/ImportHub.jsx', /createDialogDropGuard/, /closest\('dialog'\)/, /closest\("dialog"\)/);
});
