import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { groupPrompt } from '../ui/topic-group-prompt.js';

const require = createRequire(import.meta.url);
const { parse } = createRequire(require.resolve('eslint/package.json'))('espree');
const han = /[\u3400-\u9fff]/;
const compiled = await build({ stdin: { contents: `export * from './ui/i18n.js'; export { boardColumnLabel } from './ui/Board.jsx'; export { default as DocumentImport } from './ui/document-preview/DocumentImport.jsx'; export { default as DocumentLearning, PassageLinks } from './ui/document-preview/DocumentLearning.jsx';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' } });
test('English topic-group handoffs retain API names and preserve existing questions', () => {
  for (const mode of ['merge', 'replace']) {
    const text = groupPrompt({ mode, ungrouped: 12, topicCount: 36 }, 'en');
    assert.doesNotMatch(text, han);
    assert.match(text, /skeleton.topics/);
    assert.match(text, /topic.groups.save/);
    assert.match(text, /Do not modify the questions/);
  }
  assert.match(groupPrompt({ mode: 'merge', ungrouped: 12 }), /不要修改题目本身/);
});
function load() {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}

test('built-in board columns use English without translating custom column titles', () => {
  const { boardColumnLabel, setUiLanguage } = load();
  setUiLanguage('en');
  for (const [id, title] of [['todo', '待办'], ['doing', '进行中'], ['done', '已完成']]) {
    const column = { id, title };
    assert.doesNotMatch(boardColumnLabel(column), han);
    assert.equal(column.title, title);
  }
  assert.equal(boardColumnLabel({ id: 'custom', title: '待办' }), '待办');
  assert.equal(boardColumnLabel({ id: 'todo', title: '我的计划' }), '我的计划');
  setUiLanguage('zh');
  assert.equal(boardColumnLabel({ id: 'todo', title: '待办' }), '待办');
});

test('first-time browser language chooses English while an explicit Chinese preference survives', () => {
  const keys = ['window', 'navigator', 'localStorage'];
  const original = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {} } });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['en-GB'], language: 'en-GB' } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } });
    assert.equal(load().getUiLanguage(), 'en');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'zh', setItem() {} } });
    assert.equal(load().getUiLanguage(), 'zh');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => { throw new Error('blocked storage'); } } });
    assert.equal(load().getUiLanguage(), 'en');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['zh-Hant'], language: 'zh-Hant' } });
    assert.equal(load().getUiLanguage(), 'zh');
  } finally {
    keys.forEach((key, index) => original[index] ? Object.defineProperty(globalThis, key, original[index]) : delete globalThis[key]);
  }
});

test('English document import and passage learning localize UI while retaining original citations', () => {
  const { setUiLanguage, DocumentImport, DocumentLearning, PassageLinks } = load();
  setUiLanguage('en');
  const html = renderToStaticMarkup(React.createElement(DocumentImport, { act() {} }));
  assert.doesNotMatch(html, han);
  assert.match(html, /PDF, Markdown, HTML/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(DocumentLearning, { call() {}, document: {} })), han);
  const original = '原文引用保持中文';
  const links = renderToStaticMarkup(React.createElement(PassageLinks, { onOpenCard() {}, groups: [{ selection: { quote: original }, links: [{ deckId: 'd', cardId: 'c', prompt: 'Question', status: 'stale' }] }] }));
  assert.ok(links.includes(original));
  assert.match(links, /Open question and explanation/);
  assert.doesNotMatch(links.replace(original, ''), han);
  setUiLanguage('zh');
  assert.match(renderToStaticMarkup(React.createElement(DocumentImport, { act() {} })), /导入资料原文件/);
});

async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== 'locales') result.push(...await files(path));
    else if (/\.(jsx|js)$/.test(entry.name)) result.push(path);
  }
  return result;
}
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(item => walk(item, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
test('every static application UI translation has an English catalogue entry', async () => {
  const { ui, setUiLanguage } = load();
  setUiLanguage('en');
  const missing = [];
  for (const file of await files('ui')) {
    const tree = parse(await readFile(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } });
    walk(tree, node => {
      if (node.type !== 'CallExpression' || !['ui', 'uiFormat'].includes(node.callee.name)) return;
      const text = node.arguments[0]?.value;
      if (typeof text === 'string' && han.test(text) && han.test(ui(text))) missing.push(`${file}: ${text}`);
    });
  }
  assert.deepEqual(missing, []);
});
