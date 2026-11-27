import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* 出题方式 on the form (ui/presets): the rough cost of each cell is read from the token estimate of that cell for the chosen materials, divided by the default cell's
   (never a fixed multiple); the form's own cell does not repeat its number of questions (the summary beside the button says it); with nothing estimated nothing is said. */

const m = await loadUi(`
  export * from './ui/presets/Presets.jsx';
  export { DepthChoice, CostMatrix, CostLine } from './ui/presets/PresetsFold.jsx';
  export * as words from './ui/presets/cost-words.js';
  export { DEPTHS, PRESETS, presetOf } from './lib/contexts/generation/presets.js';
  export { askCells } from './ui/presets/use-cell-estimates.js';
  export { estimateRequestOf, generationRequest } from './ui/generate-form.js';
  export { generationFormDefaults } from './ui/generation-status.js';
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
  assert.equal(m.words.ratioText(0.2849), '约 ×0.3');
  assert.equal(m.words.ratioText(1.75), '约 ×1.8');
  assert.equal(m.words.ratioText(1, { base: true }), '×1');
  assert.equal(m.words.ratioText(null), '');
  assert.equal(m.words.ratioText(0.62, { bare: true }), '×0.6', 'without 约 where the heading says the costs are rough');
  assert.equal(m.words.questionsText({ goal: 66, goalLow: 53 }), '53–66 题');
  assert.equal(m.words.questionsText({ goal: 28 }), '28 题');
  assert.equal(m.words.questionsText(null), '');
});

test('the presets say each rough cost and how many questions the others make; the form\'s own cell says no count (the summary does)', () => {
  m.setUiLanguage('zh');
  const costs = m.cost.cellCosts(ANSWERS, m.cost.PRESET_CELLS);
  const picker = renderToStaticMarkup(React.createElement(m.PresetPicker, { cell: { density: 'standard', depth: 'scenario' }, applies: true, costs, onPick: () => {} }));
  assert.match(picker, /data-preset="scenario"/);
  // Until its chunk arrives the line holds its place with its lead (ui/presets/Presets.jsx); the line itself is drawn by CostLine.
  assert.match(picker, /data-preset-cost[^>]*data-status="loading"[^>]*><span class="presets__cost-lead">大致花费<\/span><\/p>/);
  const items = m.cost.PRESET_CELLS.map(cell => ({ label: m.copy.presetLabel(cell.depth), cost: costs.get(m.cost.cellKey(cell)), current: m.cost.cellKey(cell) === 'standard:scenario' }));
  const html = renderToStaticMarkup(React.createElement(m.CostLine, { items, lead: m.copy.costLead() }));
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
  const html = renderToStaticMarkup(React.createElement(m.CostMatrix, { matrix: m.words.matrixWords(m.cost.cellCosts(answers, m.cost.MATRIX_CELLS), { density: 'lean', depth: 'quick' }, { columns: m.copy.matrixColumns(), depths: m.DEPTHS }) }));
  assert.deepEqual([...html.matchAll(/<thead>[\s\S]*?<\/thead>/g)].map(match => text(match[0])), ['出题深度 精简 标准 完整']);
  assert.deepEqual([...html.matchAll(/<th scope="row">(.*?)<\/th>/g)].map(match => match[1]), ['快问', '情境题', '逐题精出']);
  const current = /<td[^>]*data-current="true"[^>]*>([\s\S]*?)<\/td>/.exec(html);
  assert.match(current[0], /data-cell="lean:quick"/);
  assert.equal(text(current[1]), '×0.5 （当前）', 'its ratio (the caption says the costs are rough) and 当前, not its count');
  assert.match(text(/<td[^>]*data-cell="standard:scenario"[^>]*>([\s\S]*?)<\/td>/.exec(html)[1]), /^×1 53–66 题$/);
  assert.equal((html.match(/data-current="true"/g) || []).length, 1);
});

test('the matrix in words: loading cells say no figure, and nothing is drawn when the default cell could not be estimated', () => {
  m.setUiLanguage('zh');
  const asking = m.words.matrixWords(m.cost.cellCosts(new Map(), m.cost.MATRIX_CELLS), { density: 'standard', depth: 'scenario' }, { columns: m.copy.matrixColumns(), depths: m.DEPTHS });
  assert.equal(asking.ready, false);
  assert.ok(asking.rows.every(row => row.cells.every(cell => !cell.ready && cell.ratio === '' && cell.questions === '')));
  const failed = new Map(m.cost.MATRIX_CELLS.map(cell => [m.cost.cellKey(cell), estimate(1000, 1)]));
  failed.set('standard:scenario', null);
  assert.equal(m.words.matrixWords(m.cost.cellCosts(failed, m.cost.MATRIX_CELLS), { density: 'standard', depth: 'scenario' }, { columns: m.copy.matrixColumns(), depths: m.DEPTHS }), null);
});

test('the part of 更多选项 reaches nothing in lib/: loading it apart must not split the chunks of the first load', async () => {
  const { readFile } = await import('node:fs/promises');
  const seen = new Set(), pending = ['ui/presets/PresetsFold.jsx'];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, 'utf8'), dir = file.slice(0, file.lastIndexOf('/'));
    for (const [, spec] of source.matchAll(/^import [^;]*?from '(\.[^']+)'/gm)) {
      const path = new URL(spec, `file:///${dir}/`).pathname.slice(1);
      assert.doesNotMatch(path, /^lib\//, `${file} imports ${spec}`);
      if (path.startsWith('ui/presets/')) pending.push(path);
    }
  }
  assert.ok(seen.has('ui/presets/depth-copy.js') && seen.has('ui/presets/depth-label.js'));
});

