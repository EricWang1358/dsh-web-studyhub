import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* #664: the 覆盖强度 control shows what will happen. 精简 / 标准 / 完整 / 自定义 are four choices of one control; exactly one is on at any time, and a typed number of
   questions is the choice 自定义, never a hidden override under a highlighted 标准. The decision is one pure function (ui/generate-form.js coverageChoiceOf / effectiveCoverage /
   coverageChoicePatch); the control and the page read it, and what a run sends (generationRequest, estimateRequestOf) stays as it was. */

const m = await loadUi(`
  export { default as CoverageStrength } from './ui/coverage/CoverageStrength.jsx';
  export * as form from './ui/generate-form.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const noop = () => {};
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const stats = { materials: 2, pages: 0, chars: 20000 };
const render = (props = {}) => renderToStaticMarkup(React.createElement(m.CoverageStrength, { level: 'standard', customCount: '', onLevel: noop, onCustom: noop, stats, enabled: true, ...props }));
const segments = html => [...html.matchAll(/<button[^>]*class="sh-seg__item[^"]*"[^>]*aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)].map(match => [text(match[2]), match[1] === 'true']);

test('coverageChoiceOf: a valid typed number is the choice 自定义, anything else is the level', () => {
  const { coverageChoiceOf } = m.form;
  assert.equal(coverageChoiceOf({ coverageLevel: 'standard', customCount: '' }), 'standard');
  assert.equal(coverageChoiceOf({ coverageLevel: 'lean' }), 'lean');
  assert.equal(coverageChoiceOf({ coverageLevel: 'full', customCount: '12' }), 'custom');
  assert.equal(coverageChoiceOf({ coverageLevel: 'full', customCount: '0' }), 'full', 'a number the backend would not take is no choice');
  assert.equal(coverageChoiceOf({ coverageLevel: 'nonsense', customCount: '' }), 'standard', 'an unknown level reads as the default');
  assert.equal(coverageChoiceOf({ coverageLevel: 'standard', customCount: '' }, { picking: true }), 'custom', 'while the learner is typing a number the field stays');
});

test('effectiveCoverage: the one place that says which plan applies (the level, or the typed count)', () => {
  const { effectiveCoverage } = m.form;
  assert.deepEqual(effectiveCoverage({ coverageLevel: 'lean', customCount: '' }), { choice: 'lean', level: 'lean', count: null });
  assert.deepEqual(effectiveCoverage({ coverageLevel: 'lean', customCount: '4' }), { choice: 'custom', level: 'lean', count: 4 });
  assert.deepEqual(effectiveCoverage({ coverageLevel: 'full', customCount: '' }, { picking: true }), { choice: 'custom', level: 'full', count: null }, 'picked but not typed yet: the level still plans');
});

test('the four choices, switched back and forth: one is on at every step and the plan follows it', () => {
  const { coverageChoicePatch, effectiveCoverage, estimateRequestOf, generationRequest } = m.form;
  let gen = { coverageLevel: 'standard', customCount: '', kind: 'quiz', kinds: ['quiz'], difficulty: 'mixed', language: '中文' };
  const apply = (choice, suggested = 12) => { gen = { ...gen, ...coverageChoicePatch(choice, { suggested }) }; return effectiveCoverage(gen); };
  assert.deepEqual(apply('custom'), { choice: 'custom', level: 'standard', count: 12 }, '自定义 starts from a number the page suggests, so the field is never empty');
  assert.equal(estimateRequestOf(gen, { course: '', sourceIds: [] }).count, 12);
  assert.deepEqual(apply('full'), { choice: 'full', level: 'full', count: null }, 'a level takes the typed number away');
  assert.equal(estimateRequestOf(gen, { course: '', sourceIds: [] }).count, undefined, 'and no count is sent');
  assert.equal(generationRequest(gen, { course: '', sourceIds: [] }).count, undefined);
  assert.deepEqual(apply('custom', 40), { choice: 'custom', level: 'full', count: 40 });
  assert.deepEqual(apply('lean'), { choice: 'lean', level: 'lean', count: null });
  assert.deepEqual(apply('custom', 4), { choice: 'custom', level: 'lean', count: 4 });
  assert.deepEqual(apply('standard'), { choice: 'standard', level: 'standard', count: null });
  assert.equal(generationRequest(gen, { course: '', sourceIds: [] }).coverageLevel, 'standard');
});

test('the control draws four choices and exactly one is on', () => {
  for (const [props, on] of [[{}, '标准'], [{ level: 'lean' }, '精简'], [{ level: 'full' }, '完整'], [{ level: 'standard', customCount: '4' }, '自定义'], [{ level: 'full', customCount: '4' }, '自定义']]) {
    const drawn = segments(render(props));
    assert.deepEqual(drawn.map(([name]) => name), ['精简', '标准', '完整', '自定义']);
    assert.deepEqual(drawn.filter(([, pressed]) => pressed).map(([name]) => name), [on], JSON.stringify(props));
  }
});

test('a typed number shows its field under the choice; a level shows none', () => {
  const custom = render({ customCount: '4' });
  assert.match(custom, /<input[^>]*id="generate-count"[^>]*value="4"|<input[^>]*value="4"[^>]*id="generate-count"/);
  assert.match(custom, /data-tour="generate-custom-count"/);
  const level = render({});
  assert.doesNotMatch(level, /id="generate-count"/, 'the number field is only there for 自定义');
  assert.doesNotMatch(text(level), /改回按覆盖强度/);
});

test('自动补到完整 is offered where it means something: the three levels, and a custom number that needs several rounds', () => {
  const { effectiveCoverage } = m.form;
  assert.equal(effectiveCoverage({ coverageLevel: 'standard', customCount: '' }).choice !== 'custom', true);
  const withAuto = (props, coverage) => render({ onAuto: noop, auto: true, state: { status: 'ready', estimate: { coverage } }, ...props });
  assert.match(withAuto({}, { rounds: 3 }), /data-coverage-auto/);
  assert.doesNotMatch(withAuto({ customCount: '4' }, { rounds: 1 }), /data-coverage-auto/, 'four questions fit one round: nothing to go on with');
  assert.match(withAuto({ customCount: '100' }, { rounds: 4 }), /data-coverage-auto/, '100 questions are several rounds');
});
