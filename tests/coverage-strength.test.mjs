import test from 'node:test';
import assert from 'node:assert/strict';
import { STRENGTH, LEVELS, DEFAULT_LEVEL, LIMITS, strengthPlan, quotasFor, assignmentsOf, roundsOf, weightOf } from '../lib/coverage-strength.js';
import { sectionKey } from '../lib/coverage.js';
import { transcriptFixture } from './helpers/coverage-fixture.mjs';

/* The strength of a coverage (lean / standard / full): which sections must get a question, the target density, the quota of each section and the rounds they are grouped into.
   The ground truth is stated here, in plain numbers (the table of lib/coverage-strength.js), not read back from the code under test. */

const fx = transcriptFixture();
const keyOf = section => sectionKey(section.sourceId, section.id);
const section = (id, chars, extra = {}) => ({ id, key: `s#${id}`, sourceId: 's', chars, leaf: true, start: 0, end: chars, ...extra });
/** n sections of `chars` characters in one source, with real offsets. */
const material = (sizes, extra = () => ({})) => { let at = 0; return sizes.map((chars, index) => { const item = section(`p${index + 1}`, chars, { start: at, end: at + chars, ...extra(index) }); at += chars; return item; }); };
const sum = quotas => quotas.reduce((total, item) => total + item.quota, 0);

test('the table: three levels, standard is the default, and the numbers are the stated ones', () => {
  assert.deepEqual([...LEVELS], ['lean', 'standard', 'full']);
  assert.equal(DEFAULT_LEVEL, 'standard');
  assert.deepEqual([STRENGTH.lean.perTenK, STRENGTH.standard.perTenK, STRENGTH.full.perTenK], [3, 6, 10]);
  assert.equal(STRENGTH.standard.minChars, 600);
  assert.equal(STRENGTH.lean.share, 0.6);
  assert.deepEqual([STRENGTH.lean.minQuota, STRENGTH.standard.minQuota, STRENGTH.full.minQuota], [1, 1, 1]);
  assert.equal(LIMITS.total, 500);
});

test('standard: every section of at least 600 characters gets a question, the goal is the density, the sum is the goal', () => {
  const sections = material([5000, 5000, 5000, 5000]); // 20 000 characters: 6 per 10 000 is 12
  const plan = strengthPlan(sections, [], 'standard');
  assert.equal(plan.level, 'standard');
  assert.equal(plan.goal, 12);
  assert.equal(sum(plan.quotas), 12);
  assert.deepEqual(plan.quotas.map(item => item.sectionId), sections.map(item => item.key), 'reading order, every section');
  assert.ok(plan.quotas.every(item => item.quota >= 1 && item.quota <= STRENGTH.standard.maxQuota));
  assert.deepEqual(plan.quotas.map(item => item.quota), [3, 3, 3, 3], 'equal sections share equally');
  assert.equal(plan.mustCover, 4);
  assert.equal(plan.dropped.length, 0);
});

test('a longer section and a more important one get more questions; a chatter section gets the floor', () => {
  const sections = material([6000, 24000, 6000, 6000, 6000]);
  const weights = [{ sectionId: 's#p3', importance: 5, kind: 'definition' }, { sectionId: 's#p4', importance: 1, kind: 'chatter' }];
  const plan = strengthPlan(sections, weights, 'standard'), by = new Map(plan.quotas.map(item => [item.sectionId, item]));
  assert.ok(by.get('s#p2').quota > by.get('s#p1').quota, 'the long section gets more');
  assert.ok(by.get('s#p3').quota > by.get('s#p1').quota, 'the important section gets more than a plain one of the same size');
  assert.ok(by.get('s#p4').quota <= by.get('s#p1').quota, 'chatter gets no more than a plain one');
  assert.ok(by.get('s#p4').quota >= 1, 'but still a question');
  assert.equal(by.get('s#p3').reason, 'important');
  assert.equal(by.get('s#p2').reason, 'long');
  assert.equal(sum(plan.quotas), plan.goal);
  assert.equal(weightOf(sections[2], weights[0]) / weightOf(sections[0], undefined) > 2, true, 'the weight is length times importance');
});

test('standard: a stub shares the question of its neighbour; full asks every section; the stub is never alone in its source', () => {
  const sections = material([4000, 300, 4000]);
  const standard = strengthPlan(sections, [], 'standard');
  assert.deepEqual(standard.quotas.map(item => item.sectionId), ['s#p1', 's#p3']);
  assert.deepEqual(standard.quotas[0].shares, ['s#p2'], 'the stub after p1 shares its question');
  const assignments = assignmentsOf(standard, sections, []);
  assert.deepEqual([assignments[0].start, assignments[0].end], [0, 4300], 'the assignment of the neighbour is widened over the stub');
  assert.deepEqual([assignments[1].start, assignments[1].end], [4300, 8300]);
  const full = strengthPlan(sections, [], 'full');
  assert.deepEqual(full.quotas.map(item => item.sectionId), ['s#p1', 's#p2', 's#p3'], 'full covers even the stub');
  const lone = strengthPlan(material([300]), [], 'standard');
  assert.equal(lone.quotas.length, 1, 'a note that is only a stub is still asked');
});

