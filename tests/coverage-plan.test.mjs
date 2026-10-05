import test from 'node:test';
import assert from 'node:assert/strict';
import { coveragePlan, coverageSpec, SPEC_LIMITS, specNotes } from '../lib/coverage-plan.js';
import { leafSectionsFor, annotateCoverage, coverageForDraft } from '../lib/coverage-state.js';
import { lengthWeights } from '../lib/section-weights.js';
import { coverageOf, sectionKey } from '../lib/coverage.js';
import { transcriptFixture } from './helpers/coverage-fixture.mjs';

/* The plan of a run as the backend makes it (the creation form's consequence line, the job, the draft's coverageSpec) from ONE function, and the spec a draft keeps so the screens can say why a
   section got its questions. */

const fx = transcriptFixture();
const state = { sources: fx.sources, drafts: [], decks: [], documents: [] };

test('the leaf sections of a selection are the sections of the coverage view: one unit everywhere', () => {
  const leaves = leafSectionsFor(state, fx.sources);
  assert.equal(leaves.length, 81);
  assert.deepEqual(leaves.map(item => item.key), coverageOf({ sources: fx.sources }).sections.map(item => item.key));
  assert.ok(leaves.every(item => item.leaf && item.key === sectionKey(item.sourceId, item.id) && item.chars > 0));
});

test('the plan: strength, quotas, assignments and rounds from the same sections; the length weights make it estimable without a model', () => {
  const leaves = leafSectionsFor(state, fx.sources), weights = lengthWeights(leaves);
  const { plan, assignments, rounds } = coveragePlan({ leaves, weights, level: 'standard' });
  assert.equal(plan.level, 'standard');
  assert.equal(plan.mustCover, 81);
  assert.equal(assignments.reduce((sum, item) => sum + item.quota, 0), plan.goal);
  assert.equal(rounds.reduce((sum, round) => sum + round.questions, 0), plan.goal);
  assert.ok(rounds.every(round => round.questions <= 30));
  assert.deepEqual(coveragePlan({ leaves, weights: [], level: 'standard' }).plan.quotas, plan.quotas, 'no weights at all is the same as the length weights');
  const custom = coveragePlan({ leaves, weights, level: 'standard', goalCount: 40 });
  assert.equal(custom.plan.goal, 40);
  assert.equal(custom.rounds.length, 2);
});

test('the spec a draft keeps: level, goal, weights with their reason, quotas and the rounds, bounded', () => {
  const leaves = leafSectionsFor(state, fx.sources);
  const weights = leaves.map((leaf, at) => ({ sectionId: leaf.key, importance: 1 + (at % 5), kind: 'definition', reason: `reason ${at}`, source: 'model' }));
  const { plan, assignments, rounds } = coveragePlan({ leaves, weights, level: 'standard' });
  const spec = coverageSpec({ plan, rounds, weights, weightSource: 'model' });
  assert.equal(spec.version, 1);
  assert.deepEqual([spec.level, spec.goal, spec.mustCover, spec.leaves, spec.weightSource], ['standard', plan.goal, 81, 81, 'model']);
  assert.equal(spec.weights.length, 81);
  assert.deepEqual(spec.weights[3], { sectionId: leaves[3].key, importance: 4, kind: 'definition', reason: 'reason 3', source: 'model' });
  assert.deepEqual(spec.quotas.map(item => [item.sectionId, item.quota]), plan.quotas.map(item => [item.sectionId, item.quota]));
  assert.equal(spec.rounds.length, rounds.length);
  assert.deepEqual(spec.rounds.map(round => round.questions), rounds.map(round => round.questions));
  assert.deepEqual([...new Set(spec.rounds.flatMap(round => round.sectionIds))].sort(), [...new Set(assignments.map(item => item.sectionId))].sort(), 'every section is in a round, once');
  assert.ok(JSON.stringify(spec).length < 60000, `bounded: ${JSON.stringify(spec).length} characters`);
  const huge = Array.from({ length: 1500 }, (_, at) => ({ id: `p${at}`, key: `s#p${at}`, sourceId: 's', chars: 6000, leaf: true, start: at * 6000, end: at * 6000 + 6000 }));
  const big = coveragePlan({ leaves: huge, weights: lengthWeights(huge), level: 'standard' });
  const bounded = coverageSpec({ plan: big.plan, rounds: big.rounds, weights: lengthWeights(huge), weightSource: 'length' });
  assert.ok(bounded.weights.length <= SPEC_LIMITS.rows && bounded.quotas.length <= SPEC_LIMITS.rows && bounded.truncated === true);
  assert.ok(JSON.stringify(bounded).length < 200000);
});

test('the notes of a spec say why each section got its questions: importance, kind, reason, quota', () => {
  const leaves = leafSectionsFor(state, fx.sources).slice(0, 6);
  const weights = leaves.map((leaf, at) => ({ sectionId: leaf.key, importance: at === 2 ? 5 : 3, kind: at === 2 ? 'definition' : 'other', reason: at === 2 ? 'the core definition' : '', source: at < 5 ? 'model' : 'length' }));
  const { plan, rounds } = coveragePlan({ leaves, weights, level: 'standard' });
  const notes = specNotes(coverageSpec({ plan, rounds, weights, weightSource: 'mixed' }));
  const note = notes.get(leaves[2].key);
  assert.equal(note.importance, 5);
  assert.equal(note.kind, 'definition');
  assert.equal(note.reason, 'the core definition');
  assert.equal(note.source, 'model');
  assert.ok(note.quota >= 1);
  assert.equal(note.why, 'important');
  assert.equal(notes.get(leaves[5].key).source, 'length');
});

test('coverage annotated with a spec: each section carries its weight note; nothing changes without a spec', () => {
  const leaves = leafSectionsFor(state, fx.sources), weights = leaves.map(leaf => ({ sectionId: leaf.key, importance: 4, kind: 'method', reason: 'how to do it', source: 'model' }));
  const { plan, rounds } = coveragePlan({ leaves, weights, level: 'standard' });
  const draft = { id: 'd', draftVersion: 1, cards: [], editorial: { generation: { sourceIds: fx.sources.map(source => source.id) }, partPlans: [], coverageSpec: coverageSpec({ plan, rounds, weights, weightSource: 'model' }) } };
  const coverage = coverageForDraft({ ...state, drafts: [draft] }, draft), annotated = annotateCoverage(coverage, draft.editorial.coverageSpec);
  assert.equal(annotated.sections.length, 81);
  assert.ok(annotated.sections.every(section => section.weight?.importance === 4 && section.weight.kind === 'method' && section.weight.reason === 'how to do it' && section.weight.quota >= 1));
  assert.deepEqual(annotateCoverage(coverage, undefined), coverage);
  assert.deepEqual(annotated.spec, { level: 'standard', goal: plan.goal, rounds: rounds.length, weightSource: 'model' });
});
