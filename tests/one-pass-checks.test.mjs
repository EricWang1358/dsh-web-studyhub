import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlacer, optionsProblem, answerStandsOut, shuffleOptions, cardOf } from '../lib/one-pass/checks.js';
import { pieceOfAssignment } from '../lib/assigned-plan.js';

/* The program checks of one pass (plan §3 item 3, §10): no model. The quote is located in its section, exactly one option is correct, no second card on the
   same quote or objective, at most the quota per section, options shuffled by the program. */

const text = [
  'Alpha section. A cache stores the result of an expensive call so the next identical call is answered at once.',
  'Beta section. An index lets a database find rows without scanning the whole table, at the price of slower writes.',
].join('\n\n');
const source = { id: 'doc', title: 'Notes', text };
const betaAt = text.indexOf('Beta section.');
const assignments = [
  { key: 'doc#a', sectionId: 'doc#a', sourceId: 'doc', start: 0, end: betaAt, quota: 2, title: 'Alpha' },
  { key: 'doc#b', sectionId: 'doc#b', sourceId: 'doc', start: betaAt, end: text.length, quota: 1, title: 'Beta' },
];
const slots = assignments.map((assignment, index) => ({ ...assignment, label: `S${index + 1}`, pieces: pieceOfAssignment(assignment, [source], `S${index + 1}`) }));
const options = (right = 'It answers repeated calls at once', wrong = ['It encrypts each stored value', 'It compresses the network traffic', 'It sorts the requests by size']) =>
  [{ text: right, correct: true, explanation: 'why' }, ...wrong.map(item => ({ text: item, correct: false, explanation: 'misconception' }))];
const written = (extra = {}) => ({ section: 'S1', topic: 'Caching', objective: 'Explain what a cache saves', quote: 'A cache stores the result of an expensive call',
  prompt: 'A service repeats one slow lookup. What does adding a cache change?', hint: 'Think about repeated work.', options: options(),
  explanation: 'The stored result is reused.', misconception: 'Thinking a cache makes the first call faster.', ...extra });

test('a card whose quote stands in its section is kept as a verified target with the offsets of the quote', () => {
  const place = createPlacer({ slots });
  const { target } = place(written());
  assert.equal(target.sectionId, 'doc#a');
  assert.equal(target.assignment, 'doc#a');
  assert.equal(text.slice(target.start, target.end), 'A cache stores the result of an expensive call');
  assert.deepEqual(target.citations, [{ sourceId: 'doc', quote: 'A cache stores the result of an expensive call' }]);
  assert.equal(target.targetId, 'target-1');
});

test('a quote that is not in the material is dropped: quote-not-found', () => {
  assert.equal(createPlacer({ slots })(written({ quote: 'A cache is a kind of spreadsheet used by accountants' })).reason, 'quote-not-found');
});

test('a quote in another section of the portion is credited to the section it really stands in', () => {
  const { target } = createPlacer({ slots })(written({ section: 'S1', objective: 'Explain the cost of an index', quote: 'at the price of slower writes' }));
  assert.equal(target.sectionId, 'doc#b');
});

test('at most the quota per section: the card past it is dropped as over-quota', () => {
  const place = createPlacer({ slots });
  assert.ok(place(written({ section: 'S2', objective: 'One', quote: 'An index lets a database find rows' })).target);
  assert.equal(place(written({ section: 'S2', objective: 'Two', quote: 'at the price of slower writes' })).reason, 'over-quota');
});

test('no second card on the same objective or the same quote; an objective the library holds is a duplicate too', () => {
  const place = createPlacer({ slots, existing: ['Explain what an index costs'] });
  assert.ok(place(written()).target);
  assert.equal(place(written({ quote: 'so the next identical call is answered at once' })).reason, 'duplicate', 'the same objective, written differently');
  assert.equal(place(written({ objective: 'Something else entirely' })).reason, 'duplicate', 'the same quote');
  assert.equal(place(written({ section: 'S2', objective: 'explain what an INDEX costs!', quote: 'An index lets a database find rows' })).reason, 'duplicate');
});

test('exactly one option is correct, and the options are a choice of 3 to 6', () => {
  assert.equal(optionsProblem(options()), '');
  const two = options().map((option, index) => ({ ...option, correct: index < 2 }));
  assert.match(optionsProblem(two), /correct/);
  assert.match(optionsProblem(options().map(option => ({ ...option, correct: false }))), /correct/);
  assert.match(optionsProblem(options().slice(0, 2)), /options/);
  assert.match(optionsProblem(undefined), /options/);
  assert.equal(createPlacer({ slots })(written({ options: two })).reason, 'options');
});

test('the answer stands out when the correct option is more than 25% longer than the longest wrong option', () => {
  assert.equal(answerStandsOut(options('abcdefghij', ['abcdefgh', 'abc', 'ab'])), false, '10 against 8 is exactly 25% longer');
  assert.equal(answerStandsOut(options('abcdefghijk', ['abcdefgh', 'abc', 'ab'])), true, '11 against 8');
  assert.equal(answerStandsOut(options('a b c d e f g h i j k', ['abcdefgh', 'abc', 'ab'])), true, 'spaces do not count');
});

test('the program shuffles the options: the same options, each with its own id, in the order the random source gives', () => {
  const sequence = [0.1, 0.9, 0.5], random = () => sequence.shift() ?? 0;
  const shuffled = shuffleOptions(options(), random);
  assert.deepEqual(new Set(shuffled.map(option => option.text)), new Set(options().map(option => option.text)));
  assert.deepEqual(shuffled.map(option => option.id), ['option-1', 'option-2', 'option-3', 'option-4']);
  assert.equal(shuffled.filter(option => option.correct).length, 1);
  assert.notDeepEqual(shuffled.map(option => option.text), options().map(option => option.text));
});

test('a placed card becomes a card with the fields of today\'s cards: its objective, answer, options and citation come from what the program checked', () => {
  const { target } = createPlacer({ slots })(written());
  const card = cardOf(written(), target, { random: () => 0 });
  assert.equal(card.kind, 'quiz');
  assert.equal(card.targetId, target.targetId);
  assert.equal(card.objective, 'Explain what a cache saves');
  assert.deepEqual(card.citations, target.citations);
  assert.equal(card.answer, 'It answers repeated calls at once');
  for (const key of ['id', 'topic', 'prompt', 'hint', 'explanation', 'misconception']) assert.equal(typeof card[key], 'string', key);
  assert.ok(card.options.every(option => option.id && typeof option.correct === 'boolean' && option.explanation));
});
