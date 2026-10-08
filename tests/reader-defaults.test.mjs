import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestDeck, supplementDefaults, rememberDeck, recallDeck, LAST_DECK_KEY } from '../ui/document-preview/supplement-defaults.js';
import { createThreadMemory } from '../ui/document-preview/thread-memory.js';
import { addNode, answerNode, emptyThread, failNode } from '../ui/document-preview/ask-thread.js';

/* The reader's top-up form starts filled in, and says why: the deck the material is used by, else the deck last topped up; the kind and the number come
   from 设置 › 出题偏好 (one fact, one number). A thread of answers that was not kept comes back when its passage is selected again. */

const decks = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C', archived: true }];
const memory = () => { const map = new Map(); return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => { map.set(key, String(value)); } }; };

test('the material\'s only deck is the suggestion, with its reason', () => {
  assert.deepEqual(suggestDeck({ usedBy: [{ kind: 'deck', id: 'a', title: 'A' }], decks }), { deckId: 'a', reason: 'material' });
  // A draft is not a deck, an archived or missing deck is not offered, so the only one left still counts.
  assert.deepEqual(suggestDeck({ usedBy: [{ kind: 'draft', id: 'x' }, { kind: 'deck', id: 'a' }, { kind: 'deck', id: 'c', archived: true }, { kind: 'deck', id: 'gone' }], decks }), { deckId: 'a', reason: 'material' });
});

test('with several decks, or none, the last deck topped up is used when it is still there', () => {
  const many = [{ kind: 'deck', id: 'a' }, { kind: 'deck', id: 'b' }];
  assert.deepEqual(suggestDeck({ usedBy: many, decks, last: 'b' }), { deckId: 'b', reason: 'last' });
  assert.deepEqual(suggestDeck({ usedBy: [], decks, last: 'a' }), { deckId: 'a', reason: 'last' });
  assert.deepEqual(suggestDeck({ usedBy: many, decks, last: '' }), { deckId: '', reason: '' }, 'two candidates and no memory: the learner chooses');
  assert.deepEqual(suggestDeck({ usedBy: [], decks, last: 'c' }), { deckId: '', reason: '' }, 'an archived deck is not suggested');
  assert.deepEqual(suggestDeck({ usedBy: [], decks, last: 'gone' }), { deckId: '', reason: '' });
  assert.deepEqual(suggestDeck({ decks: [], last: 'a' }), { deckId: '', reason: '' }, 'no decks at all');
});

test('the last deck is remembered in the browser and a blocked storage changes nothing', () => {
  const storage = memory();
  assert.equal(recallDeck(storage), '');
  rememberDeck('b', storage);
  assert.equal(storage.getItem(LAST_DECK_KEY), JSON.stringify('b'));
  assert.equal(recallDeck(storage), 'b');
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(recallDeck(blocked), '');
  assert.doesNotThrow(() => rememberDeck('b', blocked));
});

test('kind and number come from the saved 出题偏好, within what a top-up accepts', () => {
  assert.deepEqual(supplementDefaults({ kinds: ['quiz'], count: 10 }), { kind: 'quiz', count: 10 });
  assert.deepEqual(supplementDefaults({ kinds: ['cloze', 'quiz'], count: 6 }), { kind: 'cloze', count: 6 }, 'a top-up writes one kind: the first one ticked');
  assert.deepEqual(supplementDefaults({ kinds: ['flashcard'], count: 200 }), { kind: 'flashcard', count: 20 }, 'a top-up writes at most 20');
  assert.deepEqual(supplementDefaults(undefined), { kind: 'quiz', count: 10 }, 'no saved settings: the shipped defaults of 出题偏好');
  assert.deepEqual(supplementDefaults({ kind: 'open', count: 4 }), { kind: 'open', count: 4 }, 'a library from an older version has only `kind`');
});

test('an unsaved thread comes back with its saved ids when its passage is selected again, and it is forgotten when the learner deletes it', () => {
  const held = createThreadMemory();
  const answered = answerNode(addNode(emptyThread(), { id: 'n1', parentId: null, question: 'q' }), 'n1', 'a');
  assert.equal(held.recall('s|0|5'), null);
  held.remember('s|0|5', answered, new Set(['n1']));
  const back = held.recall('s|0|5');
  assert.deepEqual(back.thread, answered);
  assert.deepEqual([...back.saved], ['n1']);
  assert.equal(held.recall('s|6|9'), null, 'another passage has its own');
  // Nothing worth keeping: a thread of failed questions is not held, and an empty one (the panel between two passages) leaves what was held alone.
  held.remember('s|6|9', failNode(addNode(emptyThread(), { id: 'n2', parentId: null, question: 'q' }), 'n2', 'offline'), new Set());
  assert.equal(held.recall('s|6|9'), null);
  held.remember('s|0|5', emptyThread(), new Set());
  assert.ok(held.recall('s|0|5'), 'an empty thread is not a deletion');
  held.forget('s|0|5');
  assert.equal(held.recall('s|0|5'), null);
  held.remember('', answered, new Set());
  assert.equal(held.recall(''), null, 'no key, no memory');
});

test('a question still waiting when the learner moves on is held, and its answer lands in the held thread', () => {
  const held = createThreadMemory();
  const waiting = addNode(emptyThread(), { id: 'n1', parentId: null, question: 'q' });
  held.remember('s|0|5', waiting);
  assert.deepEqual(held.recall('s|0|5').thread, waiting, 'it was paid for, so it is held');
  assert.equal(held.settle('s|0|5', 'n1', thread => answerNode(thread, 'n1', 'late answer')), true);
  assert.equal(held.recall('s|0|5').thread.nodes[0].answer, 'late answer');
  assert.equal(held.settle('s|0|5', 'other', thread => thread), false, 'a node of another thread is not applied');
  assert.equal(held.settle('s|6|9', 'n1', thread => thread), false, 'nor on a passage that holds nothing');
});
