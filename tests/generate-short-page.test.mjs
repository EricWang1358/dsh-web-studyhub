import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* 创建题组, the short main path (#667): sources, 题型, 出题方式 (the three presets 快问 / 情境题 / 逐题精出, lib/contexts/generation/presets.js), one line of where the new deck goes (课程, #665)
   with 前往设置, and the one button. Every optional control (覆盖强度 with 自定义 and 自动补到完整, 出题深度, 想练什么, 重点, 参考样题, 难度, 语言, 公式写法, 花费上限, 名称, 目标岗位 / 面试方向 #666)
   is inside 更多选项, in groups by purpose. Static markup here; the opening state,
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
// 出题深度 and the matrix arrive in a chunk of their own (deferredView): one render asks for it, and once it is in every render below draws it, whichever test runs first.
render();
await new Promise(resolve => setTimeout(resolve, 0));
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const FOLD = '<details class="sh-disclosure generate-more';
const parts = html => {
  const options = html.indexOf('data-tour="generate-options"'), fold = html.indexOf(FOLD), submit = html.indexOf('data-tour="generate-summary"');
  assert.ok(options > 0 && fold > options && submit > fold, 'the options, the fold and the submit area come in that order');
  return { main: html.slice(options, fold), fold: html.slice(fold, submit), submit: html.slice(submit) };
};

const pressed = html => [...html.matchAll(/<button[^>]*class="sh-seg__item[^"]*"[^>]*aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)].map(match => [text(match[2]), match[1] === 'true']);

test('the main path of the options: the question types, the three presets of 出题方式, one line for the course and the way to the settings', () => {
  const { main } = parts(render());
  assert.match(main, /data-tour="generate-kinds"/);
  assert.match(main, /data-tour="generate-preset"/);
  assert.doesNotMatch(main, /data-tour="generate-(coverage|depth)"/, 'the two axes of the presets are in 更多选项');
  assert.deepEqual(pressed(main), [['快问', false], ['情境题', true], ['逐题精出', false]], 'three presets, the default on');
  assert.match(text(main), /情境题（默认）：标准题量/, 'what the chosen preset does, in one line');
  // A combination that is no preset says what it is and where it is changed; the other kinds turn the presets off and say why.
  const custom = parts(render({}, { gen: { ...gen, coverageLevel: 'full', depth: 'quick' } })).main;
  assert.deepEqual(pressed(custom).filter(([, on]) => on), [], 'no preset on for 完整 × 快问');
  assert.match(text(custom), /自定义：完整 × 直接问。在「更多选项 › 出题方式与题量」里改/);
  const open = parts(render({}, { gen: { ...gen, kind: 'open', kinds: ['open'] } })).main;
  assert.match(open, /data-preset="off"/);
  assert.match(text(open), /只有单选题能选写法/);
  assert.match(main, /data-generate-plan/);
  assert.match(text(main.slice(main.indexOf('data-generate-plan'))), /^[^>]*> 新题组放进的课程 数据库 更改 前往设置/, 'where the new deck goes (as the page infers it), 更改, and the way to the defaults');
  assert.match(main, /<div class="generate-row" data-tour="generate-course" data-generate-plan="[^"]*"><div class="generate-row__label">新题组放进的课程<\/div>/, 'one more row of the form, so it lines up with the rows above it (#1702)');
  const links = [...main.slice(main.indexOf('data-generate-plan')).matchAll(/<button[^>]*class="(sh-btn sh-btn--link[^"]*)"/g)].map(match => match[1]);
  assert.ok(links.length >= 2 && links.every(name => name.split(' ').includes('sh-btn--ink')), `the row's links are in ink, not the accent of the one primary button (${links})`);
  assert.match(main, /<button[^>]*data-open-settings="settings-generation"[^>]*>前往设置(?:<svg[\s\S]*?<\/svg>)?<\/button>/);
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
  for (const label of ['出题方式与题量', '覆盖强度', '自定义', '写法', '想练什么', '难度与语言', '高级', '题组信息', '额外要求（可选）', '这次想练什么？', '难度', '语言', '公式写法', '花费上限', '题组名称（可选）', '目标岗位 / 面试方向（可选）', '参考样题（可选）'])
    assert.ok(text(fold).includes(label), `${label} is in the fold`);
  assert.match(fold, /id="generate-focus"/);
  assert.match(fold, /data-tour="generate-budget"/, 'the spending limit');
  assert.match(fold, /data-tour="generate-coverage"/, 'the 覆盖强度 (with 自定义 and 自动补到完整)');
  assert.match(fold, /data-coverage-auto/);
  assert.match(fold, /data-tour="generate-depth"/, 'the 写法');
  assert.deepEqual(pressed(fold).slice(0, 7), [['精简', false], ['标准', true], ['完整', false], ['自定义', false], ['直接问', false], ['短情境', true], ['先设计再写', false]], 'the two axes of the preset, the cell of the form on');
  const every = pressed(render()).map(([word]) => word);
  assert.deepEqual(every.filter((word, at) => every.indexOf(word) !== at), [], 'no option words stand twice on the page (#1686)');
  assert.doesNotMatch(text(render()), /出题深度/, 'the choice has one name');
  assert.doesNotMatch(fold, /kinds-quiz|data-tour="generate-preset"/, 'the question types and the presets are on the main path, not repeated here');
  assert.match(text(fold.slice(0, 600)), /题量、想练什么、难度、花费、额外要求/, 'the closed fold says what is in it');
  // typed values open it, so nothing the learner entered is hidden; what stands on the main path does not
  for (const typed of [{ focus: '死锁' }, { title: '期中复习' }, { role: '后端' }, { difficulty: 'advanced' }, { language: 'English' }, { tokenBudget: '2M' }, { customCount: '40' }, { autoComplete: false }])
    assert.match(parts(render({}, { gen: { ...gen, ...typed } })).fold.slice(0, 80), /\sopen[\s>=]/, `${Object.keys(typed)} opens the fold`);
  // The level and the depth are said on the main path (the preset, or 自定义 with both), so they leave the fold shut.
  for (const onMain of [{ kinds: ['quiz', 'open'], kind: 'quiz' }, { coverageLevel: 'full' }, { depth: 'quick' }, { coverageLevel: 'lean', depth: 'quick' }])
    assert.doesNotMatch(parts(render({}, { gen: { ...gen, ...onMain } })).fold.slice(0, 80), /\sopen[\s>=]/, `${Object.keys(onMain)} is said on the main path and leaves the fold shut`);
});

test('the target role is not on the regular path: folded inside 更多选项 (open for an interview goal or a typed role)', () => {
  const { main, fold } = parts(render());
  assert.doesNotMatch(main, /generate-role|目标岗位/);
  const role = /<details class="sh-disclosure[^"]*generate-role"([^>]*)>/.exec(fold);
  assert.ok(role, 'the role sits in its own fold');
  assert.doesNotMatch(role[1], /\sopen/, 'shut for an ordinary course');
  assert.match(fold, /data-tour="generate-role"/, 'the anchor stays for 找功能');
  assert.match(/<details class="sh-disclosure[^"]*generate-role"([^>]*)>/.exec(parts(render({}, { gen: { ...gen, role: '后端工程师' } })).fold)[1], /\sopen/, 'a typed role stays visible');
  assert.match(/<details class="sh-disclosure[^"]*generate-role"([^>]*)>/.exec(parts(render({ courses: [{ name: '数据库', interview: { role: '后端工程师' } }], focus: { course: '数据库', courses: [{ name: '数据库' }] } })).fold)[1], /\sopen/, 'and so does an interview course');
});

test('the 覆盖强度 draws only its choices: the plan, the count and the estimate are said once, under the form', () => {
  const { fold, submit } = parts(render());
  assert.doesNotMatch(fold, /data-coverage-consequence|data-coverage-auto-note/, 'no estimate line and no rounds sentence in the fold');
  assert.doesNotMatch(parts(render()).main, /data-coverage-consequence|data-coverage-auto-note/, 'nor on the main path: only the choices and 自动补到完整 itself');
  assert.match(fold, /data-coverage-auto/, 'the choice 自动补到完整 belongs to the strength and stands with it');
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
  assert.match(text(parts(html).main), /新题组放进的课程 未分类/);
  assert.doesNotMatch(text(html), /可在上方指定课程/);
});

test('the same page in English has no Chinese outside the control values', () => {
  m.setUiLanguage('en');
  try {
    const html = render();
    const bare = html.replace(/\bvalue="[^"]*"/g, '').replace(/>中文</g, '><').replace(/placeholder="[^"]*"/g, '');
    assert.doesNotMatch(text(bare).replace(/数据库|索引笔记|事务笔记/g, ''), han);
    assert.match(text(parts(html).main), /How questions are written Quick Scenario Step by step Scenario \(default\)/);
    assert.match(text(parts(html).fold), /How and how many Coverage strength Lean Standard Full Custom/);
    assert.match(text(parts(html).main), /Course for the new deck 数据库 Change Go to settings/);
    assert.match(parts(html).main, />Go to settings</);
  } finally { m.setUiLanguage('zh'); }
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
  assert.equal(moreValuesOf({ ...base, depth: 'quick' }, base), false, 'so does the depth (the main path says it: a preset, or 自定义)');
  assert.equal(moreValuesOf({ ...base, customCount: '40' }, base), true, 'a typed number of questions is in the fold (出题方式与题量), so it opens it');
  assert.equal(moreValuesOf({ ...base, kinds: ['quiz', 'open'], kind: 'quiz' }, base), false, 'and the question types');
  assert.equal(moreValuesOf({ ...base, course: '网络' }, base), false, 'a course stands on the main path line, so it opens nothing');
  assert.equal(moreValuesOf({ ...base, autoComplete: false }, base), true, 'the rounds are chosen under 覆盖强度, in the fold');
  assert.equal(moreValuesOf({ ...base, autoComplete: true }, base), true, 'ticked by hand too');
});
