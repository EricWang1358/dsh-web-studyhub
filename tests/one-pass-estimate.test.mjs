import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateRun } from '../lib/token-estimate.js';
import { packPortions } from '../lib/one-pass/portions.js';
import { ONE_PASS_LIMITS } from '../lib/one-pass/limits.js';

/* The estimate of a round written in one pass is priced as one pass runs it (lib/batch.js, lib/one-pass/portion.js), not as the staged pipeline:
   per portion ONE write call and one review call per batch of at most `reviewBatch` cards, plus ONE same-fact merge call per round. The rewrite of the
   options (at most one call per portion), the re-ask of a section left without a card (at most one per section, a write over that section alone) and the second try
   of a review batch are an allowance of the upper end only: the low end does not count them, the high end does (gate round 2). */

const text = 'The heart pumps blood through the body. '.repeat(1500);
const sources = [{ id: 'doc', title: 'Doc', text }];
// 12 sections of 2 400 characters with 4 questions each: three per portion by characters (9 000), and 12 cards a portion.
const assignments = Array.from({ length: 12 }, (_, index) => ({ key: `doc#s${index + 1}`, sectionId: `doc#s${index + 1}`, sourceId: 'doc', title: `Section ${index + 1}`,
  start: index * 2400, end: index * 2400 + 2400, quota: 4 }));
const count = assignments.reduce((sum, item) => sum + item.quota, 0);
const stage = (estimate, id) => estimate.stages.find(item => item.id === id);

test('one pass is priced per portion: one write, ceil(cards / 7) reviews, one merge per round; the rewrite, re-asks and second reviews only in the high end', () => {
  const portions = packPortions(assignments);
  assert.ok(portions.length >= 3, `${portions.length} portions`);
  const reviews = portions.reduce((sum, portion) => sum + Math.ceil(portion.questions / ONE_PASS_LIMITS.reviewBatch), 0);
  const estimate = estimateRun('generate', { sources, count, assignments, kind: 'quiz', performance: { strategy: 'one-pass' } });
  assert.equal(stage(estimate, 'blueprint'), undefined, 'no blueprint call');
  assert.equal(stage(estimate, 'plan'), undefined, 'no planning call');
  assert.equal(stage(estimate, 'author').calls, portions.length, 'one write call per portion');
  assert.equal(stage(estimate, 'review').calls, reviews + 1, 'the review batches and the one merge');
  assert.equal(estimate.calls.low, portions.length + reviews + 1);
  assert.equal(estimate.calls.high, estimate.calls.low + portions.length + assignments.length + reviews, 'a rewrite per portion, a re-ask per section, a second try per review batch');
  assert.equal(stage(estimate, 'author').callsHigh, portions.length * 2 + assignments.length);
  assert.equal(stage(estimate, 'review').callsHigh, reviews * 2 + 1, 'the merge is not tried twice');
  assert.ok(stage(estimate, 'author').inputTokens.high > stage(estimate, 'author').inputTokens.low, 'the allowance adds to the high end');
  // A re-ask carries one section's text, a rewrite the options: neither costs more than an average portion write.
  const write = stage(estimate, 'author').inputTokens, perWrite = write.low / portions.length;
  assert.ok(write.high <= write.low + (assignments.length + portions.length) * perWrite, 'a re-ask carries one section, not the portion');
  assert.ok(stage(estimate, 'review').inputTokens.high > stage(estimate, 'review').inputTokens.low * 1.5, 'the second tries of the reviews are in the high end');
  assert.equal(estimate.totalTokens.high, estimate.stages.reduce((sum, item) => sum + item.inputTokens.high + item.outputTokens.high, 0), 'the stages add up to the high end');
  assert.equal(estimate.totalTokens.low, estimate.stages.reduce((sum, item) => sum + item.inputTokens.low + item.outputTokens.low, 0), 'and to the low end');
});

test('the same round priced for the staged pipeline still plans, designs, writes and reviews, and costs more calls', () => {
  const staged = estimateRun('generate', { sources, count, assignments, kind: 'quiz', performance: { strategy: 'staged' } });
  const onePass = estimateRun('generate', { sources, count, assignments, kind: 'quiz', performance: { strategy: 'one-pass' } });
  assert.ok(stage(staged, 'plan') && stage(staged, 'blueprint'));
  assert.ok(staged.calls.low > onePass.calls.low);
  // A kind one pass does not write is staged whatever the setting says.
  const flash = estimateRun('generate', { sources, count, assignments, kind: 'flashcard', performance: { strategy: 'one-pass' } });
  assert.ok(stage(flash, 'blueprint'));
});

