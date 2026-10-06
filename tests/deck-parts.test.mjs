import test from 'node:test';
import assert from 'node:assert/strict';
import { partOf, nextPartOf, partsOf, partsSummary, nextPartOfSummary, draftPart, stampPart } from '../lib/deck-parts.js';
import { coverageForDraft, coverageForDocument, documentTopUp } from '../lib/coverage-state.js';
import { contentKey } from '../lib/card-content.js';
import { sectionKey } from '../lib/coverage.js';
import { transcriptFixture } from './helpers/coverage-fixture.mjs';

/* The parts of a deck (the owner's decision of 2026-10-06): a published deck is never topped up in place; 为没覆盖的部分补题 of its material makes a NEW draft whose targets are exactly
   the document's sections without a question, and once published into the deck its questions are the deck's next part (`part: N` on each card; no marker = part 1). The pure rules. */

const fx = transcriptFixture({ recordings: 2, parts: 6, paragraphs: 4 });
const keyOf = section => sectionKey(section.sourceId, section.id);
const deck = (id, cards, extra = {}) => ({ id, title: `Deck ${id}`, cards, ...extra });
const first = fx.leaves.slice(0, 2).map(section => fx.card(section));

test('a deck without a marker is ONE part (old decks need no migration); the next part is the highest + 1', () => {
  const old = deck('old', first);
  assert.deepEqual(partsOf(old), [{ n: 1, count: 2 }]);
  assert.equal(nextPartOf(old), 2);
  assert.deepEqual(partsSummary(old), {}, 'a deck of one part says nothing in the snapshot');
  assert.equal(nextPartOfSummary({}), 2);
  assert.equal(partOf({}), 1);
  assert.equal(partOf({ part: 'x' }), 1);
  assert.equal(nextPartOf(undefined), 2, 'no deck, no crash');
  const two = deck('two', [...first, ...stampPart([fx.card(fx.leaves[3])], 2)]);
  assert.deepEqual(partsOf(two), [{ n: 1, count: 2 }, { n: 2, count: 1 }]);
  assert.deepEqual(partsSummary(two), { parts: [2, 1], partNumbers: [1, 2] });
  assert.equal(nextPartOf(two), 3, 'a third top-up is part 3');
  assert.equal(nextPartOfSummary(partsSummary(two)), 3);
});

test('the marker is not content: stamping a part does not reset what the learner knows of the card', () => {
  const [card] = first;
  assert.equal(contentKey({ ...card, part: 2 }), contentKey(card));
});

test('a draft that will be a part says which deck and which part; any other draft is not one', () => {
  assert.deepEqual(draftPart({ editorial: { part: { deckId: 'D', n: 2 } } }), { deckId: 'D', n: 2 });
  assert.equal(draftPart({ editorial: {} }), null);
  assert.equal(draftPart({ editorial: { part: {} } }), null);
});

test('the document offers the top-up: the decks that hold its questions are the candidates, the round covers exactly its sections without a question', () => {
  const state = { sources: fx.sources, decks: [deck('D', first)], drafts: [] };
  const found = documentTopUp(state, { sourceId: fx.sources[0].id });
  const doc = coverageForDocument(state, { sourceId: fx.sources[0].id });
  assert.equal(found.coverage.covered, 2);
  assert.equal(found.coverage.percentLeaves, doc.coverage.percentLeaves, 'one fact, one number: the same coverage the 资料 row says');
  assert.deepEqual(found.candidates.map(item => [item.id, item.questions, item.nextPart]), [['D', 2, 2]]);
  assert.equal(found.round.uncovered, fx.leaves.length - 2);
  const covered = new Set(fx.leaves.slice(0, 2).map(keyOf));
  assert.ok(found.round.picks.length > 0 && found.round.picks.every(pick => !covered.has(pick.key)), 'a covered section is never planned');
  assert.equal(found.round.allQuestions, fx.leaves.length - 2, 'one question per section without one: what it takes to reach every section');
  assert.equal(found.canTopUp, true);
});

