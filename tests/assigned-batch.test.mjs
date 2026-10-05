import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBatched, planGeneration } from '../lib/batch.js';
import { coverageOf, COVERED, PLANNED_FAILED, sectionKey } from '../lib/coverage.js';
import { strengthPlan, assignmentsOf, roundsOf } from '../lib/coverage-strength.js';
import { transcriptFixture } from './helpers/coverage-fixture.mjs';
import { clusteringModel, sectionOfQuote } from './helpers/clustering-model.mjs';

/* A run planned from assignments (lib/assigned-plan.js through lib/batch.js): the planner clusters on purpose and the covered sections still equal the sections the round assigned. */

const fx = transcriptFixture();
const leaves = fx.leaves.map(section => ({ ...section, key: sectionKey(section.sourceId, section.id) }));
const CONT = leaves.find(section => section.continued).key;
const assign = (list, quota) => list.map(section => ({ key: section.key, sectionId: section.key, sourceId: section.sourceId, start: section.start, end: section.end, quota, title: section.title }));
const performance = { concurrency: 2, batchSize: 5, fillRounds: 0 };
const run = (model, assignments, extra = {}) => generateBatched(model.complete, { kind: 'quiz', sources: fx.sources, assignments, count: assignments.reduce((sum, item) => sum + item.quota, 0), performance, ...extra });
const coverage = deck => coverageOf({ sources: fx.sources, cards: deck.cards, partPlans: deck.editorial.partPlans });

test('the first round of a standard plan: a clustering planner, and the covered sections are exactly the assigned ones', async () => {
  const plan = strengthPlan(leaves, [], 'standard'), rounds = roundsOf(assignmentsOf(plan, leaves, [])), first = rounds[0];
  assert.ok(first.questions <= 30 && first.assignments.length >= 6);
  const model = clusteringModel();
  const deck = await run(model, first.assignments);
  const found = coverage(deck), coveredIds = found.sections.filter(section => section.state === COVERED).map(section => sectionKey(section.sourceId, section.id)).sort();
  assert.deepEqual(coveredIds, first.assignments.map(item => item.sectionId).sort(), 'the covered sections equal the assigned checklist');
  assert.equal(deck.cards.length, first.questions, 'every planned target became a question');
  const per = new Map();
  for (const card of deck.cards) { const id = sectionOfQuote(card.citations[0].quote); per.set(id, (per.get(id) || 0) + 1); }
  for (const item of first.assignments) assert.equal(per.get(item.sectionId.split('#')[1]), item.quota, `${item.sectionId} has its quota of questions`);
  assert.equal(deck.editorial.requested, first.questions);
  assert.equal(deck.editorial.partReport.failed, 0);
  assert.ok(model.log.asks.length > 1, 'the planner was asked again for the sections it clustered away from');
});

test('a section the plan could not fill is a failed part of the run with the code plan-short: a planned-failed section with its reason, never silently dropped', async () => {
  const assignments = [...assign([leaves[0]], 2), ...assign([leaves.find(section => section.key === CONT)], 2), ...assign([leaves[2]], 1)];
  const model = clusteringModel();
  const deck = await run(model, assignments);
  assert.equal(deck.cards.length, 3, 'the other two sections kept their questions');
  const found = coverage(deck), contSection = found.sections.find(section => sectionKey(section.sourceId, section.id) === CONT);
  assert.equal(contSection.state, PLANNED_FAILED);
  assert.equal(contSection.reason, 'plan-short');
  const failed = deck.editorial.partPlans.find(plan => plan.reason === 'plan-short');
  assert.ok(failed, 'the part that records it is in the draft');
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.ranges.map(range => [range.start, range.end]), [[contSection.start, contSection.end]], 'its range is exactly the section');
  assert.ok(deck.editorial.failures.some(line => /plan-short|came back short/.test(line)), 'and in the failures of the run');
  assert.equal(deck.editorial.partReport.reasons['plan-short'], 1);
  assert.equal(deck.editorial.partReport.failed, 1);
});

test('planGeneration of an assignment run: the groups of calls, the parts of at most batchSize questions, the questions add up', () => {
  const assignments = assign(leaves.slice(0, 12), 3);
  const parts = planGeneration({ kind: 'quiz', sources: fx.sources, assignments, count: 36, performance });
  assert.equal(parts.reduce((sum, part) => sum + part.count, 0), 36);
  assert.ok(parts.every(part => part.count >= 1 && part.count <= 5 && part.assignments?.length >= 1 && part.sources.length >= 1));
  assert.ok(parts.every(part => part.sources.every(piece => piece.text.length <= 60000) && part.sources.reduce((sum, piece) => sum + piece.text.length, 0) <= 60000), 'a call is given at most 60 000 characters');
  const mixed = planGeneration({ kind: 'mixed', sources: fx.sources, assignments, count: 36, performance });
  const quiz = mixed.filter(part => part.kind === 'quiz').reduce((sum, part) => sum + part.count, 0), flash = mixed.filter(part => part.kind === 'flashcard').reduce((sum, part) => sum + part.count, 0);
  assert.equal(quiz + flash, 36);
  assert.ok(quiz >= flash && quiz - flash <= 4, `half each, the odd question of a call a quiz: ${quiz}/${flash}`);
  assert.ok(planGeneration({ kind: 'quiz', sources: fx.sources, count: 10, performance }).every(part => part.assignments === undefined), 'a request without assignments is planned as before');
});

test('a mixed run spreads quiz and flashcards over the sections and writes both', async () => {
  const assignments = assign(leaves.slice(0, 4), 2);
  const deck = await run(clusteringModel(), assignments, { kind: 'mixed' });
  assert.equal(deck.cards.length, 8);
  assert.equal(coverage(deck).covered, 4);
});

test('the draft keeps the coverage record of the request: the level and the spec it was planned from', async () => {
  const assignments = assign(leaves.slice(0, 2), 2), spec = { level: 'standard', goal: 4, rounds: [] };
  const deck = await run(clusteringModel(), assignments, { coverageLevel: 'standard', coverageSpec: spec });
  assert.deepEqual(deck.editorial.coverageSpec, spec);
  assert.equal(deck.editorial.generation.coverageLevel, 'standard');
});
