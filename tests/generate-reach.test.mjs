import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* 创建题组, the submit area (#1082): the DOM is in the order it is seen, so Tab reaches the one button before anything the run's facts hold (the estimate's ⓘ).
   No CSS `order` puts it back together. The words of 额外要求 and of the line under the button are a student's (zh and en). The reach on screen is in
   tests/generate-reach-browser.test.mjs. */

const m = await loadUi(`
  export { default as Generate } from './ui/Generate.jsx';
  export { setUiLanguage, ui, uiFormat } from './ui/i18n.js';`);
const noop = () => {};
const sources = [
  { id: 'a', title: '索引笔记', text: '数据库索引加快查找。'.repeat(20), courses: ['数据库'], usedBy: [] },
  { id: 'b', title: '事务笔记.md', text: '事务保证一致性。'.repeat(20), courses: ['数据库'], usedBy: [], document: { id: 'md', format: 'markdown' } },
];
const gen = { kind: 'quiz', kinds: ['quiz'], count: 10, difficulty: 'mixed', language: '中文', focus: '', role: '', coverageLevel: 'standard', customCount: '', notation: 'auto' };
function render(patch = {}, props = {}) {
  const data = { root: 'lib', decks: [], drafts: [], jobs: [], sources, modelReady: true, focus: { course: '数据库', courses: [{ name: '数据库' }] }, ...patch };
  return renderToStaticMarkup(React.createElement(m.Generate, { data, busy: false, running: false, act: noop, call: noop, openDraft: noop, setPage: noop, setNotice: noop,
    genSource: 'files', setGenSource: noop, gen, setGen: noop, selectedSources: ['a', 'b'], setSelectedSources: noop, setModal: noop, askInChat: noop, openModelSettings: noop, ...props }));
}

test('the submit area is in the order it is seen: the count, then the button, then what the run asks for and costs, then the note about the checks', () => {
  const html = render();
  const submit = html.slice(html.indexOf('data-tour="generate-summary"'));
  const at = needle => submit.indexOf(needle);
  assert.ok(at('class="generate-summary"') >= 0, 'the count line is there');
  assert.ok(at('data-tour="generate-submit"') > 0, 'the button is there');
  assert.ok(at('data-generate-estimate') > 0, 'the estimate is there (sources ticked, nothing blocked)');
  assert.ok(at('class="generate-summary"') < at('data-tour="generate-submit"'), 'the count comes before the button');
  assert.ok(at('data-tour="generate-submit"') < at('data-generate-estimate'), 'the button comes before the estimate (and its ⓘ), so Tab reaches it first');
  assert.ok(at('data-generate-estimate') < at('generate-quality'), 'the note about the checks comes last');
});

test('no CSS `order` rearranges 创建题组: what is seen is the DOM, so the Tab order is the reading order', async () => {
  const css = await readFile(new URL('../ui/generate-home.css', import.meta.url), 'utf8');
  assert.deepEqual(css.match(/(?<![-\w])order\s*:[^;]+/g) || [], [], 'no order rules in ui/generate-home.css');
});

test('额外要求 names its own field for what it is: not 「名称（可选）」 beside 题组名称（可选）', () => {
  const html = render();
  const label = /<label[^>]*for="generate-module-template"[^>]*>(.*?)<\/label>/.exec(html);
  assert.ok(label, 'the field of the requirements\' name has a label');
  const words = label[1].replace(/<[^>]+>/g, '');
  assert.notEqual(words, '名称（可选）', 'not a bare 名称, which reads like a second deck name');
  assert.match(words, /要求/, `the label says it names the requirements: ${words}`);
  m.setUiLanguage('en');
  try {
    const en = /<label[^>]*for="generate-module-template"[^>]*>(.*?)<\/label>/.exec(render())[1].replace(/<[^>]+>/g, '');
    assert.notEqual(en, 'Name (optional)');
    assert.match(en, /requirement/i, `and so does the English: ${en}`);
  } finally { m.setUiLanguage('zh'); }
});

test('the line under the button reads right for one focus topic and for many, in English', () => {
  m.setUiLanguage('en');
  try {
    for (const n of [1, 3]) {
      const said = m.uiFormat('课程重点继承 {0} 项', [n]);
      assert.doesNotMatch(said, /\(s\)/, `no "(s)": ${said}`);
      assert.ok(said.includes(String(n)), `the number is said: ${said}`);
      assert.doesNotMatch(said, /[一-鿿]/, `English: ${said}`);
    }
  } finally { m.setUiLanguage('zh'); }
});
