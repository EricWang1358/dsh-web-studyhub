import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAcrossPortions } from '../lib/one-pass/merge.js';
import { portionDeck } from '../lib/one-pass/deck.js';

/* After every portion has settled, cards of different sections that test the same objective (or rest on the same quote) are merged by the program: the
   earlier one in reading order stays, the later one is omitted with the reason, its review receipt and check go with it. Staged parts are left alone. */

const card = (id, objective, quote) => ({ id, targetId: `t-${id}`, kind: 'quiz', topic: 'T', objective, prompt: `Q ${id}?`, answer: 'a', hint: 'h', explanation: 'e', misconception: 'm',
  options: [{ id: 'option-1', text: 'a', correct: true, explanation: 'x' }, { id: 'option-2', text: 'b', correct: false, explanation: 'y' }, { id: 'option-3', text: 'c', correct: false, explanation: 'z' }],
  citations: [{ sourceId: 'doc', quote }] });
const deckOf = cards => portionDeck({ cards, targets: [], checks: cards.map(item => ({ cardId: item.id, explanation: 'ok' })) });

test('a later portion\'s card on the same objective or the same quote is omitted; the earlier one stays', () => {
  const first = deckOf([card('a', 'Apply the limit rule', 'The value stays below 100.'), card('b', 'Name the unit', 'Readings are in volts.')]);
  const second = deckOf([card('c', 'apply the  LIMIT rule!', 'Another sentence entirely.'), card('d', 'State the cause', 'readings are in volts'), card('e', 'Explain the reset', 'A failed reading resets it.')]);
  const planned = [{ onePass: true, count: 2 }, { onePass: true, count: 3 }];
  const outcomes = [{ deck: first }, { deck: second }];
  const merged = mergeAcrossPortions(planned, outcomes);
  assert.equal(merged[0].deck, first, 'the first portion is untouched');
  const kept = merged[1].deck;
  assert.deepEqual(kept.cards.map(item => item.objective), ['Explain the reset']);
  assert.equal(Object.keys(kept.editorial.reviewedCards).length, 1);
  assert.equal(kept.editorial.audit.checks.length, 1);
  assert.deepEqual(kept.editorial.omitted.map(item => item.objective), ['apply the  LIMIT rule!', 'State the cause']);
  assert.ok(kept.editorial.omitted.every(item => /duplicate learning target/.test(item.reasons[0])));
  assert.equal(kept.editorial.dropped, 2);
  assert.equal(second.cards.length, 3, 'the outcome given is not changed in place');
});

test('staged parts, failed parts and a run with nothing repeated are returned as they were', () => {
  const staged = { deck: deckOf([card('a', 'Same objective', 'q1')]) }, failed = { error: 'boom' };
  const onePass = { deck: deckOf([card('b', 'Other objective', 'q2')]) };
  const outcomes = [staged, failed, onePass, undefined];
  const merged = mergeAcrossPortions([{ count: 1 }, { onePass: true, count: 1 }, { onePass: true, count: 1 }, { onePass: true, count: 1 }], outcomes);
  assert.deepEqual(merged, outcomes);
  const repeat = { deck: deckOf([card('c', 'Same objective', 'q3')]) };
  assert.equal(mergeAcrossPortions([{ count: 1 }, { onePass: true, count: 1 }], [staged, repeat])[1], repeat, 'a staged card is not a one-pass portion: the run\'s own check handles it');
});
