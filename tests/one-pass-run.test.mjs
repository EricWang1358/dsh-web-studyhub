import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBatched } from '../lib/batch.js';
import { coverageOf, COVERED, PLANNED_FAILED, sectionKey } from '../lib/coverage.js';
import { strengthPlan, assignmentsOf, roundsOf } from '../lib/coverage-strength.js';
import { packPortions } from '../lib/one-pass/portions.js';
import { ONE_PASS_LIMITS } from '../lib/one-pass/limits.js';
import { GENERATION_STAGE_TEXT as STAGE } from '../lib/contexts/jobs/contracts.js';
import { transcriptFixture } from './helpers/coverage-fixture.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { onePassModel, writeAll } from './helpers/one-pass-model.mjs';

/* A coverage round written in one pass through the run (lib/batch.js generateBatched): the portions of the plan's assignments, one write and the reviews per
   portion, and the records the staged pipeline keeps (the parts, what was planned and what became of it, the covered and planned-failed sections). */

const fx = transcriptFixture();
const leaves = fx.leaves.map(section => ({ ...section, key: sectionKey(section.sourceId, section.id) }));
const first = roundsOf(assignmentsOf(strengthPlan(leaves, [], 'standard'), leaves, []))[0];
const run = (model, assignments, extra = {}) => generateBatched(model.complete, { kind: 'quiz', language: 'English', sources: fx.sources, assignments,
  count: assignments.reduce((sum, item) => sum + item.quota, 0), performance: { concurrency: 2, fillRounds: 1 }, ...extra });
const coverage = deck => coverageOf({ sources: fx.sources, cards: deck.cards, partPlans: deck.editorial.partPlans });
const keyOf = section => sectionKey(section.sourceId, section.id);

test('the first round of a standard plan in one pass: one write per portion, reviews of at most 7, every assigned section covered with its quota', async () => {
  const model = onePassModel();
  const deck = await run(model, first.assignments);
  const portions = packPortions(first.assignments);
  assert.ok(portions.length >= 2, 'the round needs more than one portion');
  const writes = model.calls.filter(call => call.stage === 'write'), reviews = model.calls.filter(call => call.stage === 'review');
  assert.equal(writes.length, portions.length, 'one write call per portion, no re-ask');
  assert.equal(reviews.length, portions.reduce((sum, portion) => sum + Math.ceil(portion.questions / ONE_PASS_LIMITS.reviewBatch), 0));
  assert.deepEqual(model.calls.filter(call => call.stage === 'other'), [], 'no staged call (plan, blueprint, author, editor)');
  for (const write of writes) assert.ok(write.data.sections.every(item => Number.isInteger(item.quota)) && write.data.count === undefined);
  for (const call of model.calls) {
    assert.ok(Number.isInteger(call.context.part) && call.context.attempt === 1, 'every call is a step of its part');
    assert.match(call.context.stage, new RegExp(`^Part \\d+/${portions.length} · (${STAGE.authoring}|${STAGE.reviewing})$`), 'every portion is a part from the start');
  }
  assert.equal(deck.cards.length, first.questions);
  const covered = coverage(deck).sections.filter(section => section.state === COVERED).map(keyOf).sort();
  assert.deepEqual(covered, first.assignments.map(item => item.sectionId).sort(), 'the covered sections are exactly the assigned ones');
  const plans = deck.editorial.partPlans;
  assert.equal(plans.length, portions.length);
  assert.ok(plans.every(plan => plan.status === 'passed' && plan.targets.every(target => target.status === 'kept')));
  assert.equal(plans.reduce((sum, plan) => sum + plan.targets.length, 0), first.questions);
  assert.deepEqual(deck.editorial.failures, []);
  assert.equal(deck.editorial.partReport.failed, 0);
  assert.equal(deck.editorial.generation.performance.strategy, 'one-pass');
  assert.equal(Object.keys(deck.editorial.reviewedCards).length, deck.cards.length);
});

