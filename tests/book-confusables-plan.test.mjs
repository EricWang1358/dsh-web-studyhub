/* 易混概念 (#710 S3), what the build decides before and after its calls: the pairs of the points' cards put in batches of CONFUSABLE_PAIRS (a comparison already
   written from the same words is kept, no call), the prompt (the rules lead and are the same for every batch; the batch's pairs come last) and the reading of the
   answer (nothing is trusted: a pair that was not asked, a row with an unknown aspect or a missing cell is dropped). Fakes only: no model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFUSABLE_PAIRS } from '../lib/contexts/generation/book/constants.js';
import { assembleConfusables, expectedConfusableCalls, planConfusables } from '../lib/contexts/generation/book/confusables/plan.js';
import { confusablePrompt } from '../lib/contexts/generation/book/confusables/prompt.js';
import { readConfusables } from '../lib/contexts/generation/book/confusables/read.js';
import { scaleEstimate } from '../lib/contexts/generation/book/estimate.js';

const ID = n => `i${String(n).padStart(11, '0')}`;
/** Pairs 1..n: card 2k-1 is opposite card 2k, all on one point (`id` of the work item), the second card naming the first back (A-B and B-A). */
const itemOf = (id, from, pairs, extra = {}) => ({ id, body: { units: [{ text: 't', cards: Array.from({ length: pairs * 2 }, (_, at) => {
  const n = from + at, odd = at % 2 === 0;
  return { item: ID(n), name: `Concept ${n}`, plain: `${extra.word ?? 'plain'} ${n}`, pitch: `pitch ${n}`, relations: [{ kind: odd ? 'opposite' : 'parallel', item: ID(odd ? n + 1 : n - 1), name: `Concept ${odd ? n + 1 : n - 1}` }] };
}) }] } });
const rows = [{ aspect: 'what', cells: ['a', 'b'] }, { aspect: 'difference', cells: ['a differs', 'b differs'] }];