test('a top-up that also writes failed targets again prices those as the staged parts they are, beside the one-pass portions', () => {
  const reuse = [{ sources, targets: [{ objective: 'Explain why the heart pumps blood.', citations: [{ sourceId: 'doc', quote: 'The heart pumps blood' }] }] }];
  const estimate = estimateRun('generate', { sources, count, assignments, reuse, kind: 'quiz', performance: { strategy: 'one-pass' } });
  assert.equal(stage(estimate, 'blueprint').calls, 1, 'the target written again is designed');
  assert.equal(stage(estimate, 'author').calls, packPortions(assignments).length + 1);
});

// Gate round 2: the machine's calibration ratios are learned from staged runs (a one-pass run records none, lib/contexts/generation/generate/execute.js). Applied to a
// one-pass estimate they could pull the shown upper end far below what the run costs, so they are not applied to it; the thinking allowance (which only raises) still is.
test('staged calibration ratios are not applied to an estimate priced for one pass; they still correct a staged one', async () => {
  const { calibrateEstimate } = await import('../lib/token-estimate.js');
  const factors = { stages: { plan: 0.4, blueprint: 0.4, author: 0.4, review: 0.4 }, samples: 9 }, none = { stages: {}, samples: 0, defaults: {} };
  const onePass = estimateRun('generate', { sources, count, assignments, kind: 'quiz', performance: { strategy: 'one-pass' } });
  assert.equal(onePass.onePass, true);
  assert.equal(estimateRun('generate', { sources, count, assignments, kind: 'quiz', performance: { strategy: 'staged' } }).onePass, undefined);
  assert.deepEqual(calibrateEstimate(onePass, factors, none).totalTokens, calibrateEstimate(onePass, null, none).totalTokens);
  const staged = estimateRun('generate', { sources, count, assignments, kind: 'quiz', performance: { strategy: 'staged' } });
  assert.ok(calibrateEstimate(staged, factors, none).totalTokens.high < staged.totalTokens.high, 'a staged estimate is still corrected');
});

/* 写法 (writeStyle): the estimate prices the write calls with the prompt of the style, and sizes their output by the style's factor (lib/one-pass/write-style.js
   WRITE_STYLE_OUTPUT: the sample cards cannot tell the styles apart, and `quick` is not measured). The factor also scales the thinking a write call is assumed to
   write, so the figure the form shows (and the cost ratio read from it) tells a quick run from a scenario run. */
test('a quick run is priced with the quick prompt and the quick output factor, below a scenario run; the reviews are the same', async () => {
  const { calibrateEstimate } = await import('../lib/token-estimate.js');
  const { WRITE_STYLE_OUTPUT } = await import('../lib/one-pass/write-style.js');
  const priced = writeStyle => estimateRun('generate', { sources, count, assignments, kind: 'quiz', performance: { strategy: 'one-pass', writeStyle } });
  const quick = priced('quick'), scenario = priced('scenario'), plain = estimateRun('generate', { sources, count, assignments, kind: 'quiz', performance: { strategy: 'one-pass' } });
  assert.deepEqual(plain.totalTokens, scenario.totalTokens, 'the default is the scenario style');
  assert.ok(WRITE_STYLE_OUTPUT.quick < 1 && WRITE_STYLE_OUTPUT.scenario === 1);
  assert.ok(stage(quick, 'author').inputTokens.low < stage(scenario, 'author').inputTokens.low, 'the quick wording is shorter');
  assert.ok(stage(quick, 'author').outputTokens.high < stage(scenario, 'author').outputTokens.high);
  assert.deepEqual(stage(quick, 'review'), stage(scenario, 'review'));
  const assumed = { stages: {}, samples: 0 };
  const shown = estimate => calibrateEstimate(estimate, null, assumed).totalTokens.high;
  assert.ok(shown(quick) < shown(scenario), `the shown upper end tells them apart: ${shown(quick)} < ${shown(scenario)}`);
  const author = estimate => calibrateEstimate(estimate, null, assumed).stages.find(item => item.id === 'author').outputTokens.high;
  assert.ok(Math.abs(author(quick) / author(scenario) - WRITE_STYLE_OUTPUT.quick) < 0.05, 'the write output, thinking included, by the factor');
  assert.deepEqual(estimateRun('generate', { sources, count, assignments, kind: 'quiz', performance: { strategy: 'staged', writeStyle: 'quick' } }).totalTokens,
    estimateRun('generate', { sources, count, assignments, kind: 'quiz', performance: { strategy: 'staged' } }).totalTokens, 'the staged pipeline has no style');
});
