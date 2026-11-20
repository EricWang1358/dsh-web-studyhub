import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateRun } from '../lib/token-estimate.js';
import { packPortions } from '../lib/one-pass/portions.js';
import { ONE_PASS_LIMITS } from '../lib/one-pass/limits.js';

/* The estimate of a round written in one pass is priced as one pass runs it (lib/batch.js, lib/one-pass/portion.js), not as the staged pipeline:
   per portion ONE write call and one review call per batch of at most `reviewBatch` cards, plus ONE same-fact merge call per round. The rewrite of the
   options (at most one call per portion) is an allowance of the upper end only: the low end does not count it, the high end does. */

const text = 'The heart pumps blood through the body. '.repeat(1500);
const sources = [{ id: 'doc', title: 'Doc', text }];
// 12 sections of 2 400 characters with 4 questions each: three per portion by characters (9 000), and 12 cards a portion.
const assignments = Array.from({ length: 12 }, (_, index) => ({ key: `doc#s${index + 1}`, sectionId: `doc#s${index + 1}`, sourceId: 'doc', title: `Section ${index + 1}`,
  start: index * 2400, end: index * 2400 + 2400, quota: 4 }));
const count = assignments.reduce((sum, item) => sum + item.quota, 0);
const stage = (estimate, id) => estimate.stages.find(item => item.id === id);

test('one pass is priced per portion: one write, ceil(cards / 7) reviews, one merge per round; the rewrite only in the high end', () => {
  const portions = packPortions(assignments);
  assert.ok(portions.length >= 3, `${portions.length} portions`);
  const reviews = portions.reduce((sum, portion) => sum + Math.ceil(portion.questions / ONE_PASS_LIMITS.reviewBatch), 0);
  const estimate = estimateRun('generate', { sources, count, assignments, kind: 'quiz', performance: { strategy: 'one-pass' } });
  assert.equal(stage(estimate, 'blueprint'), undefined, 'no blueprint call');
  assert.equal(stage(estimate, 'plan'), undefined, 'no planning call');
  assert.equal(stage(estimate, 'author').calls, portions.length, 'one write call per portion');
  assert.equal(stage(estimate, 'review').calls, reviews + 1, 'the review batches and the one merge');
  assert.equal(estimate.calls.low, portions.length + reviews + 1);
  assert.equal(estimate.calls.high, estimate.calls.low + portions.length, 'a rewrite per portion at most');
  assert.equal(stage(estimate, 'author').callsHigh, portions.length * 2);
  assert.ok(stage(estimate, 'author').inputTokens.high > stage(estimate, 'author').inputTokens.low, 'the rewrite adds to the high end');
  assert.ok(stage(estimate, 'author').inputTokens.high < stage(estimate, 'author').inputTokens.low * 2, 'a rewrite carries the options, not the material');
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