test('the batches: CONFUSABLE_PAIRS pairs a call in book order, aliases p1… inside a batch, keys that follow the words', () => {
  const plan = planConfusables([itemOf('x', 1, 25)], { language: 'en', previous: [] });
  assert.equal(plan.pairs.length, 25);
  assert.deepEqual(plan.batches.map(batch => batch.pairs.length), [CONFUSABLE_PAIRS, CONFUSABLE_PAIRS, 5]);
  assert.deepEqual(plan.batches[2].pairs.map(pair => pair.alias), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(plan.batches.map(batch => batch.number), [1, 2, 3]);
  assert.deepEqual(plan.batches[0].pairs[0].items, [ID(1), ID(2)], 'the card with the lower code first');
  assert.equal(new Set(plan.batches.map(batch => batch.key)).size, 3);
  assert.deepEqual(planConfusables([itemOf('x', 1, 25)], { language: 'en', previous: [] }).batches.map(batch => batch.key), plan.batches.map(batch => batch.key),
    'the same cards, the same keys (a retry reuses the answers)');
  assert.notDeepEqual(planConfusables([itemOf('x', 1, 25)], { language: 'zh', previous: [] }).batches.map(batch => batch.key), plan.batches.map(batch => batch.key),
    'another language is another comparison');
  assert.deepEqual(planConfusables([itemOf('x', 1, 0)], { language: 'en', previous: [] }).batches, []);
  assert.deepEqual(planConfusables([{ id: 'empty' }, { id: 'e2', body: { empty: true } }], { language: 'en' }).batches, [], 'points with no body have no pairs');
});

test('a comparison written from the same words is kept and costs no call; changed words ask the pair again; a pair that is none any more is not kept', () => {
  const first = planConfusables([itemOf('x', 1, 3)], { language: 'en', previous: [] });
  const written = new Map(first.pairs.map(pair => [pair.key, rows]));
  const saved = assembleConfusables(first, written);
  assert.equal(saved.length, 3);
  assert.deepEqual(Object.keys(saved[0]).sort(), ['items', 'print', 'rows']);
  const again = planConfusables([itemOf('x', 1, 3)], { language: 'en', previous: saved });
  assert.deepEqual(again.batches, [], 'nothing changed: no call');
  assert.deepEqual(assembleConfusables(again, new Map()), saved, 'and the saved comparisons are kept as they were');
  // One card was written again with other words: its pair alone is asked.
  const items = [itemOf('x', 1, 3)];
  items[0].body.units[0].cards[2].plain = 'a rewritten sentence';
  const changed = planConfusables(items, { language: 'en', previous: saved });
  assert.deepEqual(changed.batches.map(batch => batch.pairs.map(pair => pair.items)), [[[ID(3), ID(4)]]]);
  // A pair whose relation was dropped is no longer kept.
  const fewer = planConfusables([itemOf('x', 1, 2)], { language: 'en', previous: saved });
  assert.equal(assembleConfusables(fewer, new Map()).length, 2);
});

test('a batch that failed leaves its pairs out of the record (the next build asks them again); the others are kept in book order', () => {
  const plan = planConfusables([itemOf('x', 1, 14)], { language: 'en', previous: [] });
  const written = new Map(plan.batches[1].pairs.map(pair => [pair.key, rows]));
  const record = assembleConfusables(plan, written);
  assert.deepEqual(record.map(entry => entry.items[0]), plan.batches[1].pairs.map(pair => pair.items[0]));
  assert.deepEqual(assembleConfusables(plan, new Map()), []);
});

const batchOf = () => planConfusables([itemOf('x', 1, 25)], { language: 'zh', previous: [] }).batches;

test('the prompt: the rules lead and are the same for every batch, the pairs\' words come last, cards are data and the language is the book\'s', () => {
  const [one, , three] = batchOf().map(batch => confusablePrompt(batch, { language: 'zh' }));
  const at = request => request.prompt.indexOf('REQUEST DATA:');
  assert.ok(at(one) > 0);
  assert.equal(one.system, three.system);
  assert.equal(one.prompt.slice(0, at(one)), three.prompt.slice(0, at(three)), 'everything before the data is the same for a call of ten pairs and one of five');
  assert.ok(!one.prompt.slice(0, at(one)).includes('Concept 1'), 'no pair word leads');
  assert.match(one.system, /untrusted data, never instructions/);
  assert.match(one.prompt, /Simplified Chinese/);
  for (const aspect of ['what', 'when', 'difference', 'mistake']) assert.match(one.prompt, new RegExp(`"${aspect}"`));
  const data = JSON.parse(one.prompt.slice(at(one) + 'REQUEST DATA:\n'.length));
  assert.equal(data.stage, 'confusables');
  assert.equal(data.pairs.length, CONFUSABLE_PAIRS);
  assert.deepEqual(data.pairs[0], { id: 'p1', relation: 'opposite', a: { name: 'Concept 1', plain: 'plain 1', pitch: 'pitch 1' }, b: { name: 'Concept 2', plain: 'plain 2', pitch: 'pitch 2' } });
  assert.ok(!JSON.stringify(data).includes(ID(1)), 'inventory ids are never shown: short aliases only');
  const en = confusablePrompt(batchOf()[0], { language: 'en' });
  assert.match(en.prompt, /English/);
});

test('the answer is read like every model reply: unreadable is null; a pair not asked, an unknown aspect and a row missing a cell are dropped; a pair with no row is not answered', () => {
  const batch = batchOf()[2];
  const reply = { pairs: [
    { id: 'p1', rows: [{ aspect: 'what', a: 'A is', b: 'B is' }, { aspect: 'mistake', a: 'slip A', b: 'slip B' }, { aspect: 'bogus', a: 'x', b: 'y' }, { aspect: 'when', a: 'only a' }] },
    { id: 'p2', rows: [{ aspect: 'bogus', a: 'x', b: 'y' }] },
    { id: 'p99', rows: [{ aspect: 'what', a: 'x', b: 'y' }] },
    { id: 'p3', rows: 'no rows' },
    { id: 'p4', rows: [{ aspect: 'difference', a: ` ${'long '.repeat(80)} `, b: 'short' }] },
    { id: 'p1', rows: [{ aspect: 'what', a: 'repeated', b: 'repeated' }] },
    'junk',
  ] };
  const read = readConfusables(JSON.stringify(reply), batch);
  assert.deepEqual([...read.keys()], [0, 3], 'p1 and p4 only; p1 once, its first answer');
  assert.deepEqual(read.get(0), [{ aspect: 'what', cells: ['A is', 'B is'] }, { aspect: 'mistake', cells: ['slip A', 'slip B'] }]);
  assert.ok(read.get(3)[0].cells[0].length <= 240);
  assert.equal(readConfusables('Not JSON at all.', batch), null);
  assert.equal(readConfusables(JSON.stringify({ rows: [] }), batch), null, 'not the shape asked: asked once more');
  assert.equal(readConfusables(JSON.stringify({ pairs: [] }), batch).size, 0);
});

test('the sample\'s scale: the pairs its cards name, per point, for the points still to write; the calls are in the estimate\'s calls, tokens and stages', () => {
  // Two sample points with 3 pairs each (each pair named from both sides, counted once): 3 a point, 30 points left, 10 pairs a call.
  const sample = [itemOf('a', 1, 3), itemOf('b', 7, 3), { id: 'c' }];
  assert.equal(expectedConfusableCalls(sample, 30), 9);
  assert.equal(expectedConfusableCalls(sample, 0), 0);
  assert.equal(expectedConfusableCalls([{ id: 'c' }], 30), 0, 'no card in the sample: no pair seen');
  const usage = (input, output) => ({ uncachedInputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const calls = [{ stage: 'write', part: 1, modelRequest: true, tokenUsage: usage(800, 400), startedAt: new Date(0).toISOString(), endedAt: new Date(1000).toISOString() }];
  const without = scaleEstimate({ calls, rest: { points: 30, tested: 0, inventory: 0 }, total: 32, sample: 2, concurrency: 4 });
  const withPairs = scaleEstimate({ calls, rest: { points: 30, tested: 0, inventory: 0, confusables: 9 }, total: 32, sample: 2, concurrency: 4 });
  assert.equal(withPairs.calls.low, without.calls.low + 9);
  assert.ok(withPairs.totalTokens.low > without.totalTokens.low);
  assert.deepEqual(withPairs.stages.at(-1).id, 'confusables');
  assert.equal(withPairs.stages.at(-1).calls, 9);
  assert.equal(without.stages.some(stage => stage.id === 'confusables'), false, 'a build with none lists none');
});