test('archived decks, suspended questions and copies of a published deck are left out, like the coverage of a document', () => {
  const archived = deck('A', [fx.card(fx.leaves[4])], { archived: true });
  const suspended = deck('S', [{ ...fx.card(fx.leaves[5]), suspended: true }]);
  const copy = { id: 'copy', title: 'edit', editingDeckId: 'D', cards: [fx.card(fx.leaves[6])], editorial: {} };
  const state = { sources: fx.sources, decks: [deck('D', first), archived, suspended], drafts: [copy] };
  const found = documentTopUp(state, { sourceId: fx.sources[0].id });
  assert.equal(found.coverage.covered, 2);
  assert.deepEqual(found.candidates.map(item => item.id), ['D'], 'an archived deck and a deck whose only question is suspended are not candidates');
});

test('no published deck holds the material: nothing is offered (the draft page has its own top-up)', () => {
  const draft = { id: 'd1', title: 'first draft', cards: first, editorial: { requested: 2, generation: { sourceIds: fx.sources.map(source => source.id) } } };
  const found = documentTopUp({ sources: fx.sources, decks: [], drafts: [draft] }, { sourceId: fx.sources[0].id });
  assert.deepEqual(found.candidates, []);
  assert.equal(found.canTopUp, false);
});

test('every section has a question: nothing to top up', () => {
  const all = fx.leaves.map(section => fx.card(section));
  const found = documentTopUp({ sources: fx.sources, decks: [deck('D', all)], drafts: [] }, { sourceId: fx.sources[0].id });
  assert.equal(found.coverage.covered, found.coverage.leaves);
  assert.equal(found.round.sections, 0);
  assert.equal(found.canTopUp, false);
});

test('sections a draft is already working on (its run is running, paused or waiting with them in rounds not done) are not planned twice', () => {
  const waiting = fx.leaves.slice(2, 6).map(keyOf);
  const inFlight = { id: 'p', title: 'part', cards: [], editorial: { requested: 4, generation: { sourceIds: fx.sources.map(source => source.id) }, part: { deckId: 'D', n: 2 },
    coverageSpec: { topup: true, goal: 4, quotas: waiting.map(sectionId => ({ sectionId, quota: 1 })), rounds: [{ round: 1, questions: 4, sectionIds: waiting, status: 'pending' }] },
    coverageRun: { state: 'waiting' } } };
  const state = { sources: fx.sources, decks: [deck('D', first)], drafts: [inFlight] };
  const found = documentTopUp(state, { sourceId: fx.sources[0].id });
  assert.equal(found.round.uncovered, fx.leaves.length - 2 - waiting.length);
  assert.ok(found.round.picks.every(pick => !waiting.includes(pick.key)));
  assert.equal(found.inFlight, waiting.length);
  // A run that STOPPED is not working on its sections: they are offered again.
  const stopped = { ...inFlight, editorial: { ...inFlight.editorial, coverageRun: { state: 'stopped', stop: { reason: 'learner' } } } };
  assert.equal(documentTopUp({ ...state, drafts: [stopped] }, { sourceId: fx.sources[0].id }).round.uncovered, fx.leaves.length - 2);
});

test('the coverage of a part draft is its DOCUMENT\'s: the deck\'s questions count, so its numbers are the 资料 row\'s', () => {
  const part = { id: 'p', title: 'part', cards: [fx.card(fx.leaves[3], { id: 'new-1' })], editorial: { requested: 1, generation: { sourceIds: fx.sources.map(source => source.id) }, part: { deckId: 'D', n: 2 } } };
  const state = { sources: fx.sources, decks: [deck('D', first)], drafts: [part] };
  const own = coverageForDraft(state, part), doc = coverageForDocument(state, { sourceId: fx.sources[0].id }).coverage;
  assert.equal(own.covered, 3);
  assert.equal(own.covered, doc.covered);
  assert.equal(own.percentLeaves, doc.percentLeaves);
  // A draft that is not a part keeps its own coverage, as before.
  const plain = { ...part, editorial: { ...part.editorial, part: undefined } };
  assert.equal(coverageForDraft({ ...state, drafts: [plain] }, plain).covered, 1);
});
