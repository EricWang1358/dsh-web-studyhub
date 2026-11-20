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
  assert.deepEqual(kept.editorial.omitted.map(item => item.coveredBy), [first.cards[0].id, first.cards[1].id], 'each names the card that covers its target');
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

/* Then ONE model call over the whole round groups the cards that test the same fact in other words; the first of each group in reading order stays. The program
   bounds what the reply may remove: only groups of the same or adjacent sections, of at most `sameFactGroup` cards, and never more than `sameFactShare` of the round. */

// Ten sections of 100 characters; portion A holds sections 0–4, portion B sections 5–9, one card in each, and a staged part between them.
const section = n => ({ key: `doc#s${n}`, sectionId: `doc#s${n}`, sourceId: 'doc', start: n * 100, end: n * 100 + 100, quota: 1 });
const placed = n => ({ ...card(`c${n}`, `Objective ${n}`, `quote ${n}`), citations: [{ sourceId: 'doc', quote: `quote ${n}`, at: { start: n * 100 + 10, end: n * 100 + 20 } }] });
const round = () => {
  const planned = [{ onePass: true, count: 5, assignments: [0, 1, 2, 3, 4].map(section) }, { count: 1 }, { onePass: true, count: 5, assignments: [5, 6, 7, 8, 9].map(section) }];
  const outcomes = [{ deck: deckOf([0, 1, 2, 3, 4].map(placed)) }, { deck: deckOf([card('s', 'Staged objective', 'q9')]) }, { deck: deckOf([5, 6, 7, 8, 9].map(placed)) }];
  return { planned, outcomes };
};
const replying = (groups, calls = []) => async (system, prompt, context) => { calls.push({ system, data: JSON.parse(prompt), context }); return JSON.stringify({ groups }); };
const kept = merged => merged.flatMap(outcome => (outcome?.deck?.cards || []).map(item => item.objective));

test('the same-fact merge: one call with every one-pass card; in a group the first in reading order stays, the other is omitted naming the card that covers it', async () => {
  const { planned, outcomes } = round(), calls = [];
  const merged = await mergeSameFacts(planned, outcomes, replying([[5, 4]], calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].system, SAME_FACT_SYSTEM);
  assert.deepEqual(calls[0].context, { stage: STAGE.reviewing, unit: 'merge' });
  assert.deepEqual(calls[0].data.cards.map(item => [item.index, item.objective]), Array.from({ length: 10 }, (_, n) => [n, `Objective ${n}`]), 'staged cards are not sent');
  assert.equal(merged[0], outcomes[0], 'the portion of the card that stays is untouched');
  assert.equal(merged[1], outcomes[1]);
  assert.deepEqual(merged[2].deck.cards.map(item => item.objective), ['Objective 6', 'Objective 7', 'Objective 8', 'Objective 9']);
  const [omitted] = merged[2].deck.editorial.omitted;
  assert.deepEqual([omitted.objective, omitted.reasons[0], omitted.coveredBy], ['Objective 5', SAME_FACT_REASON, outcomes[0].deck.cards[4].id]);
  assert.equal(merged[2].deck.editorial.audit.checks.length, 4);
  assert.equal(outcomes[2].deck.cards.length, 5, 'the outcome given is not changed in place');
});

test('bounds: a group of sections that are not adjacent, a group larger than sameFactGroup, an unknown index or a card with no place removes nothing', async () => {
  const { planned, outcomes } = round();
  assert.deepEqual(kept(await mergeSameFacts(planned, outcomes, replying([[0, 2], [3, 9]]))), kept(outcomes), 'two sections apart');
  const big = Array.from({ length: ONE_PASS_LIMITS.sameFactGroup + 1 }, (_, n) => n);
  assert.deepEqual(kept(await mergeSameFacts(planned, outcomes, replying([big]))), kept(outcomes), 'a group larger than the limit');
  assert.deepEqual(kept(await mergeSameFacts(planned, outcomes, replying([[0, 99], ['x', 1]]))), kept(outcomes), 'unknown indexes leave a group of one');
  const loose = round();
  loose.outcomes[0] = { deck: deckOf([card('n', 'No place', 'q0'), ...[1, 2, 3, 4].map(placed)]) };
  assert.deepEqual(kept(await mergeSameFacts(loose.planned, loose.outcomes, replying([[0, 1]]))), kept(loose.outcomes), 'a card whose section is unknown');
  const fine = await mergeSameFacts(planned, outcomes, replying([[0, 1], [0, 2]]));
  assert.equal(kept(fine).length, 10, 'the accepted group of adjacent sections still goes through');
});

test('bounds: a reply that would remove more than sameFactShare of the round is ignored whole, and every card stays', async () => {
  const { planned, outcomes } = round(), share = Math.max(1, Math.floor(10 * ONE_PASS_LIMITS.sameFactShare));
  assert.equal(share, 2);
  assert.equal(kept(await mergeSameFacts(planned, outcomes, replying([[0, 1], [2, 3]]))).length, 9, 'two of the ten one-pass cards may go (the staged card stays)');
  assert.deepEqual(await mergeSameFacts(planned, outcomes, replying([[0, 1], [2, 3], [4, 5]])), outcomes, 'three of ten would be too many: nothing goes');
});

test('a broken reply is asked again once; a reply with no groups, fewer than two cards or more than the limit leave the run as it is', async () => {
  const { planned, outcomes } = round(), replies = ['not json', '{"groups":[]}'], contexts = [];
  const merged = await mergeSameFacts(planned, outcomes, async (system, prompt, context) => { contexts.push(context); return replies.shift(); });
  assert.deepEqual(contexts.map(item => item.retry), [undefined, 1]);
  assert.deepEqual(merged, outcomes);
  let asked = 0;
  const count = async () => { asked++; return '{"groups":[[0,1]]}'; };
  const one = [{ deck: deckOf([placed(0)]) }];
  assert.equal(await mergeSameFacts([{ onePass: true, assignments: [section(0)] }], one, count), one);
  const many = [{ deck: deckOf(Array.from({ length: ONE_PASS_LIMITS.sameFactCards + 1 }, (_, index) => card(`m${index}`, `Objective ${index}`, `quote ${index}`))) }];
  assert.equal(await mergeSameFacts([{ onePass: true }], many, count), many);
  assert.equal(asked, 0);
  await assert.rejects(mergeSameFacts(planned, outcomes, async () => 'still not json'), SyntaxError, 'a reply that stays broken throws; the run keeps its cards');
});
