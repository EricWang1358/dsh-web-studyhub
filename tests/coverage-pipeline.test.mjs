import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBatched } from '../lib/batch.js';
import { coverageOf, COVERED, PLANNED_FAILED, NEVER_PLANNED } from '../lib/coverage.js';
import { transcriptFixture, sectionedModel } from './helpers/coverage-fixture.mjs';

/* A real run over the merged transcript with parts that fail: what the draft keeps (editorial.partPlans: the range of every part and the offsets of every
   target) is enough for coverageOf to say, section by section, which are covered, which were planned and did not come out, and which were never planned.
   The ground truth comes from the fake model's own log (which section each planned quote is in, which parts it was told to fail), not from the code under test. */

const fx = transcriptFixture();
const sectionOfQuote = quote => { const match = /Recording (\d+), part (\d+), point/.exec(quote); return `r${match[1]}.p${match[2]}`; };
const run = (model, extra = {}) => generateBatched(model.complete, { count: 24, kind: 'quiz', sources: fx.sources, performance: { concurrency: 2, batchSize: 5, fillRounds: 0 }, ...extra });

test('failed parts: covered, planned-failed and never-planned sections equal the ground truth of the run', async () => {
  const failing = new Set([2, 4]);
  const model = sectionedModel({ failReview: part => failing.has(part) });
  const deck = await run(model);
  assert.ok(deck.editorial.partPlans.length >= 5, 'the run has several parts');
  const covered = new Set(), failed = new Set();
  for (const { part, objectives } of model.log.authors) for (const objective of objectives) (failing.has(part) ? failed : covered).add(sectionOfQuote(model.log.quoteOf.get(objective)));
  assert.ok(covered.size >= 8 && failed.size >= 3, `a real mix: ${covered.size} covered, ${failed.size} failed`);
  const found = coverageOf({ sources: fx.sources, cards: deck.cards, partPlans: deck.editorial.partPlans });
  const stateOf = state => found.sections.filter(section => section.state === state).map(section => section.id).sort();
  assert.deepEqual(stateOf(COVERED), [...covered].sort());
  assert.deepEqual(stateOf(PLANNED_FAILED), [...failed].filter(id => !covered.has(id)).sort(), 'a part range is not used when its targets are located');
  assert.equal(found.neverPlanned, found.leaves - found.covered - found.plannedFailed);
  assert.equal(found.recorded, true);
  for (const section of found.sections.filter(item => item.state === PLANNED_FAILED)) assert.equal(section.reason, 'review-protocol');
  assert.ok(found.sections.filter(section => section.state === NEVER_PLANNED).length > 40, 'most of the material was never planned: the whole point');
});

test('the draft records the range of every part and the offsets of every target, as stored text', async () => {
  const model = sectionedModel({ failReview: part => part === 3 });
  const deck = await run(model);
  for (const plan of deck.editorial.partPlans) {
    assert.ok(plan.ranges?.length >= 1, `part ${plan.part} has a range`);
    for (const range of plan.ranges) assert.ok(range.end > range.start && range.end <= fx.textOf(range.sourceId).length);
    for (const target of plan.targets) {
      assert.ok(Number.isInteger(target.start) && target.end > target.start, `target ${target.targetId} of part ${plan.part} has offsets`);
      const stored = fx.textOf(target.sourceId).slice(target.start, target.end);
      assert.ok(stored.startsWith('Recording'), stored.slice(0, 40));
      assert.ok(stored.includes(target.quote.replace(/…$/, '')), 'the stored text between the offsets is the verbatim quote');
      assert.ok(target.knowledge && target.knowledge.length <= 240);
    }
    assert.ok(plan.targets.every(target => plan.ranges.some(range => range.sourceId === target.sourceId && target.start >= range.start && target.end <= range.end)), 'a target lies inside the range of its part');
  }
  assert.ok(JSON.stringify(deck.editorial.partPlans).length < 120_000, 'bounded');
});

test('a run that kept everything has no planned-failed section', async () => {
  const model = sectionedModel();
  const deck = await run(model, { count: 10 });
  const found = coverageOf({ sources: fx.sources, cards: deck.cards, partPlans: deck.editorial.partPlans });
  assert.equal(found.plannedFailed, 0);
  assert.equal(found.covered, new Set(deck.cards.map(card => sectionOfQuote(card.citations[0].quote))).size);
  assert.ok(found.covered >= 8 && found.covered <= 10);
});
