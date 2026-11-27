import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* 创建题组, the submit area (#1082): the DOM is in the order it is seen, so Tab reaches the one button before anything the run's facts hold (the estimate's ⓘ).
   No CSS `order` puts it back together. The bar holds the count and the tokens, as two lines that are there with nothing ticked too (saying what to do), so the
   button never moves; the rest of the plan (coverage, rounds, calls, the ⓘ) is under it, each fact once. The words of 额外要求 and of the line under the button are a student's (zh and en). The reach on screen is in
   tests/generate-reach-browser.test.mjs. */

const m = await loadUi(`
  export { default as Generate } from './ui/Generate.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { setUiLanguage, ui, uiFormat } from './ui/i18n.js';`);
const noop = () => {};
const sources = [
  { id: 'a', title: '索引笔记', text: '数据库索引加快查找。'.repeat(20), courses: ['数据库'], usedBy: [] },
  { id: 'b', title: '事务笔记.md', text: '事务保证一致性。'.repeat(20), courses: ['数据库'], usedBy: [], document: { id: 'md', format: 'markdown' } },
];
const gen = { kind: 'quiz', kinds: ['quiz'], count: 10, difficulty: 'mixed', language: '中文', focus: '', role: '', coverageLevel: 'standard', customCount: '', notation: 'auto' };
function render(patch = {}, props = {}, services = null) {
  const data = { root: 'lib', decks: [], drafts: [], jobs: [], sources, modelReady: true, focus: { course: '数据库', courses: [{ name: '数据库' }] }, ...patch };
  const el = React.createElement(m.Generate, { data, busy: false, running: false, act: noop, call: noop, openDraft: noop, setPage: noop, setNotice: noop,
    genSource: 'files', setGenSource: noop, gen, setGen: noop, selectedSources: ['a', 'b'], setSelectedSources: noop, setModal: noop, askInChat: noop, openModelSettings: noop, ...props });
  if (!services) return renderToStaticMarkup(el);
  return renderToStaticMarkup(
    React.createElement(m.AppContext.Provider, { value: { data } },
      React.createElement(m.StudyServicesContext.Provider, { value: services }, el)),
  );
}

test('the submit area is in the order it is seen: the count and the tokens, the button, then the rest of the plan, then the note about the checks', () => {
  const html = render();
  const submit = html.slice(html.indexOf('data-tour="generate-summary"'));
  const at = needle => submit.indexOf(needle);
  const bar = submit.slice(0, at('data-generate-run'));
  assert.ok(at('class="generate-summary"') >= 0, 'the count line is there');
  assert.ok(at('data-tour="generate-submit"') > 0, 'the button is there');
  assert.ok(at('data-generate-estimate') > 0 && at('data-generate-coverage') > 0, 'the tokens and the plan are there (sources ticked, nothing blocked)');
  assert.ok(bar.includes('data-generate-estimate'), 'the tokens are in the bar, where the tour step about the cost lights them');
  assert.ok(at('class="generate-summary"') < at('data-generate-estimate') && at('data-generate-estimate') < at('data-tour="generate-submit"'), 'the count, then the tokens, then the button');
  assert.ok(at('data-tour="generate-submit"') < at('data-generate-coverage'), 'the button comes before the plan (and its ⓘ), so Tab reaches it first');
  assert.ok(at('data-generate-coverage') < at('generate-quality'), 'the note about the checks comes last');
});

test('with nothing ticked the bar still has its two lines, the first saying what to do and the second holding its place with no filler, so ticking the first material moves nothing', () => {
  for (const lang of ['zh', 'en']) {
    m.setUiLanguage(lang);
    const html = render({}, { selectedSources: [] });
    const bar = html.slice(html.indexOf('data-tour="generate-summary"'), html.indexOf('data-generate-run'));
    const lines = /<div class="generate-submit__lines">([\s\S]*?)<button/.exec(bar)?.[1] || '';
    assert.match(lines, /role="status"[^>]*>[^<]+</, `${lang}: the first line says what to do`);
    assert.match(lines, /data-generate-estimate[^>]*><\/div>/, `${lang}: the second line is there, empty: no sentence about where the tokens will be (#1082)`);
    assert.ok(bar.indexOf('generate-submit__lines') < bar.indexOf('data-tour="generate-submit"'), `${lang}: the lines come before the button, as when something is ticked`);
  }
  m.setUiLanguage('zh');
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

test('one focus topic is one in English: 「1 focus topic」, never 「1 focus topics」; many stay plural (#1082)', () => {
  m.setUiLanguage('en');
  try {
    for (const [count, said] of [[1, /has 1 focus topic:/], [3, /has 3 focus topics:/]]) {
      const html = render({ courses: [{ name: '数据库', focusTopics: Array.from({ length: count }, (_, at) => `topic ${at}`) }] });
      const text = html.replace(/<[^>]+>/g, ' ');
      assert.doesNotMatch(text, / 1 focus topics/, `${count}: no 「1 focus topics」`);
      assert.match(text, said, `${count}: the line under 想练什么 says the count in the right number`);
    }
  } finally { m.setUiLanguage('zh'); }
});

test('the page draws its list and its form at once, as on main: nothing waits for the index answer (#1084, round 4)', async () => {
  const coverage = await loadUi(`export * from './ui/use-index-coverage.js';`);
  assert.deepEqual(Object.keys(coverage).filter(name => /wait/i.test(name)), [], 'and no wait left to call');

  const pendingServices = {
    call: () => new Promise(() => {}),
    act: async () => undefined,
    busy: false,
    notify: noop,
    askInChat: noop,
    host: {},
    openSettings: noop,
    navigate: noop,
    openModal: noop,
  };
  try {
    for (const lang of ['zh', 'en']) {
      m.setUiLanguage(lang);
      const html = render({}, {}, pendingServices);
      const sourcesAt = html.indexOf('data-tour="generate-sources"');
      const optionsAt = html.indexOf('data-tour="generate-options"');
      const summaryAt = html.indexOf('data-tour="generate-summary"');
      const submitAt = html.indexOf('data-tour="generate-submit"');
      assert.ok(sourcesAt >= 0, `${lang}: source list renders synchronously while index coverage is pending`);
      assert.ok(optionsAt > sourcesAt, `${lang}: options form follows source list in DOM order`);
      assert.ok(summaryAt > optionsAt, `${lang}: summary bar follows options form in DOM order`);
      assert.ok(submitAt > summaryAt, `${lang}: submit button follows summary bar in DOM order`);
      assert.ok(html.includes('索引笔记') && html.includes('事务笔记.md'), `${lang}: material rows are drawn on first paint`);
      assert.doesNotMatch(html, /sh-loading|aria-busy="true"|class="[^"]*holding/i, `${lang}: no loading or holding gate blocks first paint`);
    }
  } finally {
    m.setUiLanguage('zh');
  }
});

test('更多选项 says the choices that are not the defaults while it is shut: the difficulty and the language a run will use are seen (#1082)', () => {
  const summaryOf = html => /<details class="sh-disclosure[^"]*generate-more"[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>/.exec(html)?.[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
  const plain = summaryOf(render());
  assert.doesNotMatch(plain, /深入辨析|English/, `defaults: the summary says what is inside (${plain})`);
  const chosen = summaryOf(render({}, { gen: { ...gen, difficulty: 'advanced', language: 'English' } }));
  assert.match(chosen, /深入辨析/, `the difficulty is named (${chosen})`);
  assert.match(chosen, /English/, `the language is named (${chosen})`);
  const bar = render({}, { gen: { ...gen, difficulty: 'advanced', language: 'English' } });
  const count = /class="generate-summary"[^>]*>([\s\S]*?)<\/p>/.exec(bar)?.[1].replace(/<[^>]+>/g, '') || '';
  assert.doesNotMatch(count, /深入辨析|English/, `the count line stays short: questions, materials, pages (${count})`);
});
