import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* 创建题组 (#1082, #1084): the engineering-looking group (题型配额与模块化规则) is a student's 「额外要求（可选）」, shut inside 「高级」 next to 花费上限 and open only when the form carries a value
   of it; the words of the old group (业务规则模板名称, 启用此模块, 系统基础安全约束 …, 预览生效要求与阶段规则（零模型调用）) are gone from the page in both languages. Every picker row
   keeps a slot of fixed size for its index badge at the end of its facts line. */

const m = await loadUi(`
  export { default as Generate } from './ui/Generate.jsx';
  export { default as SourcePicker } from './ui/SourcePicker.jsx';
  export * as form from './ui/generate-form.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const noop = () => {};
const han = /[㐀-鿿]/;
const sources = [
  { id: 'a', title: '索引笔记', text: '数据库索引加快查找。', courses: ['数据库'], usedBy: [], chars: 12 },
  { id: 'b', title: '事务笔记.md', text: '事务保证一致性。', courses: ['数据库'], usedBy: [], chars: 12, document: { id: 'md', format: 'markdown' } },
];
const gen = { kind: 'quiz', kinds: ['quiz'], count: 10, difficulty: 'mixed', language: '中文', focus: '', role: '', coverageLevel: 'standard', customCount: '', notation: 'auto' };
function render(patch = {}) {
  const data = { root: 'lib', decks: [], drafts: [], jobs: [], sources, modelReady: true, focus: { course: '数据库', courses: [{ name: '数据库' }] } };
  return renderToStaticMarkup(React.createElement(m.Generate, { data, busy: false, running: false, act: noop, call: noop, openDraft: noop, setPage: noop, setNotice: noop,
    genSource: 'files', setGenSource: noop, gen: { ...gen, ...patch }, setGen: noop, selectedSources: ['a'], setSelectedSources: noop, setModal: noop, askInChat: noop, openModelSettings: noop }));
}
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const EXTRA = /<details class="sh-disclosure[^"]*generate-extra"([^>]*)>/;
const ENGINEERING = ['业务规则模板名称', '启用此模块', '系统基础安全约束', 'JSON 协议校验', '零模型调用', '题型配额与模块化规则', '预览生效要求与阶段规则', '独立审阅闭环', '规格版本', '请求最前'];

test('the extra requirements are one fold inside 高级, next to 花费上限, shut by default', () => {
  const html = render(), fold = html.slice(html.indexOf('<details class="sh-disclosure generate-more'));
  const extra = EXTRA.exec(fold);
  assert.ok(extra, '额外要求 is its own fold');
  assert.doesNotMatch(extra[1], /\sopen/, 'shut with the defaults');
  assert.match(extra[1], /data-tour="generate-extra"/, 'the anchor 找功能 lights');
  assert.ok(text(fold).includes('额外要求（可选）'), 'named for a student');
  const advanced = fold.indexOf('aria-label="高级"');
  assert.ok(advanced > 0, 'the group is 高级');
  assert.ok(fold.indexOf('data-tour="generate-budget"') > advanced && fold.indexOf('generate-extra') > advanced, '花费上限 and 额外要求 are both under 高级');
  assert.doesNotMatch(text(fold), /花费 /, 'no separate 花费 group');
});

test('a quota or a module of the form opens the fold, so nothing the learner set is hidden', () => {
  assert.match(EXTRA.exec(render({ kinds: ['quiz', 'open'], kind: 'quiz', kindCounts: { quiz: 3, open: 1 } }))[1], /\sopen/);
  assert.match(EXTRA.exec(render({ moduleOverrides: { reasoning: { enabled: true, instruction: '多考边界条件' } } }))[1], /\sopen/);
  assert.doesNotMatch(EXTRA.exec(render({ kinds: ['quiz', 'open'], kind: 'quiz' }))[1], /\sopen/, 'two types on their own are not a quota');
  assert.equal(m.form.extraValuesOf({ ...gen }), false);
  assert.equal(m.form.extraValuesOf({ ...gen, moduleOverrides: {} }), false);
});

test('no engineering words on the page, shut or open, in either language', () => {
  const open = { kinds: ['quiz', 'open'], kind: 'quiz', kindCounts: { quiz: 3, open: 1 }, moduleOverrides: { templateName: '期末强化', reasoning: { enabled: true, instruction: 'x' }, rubric: { enabled: false, instruction: '' } } };
  for (const patch of [{}, open]) {
    const said = text(render(patch));
    for (const word of ENGINEERING) assert.ok(!said.includes(word), `${word} is not shown`);
    assert.doesNotMatch(render(patch), /data-locked-protocol/, 'the read-only safety row is gone: the note under the form already says the questions are checked against the source');
  }
  m.setUiLanguage('en');
  try {
    for (const patch of [{}, open]) {
      const html = render(patch);
      assert.doesNotMatch(text(html.replace(/\bvalue="[^"]*"/g, '').replace(/placeholder="[^"]*"/g, '')).replace(/数据库|索引笔记|事务笔记|期末强化/g, ''), han, 'English page has no Chinese');
      assert.doesNotMatch(text(html), /Core safety constraints|Enable this module|Rule template name|0 model calls|modular rules/i);
    }
  } finally { m.setUiLanguage('zh'); }
});

test('every picker row has the badge\'s slot at the end of its facts line, whatever the answer: the title has the whole column (#1084, round 4)', () => {
  const render2 = props => renderToStaticMarkup(React.createElement(m.SourcePicker, { sources, selected: [], onChange: noop, ...props }));
  for (const [what, coverage] of [['no answer yet', null], ['answered, no badge', { indexed: [], stale: [], canIndex: true }], ['with badges', { indexed: ['a', 'b'], stale: [], canIndex: true }]]) {
    const html = render2({ indexCoverage: coverage });
    assert.equal(html.match(/data-index-slot/g)?.length, 2, `${what}: a slot on each row`);
    assert.doesNotMatch(html, /source-picker__place|source-picker__head/, `${what}: nothing beside the title takes its width`);
    for (const row of html.split('data-document-key').slice(1)) {
      assert.ok(row.indexOf('<strong') < row.indexOf('source-picker__facts') && row.indexOf('source-picker__facts') < row.indexOf('data-index-slot'), `${what}: title, facts, then the slot (read in that order)`);
    }
  }
});

/* The preview is what a student would ask: which materials, how many questions of which types, difficulty, language, formula style, the extra requirements. */
const preview = await loadUi(`
  export { EffectivePreview } from './ui/GenerationTransparency.jsx';
  export { previewRows } from './ui/generation-preview.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const render3 = (rows) => renderToStaticMarkup(React.createElement(preview.EffectivePreview, { rows }));
const rowsOf = (patch = {}, extra = {}) => preview.previewRows({ gen: { ...gen, ...patch }, sources, sourceIds: ['a', 'b'], plannedGoal: 10, focusCount: 1, referenceCount: 0, rules: [], ...extra });
const ENGINEERING_PREVIEW = [/蓝图/, /缓存/, /协议/, /阶段/, /模块化/, /JSON/, /校验/, /请求最前/, /六维/, /mixed/, /text/, /model call/i, /stage/i, /prefix/i, /blueprint/i, /protocol/i];

test('the preview says what the run will ask for in a student\'s words: materials, counts per type, difficulty, language, formula style, extras', () => {
  const rows = rowsOf({ kinds: ['quiz', 'flashcard'], kind: 'quiz', notation: 'text', difficulty: 'application', moduleOverrides: { templateName: '期末强化', reasoning: { enabled: true, instruction: '多考边界条件' }, rubric: { enabled: false, instruction: '' } } });
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]));
  assert.match(byKey.materials.value, /^2 份：索引笔记、事务笔记/);
  assert.equal(byKey.questions.value, '单选测验 5 · 闪卡 5（共 10 题）');
  assert.equal(byKey.difficulty.value, '应用迁移');
  assert.equal(byKey.language.value, '中文');
  assert.equal(byKey.notation.value, '纯文本', 'formula style in words, not the stored value');
  assert.match(byKey['course-focus'].value, /1 个重点知识点/);
  assert.deepEqual(byKey.extras.items, ['推理要求：多考边界条件'], 'only a requirement that is in use, with its label');
  assert.equal(byKey.extras.name, '期末强化');
  assert.equal(rowsOf().find((row) => row.key === 'extras').value, '没有，按默认来');
  const quotas = rowsOf({ kinds: ['quiz', 'open'], kind: 'quiz', kindCounts: { quiz: 3, open: 0 } }).find((row) => row.key === 'questions').value;
  assert.equal(quotas, '单选测验 3 · 开放问答 0（共 3 题）');
  const html = render3(rows), said = text(html);
  for (const pattern of ENGINEERING_PREVIEW) assert.doesNotMatch(said, pattern, `${pattern} is not shown`);
  assert.match(html, /data-effective-preview-panel/);
});

