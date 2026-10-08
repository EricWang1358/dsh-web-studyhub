import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* 创建题组, the short main path: sources, one line of what will be made (题型, 覆盖强度, 课程) with 前往设置, and the one button. Every optional control (题型, 覆盖强度, 难度, 语言, 公式写法,
   课程, 想练什么, 名称, 岗位, 参考样题) is inside 更多选项. Static markup here; the opening state, the estimate and the clicks are in tests/generate-short-browser.test.mjs. */

const m = await loadUi(`
  export { default as Generate } from './ui/Generate.jsx';
  export * as form from './ui/generate-form.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const han = /[㐀-鿿]/;
const noop = () => {};
const sources = [
  { id: 'a', title: '索引笔记', text: '数据库索引加快查找。', courses: ['数据库'], usedBy: [] },
  { id: 'b', title: '事务笔记.md', text: '事务保证一致性。', courses: ['数据库'], usedBy: [], document: { id: 'md', format: 'markdown' } },
];
const gen = { kind: 'quiz', kinds: ['quiz'], count: 10, difficulty: 'mixed', language: '中文', focus: '', role: '', coverageLevel: 'standard', customCount: '', notation: 'auto' };
function render(patch = {}, props = {}) {
  const data = { root: 'lib', decks: [], drafts: [], jobs: [], sources, modelReady: true, focus: { course: '数据库', courses: [{ name: '数据库' }] }, ...patch };
  return renderToStaticMarkup(React.createElement(m.Generate, { data, busy: false, running: false, act: noop, call: noop, openDraft: noop, setPage: noop, setNotice: noop,
    genSource: 'files', setGenSource: noop, gen, setGen: noop, selectedSources: ['a'], setSelectedSources: noop, setModal: noop, askInChat: noop, openModelSettings: noop, ...props }));
}
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const FOLD = '<details class="sh-disclosure generate-more';
const parts = html => {
  const options = html.indexOf('data-tour="generate-options"'), fold = html.indexOf(FOLD), submit = html.indexOf('data-tour="generate-summary"');
  assert.ok(options > 0 && fold > options && submit > fold, 'the options, the fold and the submit area come in that order');
  return { main: html.slice(options, fold), fold: html.slice(fold, submit), submit: html.slice(submit) };
};

test('the main path of the options is one line with a link to the settings: no control, no row', () => {
  const { main } = parts(render());
  assert.match(main, /data-generate-plan/);
  assert.match(text(main), /单选测验 · 覆盖强度：标准 · 课程：数据库/, 'the question types, the 覆盖强度 and the course (as the page infers it) in one line');
  assert.match(main, /<button[^>]*data-open-settings="settings-generation"[^>]*>前往设置<\/button>/, 'and the way to the defaults');
  assert.doesNotMatch(main, /<(input|select|textarea)\b/, 'nothing to fill in on the main path');
  assert.doesNotMatch(main, /generate-row|sh-seg|sh-check/, 'no row of controls either');
});

test('every optional control is inside 更多选项, closed unless the form carries values', () => {
  const { fold } = parts(render());
  assert.doesNotMatch(fold.slice(0, 80), /\sopen[\s>=]/, 'the fold is closed with the defaults');
  for (const label of ['题型', '覆盖强度', '难度', '语言', '公式写法', '课程归属', '这次想练什么？', '题组名称（可选）', '目标岗位 / 面试方向（可选）', '参考样题（可选）'])
    assert.ok(text(fold).includes(label), `${label} is in the fold`);
  assert.match(fold, /id="generate-focus"/);
  assert.match(fold, /name="kinds-quiz"|class="generate-kind/, 'the question types');
  assert.match(fold, /data-coverage-strength/, 'the 覆盖强度 choice');
  assert.match(text(fold.slice(0, 600)), /题型、覆盖强度、难度、语言、课程、想练什么/, 'the closed fold says what is in it');
  // typed values open it, so nothing the learner entered is hidden
  for (const typed of [{ focus: '死锁' }, { title: '期中复习' }, { role: '后端' }, { difficulty: 'advanced' }, { customCount: '40' }, { kinds: ['quiz', 'open'], kind: 'quiz' }, { language: 'English' }])
    assert.match(parts(render({}, { gen: { ...gen, ...typed } })).fold.slice(0, 80), /\sopen[\s>=]/, `${Object.keys(typed)} opens the fold`);
});

test('the 覆盖强度 in the fold draws only its choices: the plan, the count and the estimate are said once, under the form', () => {
  const { fold, submit } = parts(render());
  assert.doesNotMatch(fold, /data-coverage-consequence|data-coverage-auto-note/, 'no estimate line and no rounds sentence in the fold');
  assert.match(fold, /data-coverage-auto/, 'the choice 自动补到完整 itself is there');
  assert.doesNotMatch(text(fold), /共 \d+ 种题型，按 \d+ 题平均分配/, 'the question types do not repeat the planned total');
  assert.match(submit, /data-tour="generate-summary"/);
});

test('the page promises no check at publish: it says what the generation already did and where the check is', () => {
  const html = render(), said = text(html);
  assert.doesNotMatch(said, /发布时逐题检查|发布时会再次逐题检查|发布时还会再检查/);
  assert.match(said, /原文引用核验 · 独立质量审阅 · 干扰项逐项解释/);
  assert.match(said, /想再检查一遍，在草稿页点「保存并校验」/);
  assert.match(said, /生成结果先进入草稿，你看过再发布/);
});

test('an uncategorised result is said once, in the plan line, and points at the fold, not at something "above"', () => {
  const data = { sources: sources.map(source => ({ ...source, courses: [] })), focus: { course: '*', courses: [] } };
  const html = render(data);
  assert.match(text(parts(html).main), /课程：未分类/);
  assert.doesNotMatch(text(html), /可在上方指定课程/);
});

test('the same page in English has no Chinese outside the control values', () => {
  m.setUiLanguage('en');
  try {
    const html = render();
    const bare = html.replace(/\bvalue="[^"]*"/g, '').replace(/>中文</g, '><').replace(/placeholder="[^"]*"/g, '');
    assert.doesNotMatch(text(bare).replace(/数据库|索引笔记|事务笔记/g, ''), han);
    assert.match(text(parts(html).main), /Single choice · Coverage strength: Standard · Course: 数据库/);
    assert.match(parts(html).main, />Go to settings</);
  } finally { m.setUiLanguage('zh'); }
});

test('planLine names the types, the strength (or that a number was typed) and the course', () => {
  const { planLine } = m.form;
  assert.equal(planLine({ kinds: ['quiz'], level: 'lean', course: '网络' }), '单选测验 · 覆盖强度：精简 · 课程：网络');
  assert.equal(planLine({ kinds: ['quiz', 'flashcard'], level: 'full', course: '' }), '单选测验 + 闪卡 · 覆盖强度：完整 · 课程：未分类');
  assert.equal(planLine({ kinds: ['open'], level: 'standard', custom: true, course: 'DB' }), '开放问答 · 覆盖强度：自定义题数 · 课程：DB');
});

test('moreValuesOf: what makes the fold open', () => {
  const { moreValuesOf } = m.form;
  const base = { ...gen };
  assert.equal(moreValuesOf(base, base), false);
  assert.equal(moreValuesOf({ ...base, focus: '  ' }, base), false, 'blanks are nothing');
  assert.equal(moreValuesOf({ ...base, focus: '死锁' }, base), true);
  assert.equal(moreValuesOf({ ...base, tokenBudget: '2M' }, base), true);
  assert.equal(moreValuesOf({ ...base, referenceSourceIds: ['x'] }, base), true);
  assert.equal(moreValuesOf({ ...base, difficulty: 'advanced' }, { ...base, difficulty: 'advanced' }), false, 'a value that is the saved default is not a choice made here');
  assert.equal(moreValuesOf({ ...base, coverageLevel: 'full' }, base), true);
  assert.equal(moreValuesOf({ ...base, kinds: ['quiz', 'open'], kind: 'quiz' }, base), true);
  assert.equal(moreValuesOf({ ...base, course: '网络' }, base), false, 'a course stands on the main path line, so it opens nothing');
  assert.equal(moreValuesOf({ ...base, autoComplete: false }, base), true, 'a choice about the rounds is a choice');
});
