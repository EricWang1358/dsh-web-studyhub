import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBatched, shareCount, chunkSources, planGeneration } from '../lib/batch.js';
import { planPrompts } from '../lib/assessment-quality.js';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { eightRecordings, pdfBook, notes } from './helpers/materials-fixture.mjs';

/* Flow A, the plain path (a count of at most 30, no coverage level): the owner's real mixed deck asked for 30, planned 18 and kept 8, and 6 of its 8 recordings (60% of the text) had no
   question, because a planner that answers "insufficient evidence" for a whole group of 60 000 characters threw the group away. */

const performance = { concurrency: 2, batchSize: 5, fillRounds: 0 };
const recordingsIn = (sources) => new Set(sources.flatMap(source => [...source.text.matchAll(/Recording (\d+), part \d+, point \d+\.1:/g)].map(match => Number(match[1]))));
const recordingOfCard = card => Number(/Recording (\d+),/.exec(card.citations[0].quote)?.[1]);

test('shareCount: every group of pages gets at least one question while the count allows', () => {
  const chunk = (chars) => [{ id: `s${chars}`, text: 'x'.repeat(chars) }];
  assert.deepEqual(shareCount([chunk(60000), chunk(60000), chunk(5000)], 10).map(n => n >= 1), [true, true, true]);
  assert.equal(shareCount([chunk(60000), chunk(60000), chunk(5000)], 10).reduce((a, b) => a + b, 0), 10);
  assert.deepEqual(shareCount([chunk(60000), chunk(100), chunk(100)], 2), [1, 1, 0], 'fewer questions than groups: the largest get one');
});

test('two kinds over more groups than either kind has questions: no group is left with none', () => {
  const sources = [...notes(4, 59000)];
  const parts = planGeneration({ sources, count: 5, kinds: ['quiz', 'flashcard'], performance });
  const groups = chunkSources(sources);
  assert.equal(groups.length, 4);
  for (const group of groups) assert.ok(parts.some(part => part.sources.some(source => group.some(piece => piece.id === source.id))), 'a part for every group');
  assert.equal(parts.reduce((sum, part) => sum + part.count, 0), 5);
});

test('the plain prompt says to spread over ALL materials when a call holds several, and only then', () => {
  const several = planPrompts({ sources: [...notes(2)], count: 4 }).prompt, one = planPrompts({ sources: pdfBook({ pages: 3 }), count: 4 }).prompt;
  assert.match(several, /SEVERAL materials/);
  assert.match(several, /spread the knowledge points over ALL of them/);
  assert.doesNotMatch(one, /SEVERAL materials/, 'the pages of one PDF are one material');
  const merged = planPrompts({ sources: eightRecordings().sources.slice(0, 1), count: 4 }).prompt;
  assert.match(merged, /SEVERAL materials/, 'the recordings of a merged transcript are several materials');
});

test('a group the planner refuses as a whole is planned material by material: every recording gets questions (the old run lost every refused group)', async () => {
  const { sources } = eightRecordings();
  // The planner refuses any call that holds more than one recording (the owner's free model on a 60 000-character group), and answers one recording at a time.
  let refused = 0;
  const model = clusteringModel({ refuse: request => { const no = recordingsIn(request.sources).size > 1; refused += no ? 1 : 0; return no; } });
  const deck = await generateBatched(model.complete, { kind: 'quiz', sources, count: 30, performance });
  const asked = new Set(deck.cards.map(recordingOfCard));
  assert.deepEqual([...asked].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8], 'every recording has a question');
  assert.equal(deck.editorial.needsTopUp, undefined, 'nothing is left for a top-up');
  // What it costs: the refused calls (one per group of pages) and one call per material of those groups (a group cut inside a recording holds a piece of it): nothing is planned a third time.
  const groups = chunkSources(sources).length;
  assert.equal(refused, groups, `${refused} refused calls for ${groups} groups`);
  assert.ok(model.log.asks.length - refused <= 8 + groups, `${model.log.asks.length - refused} planning calls by material`);
});

test('a material the planner refuses even alone is recorded as needing a top-up, with the reason; the others keep their questions', async () => {
  const { sources } = eightRecordings();
  const model = clusteringModel({ refuse: request => recordingsIn(request.sources).size > 1 || recordingsIn(request.sources).has(5) });
  const deck = await generateBatched(model.complete, { kind: 'quiz', sources, count: 30, performance });
  const asked = new Set(deck.cards.map(recordingOfCard));
  assert.ok(!asked.has(5));
  for (const recording of [1, 2, 3, 4, 6, 7, 8]) assert.ok(asked.has(recording), `recording ${recording} has a question`);
  const gap = deck.editorial.needsTopUp?.find(item => item.title === 'lecture-05.mp3');
  assert.ok(gap, JSON.stringify(deck.editorial.needsTopUp));
  assert.equal(gap.reason, 'insufficient-evidence');
  assert.match(gap.detail, /insufficient evidence/);
  assert.ok(gap.sourceIds.length >= 1);
});
