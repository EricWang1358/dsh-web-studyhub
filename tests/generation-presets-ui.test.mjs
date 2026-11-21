import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* 出题方式 on the form (ui/presets): the rough cost of each cell is read from the token estimate of that cell for the chosen materials, divided by the default cell's
   (never a fixed multiple); the form's own cell does not repeat its number of questions (the summary beside the button says it); with nothing estimated nothing is said. */

const m = await loadUi(`
  export * from './ui/presets/Presets.jsx';
  export * as cost from './ui/presets/cost.js';
  export * as copy from './ui/presets/copy.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const han = /[㐀-鿿]/;
const text = html => html.replace(/<span[^>]*role="tooltip"[^>]*>[\s\S]*?<\/span>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const estimate = (high, goal, goalLow) => ({ totalTokens: { low: high / 2, high }, coverage: { goal, ...(goalLow ? { goalLow } : {}) } });
// Three estimates: the default cell (情境题), 快问 (lean × quick) and 逐题精出 (standard × staged).
const ANSWERS = new Map([['standard:scenario', estimate(100000, 66, 53)], ['lean:quick', estimate(30000, 33, 26)], ['standard:blueprint', estimate(70000, 28)]]);

test('cell requests: the form\'s request with the cell\'s level and depth, no typed count; the default cell asked first, each once', () => {
  const base = { feature: 'generate', sourceIds: ['a'], coverageLevel: 'full', count: 40, kind: 'quiz', performance: { strategy: 'staged' } };
  assert.deepEqual(m.cost.cellRequest(base, { density: 'lean', depth: 'quick' }),
    { feature: 'generate', sourceIds: ['a'], coverageLevel: 'lean', kind: 'quiz', performance: { strategy: 'one-pass', writeStyle: 'quick' } });
  assert.deepEqual(m.cost.cellsToAsk(m.cost.PRESET_CELLS).map(m.cost.cellKey), ['standard:scenario', 'lean:quick', 'standard:blueprint']);
  assert.equal(m.cost.MATRIX_CELLS.length, 9);
  assert.equal(m.cost.cellsToAsk(m.cost.MATRIX_CELLS).length, 9);
});

test('cell costs: each upper end over the default cell\'s; unknown while asked, nothing when an estimate failed', () => {
  const costs = m.cost.cellCosts(ANSWERS, m.cost.PRESET_CELLS);
  assert.deepEqual(costs.get('lean:quick'), { ratio: 0.3, coverage: { goal: 33, goalLow: 26 }, base: false, ready: true });
  assert.equal(costs.get('standard:scenario').ratio, 1);
  assert.equal(costs.get('standard:scenario').base, true);
  const asking = m.cost.cellCosts(new Map([['standard:scenario', estimate(100000, 66, 53)]]), m.cost.PRESET_CELLS);
  assert.equal(asking.get('lean:quick').ready, false, 'not ready while its own estimate is asked');
  const failed = m.cost.cellCosts(new Map([['standard:scenario', null], ['lean:quick', estimate(1, 1)], ['standard:blueprint', estimate(1, 1)]]), m.cost.PRESET_CELLS);
  assert.equal(failed.get('lean:quick').ratio, null, 'no ratio against a default that could not be estimated');
});

test('ratio words: 「约 ×0.3」, the default cell 「×1」, nothing without a ratio', () => {
  m.setUiLanguage('zh');
  assert.equal(m.copy.ratioText(0.2849), '约 ×0.3');
  assert.equal(m.copy.ratioText(1.75), '约 ×1.8');
  assert.equal(m.copy.ratioText(1, { base: true }), '×1');
  assert.equal(m.copy.ratioText(null), '');
  assert.equal(m.copy.ratioText(0.62, { bare: true }), '×0.6', 'without 约 where the heading says the costs are rough');
  assert.equal(m.copy.questionsText({ goal: 66, goalLow: 53 }), '53–66 题');
  assert.equal(m.copy.questionsText({ goal: 28 }), '28 题');
  assert.equal(m.copy.questionsText(null), '');
});

test('the presets say each rough cost and how many questions the others make; the form\'s own cell says no count (the summary does)', () => {
  m.setUiLanguage('zh');
  const costs = m.cost.cellCosts(ANSWERS, m.cost.PRESET_CELLS);
  const html = renderToStaticMarkup(React.createElement(m.PresetPicker, { cell: { density: 'standard', depth: 'scenario' }, applies: true, costs, onPick: () => {} }));
  assert.match(html, /data-preset="scenario"/);
  const line = /data-preset-cost[^>]*data-status="ready"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] || '';
  assert.match(text(line), /^大致花费 快问 约 ×0\.3（26–33 题） · 情境题 ×1 · 逐题精出 约 ×0\.7（28 题）$/);
  assert.match(html, /role="tooltip"[^>]*>[^<]*只是粗略比较，不是固定倍数/, 'a hover card says the ratio is rough and depends on the model');
  assert.doesNotMatch(html, /\stitle="/, 'no title= tooltips');
  assert.doesNotMatch(html, /缓存|cache/i, 'money and tokens only, no cache-hit rows');
  // While the estimates are asked the line holds its place; with nothing estimated (costs null) there is none.
  const asking = renderToStaticMarkup(React.createElement(m.PresetPicker, { cell: { density: 'lean', depth: 'quick' }, applies: true, costs: m.cost.cellCosts(new Map(), m.cost.PRESET_CELLS), onPick: () => {} }));
  assert.match(asking, /data-preset-cost[^>]*data-status="loading"/);
  const none = renderToStaticMarkup(React.createElement(m.PresetPicker, { cell: { density: 'lean', depth: 'quick' }, applies: true, costs: null, onPick: () => {} }));
  assert.doesNotMatch(none, /data-preset-cost/);
});

test('a combination that is no preset is 自定义, and another question type turns the presets off with the reason', () => {
  m.setUiLanguage('zh');
  const custom = renderToStaticMarkup(React.createElement(m.PresetPicker, { cell: { density: 'full', depth: 'blueprint' }, applies: true, costs: null, onPick: () => {} }));
  assert.match(custom, /data-preset="custom"/);
  assert.doesNotMatch(custom, /aria-pressed="true"/);
  assert.match(text(custom), /自定义：完整 × 逐题精出。/);
  const off = renderToStaticMarkup(React.createElement(m.PresetPicker, { cell: { density: 'standard', depth: 'scenario' }, applies: false, costs: null, onPick: () => {} }));
  assert.match(off, /data-preset="off"/);
  assert.equal((off.match(/<button[^>]*sh-seg__item[^>]*disabled=""/g) || []).length, 3, 'the three presets are off');
  assert.match(text(off), /快问和情境题只用于单选题/);
});

test('the matrix: a row per depth, a column per 覆盖强度, the form\'s cell marked (in words too) without its count', () => {
  m.setUiLanguage('zh');
  const answers = new Map(m.cost.MATRIX_CELLS.map((cell, at) => [m.cost.cellKey(cell), estimate(50000 + at * 10000, 10 + at)]));
  answers.set('standard:scenario', estimate(100000, 66, 53));
  const html = renderToStaticMarkup(React.createElement(m.CostMatrix, { cell: { density: 'lean', depth: 'quick' }, costs: m.cost.cellCosts(answers, m.cost.MATRIX_CELLS) }));
  assert.deepEqual([...html.matchAll(/<thead>[\s\S]*?<\/thead>/g)].map(match => text(match[0])), ['出题深度 精简 标准 完整']);
  assert.deepEqual([...html.matchAll(/<th scope="row">(.*?)<\/th>/g)].map(match => match[1]), ['快问', '情境题', '逐题精出']);
  const current = /<td[^>]*data-current="true"[^>]*>([\s\S]*?)<\/td>/.exec(html);
  assert.match(current[0], /data-cell="lean:quick"/);
  assert.equal(text(current[1]), '×0.5 （当前）', 'its ratio (the caption says the costs are rough) and 当前, not its count');
  assert.match(text(/<td[^>]*data-cell="standard:scenario"[^>]*>([\s\S]*?)<\/td>/.exec(html)[1]), /^×1 53–66 题$/);
  assert.equal((html.match(/data-current="true"/g) || []).length, 1);
});

test('the same words in English have no Chinese', () => {
  m.setUiLanguage('en');
  try {
    const costs = m.cost.cellCosts(ANSWERS, m.cost.PRESET_CELLS);
    const answers = new Map(m.cost.MATRIX_CELLS.map(cell => [m.cost.cellKey(cell), estimate(80000, 20)]));
    const html = [
      renderToStaticMarkup(React.createElement(m.PresetPicker, { cell: { density: 'standard', depth: 'scenario' }, applies: true, costs, onPick: () => {} })),
      renderToStaticMarkup(React.createElement(m.PresetPicker, { cell: { density: 'full', depth: 'quick' }, applies: true, costs: null, onPick: () => {} })),
      renderToStaticMarkup(React.createElement(m.PresetPicker, { cell: { density: 'full', depth: 'quick' }, applies: false, costs: null, onPick: () => {} })),
      renderToStaticMarkup(React.createElement(m.DepthChoice, { depth: 'blueprint', applies: true, onDepth: () => {} })),
      renderToStaticMarkup(React.createElement(m.DepthChoice, { depth: 'quick', applies: false, onDepth: () => {} })),
      renderToStaticMarkup(React.createElement(m.CostMatrix, { cell: { density: 'full', depth: 'quick' }, costs: m.cost.cellCosts(answers, m.cost.MATRIX_CELLS) })),
    ].join('');
    assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), han);
    assert.match(html, /Quick about ×0\.3/);
  } finally { m.setUiLanguage('zh'); }
});
