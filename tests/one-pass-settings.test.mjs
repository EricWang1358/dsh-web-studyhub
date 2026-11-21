import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERATION_SETTINGS_DEFAULTS, GENERATION_STRATEGIES, GENERATION_WRITE_STYLES, normalizeGenerationPerformance, normalizeGenerationSettings, resolveGenerationRequest,
  validateGenerationPatch, validateGenerationPerformance } from '../lib/generation-settings.js';
import { runsInOnePass, questionRange, writtenWith } from '../lib/one-pass/route.js';
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

test('a continuation keeps the strategy its draft was written with; a draft recorded before the setting existed was written staged and goes on staged', () => {
  assert.equal(resolveGenerationRequest({}, {}, { continuation: { performance: { strategy: 'one-pass' } } }).performance.strategy, 'one-pass');
  assert.equal(resolveGenerationRequest({ strategy: 'one-pass' }, {}, { continuation: { performance: { strategy: 'staged' } } }).performance.strategy, 'staged');
  assert.equal(resolveGenerationRequest({}, {}, { continuation: { performance: { concurrency: 2 } } }).performance.strategy, 'staged', 'an old draft');
  assert.equal(resolveGenerationRequest({}, {}, { continuation: { kind: 'quiz' } }).performance.strategy, 'staged', 'an old draft with no performance at all');
  assert.equal(resolveGenerationRequest({}, { performance: { strategy: 'one-pass' } }, { continuation: { performance: {} } }).performance.strategy, 'one-pass', 'unless the request chooses');
});

// Gate S8: a learner who turned on 采纳审阅建议 chose quality over speed before 出题方式 existed. One pass does not use that setting, so their library stays staged
// until they choose; everyone else gets one pass. A strategy saved by the learner is kept as it is, whatever else is on.
test('a library that saved applySuggestions on and no strategy resolves to the staged pipeline; a saved strategy wins', () => {
  assert.equal(normalizeGenerationSettings({ applySuggestions: true }).strategy, 'staged');
  assert.equal(normalizeGenerationPerformance({ applySuggestions: true }).strategy, 'staged');
  assert.equal(resolveGenerationRequest({ applySuggestions: true }, {}).performance.strategy, 'staged');
  assert.equal(normalizeGenerationSettings({ applySuggestions: true, strategy: 'one-pass' }).strategy, 'one-pass');
  assert.equal(normalizeGenerationSettings({ applySuggestions: false }).strategy, 'one-pass');
  assert.equal(normalizeGenerationSettings({ applySuggestions: true, strategy: 'nonsense' }).strategy, 'staged', 'a corrupt strategy is no choice');
  assert.equal(resolveGenerationRequest({ applySuggestions: true }, { performance: { strategy: 'one-pass' } }).performance.strategy, 'one-pass', 'a request may still choose');
});

/* 写法 (writeStyle, lib/one-pass/write-style.js): how one pass asks its cards, a performance setting next to the strategy (scenario by default). It is part of what a draft was
   written with: a continuation keeps it, a draft recorded before the setting existed was written in the scenario style. A request may choose for itself. */
test('the write style is a validated performance setting, scenario by default', () => {
  assert.deepEqual(GENERATION_WRITE_STYLES, ['scenario', 'quick']);
  assert.equal(GENERATION_SETTINGS_DEFAULTS.writeStyle, 'scenario');
  assert.equal(normalizeGenerationPerformance({}).writeStyle, 'scenario');
  assert.equal(normalizeGenerationPerformance({ writeStyle: 'quick' }).writeStyle, 'quick');
  assert.equal(normalizeGenerationSettings({ writeStyle: 'loud' }).writeStyle, 'scenario', 'a corrupt saved value falls back to the default');
  assert.deepEqual(validateGenerationPatch({ writeStyle: 'quick' }), { writeStyle: 'quick' });
  assert.deepEqual(validateGenerationPerformance({ writeStyle: 'scenario' }), { writeStyle: 'scenario' });
  assert.throws(() => validateGenerationPatch({ writeStyle: 'loud' }), /Invalid generation setting: writeStyle/);
});

test('a run takes the saved write style; a choice of the request wins for that run only', () => {
  assert.equal(resolveGenerationRequest({}, {}).performance.writeStyle, 'scenario');
  assert.equal(resolveGenerationRequest({ writeStyle: 'quick' }, {}).performance.writeStyle, 'quick');
  assert.equal(resolveGenerationRequest({ writeStyle: 'quick' }, { performance: { writeStyle: 'scenario' } }).performance.writeStyle, 'scenario');
  assert.equal(resolveGenerationRequest({}, { performance: { strategy: 'one-pass', writeStyle: 'quick' } }).performance.writeStyle, 'quick');
  assert.throws(() => resolveGenerationRequest({}, { performance: { writeStyle: 'loud' } }), /Invalid generation setting: writeStyle/);
});

test('a continuation keeps the write style its draft was written with; an earlier one-pass draft was written in the scenario style', () => {
  assert.equal(resolveGenerationRequest({ writeStyle: 'scenario' }, {}, { continuation: { performance: { strategy: 'one-pass', writeStyle: 'quick' } } }).performance.writeStyle, 'quick');
  assert.equal(resolveGenerationRequest({ writeStyle: 'quick' }, {}, { continuation: { performance: { strategy: 'one-pass', writeStyle: 'scenario' } } }).performance.writeStyle, 'scenario');
  assert.equal(resolveGenerationRequest({ writeStyle: 'quick' }, {}, { continuation: { performance: { strategy: 'one-pass' } } }).performance.writeStyle, 'scenario', 'recorded before the setting');
  assert.equal(resolveGenerationRequest({ writeStyle: 'quick' }, { performance: { writeStyle: 'quick' } }, { continuation: { performance: { strategy: 'one-pass' } } }).performance.writeStyle, 'quick', 'unless the request chooses');
});

test('the draft records the write style only when one pass wrote it: the staged pipeline has none', () => {
  const performance = normalizeGenerationPerformance({ writeStyle: 'quick' });
  assert.deepEqual(writtenWith(performance, true), { ...performance, strategy: 'one-pass', writeStyle: 'quick' });
  const staged = writtenWith(performance, false);
  assert.equal(staged.strategy, 'staged');
  assert.equal('writeStyle' in staged, false);
  assert.deepEqual(Object.keys(staged), Object.keys(performance).filter(key => key !== 'writeStyle'), 'the other keys as they were, in their order');
});