test('a section the writer leaves empty is asked again alone, then recorded as a failed part with the code plan-short: a planned-failed section with its reason', async () => {
  const assignments = first.assignments.slice(0, 4), empty = assignments[1];
  const model = onePassModel({ write: data => writeAll({ ...data, sections: data.sections.filter(item => item.title !== empty.title) }) });
  const deck = await run(model, assignments);
  const writes = model.calls.filter(call => call.stage === 'write'), again = writes.filter(call => call.context.unit);
  assert.equal(writes.length, packPortions(assignments).length + 1, 'one write per portion, then the empty section alone');
  assert.deepEqual(again.map(call => call.data.sections.map(item => item.title)), [[empty.title]]);
  assert.match(again[0].context.unit, /^section-S\d+$/);
  assert.equal(deck.cards.length, assignments.reduce((sum, item) => sum + item.quota, 0) - empty.quota);
  const found = coverage(deck).sections.find(section => keyOf(section) === empty.sectionId);
  assert.equal(found.state, PLANNED_FAILED);
  assert.equal(found.reason, 'plan-short');
  const failed = deck.editorial.partPlans.find(plan => plan.reason === 'plan-short');
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.short.map(item => [item.sectionId, item.needed, item.got]), [[empty.sectionId, empty.quota, 0]]);
  assert.ok(deck.editorial.failures.some(line => /came back short \(plan-short\)/.test(line)));
  assert.equal(model.calls.filter(call => call.stage === 'write').length, writes.length, 'a plan-short part is final: no fill round writes it again');
});

test('a portion whose write call fails is written again in a fill round, as it was', async () => {
  const assignments = first.assignments.slice(0, 3);
  let failures = 0;
  const model = onePassModel({ raw: { write: () => { if (!failures++) throw new Error('Model service unavailable: 503'); return null; } } });
  const deck = await run(model, assignments);
  assert.equal(deck.cards.length, assignments.reduce((sum, item) => sum + item.quota, 0));
  const writes = model.calls.filter(call => call.stage === 'write'), again = writes.filter(call => call.context.attempt === 2);
  assert.equal(writes.length, packPortions(assignments).length + 1);
  assert.equal(again.length, 1, 'the failed portion is written again, as its part\'s second attempt');
  assert.equal(again[0].context.part, writes[0].context.part);
  assert.equal(deck.editorial.partPlans[writes[0].context.part - 1].attempts, 2);
  assert.deepEqual(deck.editorial.failures, []);
});

test('portions written at the same time that test the same objective: the later card is merged away, said in the draft', async () => {
  // The first two portions start together (neither has settled), so neither is told the other's objective.
  const model = onePassModel({ write: (data, number) => writeAll(data).map((card, index) => (index === 0 && number <= 2 ? { ...card, objective: 'Recall the first point of the recording' } : card)) });
  const deck = await run(model, first.assignments, { performance: { concurrency: 4, fillRounds: 0 } });
  assert.equal(deck.cards.filter(card => card.objective === 'Recall the first point of the recording').length, 1);
  const merged = (deck.editorial.omitted || []).filter(item => /duplicate learning target/.test(item.reasons.join(' ')));
  assert.equal(merged.length, 1);
  assert.equal(deck.editorial.partPlans.flatMap(plan => plan.targets).filter(target => target.status === 'omitted').length, 1, 'its target is on record as omitted');
  assert.equal(deck.cards.length + merged.length, first.questions);
});

test('the setting chooses: strategy "staged", or a kind one pass does not write, runs the staged pipeline', async () => {
  const assignments = first.assignments.slice(0, 2);
  for (const extra of [{ performance: { concurrency: 2, fillRounds: 0, strategy: 'staged' } }, { kind: 'flashcard', performance: { concurrency: 2, fillRounds: 0 } }]) {
    const model = clusteringModel(), seen = [];
    const deck = await run({ complete: (system, prompt, context) => { seen.push(system); return model.complete(system, prompt, context); } }, assignments, extra);
    assert.ok(model.log.asks.length >= 1, 'planned first');
    assert.ok(!seen.some(system => system.includes('every card in one pass')));
    assert.ok(deck.cards.length >= 1);
  }
});