test('lean: the heaviest sections that hold 60% of the weight, and at least one section per recording', () => {
  const sections = material([9000, 3000, 3000, 3000, 2000, 2000, 2000, 2000, 1000, 1000], index => ({ recording: index < 6 ? 1 : index < 9 ? 2 : 3 }));
  const plan = strengthPlan(sections, [], 'lean');
  const chosen = new Set(plan.quotas.map(item => item.sectionId)), weight = sections.reduce((acc, item) => acc + item.chars, 0);
  assert.ok(chosen.has('s#p1'), 'the heaviest section is in');
  const held = sections.filter(item => chosen.has(item.key)).reduce((acc, item) => acc + item.chars, 0);
  assert.ok(held >= weight * 0.6, `the chosen hold ${held}/${weight}`);
  assert.ok(sections.filter(item => !chosen.has(item.key)).length > 0, 'lean leaves sections out');
  for (const recording of [1, 2, 3]) assert.ok(sections.some(item => item.recording === recording && chosen.has(item.key)), `recording ${recording} has a section`);
  assert.ok(plan.quotas.every(item => item.quota <= STRENGTH.lean.maxQuota));
  assert.equal(plan.goal, Math.round(3 * weight / 10000));
  assert.ok(plan.goal < strengthPlan(sections, [], 'standard').goal);
});

test('lean keeps one section per recording even when a recording is light', () => {
  const sections = material([20000, 20000, 20000, 800], index => ({ recording: index === 3 ? 2 : 1 }));
  const plan = strengthPlan(sections, [], 'lean');
  assert.ok(plan.quotas.some(item => item.sectionId === 's#p4'), 'the only section of recording 2 is included although it is tiny');
});

test('the order of the levels: lean < standard < full in questions, on the same material', () => {
  const sections = material(Array.from({ length: 30 }, (_, index) => 3000 + (index % 5) * 1500));
  const goals = LEVELS.map(level => strengthPlan(sections, [], level).goal);
  assert.ok(goals[0] < goals[1] && goals[1] < goals[2], goals.join(' < '));
});

test('deterministic: the same input gives the same quotas, whatever the order of the weights', () => {
  const sections = material([3100, 4100, 5100, 2100, 6100, 2600, 3600]);
  const weights = [{ sectionId: 's#p2', importance: 4, kind: 'method' }, { sectionId: 's#p5', importance: 2, kind: 'example' }, { sectionId: 's#p6', importance: 5, kind: 'definition' }];
  const first = quotasFor(sections, weights, 'standard');
  assert.deepEqual(quotasFor(sections, weights, 'standard'), first);
  assert.deepEqual(quotasFor(sections, [...weights].reverse(), 'standard'), first);
  assert.deepEqual(quotasFor(sections, new Map(weights.map(item => [item.sectionId, item])), 'standard'), first, 'a Map works the same');
  assert.deepEqual(quotasFor(structuredClone(sections), structuredClone(weights), 'standard'), first);
});

test('a custom total rescales within the same rules', () => {
  const sections = material([4000, 4000, 4000, 4000, 4000]); // standard density: 12
  assert.equal(strengthPlan(sections, [], 'standard').goal, 12);
  const more = strengthPlan(sections, [], 'standard', { goalCount: 20 });
  assert.equal(more.goal, 20);
  assert.equal(sum(more.quotas), 20);
  assert.ok(more.quotas.every(item => item.quota >= 1 && item.quota <= 6));
  const few = strengthPlan(sections, [], 'standard', { goalCount: 3 });
  assert.equal(few.goal, 3, 'fewer questions than sections: the heaviest sections keep one each');
  assert.equal(few.quotas.length, 3);
  assert.equal(few.dropped.length, 2);
  assert.ok(few.capped.includes('sections'));
  const heavier = strengthPlan(material([4000, 9000, 4000, 4000]), [], 'standard', { goalCount: 2 });
  assert.ok(heavier.quotas.some(item => item.sectionId === 's#p2'), 'the longest section is among the ones kept');
  const huge = strengthPlan(sections, [], 'standard', { goalCount: 200 });
  assert.equal(huge.goal, 5 * 6, 'more than the quota ranges hold is cut to what they hold');
  assert.equal(sum(huge.quotas), huge.goal);
});

test('the sanity bounds: 500 in all, 400 from one source, said honestly', () => {
  const big = material(Array.from({ length: 700 }, () => 5000)); // 3.5M characters in one source: 2100 by density
  const plan = strengthPlan(big, [], 'standard');
  assert.ok(plan.goal <= LIMITS.total, `goal ${plan.goal}`);
  assert.ok(plan.capped.includes('total'));
  assert.ok(plan.mustCover <= plan.goal, 'cannot ask more sections than questions');
  assert.ok(plan.dropped.length > 0, 'the sections that could not be afforded are named');
  assert.equal(plan.mustCover + plan.dropped.length, 700);
  const perSource = strengthPlan(material(Array.from({ length: 60 }, () => 9000)), [], 'full');
  assert.ok(sum(perSource.quotas) <= LIMITS.perSource, `one source gets at most ${LIMITS.perSource}`);
  assert.ok(perSource.capped.includes('source:s'));
  assert.ok(perSource.quotas.every(item => item.quota >= 1));
});

