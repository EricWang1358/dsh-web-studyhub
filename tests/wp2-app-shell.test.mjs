import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readAppSource } from './helpers/app-source.mjs';

const compiled = await build({ stdin: { contents: "export { LibraryChip, libraryFolderName } from './ui/App.jsx'; export { setUiLanguage } from './ui/i18n.js';",
  resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { LibraryChip, libraryFolderName, setUiLanguage } = module.exports;

test('the library location reads as the folder a learner recognises', () => {
  assert.equal(libraryFolderName('C:\\Users\\me\\Documents\\deepseek-harness\\default-workspace\\.dsh-study'), 'default-workspace');
  assert.equal(libraryFolderName('/home/me/CS1010 Course/.dsh-study'), 'CS1010 Course');
  assert.equal(libraryFolderName('D:\\notes\\library'), 'library');
  assert.equal(libraryFolderName('/srv/study/'), 'study');
  assert.equal(libraryFolderName('C:\\'), 'C:');
});

test('the top-bar chip names the library, shows the full path and opens Settings', () => {
  const root = 'C:\\Users\\me\\Documents\\CS1010\\.dsh-study';
  const html = renderToStaticMarkup(React.createElement(LibraryChip, { root, onOpen() {} }));
  assert.match(html, /^<button type="button" class="[^"]*\blibrary-location\b/);
  assert.ok(html.includes(`title="${root}"`), 'the tooltip is the full path');
  assert.match(html, /学习库：CS1010/);
  let opened = 0;
  LibraryChip({ root, onOpen: () => opened++ }).props.onClick();
  assert.equal(opened, 1);
  assert.equal(renderToStaticMarkup(React.createElement(LibraryChip, { root: '', onOpen() {} })), '', 'nothing before the library resolves');
  setUiLanguage('en');
  try {
    const english = renderToStaticMarkup(React.createElement(LibraryChip, { root, onOpen() {} }));
    assert.match(english, /Library: CS1010/);
    assert.doesNotMatch(english, /[\u3400-\u9fff]/);
  } finally { setUiLanguage('zh'); }
});

test('the app shell names the product StudyHub', async () => {
  const source = await readAppSource();
  assert.doesNotMatch(source, /Daily Flashcard/);
  assert.match(source, /className="brand"[\s\S]{0,400}\{ui\(['"]StudyHub['"]\)\}<small>/);
  assert.match(source, /<span className="crumb">\{ui\(['"]StudyHub['"]\)\}<\/span>/);
  // The chip lands on the folder control (学习库与模型), not on whichever Settings category was used last.
  assert.match(source, /<LibraryChip root=\{binding\.root\} onOpen=\{\(\) => \{ settingsEntry\.setSettingsFocus\('settings-model'\); nav\.navigate\('settings', \{ animate: true, keepTrail: false \}\); \}\} \/>/);
});
