import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* 创建题组, the short main path (#667): sources, 题型, 覆盖强度 (精简 / 标准 / 完整 / 自定义), one line of where the new deck goes (课程, #665) with 前往设置, and the one button. Every optional control
   (想练什么, 重点, 参考样题, 难度, 语言, 公式写法, 自动补到完整, 花费上限, 名称, 目标岗位 / 面试方向 #666) is inside 更多选项, in four groups by purpose. Static markup here; the opening state,
   the estimate and the clicks are in tests/generate-short-browser.test.mjs. */

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

test('the main path of the options: the question types, the 覆盖强度 with 自定义 as its fourth choice, one line for the course and the way to the settings', () => {
  const { main } = parts(render());
  assert.match(main, /data-tour="generate-kinds"/);
  assert.match(main, /data-tour="generate-coverage"/);
  const choices = [...main.matchAll(/<button[^>]*class="sh-seg__item[^"]*"[^>]*aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)].map(match => [text(match[2]), match[1] === 'true']);
  assert.deepEqual(choices, [['精简', false], ['标准', true], ['完整', false], ['自定义', false]], 'four choices, one on');
  assert.match(main, /data-generate-plan/);
  assert.match(text(main.slice(main.indexOf('data-generate-plan'))), /^[^>]*> 新题组放进课程：数据库 更改 前往设置/, 'where the new deck goes (as the page infers it), 更改, and the way to the defaults');
  assert.match(main, /<button[^>]*data-open-settings="settings-generation"[^>]*>前往设置<\/button>/);
  assert.doesNotMatch(main, /generate-focus|generate-title|generate-role|generate-count|data-tour="generate-(difficulty|language|notation)"/, 'nothing optional on the main path');
  assert.doesNotMatch(main, /课程归属|课程范围/, 'the course field of the new deck is not drawn until 更改 (the page has one course field: 课程范围 of the materials)');
});

test('the one course field: 课程范围 filters the materials, and the new deck follows it (and the ticked materials) without a second field', () => {
  const html = render();
  assert.equal((html.match(/课程范围/g) || []).length > 0, true, 'the filter of the list of materials is there');
  assert.doesNotMatch(html, /课程归属/, 'no second field named for the deck\'s course');
  assert.doesNotMatch(html, /id="course-field|course-field__input/, 'the field of the deck\'s course is not drawn until 更改');
});

test('every optional control is inside 更多选项, closed unless the form carries values', () => {
  const { fold } = parts(render());
  assert.doesNotMatch(fold.slice(0, 80), /\sopen[\s>=]/, 'the fold is closed with the defaults');
  for (const label of ['想练什么', '难度与语言', '花费', '题组信息', '这次想练什么？', '难度', '语言', '公式写法', '花费上限', '题组名称（可选）', '目标岗位 / 面试方向（可选）', '参考样题（可选）'])
    assert.ok(text(fold).includes(label), `${label} is in the fold`);
  assert.match(fold, /id="generate-focus"/);
  assert.match(fold, /data-tour="generate-budget"/, 'the spending limit');
  assert.doesNotMatch(fold, /data-coverage-auto|data-coverage-level-note|kinds-quiz|id="generate-count"/, 'the question types and the strength are on the main path, not repeated here');
  assert.match(text(fold.slice(0, 600)), /想练什么、难度与语言、花费上限、题组名称/, 'the closed fold says what is in it');
  // typed values open it, so nothing the learner entered is hidden; what stands on the main path does not
  for (const typed of [{ focus: '死锁' }, { title: '期中复习' }, { role: '后端' }, { difficulty: 'advanced' }, { language: 'English' }, { tokenBudget: '2M' }])
    assert.match(parts(render({}, { gen: { ...gen, ...typed } })).fold.slice(0, 80), /\sopen[\s>=]/, `${Object.keys(typed)} opens the fold`);
  for (const onMain of [{ customCount: '40' }, { kinds: ['quiz', 'open'], kind: 'quiz' }, { coverageLevel: 'full' }, { autoComplete: false }])
    assert.doesNotMatch(parts(render({}, { gen: { ...gen, ...onMain } })).fold.slice(0, 80), /\sopen[\s>=]/, `${Object.keys(onMain)} is on the main path and leaves the fold shut`);
});

test('the target role is not on the regular path: folded inside 更多选项 (open for an interview goal or a typed role)', () => {
  const { main, fold } = parts(render());
  assert.doesNotMatch(main, /generate-role|目标岗位/);
  const role = /<details class="sh-disclosure[^"]*generate-role"([^>]*)>/.exec(fold);
  assert.ok(role, 'the role sits in its own fold');
  assert.doesNotMatch(role[1], /\sopen/, 'shut for an ordinary course');
  assert.match(fold, /data-tour="generate-role"/, 'the anchor stays for 找功能');
  assert.match(/<details class="sh-disclosure[^"]*generate-role"([^>]*)>/.exec(parts(render({}, { gen: { ...gen, role: '后端工程师' } })).fold)[1], /\sopen/, 'a typed role stays visible');
  assert.match(/<details class="sh-disclosure[^"]*generate-role"([^>]*)>/.exec(parts(render({ focus: { course: '数据库', courses: [{ name: '数据库' }], mode: 'interview' } })).fold)[1], /\sopen/, 'and so does an interview course');
});

test('the 覆盖强度 draws only its choices: the plan, the count and the estimate are said once, under the form', () => {
  const { fold, submit } = parts(render());
  assert.doesNotMatch(fold, /data-coverage-consequence|data-coverage-auto-note/, 'no estimate line and no rounds sentence in the fold');
  assert.doesNotMatch(parts(render()).main, /data-coverage-consequence|data-coverage-auto-note/, 'nor on the main path: only the choices and 自动补到完整 itself');
  assert.match(parts(render()).main, /data-coverage-auto/, 'the choice 自动补到完整 belongs to the strength and stands with it');
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
  assert.match(text(parts(html).main), /新题组放进课程：未分类/);
  assert.doesNotMatch(text(html), /可在上方指定课程/);
});

test('the same page in English has no Chinese outside the control values', () => {
  m.setUiLanguage('en');
  try {
    const html = render();
    const bare = html.replace(/\bvalue="[^"]*"/g, '').replace(/>中文</g, '><').replace(/placeholder="[^"]*"/g, '');
    assert.doesNotMatch(text(bare).replace(/数据库|索引笔记|事务笔记/g, ''), han);
    assert.match(text(parts(html).main), /Coverage strength Lean Standard Full Custom/);
    assert.match(text(parts(html).main), /New deck goes into course: 数据库 Change Go to settings/);
    assert.match(parts(html).main, />Go to settings</);
  } finally { m.setUiLanguage('zh'); }
});

test('courseLine says which course the new deck goes into', () => {
  const { courseLine } = m.form;
  assert.equal(courseLine('网络'), '新题组放进课程：网络');
  assert.equal(courseLine(''), '新题组放进课程：未分类');
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
  assert.equal(moreValuesOf({ ...base, coverageLevel: 'full' }, base), false, 'the strength stands on the main path');
  assert.equal(moreValuesOf({ ...base, customCount: '40' }, base), false, 'so does a typed number of questions (it is the choice 自定义)');
  assert.equal(moreValuesOf({ ...base, kinds: ['quiz', 'open'], kind: 'quiz' }, base), false, 'and the question types');
  assert.equal(moreValuesOf({ ...base, course: '网络' }, base), false, 'a course stands on the main path line, so it opens nothing');
  assert.equal(moreValuesOf({ ...base, autoComplete: false }, base), false, 'the rounds are chosen under 覆盖强度, on the main path');
});