test('the same words in English have no Chinese', () => {
  m.setUiLanguage('en');
  try {
    const costs = m.cost.cellCosts(ANSWERS, m.cost.PRESET_CELLS);
    const answers = new Map(m.cost.MATRIX_CELLS.map(cell => [m.cost.cellKey(cell), estimate(80000, 20)]));
    const html = [
      renderToStaticMarkup(React.createElement(m.PresetPicker, { cell: { density: 'standard', depth: 'scenario' }, applies: true, costs, onPick: () => {} })),
      renderToStaticMarkup(React.createElement(m.CostLine, { lead: m.copy.costLead(), items: m.cost.PRESET_CELLS.map(cell => ({ label: m.copy.presetLabel(cell.depth), cost: costs.get(m.cost.cellKey(cell)), current: false })) })),
      renderToStaticMarkup(React.createElement(m.PresetPicker, { cell: { density: 'full', depth: 'quick' }, applies: true, costs: null, onPick: () => {} })),
      renderToStaticMarkup(React.createElement(m.PresetPicker, { cell: { density: 'full', depth: 'quick' }, applies: false, costs: null, onPick: () => {} })),
      renderToStaticMarkup(React.createElement(m.DepthChoice, { depth: 'blueprint', depths: m.DEPTHS, applies: true, offReason: m.copy.depthOffReason(), onDepth: () => {} })),
      renderToStaticMarkup(React.createElement(m.DepthChoice, { depth: 'quick', depths: m.DEPTHS, applies: false, offReason: m.copy.depthOffReason(), onDepth: () => {} })),
      renderToStaticMarkup(React.createElement(m.CostMatrix, { matrix: m.words.matrixWords(m.cost.cellCosts(answers, m.cost.MATRIX_CELLS), { density: 'full', depth: 'quick' }, { columns: m.copy.matrixColumns(), depths: m.DEPTHS }) })),
    ].join('');
    assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), han);
    assert.match(html, /Quick about ×0\.3/);
  } finally { m.setUiLanguage('zh'); }
});

test('a ratio under 0.05 is never 「×0」: it says it is under ×0.1', () => {
  m.setUiLanguage('zh');
  assert.equal(m.words.ratioText(0.04), '不到 ×0.1');
  assert.equal(m.words.ratioText(0.04, { bare: true }), '<×0.1');
  assert.equal(m.words.ratioText(0.05), '约 ×0.1', '0.05 rounds to 0.1 as before');
  m.setUiLanguage('en');
  try { assert.equal(m.words.ratioText(0.01), 'under ×0.1'); } finally { m.setUiLanguage('zh'); }
});

test('a typed number of questions: the presets read 自定义 with that number (never a level\'s amount), and no rough cost is shown', () => {
  m.setUiLanguage('zh');
  const html = renderToStaticMarkup(React.createElement(m.PresetPicker, { cell: { density: 'standard', depth: 'scenario', count: 40 }, applies: true, costs: null, onPick: () => {} }));
  assert.match(html, /data-preset="custom"/);
  assert.doesNotMatch(html, /aria-pressed="true"/, 'no preset is lit');
  assert.match(text(html), /自定义：40 题 × 情境题。/);
  assert.doesNotMatch(text(html), /标准题量|标准 ×/, 'the note names no level\'s amount');
  assert.doesNotMatch(html, /data-preset-cost/);
  // Every ratio is the estimate of a level; a run by a typed number would not be that run, so nothing is priced while one is set.
  const on = { applies: true, sources: 2, count: null, held: false };
  assert.equal(m.cost.pricesCells(on), true);
  assert.equal(m.cost.pricesCells({ ...on, count: 40 }), false, 'a typed number: no ratio, no matrix');
  assert.equal(m.cost.pricesCells({ ...on, sources: 0 }), false, 'no materials chosen: usage.estimate is not asked');
  assert.equal(m.cost.pricesCells({ ...on, applies: false }), false, 'the depth does not apply (another question type): not asked');
  assert.equal(m.cost.pricesCells({ ...on, held: true }), false, 'a blocked button, the steps of a path or an unusable sample: not asked');
  m.setUiLanguage('en');
  try {
    const en = renderToStaticMarkup(React.createElement(m.PresetPicker, { cell: { density: 'standard', depth: 'quick', count: 40 }, applies: true, costs: null, onPick: () => {} }));
    assert.match(text(en), /Custom: 40 questions × Quick\./);
  } finally { m.setUiLanguage('zh'); }
});

