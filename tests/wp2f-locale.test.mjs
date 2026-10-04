import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { loadUi } from './helpers/ui-module.mjs';

// UI wave 2 · WP-F: every sentence the files this work package touched put through ui() has an English line, and the
// shell no longer chooses its copy with language ternaries (#123).
const { uiCatalogue } = await loadUi("export { uiCatalogue } from './ui/i18n.js';");
const catalogue = uiCatalogue();
const han = /[㐀-鿿]/;

const walk = async (dir) => (await readdir(dir, { recursive: true })).map((name) => `${dir}/${name}`.replace(/\\/g, '/')).filter((name) => /\.(js|jsx)$/.test(name));
const FILES = [
  'ui/App.jsx', 'ui/Review.jsx', 'ui/ReviewToolbar.jsx', 'ui/ReviewNavigator.jsx', 'ui/ShortcutHelp.jsx', 'ui/ExplanationFollowup.jsx', 'ui/study-context.jsx',
  'ui/components/Feedback.jsx', 'ui/ActionFeedback.jsx', 'ui/quick-actions.js',
  ...await walk('ui/app'), ...await walk('ui/review'),
];
const CALL = /\b(?:ui|uiFormat|uiRich)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const unescape = (text) => text.replace(/\\(n|t|'|"|`|\\)/g, (_, code) => ({ n: '\n', t: '\t' }[code] ?? code));
// Messages chosen by a condition inside the call (uiFormat(cond ? 'a' : 'b', ...)) are listed here.
const CONDITIONAL = ['后台助教正在解答：{0}', '后台助教正在出新题：{0}', '后台助教正在改题：{0}'];
const known = (key) => Object.hasOwn(catalogue, key) || Object.hasOwn(catalogue, key.replace(/\s+/g, ' ').trim());

test('every Chinese sentence the shell, the practice page and their hooks pass through ui() has an English line', async () => {
  const missing = [];
  for (const file of FILES) {
    const source = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
    for (const match of source.matchAll(CALL)) {
      const key = unescape(match[2]);
      if (han.test(key) && !known(key)) missing.push(`${file}: ${JSON.stringify(key)}`);
    }
  }
  for (const key of CONDITIONAL) if (!known(key)) missing.push(`conditional: ${JSON.stringify(key)}`);
  assert.deepEqual(missing, []);
});

test('the copy is not chosen with language ternaries or hard-coded English in the shell (#123)', async () => {
  for (const file of FILES) {
    const source = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
    assert.doesNotMatch(source, /language\s*===\s*['"]en['"]\s*\?/, `${file}: language === 'en' ?`);
    assert.doesNotMatch(source, /getUiLanguage\(\)\s*===\s*['"]en['"]/, `${file}: getUiLanguage() === 'en'`);
    assert.doesNotMatch(source, /YOUR LEARNING SPACE/, `${file}: the English eyebrow is the catalogue's English`);
  }
  assert.equal(catalogue['你的学习空间'], 'YOUR LEARNING SPACE', 'the English still shows the eyebrow as it did');
});

test('the fold labels of a follow-up come from the catalogue, not from CSS content (#160)', async () => {
  const css = await readFile('ui/style.css', 'utf8');
  assert.doesNotMatch(css, /followup-item[^{]*::after\s*\{[^}]*content/);
  assert.equal(catalogue['展开'], 'Expand');
  assert.equal(catalogue['收起'], 'Collapse');
  const source = await readFile('ui/ExplanationFollowup.jsx', 'utf8');
  assert.match(source, /ui\("收起"\)/);
  assert.match(source, /ui\("展开"\)/);
});
