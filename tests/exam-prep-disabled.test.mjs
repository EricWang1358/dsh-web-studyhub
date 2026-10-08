import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';
import { readFile } from 'node:fs/promises';

/* 备考补习 while the host's switch is off (a task card or a stale link can still land on it): its own off state, not the generic "enable the component". */

const compiled = await build({ stdin: { contents: `export { DisabledPage } from './ui/app/page-views.jsx'; export { AppContext } from './ui/app/app-context.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
const { DisabledPage, AppContext, setUiLanguage } = loaded.exports;

function render(page, { features, host = {}, contexts } = {}) {
  const calls = { settings: [], navigate: [], plugins: 0 };
  const app = { data: { root: 'r', features, ...(contexts ? { contexts } : {}) }, nav: { navigate: (...args) => calls.navigate.push(args) },
    host: { ...host, ...(host.openPluginManager ? { openPluginManager: () => { calls.plugins += 1; } } : {}) },
    settingsEntry: { openSettings: section => calls.settings.push(section) } };
  const html = renderToStaticMarkup(React.createElement(AppContext.Provider, { value: app }, React.createElement(DisabledPage, { page })));
  // The same view called as a function, with the fake app answering the context, to reach the buttons' handlers.
  const hooks = { ...React, useContext: () => app };
  const tree = callWith(hooks, () => { const root = DisabledPage({ page }); return typeof root.type === 'function' ? root.type(root.props) : root; });
  return { html, tree, calls };
}
const callWith = (hooks, run) => { const original = React.useContext; React.useContext = hooks.useContext; try { return run(); } finally { React.useContext = original; } };
function findAll(tree, predicate, found = []) {
  if (Array.isArray(tree)) tree.forEach(item => findAll(item, predicate, found));
  else if (React.isValidElement(tree)) { if (predicate(tree)) found.push(tree); findAll(tree.props.children, predicate, found); findAll(tree.props.actions, predicate, found); }
  return found;
}
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

test('with the switch off, 备考补习 says so in its own words and does not blame a missing component', () => {
  const { html } = render('examprep', { features: { examBlueprint: false } });
  const words = text(html);
  assert.match(words, /备考补习还没有开启/);
  assert.match(words, /由 DSH 开启/);
  assert.match(words, /已保存的考点清单仍可阅读/);
  assert.doesNotMatch(words, /启用所需组件|此功能已停用/);
  assert.doesNotMatch(words, /蓝图|blueprint/i);
  assert.match(html, /role="status"/);
});

test('前往设置 opens the exam-prep section; 打开 DSH 插件管理器 appears only when the host has one', () => {
  const without = render('examprep', { features: {} });
  assert.match(text(without.html), /前往设置/);
  assert.doesNotMatch(text(without.html), /插件管理器/);
  const withHost = render('examprep', { features: { examBlueprint: false }, host: { openPluginManager: true } });
  assert.match(text(withHost.html), /打开 DSH 插件管理器/);
  const buttons = findAll(withHost.tree, node => typeof node.props.onClick === 'function');
  assert.equal(buttons.length, 2);
  buttons.find(node => node.props.children === '前往设置').props.onClick();
  buttons.find(node => node.props.children === '打开 DSH 插件管理器').props.onClick();
  assert.deepEqual(withHost.calls.settings, ['settings-exam-prep']);
  assert.equal(withHost.calls.plugins, 1);
});

test('the off state is in English too, with no Chinese left over', () => {
  try {
    setUiLanguage('en');
    const { html } = render('examprep', { features: {}, host: { openPluginManager: true } });
    const words = text(html);
    assert.match(words, /Exam prep is not turned on yet/);
    assert.match(words, /Go to settings/);
    assert.match(words, /Open the DSH plugin manager/);
    assert.doesNotMatch(words, /[㐀-鿿]/);
  } finally { setUiLanguage('zh'); }
});

test('every other page keeps the generic message, and so does 备考补习 when the switch is on but a component is missing', () => {
  for (const [page, features] of [['sources', {}], ['review', { examBlueprint: false }], ['examprep', { examBlueprint: true }]]) {
    const { html, tree, calls } = render(page, { features, host: { openPluginManager: true } });
    assert.match(text(html), /此功能已停用/, page);
    assert.match(text(html), /启用所需组件/, page);
    assert.doesNotMatch(text(html), /备考补习还没有开启/, page);
    findAll(tree, node => typeof node.props.onClick === 'function').forEach(node => node.props.onClick());
    assert.deepEqual(calls.settings, [], page);
    assert.equal(calls.navigate.length, 1, page);
  }
});

test('the app hands the page to DisabledPage', async () => {
  const source = await readFile(new URL('../ui/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /<DisabledPage page=\{page\} \/>/);
});
