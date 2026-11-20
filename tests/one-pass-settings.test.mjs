import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERATION_SETTINGS_DEFAULTS, GENERATION_STRATEGIES, normalizeGenerationPerformance, normalizeGenerationSettings, resolveGenerationRequest,
  validateGenerationPatch, validateGenerationPerformance } from '../lib/generation-settings.js';
import { runsInOnePass, questionRange } from '../lib/one-pass/route.js';
import { ONE_PASS_LIMITS } from '../lib/one-pass/limits.js';

/* The strategy of a run (出题方式): one pass is the default, the staged pipeline stays selectable; the setting is stored and validated with the other
   generation performance settings, and a run it cannot serve is written by the staged pipeline. */

const assignments = [{ key: 'doc#s1', sectionId: 'doc#s1', sourceId: 'doc', start: 0, end: 100, quota: 1 }];

test('the strategy is a performance setting with two values, one pass by default', () => {
  assert.deepEqual(GENERATION_STRATEGIES, ['one-pass', 'staged']);
  assert.equal(GENERATION_SETTINGS_DEFAULTS.strategy, 'one-pass');
  assert.equal(normalizeGenerationPerformance({}).strategy, 'one-pass');
  assert.equal(normalizeGenerationPerformance({ strategy: 'staged' }).strategy, 'staged');
  assert.equal(normalizeGenerationSettings({ strategy: 'nonsense' }).strategy, 'one-pass', 'a corrupt saved value falls back to the default');
});

test('the strategy is validated like the other settings', () => {
  assert.deepEqual(validateGenerationPatch({ strategy: 'staged' }), { strategy: 'staged' });
  assert.deepEqual(validateGenerationPerformance({ strategy: 'one-pass' }), { strategy: 'one-pass' });
  assert.throws(() => validateGenerationPatch({ strategy: 'fast' }), /Invalid generation setting: strategy/);
});

test('a run is resolved with the strategy of the settings, and an explicit performance may choose the other one', () => {
  assert.equal(resolveGenerationRequest({}, {}).performance.strategy, 'one-pass');
  assert.equal(resolveGenerationRequest({ strategy: 'staged' }, {}).performance.strategy, 'staged');
  assert.equal(resolveGenerationRequest({}, { performance: { strategy: 'staged' } }).performance.strategy, 'staged');
  // A draft written before the setting existed is continued by the default.
  assert.equal(resolveGenerationRequest({}, {}, { continuation: { kind: 'quiz', performance: { concurrency: 2 } } }).performance.strategy, 'one-pass');
});

test('one pass writes a coverage run of multiple-choice questions; everything else falls back to the staged pipeline', () => {
  const run = extra => runsInOnePass({ kind: 'quiz', assignments, performance: {}, ...extra });
  assert.equal(run(), true);
  assert.equal(run({ kinds: ['quiz'] }), true);
  assert.equal(run({ performance: { strategy: 'staged' } }), false, 'the staged strategy');
  assert.equal(run({ kind: 'flashcard' }), false, 'a kind one pass does not write');
  assert.equal(run({ kind: 'mixed' }), false, 'quiz with flashcards');
  assert.equal(run({ kinds: ['quiz', 'open'] }), false);
  assert.equal(run({ kind: 'case' }), false);
  assert.equal(run({ assignments: undefined, count: 10 }), false, 'a plain run by a number of questions stays staged in this slice');
  assert.equal(run({ assignments: [] }), false);
});

test('the forecast of a one-pass run is a range: the plan is the upper end, the lower end allows for dropped questions', () => {
  assert.deepEqual(questionRange(40), { low: Math.floor(40 * ONE_PASS_LIMITS.forecastKeepShare), high: 40 });
  assert.deepEqual(questionRange(1), { low: 1, high: 1 }, 'never below one question when one is planned');
  assert.deepEqual(questionRange(0), { low: 0, high: 0 });
});
