import test from 'node:test';
import assert from 'node:assert/strict';
import { planRound, roundRequest } from '../lib/coverage-round.js';
import { coverageOf, sectionKey } from '../lib/coverage.js';
import { topUpRound } from '../lib/coverage-state.js';
import { coveragePlan, coverageSpec } from '../lib/coverage-plan.js';
import { leafSectionsFor } from '../lib/coverage-state.js';
import { lengthWeights } from '../lib/section-weights.js';
import { transcriptFixture } from './helpers/coverage-fixture.mjs';

/* The top-up of a draft is asked through the same assignments as a first run (lib/assigned-plan.js), and a draft that kept its plan continues it: an uncovered section costs the quota the plan gave
   it, the heaviest first. A draft without a plan behaves as before: one question per section. */

const fx = transcriptFixture();
const ids = fx.sources.map(source => source.id);
const keyOf = section => sectionKey(section.sourceId, section.id);

test('without a plan: one question per uncovered section, and the request carries the assignments', () => {
  const coverage = coverageOf({ sources: fx.sources, cards: [fx.card(fx.leaves[0])], targets: true });
  const round = planRound(coverage), request = roundRequest(round, coverage, fx.sources);
  assert.equal(round.questions, 30);
  assert.equal(request.count, 30);
  assert.equal(request.assignments.length, 30);
  assert.ok(request.assignments.every(item => item.quota === 1 && item.end > item.start && item.key === item.sectionId));
  assert.deepEqual(request.assignments.map(item => item.key), round.picks.filter(pick => !pick.reuse).map(pick => pick.key), 'the sections the screen showed');
});

test('with the plan of the draft: an uncovered section costs its quota, the heaviest quotas first, and the round says honestly how many more it needs', () => {
  const leaves = leafSectionsFor({ sources: fx.sources }, fx.sources), weights = lengthWeights(leaves);
  const { plan, rounds } = coveragePlan({ leaves, weights: weights.map((item, at) => (at === 50 ? { ...item, importance: 5, kind: 'definition' } : item)), level: 'standard' });
  const spec = coverageSpec({ plan, rounds, weights, weightSource: 'length' });
  const draft = { id: 'd', draftVersion: 1, cards: [fx.card(fx.leaves[0])], editorial: { requested: 1, generation: { sourceIds: ids }, partPlans: [], coverageSpec: spec } };
  const { round, request } = topUpRound({ sources: fx.sources, drafts: [draft], decks: [] }, draft);
  const quotaOf = new Map(plan.quotas.map(item => [item.sectionId, item.quota]));
  assert.ok(round.questions <= 30 && round.questions >= 25, `${round.questions} questions`);
  assert.equal(round.picks[0].key, keyOf(fx.leaves[50]), 'the section of the highest importance comes first');
  for (const pick of round.picks) assert.equal(pick.questions, quotaOf.get(pick.key), `${pick.key} costs its quota`);
  assert.equal(request.count, round.questions);
  assert.deepEqual(request.assignments.map(item => item.quota), round.picks.map(pick => pick.questions));
  assert.ok(round.left > 0 && round.rounds >= 4, `${round.rounds} rounds`);
});

test('a section the plan left out (a lean plan) costs one question when it is asked for', () => {
  const leaves = leafSectionsFor({ sources: fx.sources }, fx.sources), weights = lengthWeights(leaves), { plan, rounds } = coveragePlan({ leaves, weights, level: 'lean' });
  const left = leaves.find(leaf => !plan.quotas.some(item => item.sectionId === leaf.key));
  const spec = coverageSpec({ plan, rounds, weights, weightSource: 'length' });
  const draft = { id: 'd', draftVersion: 1, cards: [fx.card(fx.leaves[0])], editorial: { requested: 1, generation: { sourceIds: ids }, partPlans: [], coverageSpec: spec } };
  const { round } = topUpRound({ sources: fx.sources, drafts: [draft], decks: [] }, draft, { sectionIds: [left.key] });
  assert.equal(round.error, undefined);
  assert.equal(round.picks[0].questions, 1);
});
