import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* 创建题组 (#1082, #1084): the engineering-looking group (题型配额与模块化规则) is a student's 「额外要求（可选）」, shut inside 「高级」 next to 花费上限 and open only when the form carries a value
   of it; the words of the old group (业务规则模板名称, 启用此模块, 系统基础安全约束 …, 预览生效要求与阶段规则（零模型调用）) are gone from the page in both languages. The picker row
   reserves a line for a badge only while the answer is still coming. */

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
const ENGINEERING = ['业务规则模板名称', '启用此模块', '系统基础安全约束', 'JSON 协议校验', '零模型调用', '题型配额与模块化规则', '预览生效要求与阶段规则', '独立审阅闭环'];

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

test('the picker row draws the badge line only for a row that has a badge, or while the answer is still coming', () => {
  const render2 = props => renderToStaticMarkup(React.createElement(m.SourcePicker, { sources, selected: [], onChange: noop, ...props }));
  assert.doesNotMatch(render2({ indexCoverage: { indexed: [], stale: [], canIndex: true }, indexSlot: false }), /source-picker__index/, 'answered, no badge: no empty line');
  assert.match(render2({ indexCoverage: null, indexSlot: true }), /source-picker__index/, 'while the answer is still coming the line is kept (#205)');
});
