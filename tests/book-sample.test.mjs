/* The sample slice of a 复习全书 build (#710), without a model: which two points it writes, what a build does about it, the approved sample's words and length
   band, and the scale of the whole build scaled from what the sample really used (no prices). The Job itself: tests/book-sample-job.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorOf, bandOf, candidateOf, exemplarOf, pickSample, sampleMode } from '../lib/contexts/generation/book/sample.js';
import { scaleEstimate } from '../lib/contexts/generation/book/estimate.js';
import { EXEMPLAR_CHARS, SAMPLE_FROM } from '../lib/contexts/generation/book/constants.js';
import { normalizeSample } from '../lib/course-book-sample.js';

const node = (id, items, anchors = 1, tested = false) => ({ id, items: Array.from({ length: items }, (_, k) => `${id}-${k}`), anchors: Array.from({ length: anchors }, (_, k) => `d${k}`),
  ...(tested ? { exam: { evidence: [{ quote: 'Q1' }] } } : {}) });
const course = (weights, tested = []) => weights.map((items, at) => candidateOf(node(`p${at}`, items, 1, tested.includes(at))));

test('the pick: the typical point (median weight) and the heavy one (the heaviest of the rest); a tested point preferred as the typical one', () => {
  const weights = [3, 9, 4, 5, 2, 6, 4, 5, 7, 3, 4, 5];
  assert.equal(weights.length, SAMPLE_FROM);
  assert.deepEqual(pickSample(course(weights)), { typical: 'p2', heavy: 'p1' }, 'median 4: the first point of that weight; the heaviest is 9');
  assert.deepEqual(pickSample(course(weights, [8, 11])), { typical: 'p11', heavy: 'p1' }, 'the tested point nearest the median');
  assert.deepEqual(pickSample(course(weights, [1])), { typical: 'p1', heavy: 'p8' }, 'the only tested point is the typical one; the heavy one is the heaviest of the rest');
  assert.equal(pickSample(course(weights.slice(1))), null, 'too few points to write: no sample, the build writes them all');
  assert.deepEqual(pickSample(course(weights), { leaves: ['p5', 'p0'] }), { typical: 'p5', heavy: 'p0' }, 'made again: the same two points');
  assert.deepEqual(pickSample(course(weights), { leaves: ['p5', 'gone'] }), { typical: 'p2', heavy: 'p1' }, 'a point of it left the outline: picked anew');
  assert.equal(candidateOf({ id: 'x', anchors: ['a', 'b'] }).weight < candidateOf({ id: 'y', items: ['i'], anchors: [] }).weight, true, 'concepts weigh more than anchors');
});

test('what a build does about the sample: make one, build the rest with it, use an approved one, or none', () => {
  const waiting = { status: 'waiting', level: 'standard', language: 'zh', exemplar: 'Text.', band: { low: 100, high: 200 } };
  const approved = { ...waiting, status: 'confirmed' };
  const at = (asked, sample, extra = {}) => sampleMode({ asked, sample, level: 'standard', language: 'zh', ...extra });
  assert.deepEqual(at('auto', null), { make: true, anchor: null, confirm: false }, 'a first build makes a sample');
  assert.deepEqual(at('auto', waiting), { make: true, anchor: null, confirm: false }, 'asked again without building the rest: the sample again (kept points cost nothing)');
  assert.deepEqual(at('confirm', waiting), { make: false, anchor: anchorOf(waiting), confirm: true }, 'build the rest: the sample becomes the anchor');
  assert.deepEqual(at('auto', approved), { make: false, anchor: anchorOf(approved), confirm: false }, 'an approved sample is every later build\'s anchor');
  assert.deepEqual(at('auto', approved, { level: 'full' }), { make: true, anchor: null, confirm: false }, 'another detail level: a new sample');
  assert.deepEqual(at('confirm', waiting, { level: 'full' }), { stale: true }, 'the settings changed since the sample: refused, nothing is built');
  assert.deepEqual(at('confirm', null), { stale: true });
  assert.deepEqual(at('skip', null), { make: false, anchor: null, confirm: false }, 'skip: the whole book now');
  assert.deepEqual(at('auto', null, { point: 'p1' }), { make: false, anchor: null, confirm: false }, '补漏 of one point never makes a sample');
  assert.deepEqual(at('auto', approved, { point: 'p1' }).anchor, anchorOf(approved), '…and writes it like the approved sample');
  assert.equal(anchorOf({ ...approved, exemplar: '' }), null, 'a sample nothing was written for anchors nothing');
});

const body = (text, must) => ({ units: [{ text, cites: [] }], coverage: { must, covered: [], missing: [] } });

test('the approved sample\'s words: the text without its marks, cut at a paragraph within the budget; its band in characters per must item', () => {
  const long = Array.from({ length: 40 }, (_, k) => `Paragraph ${k}: the threat model names what to protect and from whom [^1].`).join('\n\n');
  const words = exemplarOf(body(long, 4));
  assert.ok(words.length <= EXEMPLAR_CHARS + 2 && words.endsWith('…'), `cut within the budget (${words.length})`);
  assert.ok(!words.includes('[^1]') && /Paragraph 0: .*whom\.\n\nParagraph 1:/.test(words), 'no marks; paragraphs kept');
  assert.equal(exemplarOf(body('Short and whole [^1].', 1)), 'Short and whole.');
  assert.deepEqual(bandOf([body('x'.repeat(1000), 4), body('y'.repeat(900), 2)]), { low: 250, high: 450 });
  assert.deepEqual(bandOf([body('x'.repeat(300), 0)]), { low: 300, high: 300 }, 'a point without must items counts its whole text');
});

const usage = (input, output) => ({ uncachedInputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 });
const call = (stage, part, input, output, ms = 1000) => ({ stage, part, status: 'ok', modelRequest: true, tokenUsage: usage(input, output),
  startedAt: new Date(0).toISOString(), endedAt: new Date(ms).toISOString() });

test('the scale of the whole build, from what the sample really used: the typical point is the low end, the sample\'s average the high end', () => {
  // The typical point: write, review (2 calls, 1,500 tokens, 20 s); the heavy one: write, review, repair, review (4 calls, 6,000 tokens, 60 s).
  const calls = [call('inventory', 1, 900, 100), call('write', 3, 800, 400, 12000), call('review', 3, 200, 100, 8000),
    call('write', 7, 1500, 900, 20000), call('review', 7, 800, 200, 10000), call('repair', 7, 1000, 600, 20000), call('review', 7, 800, 200, 10000),
    call('exam', 1, 300, 100, 4000), { stage: 'write', part: 7, status: 'skipped', reused: true, modelRequest: false }];
  const estimate = scaleEstimate({ calls, rest: { points: 100, tested: 20, inventory: 10 }, total: 102, sample: 2, concurrency: 4 });
  assert.deepEqual(estimate.points, { total: 102, sample: 2, rest: 100 });
  // Calls: 100 points x 2 (low) or 3 (high) + 3 exam calls (20 tested / 8 a call) + 10 inventory calls.
  assert.deepEqual(estimate.calls, { low: 213, high: 313 });
  // Tokens: 100 x 1,500 or 100 x 3,750, plus 3 x 400 for 考情 and 10 x 1,000 for the inventory.
  assert.deepEqual(estimate.totalTokens, { low: 161200, high: 386200 });
  assert.deepEqual(estimate.outputTokens, { low: 50000 + 300 + 1000, high: 120000 + 300 + 1000 });
  assert.equal(estimate.inputTokens.low, estimate.uncachedInputTokens.low + estimate.cacheReadTokens.low);
  // Time: 25 rounds of 4 points (20 s or 40 s a point), the 13 other calls 4 at a time; to the nearest minute (8.4 and 16.7 minutes).
  assert.deepEqual(estimate.minutes, { low: 8, high: 17 });
  const quick = scaleEstimate({ calls: calls.map(item => ({ ...item, endedAt: new Date(20).toISOString() })), rest: { points: 3, tested: 0, inventory: 0 }, total: 5, sample: 2, concurrency: 4 });
  assert.deepEqual(quick.minutes, { low: 0, high: 0 }, 'calls of a few milliseconds: under a minute, not "about 1 minute"');
  assert.equal(estimate.concurrency, 4);
  assert.deepEqual(estimate.stages.map(stage => [stage.id, stage.calls]), [['bookPoints', 250], ['exam', 3], ['inventory', 10]]);
  assert.ok(!JSON.stringify(estimate).match(/price|cost|元|\$/i), 'no prices');
  assert.equal(scaleEstimate({ calls: [], rest: { points: 5, tested: 0, inventory: 0 }, total: 7, sample: 2, concurrency: 3 }), null, 'nothing was asked: nothing to scale');
  const blind = scaleEstimate({ calls: calls.map(item => ({ ...item, tokenUsage: null })), rest: { points: 100, tested: 0, inventory: 0 }, total: 102, sample: 2, concurrency: 4 });
  assert.equal(blind.totalTokens, null, 'a provider that reports no usage: calls and time only');
  assert.deepEqual(blind.calls, { low: 200, high: 300 });
});

test('the sample as the book record keeps it: checked where it enters, unknown fields dropped', () => {
  const kept = normalizeSample({ status: 'waiting', level: 'standard', language: 'zh', leaves: ['p2', 'p1'], exemplar: 'Text\n\nmore', band: { low: 100.4, high: 220 },
    estimate: { points: { total: 12, sample: 2, rest: 10 }, calls: { low: 20, high: 30 }, totalTokens: { low: 1, high: 2 }, minutes: { low: 1, high: 2 }, concurrency: 3,
      stages: [{ id: 'bookPoints', calls: 25, inputTokens: { low: 1, high: 2 }, outputTokens: { low: 1, high: 2 } }], price: 9 }, extra: true });
  assert.equal(kept.exemplar, 'Text\n\nmore');
  assert.deepEqual(kept.band, { low: 100, high: 220 });
  assert.equal(kept.extra, undefined);
  assert.equal(kept.estimate.price, undefined);
  assert.deepEqual(kept.estimate.points, { total: 12, sample: 2, rest: 10 });
  assert.equal(normalizeSample({ status: 'other' }), null, 'a state this release does not know is not kept');
});
