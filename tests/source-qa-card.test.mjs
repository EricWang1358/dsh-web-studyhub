/* Save a grounded answer ("依据原文回答") as ONE flashcard linked back to its passage.
   The real versioned APIs run here; the model is absent on purpose: saving never asks it again. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { publicCard, validateDeck } from '../lib/domain.js';

const passage = "Architecture includes the principles guiding a system's design and evolution.";
const question = 'Why do principles matter here?';
const answer = 'Because they **constrain** later changes.\n\n<script>alert(1)</script>\n\n- point one\n- point two';

async function fixture(t, { course = 'Cloud / 05 Kubernetes', decks = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'source-qa-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = { id: 'old', kind: 'flashcard', objective: 'Original objective', prompt: 'Original question?', answer: 'Original',
    review: { repetitions: 5, ease_factor: 2.6, due_at: '2030-01-01' } };
  if (decks) await new Store(root).update(state => { state.decks.push({ id: 'd', title: 'Existing deck', course, contentVersion: 2, cards: [old] }); });
  let modelCalls = 0;
  const complete = async () => { modelCalls++; throw new Error('saving a Q&A card must not call the model'); };
  const runtime = createStudyRuntime(root, { contexts: ['bank', 'materials', 'generation', 'study', 'notifications'], complete });
  t.after(() => runtime.dispose());
  const imported = await runtime.call('materials.document.import', { filename: 'notes.md', course,
    dataBase64: Buffer.from(`# Notes\n\n${passage}\n\nSecond paragraph about something else entirely.`).toString('base64') });
  const selection = (await runtime.call('materials.selection.resolve', { documentId: imported.documentId, revision: imported.revision, quote: passage })).selection;
  // As over the wire: a key set to undefined is simply absent.
  const save = (args = {}, request = {}) => runtime.call('generation.selection.saveAnswer',
    Object.fromEntries(Object.entries({ selection, question, answer, operationId: 'op-1', deckId: 'd', expectedVersion: 2, ...args }).filter(([, value]) => value !== undefined)), request);
  return { root, runtime, imported, selection, save, old, modelCalls: () => modelCalls, deck: async id => (await runtime.call('bank.get', { deckId: id })).deck };
}

test('saving an answer appends one flashcard: front is the quoted passage and the question, back is the answer as shown', async t => {
  const f = await fixture(t);
  const result = await f.save();
  assert.equal(result.status, 'complete');
  assert.equal(result.deckId, 'd');
  assert.equal(result.cardId, result.receipt.cardIds[0]);
  assert.equal(result.receipt.added, 1);
  const deck = await f.deck('d');
  assert.deepEqual(deck.cards[0], f.old, 'earlier cards and their progress are untouched');
  assert.equal(deck.contentVersion, 3);
  const card = deck.cards[1];
  assert.equal(card.kind, 'flashcard');
  assert.equal(card.answer, answer, 'the model text is kept exactly as it was shown, never rewritten');
  assert.ok(card.prompt.includes(`> ${passage}`), 'the passage is quoted on the front');
  assert.ok(card.prompt.trimEnd().endsWith(question), 'the learner question follows the passage');
  assert.equal(card.sourceQa, true, 'marked as a Q&A card so the UI can tag it');
  assert.deepEqual(card.selections, [f.selection], 'the same selection links the card back to the passage');
  assert.equal(card.citations[0].sourceId, f.selection.sourceId);
  assert.ok(card.review, 'a new card is scheduled like any other');
  assert.equal(validateDeck({ title: deck.title, cards: [card] }, [{ id: f.selection.sourceId, text: `${passage}` }]).errors.length, 0);
  assert.equal(f.modelCalls(), 0, 'no model call');
});

test('the link is visible to the reader: materials.links.list reports the card as a resolved Q&A link', async t => {
  const f = await fixture(t);
  const result = await f.save();
  const { links } = await f.runtime.call('materials.links.list', { documentId: f.imported.documentId });
  assert.equal(links.length, 1);
  assert.equal(links[0].cardId, result.cardId);
  assert.equal(links[0].status, 'resolved');
  assert.equal(links[0].kind, 'flashcard');
  assert.equal(links[0].sourceQa, true);
  assert.equal(links[0].deckTitle, 'Existing deck');
  assert.deepEqual(links[0].followups, []);
});

test('a second click or retry with the same operation never makes a second card; a changed payload is refused', async t => {
  const f = await fixture(t);
  const first = await f.save();
  const again = await f.save();
  assert.deepEqual(again.receipt, { ...first.receipt, replayed: true });
  assert.equal(again.status, 'complete');
  assert.equal((await f.deck('d')).cards.length, 2);
  await assert.rejects(f.save({ answer: `${answer} changed` }), /operation|Operation/i);
  assert.equal((await f.deck('d')).cards.length, 2);
});

test('two simultaneous clicks (same operation, default deck) still make one deck and one card', async t => {
  const f = await fixture(t, { decks: false });
  const both = await Promise.all([f.save({ deckId: undefined, expectedVersion: undefined }), f.save({ deckId: undefined, expectedVersion: undefined })]);
  assert.deepEqual(both.map(item => item.status), ['complete', 'complete']);
  assert.equal(both[0].cardId, both[1].cardId);
  const decks = (await f.runtime.call('bank.decks.list')).decks;
  assert.equal(decks.length, 1);
  assert.equal((await f.deck(decks[0].id)).cards.length, 1);
});

test('a stale deck version is a visible conflict that adds nothing, and the retry with the fresh version succeeds once', async t => {
  const f = await fixture(t);
  const stale = await f.save({ expectedVersion: 1 });
  assert.equal(stale.status, 'conflict');
  assert.match(stale.error, /version/i);
  assert.equal((await f.deck('d')).cards.length, 1);
  const retry = await f.save({ expectedVersion: 2 });
  assert.equal(retry.status, 'complete');
  assert.equal((await f.deck('d')).cards.length, 2);
});

test('the same question about the same passage is reported as a duplicate with the existing card to open', async t => {
  const f = await fixture(t);
  const first = await f.save();
  const duplicate = await f.save({ operationId: 'op-2', expectedVersion: 3 });
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.cardId, first.cardId);
  assert.equal(duplicate.deckId, 'd');
  assert.equal((await f.deck('d')).cards.length, 2);
});

test('no deck chosen: a 原文问答 deck is created once in the document\'s exact course and then reused', async t => {
  const f = await fixture(t, { decks: false, course: 'Cloud Native / 05 Kubernetes' });
  const first = await f.save({ deckId: undefined, expectedVersion: undefined });
  assert.equal(first.status, 'complete');
  const decks = (await f.runtime.call('bank.decks.list')).decks;
  assert.equal(decks.length, 1);
  assert.equal(decks[0].title, '原文问答');
  const deck = await f.deck(decks[0].id);
  assert.equal(deck.course, 'Cloud Native / 05 Kubernetes', 'the exact course, never a parent');
  assert.equal(deck.cards.length, 1);
  const second = await f.save({ deckId: undefined, expectedVersion: undefined, operationId: 'op-2', question: 'A different question?' });
  assert.equal(second.status, 'complete');
  assert.equal(second.deckId, first.deckId, 'reused, not created again');
  assert.equal((await f.runtime.call('bank.decks.list')).decks.length, 1);
  assert.equal((await f.deck(first.deckId)).cards.length, 2);
});

test('the default deck follows the course: another course gets its own, an archived or renamed one is handled', async t => {
  const f = await fixture(t, { decks: false, course: 'Alpha' });
  const alpha = await f.save({ deckId: undefined, expectedVersion: undefined });
  await new Store(f.root).update(state => { state.decks.find(deck => deck.id === alpha.deckId).title = 'My own name'; });
  const renamed = await f.save({ deckId: undefined, expectedVersion: undefined, operationId: 'op-2', question: 'Another one?' });
  assert.equal(renamed.deckId, alpha.deckId, 'a renamed deck is still the Q&A deck of its course');
  await new Store(f.root).update(state => { state.decks.find(deck => deck.id === alpha.deckId).archived = true; });
  const fresh = await f.save({ deckId: undefined, expectedVersion: undefined, operationId: 'op-3', question: 'Third?' });
  assert.notEqual(fresh.deckId, alpha.deckId, 'an archived deck is not written to');
  assert.equal((await f.deck(fresh.deckId)).course, 'Alpha');
});

test('English requests name the default deck and the card scaffolding in English', async t => {
  const f = await fixture(t, { decks: false });
  const result = await f.save({ deckId: undefined, expectedVersion: undefined, uiLanguage: 'en' });
  assert.equal(result.status, 'complete');
  const deck = await f.deck(result.deckId);
  assert.equal(deck.title, 'Source Q&A');
  const card = deck.cards[0];
  for (const field of [card.hint, card.explanation, card.misconception, card.objective, deck.title]) assert.doesNotMatch(field, /[㐀-鿿]/, field);
});

test('invalid requests fail before anything is created', async t => {
  const f = await fixture(t, { decks: false });
  for (const bad of [{ question: '  ' }, { answer: '' }, { operationId: '' }, { selection: undefined }, { question: 'x'.repeat(1001) }, { answer: 'y'.repeat(8001) }])
    await assert.rejects(f.save({ deckId: undefined, expectedVersion: undefined, ...bad }), undefined, JSON.stringify(Object.keys(bad)));
  assert.equal((await f.runtime.call('bank.decks.list')).decks.length, 0, 'no deck was created by a rejected request');
});

test('a selection from an older document revision is refused, so the passage must be selected again', async t => {
  const f = await fixture(t);
  await f.runtime.call('materials.document.import', { documentId: f.imported.documentId, filename: 'notes.md', course: 'Cloud / 05 Kubernetes',
    dataBase64: Buffer.from(`Rewritten.\n\n${passage}\n\nChanged.`).toString('base64') });
  await assert.rejects(f.save(), /stale|select/i);
  assert.equal((await f.deck('d')).cards.length, 1);
});

test('a short selection still gets a citation the deck check accepts, and the whole selection stays the link', async t => {
  const f = await fixture(t);
  const short = (await f.runtime.call('materials.selection.resolve', { documentId: f.imported.documentId, revision: f.imported.revision, quote: 'principles' })).selection;
  const result = await f.save({ selection: short, operationId: 'short' });
  assert.equal(result.status, 'complete');
  const card = (await f.deck('d')).cards[1];
  assert.deepEqual(card.selections, [short]);
  assert.ok(card.citations[0].quote.length >= 12);
});

test('Q&A cards are tagged for the review screen and everything else is not', () => {
  assert.equal(publicCard({ id: 'a', kind: 'flashcard', sourceQa: true, topic: 't', prompt: 'p', hint: 'h' }).sourceQa, true);
  assert.equal(publicCard({ id: 'a', kind: 'flashcard', topic: 't', prompt: 'p', hint: 'h' }).sourceQa, false);
});

test('follow-up Q&A saved on a card travel with its passage link, newest first, and only the ones for the current card text', async t => {
  const f = await fixture(t);
  const saved = await f.save();
  const add = text => f.runtime.call('card.followup.add', { deckId: 'd', cardId: saved.cardId, question: text, answer: `answer to ${text}` });
  await add('first follow-up?');
  await new Promise(resolve => setTimeout(resolve, 5));
  await add('second follow-up?');
  const { links } = await f.runtime.call('materials.links.list', { documentId: f.imported.documentId });
  assert.deepEqual(links[0].followups.map(item => item.question), ['second follow-up?', 'first follow-up?']);
  assert.equal(typeof links[0].followups[0].answer, 'string');
  assert.equal(links[0].followups[0].digest, undefined, 'internal digests stay private');
  await new Store(f.root).update(state => { state.decks.find(deck => deck.id === 'd').cards[1].followups[0].digest = 'older-card-text'; });
  const after = await f.runtime.call('materials.links.list', { documentId: f.imported.documentId });
  assert.deepEqual(after.links[0].followups.map(item => item.question), ['second follow-up?'], 'an answer to an older version of the card is not shown as current');
});
