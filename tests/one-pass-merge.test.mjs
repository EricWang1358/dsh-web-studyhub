import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAcrossPortions, mergeSameFacts, SAME_FACT_SYSTEM, SAME_FACT_REASON } from '../lib/one-pass/merge.js';
import { ONE_PASS_LIMITS } from '../lib/one-pass/limits.js';
import { GENERATION_STAGE_TEXT as STAGE } from '../lib/contexts/jobs/contracts.js';
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

/* Then ONE model call over the whole run groups the cards that test the same fact in other words; the first of each group in reading order stays. */

const fourCards = () => {
  const planned = [{ onePass: true, count: 2 }, { count: 1 }, { onePass: true, count: 2 }];
  const outcomes = [{ deck: deckOf([card('a', 'Apply the limit', 'q1'), card('b', 'Name the unit', 'q2')]) }, { deck: deckOf([card('s', 'Staged objective', 'q9')]) },
    { deck: deckOf([card('c', 'Use the cap', 'q3'), card('d', 'Explain the reset', 'q4')]) }];
  return { planned, outcomes };
};

test('the same-fact merge: one call with every one-pass card; in each group the first in reading order stays, the others are omitted with the reason', async () => {
  const { planned, outcomes } = fourCards(), calls = [];
  const ask = async (system, prompt, context) => { calls.push({ system, data: JSON.parse(prompt), context }); return JSON.stringify({ groups: [[2, 0], [1, 99, 'x']] }); };
  const merged = await mergeSameFacts(planned, outcomes, ask);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].system, SAME_FACT_SYSTEM);
  assert.deepEqual(calls[0].context, { stage: STAGE.reviewing, unit: 'merge' });
  assert.deepEqual(calls[0].data.cards.map(item => [item.index, item.objective, item.prompt]), [[0, 'Apply the limit', 'Q a?'], [1, 'Name the unit', 'Q b?'],
    [2, 'Use the cap', 'Q c?'], [3, 'Explain the reset', 'Q d?']], 'staged cards are not sent');
  assert.equal(merged[0], outcomes[0], 'the portion of the kept card is untouched');
  assert.equal(merged[1], outcomes[1]);
  assert.deepEqual(merged[2].deck.cards.map(item => item.objective), ['Explain the reset']);
  assert.deepEqual(merged[2].deck.editorial.omitted.map(item => [item.objective, item.reasons[0]]), [['Use the cap', SAME_FACT_REASON]]);
  assert.equal(merged[2].deck.editorial.audit.checks.length, 1);
  assert.equal(outcomes[2].deck.cards.length, 2, 'the outcome given is not changed in place');
});

test('a broken reply is asked again once; a reply with no groups, fewer than two cards or more than the limit leave the run as it is', async () => {
  const { planned, outcomes } = fourCards(), replies = ['not json', '{"groups":[]}'], contexts = [];
  const merged = await mergeSameFacts(planned, outcomes, async (system, prompt, context) => { contexts.push(context); return replies.shift(); });
  assert.deepEqual(contexts.map(item => item.retry), [undefined, 1]);
  assert.deepEqual(merged, outcomes);
  let asked = 0;
  const count = async () => { asked++; return '{"groups":[[0,1]]}'; };
  const one = [{ deck: deckOf([card('a', 'Only card', 'q1')]) }];
  assert.equal(await mergeSameFacts([{ onePass: true }], one, count), one);
  const many = [{ deck: deckOf(Array.from({ length: ONE_PASS_LIMITS.sameFactCards + 1 }, (_, index) => card(`m${index}`, `Objective ${index}`, `quote ${index}`))) }];
  assert.equal(await mergeSameFacts([{ onePass: true }], many, count), many);
  assert.equal(asked, 0);
  await assert.rejects(mergeSameFacts(planned, outcomes, async () => 'still not json'), SyntaxError, 'a reply that stays broken throws; the run keeps its cards');
});
