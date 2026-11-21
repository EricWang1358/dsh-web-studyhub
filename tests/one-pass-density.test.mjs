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

// Gate F2: the quota range is per slot of a section (SLOT_CHARS at the staged density). At one pass's density a slot of 10 000 characters held only the staged range, so
// long sections were planned at the staged density whatever the table said. One pass has its own slot (`onePassSlotChars`, the same table): the range stays 1–4 / 1–6 / 1–8
// per slot, and a slot is short enough that a section can hold its level's density (lean: the density of the whole material on the ~60% of it that lean covers).
// A section asks at most one round's questions (30) in one pass: coverage is counted per section, so slots of a section that spilled into a later round were never asked
// (the round owed nothing and was skipped). Up to about 21 000 / 13 000 characters a section (标准 / 完整) one pass holds its density; a longer section asks 30.
const twoSources = (n, chars) => [...sections(n, chars, 'a'), ...sections(n, chars, 'b')];
test('one pass reaches its density on sections of up to a round of questions and on page-sized ones, at every level; the staged plans are unchanged', () => {
  for (const [shape, leaves, staged] of [['long', twoSources(3, 12000), { lean: 22, standard: 43, full: 72 }], ['pages', sections(10, 8000), { lean: 24, standard: 48, full: 80 }]]) {
    const chars = leaves.reduce((sum, leaf) => sum + leaf.chars, 0);
    for (const level of ['lean', 'standard', 'full']) {
      const plan = strengthPlan(leaves, [], level, { onePass: true });
      assert.equal(plan.goal, goalOfChars(chars, level, { onePass: true }), `${shape} ${level}: ${plan.goal}`);
      assert.deepEqual(plan.capped, [], `${shape} ${level}`);
      assert.ok(plan.quotas.every(item => item.quota >= 1), 'one question at least per covered section');
      assert.equal(strengthPlan(leaves, [], level).goal, staged[level], `${shape} ${level} staged`);
    }
  }
  // 标准: 14 per 10 000 is about twice the staged 6, for both shapes (the level's words and the changelog say so).
  assert.equal(strengthPlan(twoSources(3, 12000), [], 'standard', { onePass: true }).goal, 101);
  assert.equal(strengthPlan(sections(10, 8000), [], 'standard', { onePass: true }).goal, 112);
});

test('a section longer than a round of questions asks one round in one pass: 30 each, more than staged, below the density; staged unchanged', () => {
  const leaves = twoSources(3, 30000);
  for (const [level, staged, onePass] of [['lean', 48, 120], ['standard', 108, 180], ['full', 144, 180]]) {
    const plan = strengthPlan(leaves, [], level, { onePass: true });
    assert.equal(plan.goal, onePass, level);
    assert.ok(plan.quotas.every(item => item.quota <= 30), level);
    assert.equal(strengthPlan(leaves, [], level).goal, staged, `${level} staged`);
  }
  // A smaller round (a test's roundLimit) bounds a section the same way.
  assert.ok(strengthPlan(leaves, [], 'standard', { onePass: true, roundLimit: 16 }).quotas.every(item => item.quota <= 16));
});

// What a run delivers (lib/contexts/generation/generate/round-next.js): a round whose sections all have a question already owes nothing and is skipped, and a later round asks
// only the sections it still owes. The plan of one pass is what runs: no round of it is skipped and every slot is asked, whatever the shape, level or round limit.
function delivered(made) {
  const covered = new Set();
  let asked = 0, skipped = 0;
  for (const round of made.rounds) {
    const owed = new Set(round.assignments.map(item => item.sectionId).filter(id => !covered.has(id)));
    if (!owed.size) { skipped += 1; continue; }
    for (const item of round.assignments) if (owed.has(item.sectionId)) asked += item.quota;
    for (const id of owed) covered.add(id);
  }
  return { asked, skipped };
}
test('every round of a one-pass plan runs: no section spills its slots into a round that would be skipped as covered', () => {
  const shapes = { pages: sections(10, 8000), mid: sections(5, 15000), long: sections(10, 30000), longer: sections(4, 60000), two: twoSources(3, 30000) };
  for (const [shape, leaves] of Object.entries(shapes)) for (const level of ['lean', 'standard', 'full']) for (const limit of [30, 16]) {
    const made = coveragePlan({ leaves, weights: [], level, onePass: true, limit });
    assert.deepEqual(delivered(made), { asked: made.plan.goal, skipped: 0 }, `${shape} ${level} limit ${limit}`);
  }
});

test('a one-pass slot still asks at most the range of its level: the assignments of a long section are cut into slots of at most maxQuota questions', () => {
  for (const level of ['lean', 'standard', 'full']) {
    const row = STRENGTH[level];
    assert.ok(row.maxQuota * 10000 / row.onePassSlotChars >= row.onePassPerTenK / (row.share ?? 1), level);
  }
  const made = coveragePlan({ leaves: twoSources(5, 30000), weights: [], level: 'standard', onePass: true });
  const all = made.rounds.flatMap(round => round.assignments);
  assert.ok(all.every(item => item.quota >= 1 && item.quota <= STRENGTH.standard.maxQuota), JSON.stringify(all.map(item => item.quota)));
  // Ten sections of a round each, less what round 1 trims from the two seeds (lib/coverage-strength.js roundsOf): the plan is what runs.
  assert.equal(all.reduce((sum, item) => sum + item.quota, 0), made.plan.goal);
  assert.equal(made.plan.goal, 270);
});

// Gate round 3: the bound per source (400) holds however many questions a section may hold. A one-pass section may hold up to a round (30), so taking one question
// a pass from each section for `maxQuota` passes (4 at 精简) left one source of long sections above it.
test('one source never plans more than the per-source bound, for long sections at every level and both strategies', () => {
  for (const chars of [21000, 40000]) for (const onePass of [false, true]) for (const level of ['lean', 'standard', 'full']) {
    const plan = strengthPlan(sections(33, chars), [], level, { onePass });
    assert.ok(plan.goal <= LIMITS.perSource, `${chars} ${onePass ? 'one pass' : 'staged'} ${level}: ${plan.goal}`);
    assert.ok(plan.quotas.every(item => item.quota >= 1));
    if (plan.goal === LIMITS.perSource) assert.ok(plan.capped.includes('source:doc'), `${chars} ${level}: the cap is said`);
  }
});
