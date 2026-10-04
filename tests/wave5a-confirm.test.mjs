import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 5A, #68: the permanent-delete dialog (资料 and 题组) is a thin wrapper over ConfirmDialog, so no confirmation is a hand-written footer.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as RemoveDeckDialog } from './ui/RemoveDeckDialog.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { RemoveDeckDialog, setUiLanguage } = module.exports;
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('PermanentDeleteDialog renders a ConfirmDialog and owns no footer of its own', () => {
  const source = read('ui/components/PermanentDeleteDialog.jsx');
  assert.match(source, /ConfirmDialog/);
  assert.doesNotMatch(source, /footer=|from '\.\/Dialog\.jsx'|from '\.\/Button\.jsx'/);
});

test('the deck removal dialog keeps its look: quiet cancel first, a danger confirm, the title and the reasons', () => {
  setUiLanguage('zh');
  const out = renderToStaticMarkup(React.createElement(RemoveDeckDialog, { deck: { id: 'd', title: '操作系统', count: 12, archived: true }, busy: false, act() {}, onClose() {}, onRemoved() {} }));
  const footer = out.match(/<footer[^>]*>(.*)<\/footer>/s)[1];
  const buttons = [...footer.matchAll(/<button[^>]*>/g)].map(match => match[0]);
  assert.equal(buttons.length, 2);
  assert.match(buttons[0], /sh-btn--quiet/);
  assert.match(buttons[1], /sh-btn--danger/);
  assert.ok(footer.indexOf('取消') < footer.indexOf('确认永久删除'));
  assert.match(out, /永久删除「操作系统」？/);
  assert.match(out, /12 道题/);
  const blocked = renderToStaticMarkup(React.createElement(RemoveDeckDialog, { deck: { id: 'd', title: '操作系统', count: 12, archived: false }, busy: false, act() {}, onClose() {}, onRemoved() {} }));
  assert.match(blocked, /请先归档题组/);
  assert.match(blocked.match(/<footer[^>]*>(.*)<\/footer>/s)[1].match(/<button[^>]*sh-btn--danger[^>]*>/)[0], /disabled=""/);
});

test('no dialog outside ConfirmDialog builds its own danger or confirm footer', () => {
  const walk = dir => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : entry.name.endsWith('.jsx') ? [`${dir}/${entry.name}`] : []);
  const offenders = walk('ui').filter(file => file !== 'ui/components/ConfirmDialog.jsx' && /<Dialog[\s\S]*?footer=\{<>[\s\S]*?variant="danger"/.test(read(file)));
  assert.deepEqual(offenders, []);
});