test('the cells are asked again on every pass, the way the form\'s own estimate is: a failure is not kept, and a pass that is gone stops asking', async () => {
  const requests = [{ coverageLevel: 'standard' }, { coverageLevel: 'lean' }].map(item => JSON.stringify(item));
  let fail = true;
  const asked = [], answers = new Map();
  const call = async (action, args) => { asked.push([action, args.coverageLevel]); if (fail && args.coverageLevel === 'lean') throw new Error('busy'); return { totalTokens: { low: 1, high: 2 } }; };
  const answer = (request, estimate) => answers.set(request, estimate);
  await m.askCells(call, requests, { isLive: () => true, answer });
  assert.deepEqual(asked, [['usage.estimate', 'standard'], ['usage.estimate', 'lean']]);
  assert.equal(answers.get(requests[1]), null, 'a failed cell says nothing this pass');
  fail = false;
  await m.askCells(call, requests, { isLive: () => true, answer });
  assert.equal(asked.length, 4, 'both cells asked again: nothing was cached, the failure least of all');
  assert.deepEqual(answers.get(requests[1]), { totalTokens: { low: 1, high: 2 } }, 'and the cost comes back');
  const empty = await m.askCells(async () => ({ totalTokens: { low: 0, high: 0 } }), requests.slice(0, 1), { isLive: () => true, answer });
  assert.equal(empty, undefined);
  assert.equal(answers.get(requests[0]), null, 'an estimate of nothing is no estimate');
  let live = true, seen = 0;
  await m.askCells(async () => { live = false; return { totalTokens: { low: 1, high: 2 } }; }, requests, { isLive: () => live, answer: () => { seen++; } });
  assert.equal(seen, 0, 'an answer that arrives after the form moved on is dropped, and the rest is not asked');
});

test('the form\'s 出题深度 is sent as performance with this run and its estimate; a form without one sends none (the saved one applies)', () => {
  const gen = { ...m.generationFormDefaults(undefined, 'zh'), kind: 'quiz', kinds: ['quiz'] };
  const where = { course: '', sourceIds: ['a'] };
  const { depth: _depth, ...plain } = gen;
  assert.equal('performance' in m.generationRequest(plain, where), false);
  assert.equal('performance' in m.estimateRequestOf(plain, where), false);
  for (const [depth, performance] of [['quick', { strategy: 'one-pass', writeStyle: 'quick' }], ['scenario', { strategy: 'one-pass', writeStyle: 'scenario' }],
    ['blueprint', { strategy: 'staged', writeStyle: 'scenario' }]]) {
    assert.deepEqual(m.generationRequest({ ...plain, depth }, where).performance, performance, `${depth}: the run`);
    assert.deepEqual(m.estimateRequestOf({ ...plain, depth }, where).performance, performance, `${depth}: its estimate`);
  }
  assert.equal('performance' in m.generationRequest({ ...plain, depth: 'loud' }, where), false, 'an unknown depth is not sent');
});

test('the copy names the default preset only where lib/contexts/generation/presets.js says it is the default', () => {
  m.setUiLanguage('zh');
  // The copy says 「情境题（默认）」 and prices against 「情境题」: if the default preset moves, this fails until the words move with it.
  const [defaultCell] = m.cost.cellsToAsk(m.cost.PRESET_CELLS);
  const defaultPreset = m.presetOf(defaultCell);
  assert.equal(defaultPreset, 'scenario');
  assert.deepEqual(defaultCell, { density: 'standard', depth: 'scenario' });
  for (const { id } of m.PRESETS) assert.equal(/（默认）/.test(m.copy.presetNote(id)), id === defaultPreset, `${id}: 默认 only on the default`);
  const label = m.copy.presetLabel(defaultPreset);
  assert.ok(m.words.costTip().includes(`「${label}」`), 'the hover card prices against the default');
  const matrix = m.words.matrixWords(m.cost.cellCosts(new Map(), m.cost.MATRIX_CELLS), defaultCell, { columns: m.copy.matrixColumns(), depths: m.DEPTHS });
  assert.ok(matrix.caption.includes(`「${label}」`), 'and so does the caption of the matrix');
});
