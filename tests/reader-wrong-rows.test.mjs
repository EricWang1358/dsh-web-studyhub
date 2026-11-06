import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

/* 错题 of the reader (reader/wrong-rows.js): the rows of the 错题与待巩固 page (call 'wrongbook') that are questions of THIS document, the current chapter's first,
   then the rest of the book, each with where to practise it and the passage it points at. Nothing is stored; the page's records are only filtered. */
const m = await loadUi(`export * from './ui/document-preview/reader/wrong-rows.js';`);

const wrong = (deckId, cardId, extra = {}) => ({ deckId, cardId, prompt: `Question ${cardId}`, topic: 'Output', assessment: 'graded', ...extra });
const linked = (deckId, cardId) => ({ deckId, cardId, level: 'weak', links: [] });

test('only the questions of this document are listed, in the order of the 错题 page, the chapter first', () => {
  const items = [wrong('d1', 'c1'), wrong('d1', 'other'), wrong('d1', 'c2'), wrong('d2', 'c3'), wrong('d1', 'c4')];
  const cards = [linked('d1', 'c1'), linked('d1', 'c2'), linked('d2', 'c3'), linked('d1', 'c4')];
  const entryOf = key => ({ 'd1|c1': 'page-1', 'd1|c2': 'page-30', 'd2|c3': 'page-2', 'd1|c4': null })[key] ?? null;
  const rows = m.wrongRowsOf({ items, cards, entryOf, drawn: new Set(['page-1', 'page-2']) });
  assert.deepEqual(rows.here.map(row => row.cardId), ['c1', 'c3'], 'the questions of the chapter that is drawn');
  assert.deepEqual(rows.rest.map(row => row.cardId), ['c2', 'c4'], 'the rest of the book: another chapter, and a question no place could be found for');
  assert.equal(rows.total, 4);
  assert.equal(rows.here[0].entryId, 'page-1');
  assert.equal(rows.rest[1].entryId, null, 'a question with no place has nowhere to jump');
  assert.equal(rows.rest[1].item.prompt, 'Question c4');
});

test('a document that is not read by chapters has one list, and nothing is listed for a document with no wrong question', () => {
  const items = [wrong('d1', 'c1'), wrong('d1', 'c2')], cards = [linked('d1', 'c1'), linked('d1', 'c2')];
  const whole = m.wrongRowsOf({ items, cards, entryOf: () => 'h-1', drawn: null });
  assert.deepEqual(whole.here.map(row => row.cardId), ['c1', 'c2']);
  assert.deepEqual(whole.rest, []);
  const none = m.wrongRowsOf({ items: [wrong('d9', 'x')], cards, entryOf: () => null, drawn: null });
  assert.equal(none.total, 0);
});

test('a card is told by its deck and its id together: the same id in another deck is another question', () => {
  const rows = m.wrongRowsOf({ items: [wrong('d2', 'c1')], cards: [linked('d1', 'c1')], entryOf: () => null, drawn: null });
  assert.equal(rows.total, 0);
});

test('readWrongBook walks the pages of the 错题 call until every row of this document is found, and stops at the end of the list', async () => {
  const all = Array.from({ length: 250 }, (_, n) => wrong('d1', `c${n}`));
  const calls = [];
  const call = async (action, args) => { calls.push({ action, ...args }); return { total: all.length, items: all.slice(args.offset, args.offset + args.limit) }; };
  const keys = new Set(['d1|c3', 'd1|c120']);
  const found = await m.readWrongBook({ call, keys });
  assert.deepEqual(found.map(item => item.cardId), ['c3', 'c120']);
  assert.equal(calls.length, 2, 'two pages of 100: both rows were found, so it stops');
  assert.ok(calls.every(entry => entry.action === 'wrongbook' && entry.view === 'weak' && entry.course === '*' && entry.includeInactive === true));
  calls.length = 0;
  const missing = await m.readWrongBook({ call, keys: new Set(['d1|nowhere']) });
  assert.deepEqual(missing, []);
  assert.equal(calls.length, 3, 'the whole list of 250 is read in 3 pages, then it stops');
});
