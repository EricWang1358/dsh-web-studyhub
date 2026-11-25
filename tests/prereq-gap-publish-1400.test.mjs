import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeck } from '../lib/domain.js';
import { runPrereqGapScan } from '../lib/contexts/generation/generate/prereq-gap-scan.js';
import { stageSystem } from '../lib/prompt-order.js';
import { settleJob } from './helpers/wait.mjs';
import { card, evidence } from './helpers/supplement-fixtures.mjs';
import { openLibrary, stagedModel } from './helpers/generation-baseline.mjs';

/* #1400: the prerequisite cards of the zero-foundation scan must be cards like any other: they pass validateDeck, are saved in the draft, publish with the deck, and the
   links that name them keep pointing at the deck they are in. Fake models only. */

const source = { id: 'p1', title: 'Notes', text: evidence };
const QUOTE = 'an abstraction from its implementation';
const SCAN_HEAD = 'You identify assumed prerequisite concepts';

/** A scan reply item with every field a card needs; `change` overrides some of them. */
const scanItem = (change = {}) => ({
  term: 'Abstraction', topic: 'Foundations', objective: 'Recognise what an abstraction is',
  prompt: 'What does an abstraction hide?', answer: 'The details of how something is done.',
  hint: 'Think about what a caller does not need to know.', explanation: 'An abstraction names the what and keeps the how behind it.',
  misconception: 'An abstraction is the same as a subclass.', sourceId: 'p1', quote: QUOTE, targetCardIds: ['a'], ...change });

const draftDeck = () => ({ id: 'deck-gap', title: 'Architecture', course: 'A',
  cards: [{ ...card('a', 'p1'), objective: 'Explain principle 1', prompt: 'What guides design question 1?' }] });

test('a prerequisite card of the scan passes validateDeck: objective, hint, misconception and a verified citation of the page it was found on', async () => {
  const result = await runPrereqGapScan({ deck: draftDeck(), sources: [source], ask: async () => JSON.stringify({ prerequisites: [scanItem()] }) });
  assert.equal(result.added, 1);
  const added = result.deck.cards.find(item => item.prereqGap === true);
  assert.deepEqual(added.citations, [{ sourceId: 'p1', quote: QUOTE }]);
  assert.deepEqual(validateDeck(result.deck, [source]).errors, []);
});

test('a prerequisite whose reply lacks a field, quotes a text that is not in the material, or repeats an objective is not added', async () => {
  const reply = { prerequisites: [
    scanItem({ term: 'No hint', prompt: 'Prompt one?', objective: 'Objective one', hint: '' }),
    scanItem({ term: 'No misconception', prompt: 'Prompt two?', objective: 'Objective two', misconception: undefined }),
    scanItem({ term: 'Invented quote', prompt: 'Prompt three?', objective: 'Objective three', quote: 'a sentence that no material contains' }),
    scanItem({ term: 'Wrong page, right quote', prompt: 'Prompt four?', objective: 'Objective four', sourceId: 'nope' }),
    scanItem({ term: 'Repeats objective', prompt: 'Prompt five?', objective: 'Explain principle 1' }),
    scanItem({ term: 'Good', prompt: 'Prompt six?', objective: 'Objective six' }),
  ] };
  const result = await runPrereqGapScan({ deck: draftDeck(), sources: [source], ask: async () => JSON.stringify(reply) });
  const kept = result.deck.cards.filter(item => item.prereqGap);
  assert.deepEqual(kept.map(item => item.prereqTerm), ['Wrong page, right quote', 'Good']);
  assert.equal(kept[0].citations[0].sourceId, 'p1', 'a quote that is verbatim on one page is pointed at that page');
  assert.equal(result.added, 2);
  assert.equal(result.skippedInvalid, 4);
  assert.deepEqual(validateDeck(result.deck, [source]).errors, []);
});

test('the scan asks the model for the fields a card needs', async () => {
  let system = '';
  await runPrereqGapScan({ deck: draftDeck(), sources: [source], ask: async (head) => { system = head; return '{"prerequisites":[]}'; } });
  for (const field of ['objective', 'hint', 'misconception', 'sourceId', 'quote']) assert.match(system, new RegExp(`"${field}"`));
});

/* ---- through the real service ---- */

function scanningModel(scanReply, record = []) {
  const staged = stagedModel();
  const complete = async (system, prompt, context) => {
    const head = stageSystem(system, prompt);
    record.push({ head, prompt });
    if (head.startsWith(SCAN_HEAD)) return JSON.stringify(scanReply);
    return staged.complete(system, prompt, context);
  };
  return { complete, record };
}
async function library(t, model) {
  const opened = await openLibrary(t, { prefix: 'study-1400-', model: model.complete });
  await opened.service.call('source.add', { ...source, courses: ['A'] });
  return opened;
}
const GENERATE = { sourceIds: ['p1'], count: 1, kind: 'flashcard' };

test('a zero-foundation run puts prerequisite cards in the draft that validate, publish with the deck, and whose links point at the published deck', async t => {
  const { complete } = scanningModel({ prerequisites: [scanItem({ targetCardIds: [] })] });
  const { service } = await library(t, { complete });
  const started = await service.call('generate', { ...GENERATE, learnerLevel: 'zero' });
  const done = await settleJob(service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  const state = await service.call('export');
  const draft = state.drafts[0];
  const prereq = draft.cards.filter(item => item.prereqGap === true);
  assert.equal(prereq.length, 1, 'the scan added its card to the draft');
  assert.deepEqual(validateDeck(draft, state.sources).errors, [], 'the draft is publishable');
  const dependents = draft.cards.filter(item => item.requires?.length);
  assert.ok(dependents.length, 'a generated card requires the prerequisite');

  const published = await service.call('draft.publish.start', { id: draft.id, draftVersion: draft.draftVersion });
  const result = await settleJob(service, published.jobId);
  assert.equal(result.status, 'complete', result.stage);
  assert.equal(result.rejected, 0, 'no card is held back');
  assert.equal(result.accepted, draft.cards.length);
  const after = await service.call('export');
  const deck = after.decks.find(item => item.id === result.deckId);
  assert.ok(deck.cards.some(item => item.prereqGap === true), 'the prerequisite card is in the deck');
  for (const item of deck.cards) for (const link of item.requires || [])
    assert.ok(after.decks.find(other => other.id === link.deckId)?.cards.some(found => found.id === link.cardId), 'a link points at a card that exists in the deck it names');
});

test('the links of a published prerequisite follow the deck when the draft is merged into another deck', async t => {
  const { complete } = scanningModel({ prerequisites: [scanItem({ targetCardIds: [] })] });
  const { service } = await library(t, { complete });
  await service.store.update(state => { state.decks.push({ id: 'target', title: 'Target', course: 'A', cards: [{ ...card('old', 'p1'), objective: 'Old objective', prompt: 'Old prompt?' }], createdAt: '2026-09-29T00:00:00.000Z' }); });
  const started = await service.call('generate', { ...GENERATE, learnerLevel: 'zero' });
  assert.equal((await settleJob(service, started.jobId)).status, 'complete');
  const draft = (await service.call('export')).drafts[0];
  const published = await service.call('draft.publish.start', { id: draft.id, draftVersion: draft.draftVersion, mergeTargetId: 'target' });
  const result = await settleJob(service, published.jobId);
  assert.equal(result.status, 'complete', result.stage);
  const after = await service.call('export');
  assert.equal(result.deckId, 'target');
  const links = after.decks.find(item => item.id === 'target').cards.flatMap(item => item.requires || []);
  assert.ok(links.length && links.every(link => link.deckId === 'target'), 'every link names the deck the cards are in now');
});