test('the merged transcript (81 sections, 5 recordings): standard asks every section, lean fewer, full all', () => {
  const leaves = fx.leaves.map(item => ({ ...item, key: keyOf(item) }));
  const standard = strengthPlan(leaves, [], 'standard'), lean = strengthPlan(leaves, [], 'lean'), full = strengthPlan(leaves, [], 'full');
  assert.equal(standard.mustCover, 81);
  assert.deepEqual(standard.quotas.map(item => item.sectionId), leaves.map(keyOf), 'the checklist: every section, in reading order');
  assert.ok(lean.mustCover < 81 && lean.mustCover >= 5);
  assert.equal(full.mustCover, 81);
  assert.ok(lean.goal < standard.goal && standard.goal < full.goal, `${lean.goal} < ${standard.goal} < ${full.goal}`);
  assert.equal(standard.goal, Math.round(6 * fx.leaves.reduce((acc, item) => acc + item.chars, 0) / 10000));
  for (const recording of [1, 2, 3, 4, 5]) assert.ok(lean.quotas.some(item => leaves.find(l => keyOf(l) === item.sectionId).recording === recording), `lean has recording ${recording}`);
  assert.equal(strengthPlan(leaves, [], 'standard').goal, standard.goal, 'stable under re-computation');
});

test('rounds: each at most 30 questions, a quota is never split, heaviest first and reading order inside a round', () => {
  const leaves = fx.leaves.map(item => ({ ...item, key: keyOf(item) }));
  const weights = leaves.slice(10, 20).map(item => ({ sectionId: item.key, importance: 5, kind: 'definition' }));
  const plan = strengthPlan(leaves, weights, 'standard'), assignments = assignmentsOf(plan, leaves, weights), rounds = roundsOf(assignments);
  assert.ok(rounds.length >= 2);
  assert.ok(rounds.every(round => round.questions <= 30 && round.questions === round.assignments.reduce((acc, item) => acc + item.quota, 0)));
  assert.equal(rounds.reduce((acc, round) => acc + round.questions, 0), plan.goal, 'the rounds hold the whole plan');
  assert.deepEqual(rounds.flatMap(round => round.assignments.map(item => item.key)).sort(), assignments.map(item => item.key).sort(), 'each section exactly once');
  const rank = new Map(assignments.map((item, index) => [item.key, index]));
  rounds.forEach(round => assert.deepEqual(round.assignments.map(item => rank.get(item.key)), [...round.assignments.map(item => rank.get(item.key))].sort((a, b) => a - b), 'reading order inside a round'));
  for (let at = 1; at < rounds.length; at++) {
    const before = Math.min(...rounds[at - 1].assignments.map(item => item.weight)), after = Math.max(...rounds[at].assignments.map(item => item.weight));
    assert.ok(before >= after, `round ${at} is not lighter than round ${at + 1}`);
  }
  const early = new Set(rounds.slice(0, 2).flatMap(round => round.assignments.map(item => item.key)));
  assert.ok(weights.every(item => early.has(item.sectionId)), 'the ten important sections are in the first two rounds: the heaviest come first');
  assert.ok(rounds[0].assignments.every(item => weights.some(w => w.sectionId === item.key)), 'and the first round holds nothing else');
  assert.ok(assignments.every(item => item.end > item.start && item.quota >= 1));
  assert.deepEqual(roundsOf(assignments).map(round => round.questions), rounds.map(round => round.questions), 'deterministic');
});

test('length keeps counting beyond one slot of 10 000 characters, and a quota above one call is cut into slots of the section', () => {
  const sections = material([10000, 40000, 10000]);
  const plan = strengthPlan(sections, [], 'standard'), by = new Map(plan.quotas.map(item => [item.sectionId, item.quota]));
  assert.ok(by.get('s#p2') > STRENGTH.standard.maxQuota, `a 40 000-character section holds more than ${STRENGTH.standard.maxQuota}: ${by.get('s#p2')}`);
  assert.ok(by.get('s#p2') >= 3 * by.get('s#p1') - 2, 'about in proportion to its length');
  assert.equal(sum(plan.quotas), plan.goal);
  const assignments = assignmentsOf(plan, sections, []), slots = assignments.filter(item => item.sectionId === 's#p2');
  assert.ok(slots.length > 1 && slots.every(item => item.quota >= 1 && item.quota <= STRENGTH.standard.maxQuota), 'each slot is answerable by one call');
  assert.equal(slots.reduce((acc, item) => acc + item.quota, 0), by.get('s#p2'));
  assert.deepEqual([slots[0].start, slots.at(-1).end], [10000, 50000], 'the slots tile the section');
  slots.slice(1).forEach((item, index) => assert.equal(item.start, slots[index].end));
  assert.equal(new Set(assignments.map(item => item.key)).size, assignments.length, 'keys are unique');
});
