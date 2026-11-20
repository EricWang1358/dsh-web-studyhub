import test from 'node:test';
import assert from 'node:assert/strict';
import { STRENGTH, LIMITS, densityOf, goalOfChars, strengthPlan } from '../lib/coverage-strength.js';
import { coveragePlan, coverageSpec } from '../lib/coverage-plan.js';
import { packPortions } from '../lib/one-pass/portions.js';
import { ONE_PASS_LIMITS } from '../lib/one-pass/limits.js';

/* The density of a coverage plan is chosen by the strategy that will write the run (owner, 2026-11-21): one pass writes about one question per 700 characters at 标准
   (about 14 per 10 000, as the measured prototype did), with 1–6 per section; 精简 and 完整 are scaled by the staged proportions 3 : 6 : 10 (about 7 and 23; not measured).
   The staged pipeline keeps 3 / 6 / 10. Every other rule of a level (which sections, the quota range, the sanity bounds) is the same for both. */

// `n` sections of `chars` characters each in source `sourceId`, in reading order.
const sections = (n, chars, sourceId = 'doc') => Array.from({ length: n }, (_, index) => ({ id: `h${index + 1}`, key: `${sourceId}#h${index + 1}`, sourceId, chars, leaf: true,
  start: index * chars, end: index * chars + chars, title: `Section ${index + 1}` }));

test('the staged densities stay 3 / 6 / 10; one pass reads 7 / 14 / 23 from the same table', () => {
  assert.deepEqual(['lean', 'standard', 'full'].map(level => STRENGTH[level].perTenK), [3, 6, 10]);
  assert.deepEqual(['lean', 'standard', 'full'].map(level => densityOf(level)), [3, 6, 10]);
  assert.deepEqual(['lean', 'standard', 'full'].map(level => densityOf(level, { onePass: true })), [7, 14, 23]);
  assert.equal(goalOfChars(70000, 'standard'), 42);
  assert.equal(goalOfChars(70000, 'standard', { onePass: true }), 98);
});

test('a one-pass plan at 标准 asks about one question per 700 characters, the staged plan about one per 1 700, with the same sections and quota range', () => {
  const leaves = sections(30, 2500), chars = 30 * 2500;
  const staged = strengthPlan(leaves, [], 'standard'), onePass = strengthPlan(leaves, [], 'standard', { onePass: true });
  assert.equal(staged.goal, Math.round(6 * chars / 10000));
  assert.equal(onePass.goal, Math.round(14 * chars / 10000));
  assert.equal(onePass.mustCover, staged.mustCover);
  assert.ok(onePass.quotas.every(item => item.quota >= 1 && item.quota <= STRENGTH.standard.maxQuota), 'still 1–6 per section');
});

test('the portions of a one-pass plan are cut by characters and by cards: none asks for more than cardsPerReply, none holds more than portionChars unless one section alone', () => {
  const leaves = sections(40, 2200);
  const made = coveragePlan({ leaves, weights: [], level: 'standard', onePass: true });
  for (const round of made.rounds) {
    for (const portion of packPortions(round.assignments)) {
      assert.ok(portion.questions <= ONE_PASS_LIMITS.cardsPerReply, `${portion.questions} questions`);
      const chars = portion.assignments.reduce((sum, item) => sum + (item.end - item.start), 0);
      assert.ok(chars <= ONE_PASS_LIMITS.portionChars || portion.assignments.length === 1, `${chars} characters`);
    }
  }
  assert.ok(made.rounds.flatMap(round => packPortions(round.assignments)).some(portion => portion.questions === ONE_PASS_LIMITS.cardsPerReply ||
    portion.questions + 1 > ONE_PASS_LIMITS.cardsPerReply - 2), 'at this density the cards bound is the one that cuts');
});

test('the sanity bounds bind sooner at the one-pass density, and a capped plan says so (capped, dropped), in the spec the draft keeps too', () => {
  // About 380 000 characters in one source: 14 per 10 000 asks for 532, above the 500 in all and the 400 from one source.
  const big = strengthPlan(sections(190, 2000), [], 'standard', { onePass: true });
  assert.ok(big.goal <= LIMITS.total && big.goal <= LIMITS.perSource);
  assert.ok(big.capped.includes('total'), big.capped.join());
  assert.ok(big.capped.includes('source:doc'), big.capped.join());
  assert.equal(strengthPlan(sections(190, 2000), [], 'standard').capped.length, 0, 'the staged plan of the same material is not capped');
  // 完整 over 600 short sections: more must-cover sections than the bound affords, so some are dropped, and said.
  const many = coveragePlan({ leaves: sections(300, 700, 'a').concat(sections(300, 700, 'b')), weights: [], level: 'full', onePass: true });
  assert.ok(many.plan.dropped.length > 0);
  assert.ok(many.plan.capped.includes('sections'));
  const spec = coverageSpec({ plan: many.plan, rounds: many.rounds, weights: [] });
  assert.ok(spec.capped?.includes('sections') && (spec.dropped > 0 || spec.droppedKeys?.length > 0), JSON.stringify({ capped: spec.capped, dropped: spec.dropped }));
});