test('the same preview in English has no Chinese outside the materials\' own names, and no engineering words', () => {
  preview.setUiLanguage('en');
  try {
    const english = [{ id: 'e1', title: 'Index notes', text: 'x', courses: ['DB'], usedBy: [], chars: 1 }];
    const rows = preview.previewRows({ gen: { ...gen, kinds: ['quiz', 'flashcard'], kind: 'quiz', language: 'English', notation: 'latex', moduleOverrides: { reasoning: { enabled: true, instruction: 'edge cases' } } },
      sources: english, sourceIds: ['e1'], plannedGoal: 10, focusCount: 2, referenceCount: 1, rules: ['Always cite the page'] });
    const said = text(render3(rows));
    assert.doesNotMatch(said, han, said);
    for (const pattern of ENGINEERING_PREVIEW) assert.doesNotMatch(said, pattern, `${pattern} is not shown: ${said}`);
    assert.match(said, /Questions.*10 in all/);
    assert.match(said, /Formula notation Formula \(LaTeX\)/);
    assert.match(said, /Reasoning: edge cases/);
  } finally { preview.setUiLanguage('zh'); }
});

test('an empty requirement is not shown as in use: the choice to apply one appears once there is a sentence', () => {
  const open = (moduleOverrides) => text(render({ moduleOverrides, kinds: ['quiz', 'open'], kind: 'quiz', kindCounts: { quiz: 3, open: 1 } }));
  assert.ok(!open({}).includes('用上这条'), 'nothing written, nothing to apply');
  assert.equal((open({ reasoning: { enabled: true, instruction: '多考边界条件' } }).match(/用上这条/g) || []).length, 1, 'one sentence, one choice');
  assert.equal((open({ rubric: { enabled: false, instruction: '' } }).match(/用上这条/g) || []).length, 1, 'one switched off earlier stays reachable');
});
