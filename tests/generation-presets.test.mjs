import test from 'node:test';
import assert from 'node:assert/strict';
import { DENSITIES, DEPTHS, PRESETS, DEFAULT_CELL, performanceOfDepth, depthOf, settingsOfCell, presetOf, presetCell, depthApplies, costRatio }
  from '../lib/contexts/generation/presets.js';
import { levelOf } from '../lib/coverage-strength.js';
import { GENERATION_COVERAGE_LEVELS, GENERATION_SETTINGS_DEFAULTS, normalizeGenerationSettings } from '../lib/generation-settings.js';

/* The preset matrix of 出题方式 (owner 2026-11-21, plan §7 item 6): two axes, density (the 覆盖强度 levels) × depth (快问 / 情境题 / 逐题精出); the main path offers three
   cells as presets, any other cell is 自定义. One module says it all, for the form, the settings and the backend. */

test('the axes: density is the coverage levels unchanged, depth is quick, scenario and the staged pipeline', () => {
  assert.deepEqual(DENSITIES, GENERATION_COVERAGE_LEVELS);
  assert.deepEqual(DEPTHS, ['quick', 'scenario', 'blueprint']);
  assert.deepEqual(performanceOfDepth('quick'), { strategy: 'one-pass', writeStyle: 'quick' });
  assert.deepEqual(performanceOfDepth('scenario'), { strategy: 'one-pass', writeStyle: 'scenario' });
  assert.deepEqual(performanceOfDepth('blueprint'), { strategy: 'staged', writeStyle: 'scenario' }, 'the staged pipeline has no write style; the default rides along so the shape is the same');
  assert.deepEqual(performanceOfDepth('nonsense'), performanceOfDepth('scenario'), 'an unknown depth is the default');
});

test('three presets: 快问 (lean × quick), 情境题 (standard × scenario, the default), 逐题精出 (standard × staged)', () => {
  assert.deepEqual(PRESETS.map(({ id, density, depth }) => [id, density, depth]), [['quick', 'lean', 'quick'], ['scenario', 'standard', 'scenario'], ['blueprint', 'standard', 'blueprint']]);
  assert.equal(presetOf(DEFAULT_CELL), 'scenario');
  assert.deepEqual(DEFAULT_CELL, { density: 'standard', depth: 'scenario' });
  assert.deepEqual(presetCell('quick'), { density: 'lean', depth: 'quick' });
  assert.equal(presetCell('nope'), null);
});

// The cell of saved settings or of a request, as the form and 设置 read it.
const cellOf = ({ coverageLevel, performance } = {}) => ({ density: levelOf(coverageLevel), depth: depthOf(performance) });

test('the default preset is today\'s default exactly: the saved defaults read as 情境题', () => {
  const saved = normalizeGenerationSettings({});
  assert.deepEqual(cellOf({ coverageLevel: saved.coverageLevel, performance: saved }), DEFAULT_CELL);
  assert.equal(presetOf(cellOf({ coverageLevel: GENERATION_SETTINGS_DEFAULTS.coverageLevel, performance: GENERATION_SETTINGS_DEFAULTS })), 'scenario');
  assert.deepEqual(settingsOfCell(DEFAULT_CELL), { coverageLevel: 'standard', performance: { strategy: 'one-pass', writeStyle: 'scenario' } });
});

test('cell → settings → cell is the same cell for all nine cells; only the three preset cells are presets', () => {
  for (const density of DENSITIES) for (const depth of DEPTHS) {
    const settings = settingsOfCell({ density, depth });
    assert.deepEqual(cellOf(settings), { density, depth }, `${density} × ${depth}`);
    const preset = PRESETS.find(item => item.density === density && item.depth === depth)?.id ?? null;
    assert.equal(presetOf({ density, depth }), preset, `${density} × ${depth} is ${preset ?? '自定义'}`);
  }
});

test('the depth of saved settings: staged is 逐题精出 whatever the style; a library that saved no strategy follows the S8 migration', () => {
  assert.equal(depthOf({ strategy: 'staged', writeStyle: 'quick' }), 'blueprint');
  assert.equal(depthOf({ strategy: 'one-pass', writeStyle: 'quick' }), 'quick');
  assert.equal(depthOf({}), 'scenario');
  assert.equal(depthOf({ applySuggestions: true }), 'blueprint', 'a library that turned on 采纳审阅建议 and never chose stays staged');
  assert.equal(depthOf({ writeStyle: 'nonsense' }), 'scenario');
});

test('the depth applies only where one pass applies: every kind multiple choice, not a case paper', () => {
  assert.equal(depthApplies({ kind: 'quiz' }), true);
  assert.equal(depthApplies({ kinds: ['quiz'] }), true);
  assert.equal(depthApplies({ kinds: ['quiz', 'flashcard'] }), false);
  assert.equal(depthApplies({ kind: 'flashcard' }), false);
  assert.equal(depthApplies({ kind: 'mixed' }), false);
  assert.equal(depthApplies({ kind: 'case' }), false);
});

test('the cost ratio is the upper end of the cell\'s estimate over the default cell\'s, and none without both', () => {
  const estimate = high => ({ totalTokens: { low: high / 4, high } });
  assert.equal(costRatio(estimate(600), estimate(1000)), 0.6);
  assert.equal(costRatio(estimate(1700), estimate(1000)), 1.7);
  assert.equal(costRatio(null, estimate(1000)), null);
  assert.equal(costRatio(estimate(600), null), null);
  assert.equal(costRatio(estimate(600), estimate(0)), null, 'no ratio of nothing');
  assert.equal(costRatio({ totalTokens: { low: 0, high: 0 } }, estimate(1000)), null);
});

test('a typed number of questions is no preset: the run is planned by that number, not by the level any preset names', () => {
  assert.equal(presetOf({ density: 'standard', depth: 'scenario', count: 40 }), null, '40 题 × 情境题 is 自定义');
  assert.equal(presetOf({ density: 'lean', depth: 'quick', count: 12 }), null);
  assert.equal(presetOf({ density: 'standard', depth: 'scenario', count: null }), 'scenario', 'no number: the level decides, and the cell may be a preset');
});
