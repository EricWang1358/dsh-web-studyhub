/* 术语卡 of the review book (#710 S1): the cards the write call returns with the text (no call of their own), checked by the program the way cites are;
   kept on the unit they were written with; the pitch in the sample papers' language. Fakes only: no model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTES_LIMITS, normalizeCourseNotes } from '../lib/course-book.js';
import { leafCards, normalizeTermCards } from '../lib/course-book-term-cards.js';
import { readDraft } from '../lib/contexts/generation/book/read.js';
import { repairPrompt, reviewPrompt, writePrompt } from '../lib/contexts/generation/book/prompts.js';
import { bodyOf } from '../lib/contexts/generation/book/jobs/leaf-stage.js';
import { pitchLanguage } from '../lib/contexts/generation/book/pitch-language.js';

const ID = n => `i${String(n).padStart(11, '0')}`;
const unit = { n: 1, of: 1, segments: [{ sourceId: 's1', start: 0, end: 60, text: 'Software architecture is the fundamental organisation of a system.', material: 'L1' }],
  checklist: [{ alias: 'c1', id: ID(1), kind: 'definition', name: 'Software architecture', priority: 'must' },
    { alias: 'c2', id: ID(2), kind: 'concept', name: 'Coupling', priority: 'must' }, { alias: 'c3', id: ID(3), kind: 'example', name: 'Big ball of mud', priority: 'optional' }] };
const reply = cards => JSON.stringify({ text: 'Software architecture and coupling, explained.', covered: [{ id: 'c1' }, { id: 'c2' }], quotes: [], cards });

test('the write reply\'s cards: aliases mapped back, unknown aliases dropped, lengths capped by NOTES_LIMITS, a relation to an item named from the checklist', () => {
  const draft = readDraft(reply([
    { item: 'c1', name: '软件架构', alt: 'Software Architecture', plain: '系统里最难推倒重来的骨架决策。', pitch: 'Software architecture defines the fundamental components.',
      relations: [{ kind: 'related', item: 'c2' }, { kind: 'opposite', name: 'Big-Ball-of-Mud' }, { kind: 'part', item: 'c9' }, { kind: 'cousin', item: 'c2' }, { kind: 'related', item: 'c1' }] },
    { item: 'c9', name: 'Invented', plain: 'x', pitch: 'y' },
    { item: 'c2', name: 'x'.repeat(500), plain: 'p'.repeat(5000), pitch: '' },
    { item: 'c1', name: 'Again', plain: 'twice', pitch: 'twice' },
    { item: 'c3', name: 'Name only' },
  ]), unit);
  assert.ok(draft, 'the text is still read');
  assert.deepEqual(draft.cards.map(card => card.item), [ID(1), ID(2)], 'c9 is not in the checklist; c1 once; a card with nothing to say is dropped');
  assert.deepEqual(draft.cards[0].relations, [{ kind: 'related', item: ID(2), name: 'Coupling' }, { kind: 'opposite', name: 'Big-Ball-of-Mud' }],
    'an unknown alias, an unknown kind and a relation to itself are dropped');
  assert.equal(draft.cards[0].alt, 'Software Architecture');
  assert.ok(draft.cards[1].name.length <= NOTES_LIMITS.termName && draft.cards[1].plain.length <= NOTES_LIMITS.termPlain);
  assert.ok(!('pitch' in draft.cards[1]) || draft.cards[1].pitch === '');
});

test('a missing or broken card list never fails the text', () => {
  for (const cards of [undefined, 'nonsense', [null, 3, { item: 'c1' }]]) {
    const draft = readDraft(reply(cards), unit);
    assert.ok(draft, `the text is kept (${JSON.stringify(cards)})`);
    assert.deepEqual(draft.cards, []);
  }
});

test('a point keeps cards only for the items its text covers', () => {
  const item = { fingerprint: 'f'.repeat(16), units: [unit], checklist: unit.checklist, readPrint: '0'.repeat(16) };
  const draft = { text: 'Software architecture …', cites: [], claimed: [ID(1), ID(2)], dropped: 0,
    cards: [{ item: ID(1), name: 'A', plain: 'a', pitch: 'a' }, { item: ID(2), name: 'B', plain: 'b', pitch: 'b' }] };
  const verdict = { pass: false, reviewed: true, covered: [ID(1)], missing: [unit.checklist[1]], blocking: [], issues: [] };
  const body = bodyOf(item, [{ draft, verdict, repaired: 0 }]);
  assert.deepEqual(body.units[0].cards.map(card => card.item), [ID(1)], 'no card for an item the text does not explain');
});

const leaf = (id, body) => ({ id, title: id.toUpperCase(), anchors: [], ...(body ? { body } : {}) });
const unitBody = cards => ({ fingerprint: 'a'.repeat(16), units: [{ text: 'Text.', cites: [], covered: [ID(1)], read: [], status: 'ok', ...(cards ? { cards } : {}) }],
  coverage: { must: 1, covered: [ID(1)], missing: [], optional: 0 }, issues: [], status: 'ok' });

test('the record keeps the cards of a unit and drops what is not a card; a book without cards loads as before', () => {
  const notes = normalizeCourseNotes({ course: 'C', outlineId: 'o', leaves: [
    leaf('a', unitBody([{ item: ID(1), name: 'A', plain: 'a', pitch: 'p', relations: [{ kind: 'part', item: ID(2), name: 'B' }, { kind: 'part', item: 'bad', name: 'X' }] },
      { item: 'not-an-id', name: 'B', plain: 'b', pitch: 'b' }])),
    leaf('b', unitBody()), leaf('c', { fingerprint: 'b'.repeat(16), points: ['Old point'], explain: 'Old text.', cites: [] })] });
  assert.deepEqual(notes.leaves[0].body.units[0].cards, [{ item: ID(1), name: 'A', plain: 'a', pitch: 'p', relations: [{ kind: 'part', item: ID(2), name: 'B' }] }]);
  assert.ok(!('cards' in notes.leaves[1].body.units[0]), 'no cards, no field');
  assert.equal(notes.leaves[2].body.explain, 'Old text.');
  assert.deepEqual(leafCards(notes.leaves[1].body), []);
  assert.deepEqual(leafCards(notes.leaves[2].body), [], 'a legacy body has no cards');
  assert.deepEqual(normalizeTermCards(null, { limits: NOTES_LIMITS, isItem: () => true }), []);
});

const card = (n, name, extra = {}) => ({ item: ID(n), name, plain: `${name} plainly`, pitch: `${name} in one exam sentence.`, ...extra });
const plan = { language: 'zh', pitchLanguage: 'en' };
const point = { title: 'What architecture is', path: [], before: null, after: null };

test('the prompts: the write call asks for cards in the reply, the pitch in the papers\' language; review and repair see the cards', () => {
  const write = writePrompt(unit, point, plan).prompt;
  assert.match(write, /"cards"/);
  assert.match(write, /pitch[^\n]*English/, 'the pitch in the language of the sample papers');
  const draft = { text: 'T', cites: [], claimed: [ID(1)], cards: [card(1, 'Architecture', { relations: [{ kind: 'related', item: ID(2), name: 'Coupling' }] })] };
  // The cards are what the review and repair alone read: their STAGE DATA, after the point's pages (the order of tests/book-prompt-order.test.mjs).
  const data = text => JSON.parse(text.slice(text.indexOf('STAGE DATA:\n') + 12));
  const review = data(reviewPrompt(unit, point, draft, plan).prompt), repair = data(repairPrompt(unit, point, draft, { missing: [], issues: [], round: 1 }, plan).prompt);
  for (const sent of [review, repair]) assert.deepEqual(sent.cards[0], { item: 'c1', name: 'Architecture', plain: 'Architecture plainly', pitch: 'Architecture in one exam sentence.',
    relations: [{ kind: 'related', item: 'c2' }] }, 'cards are shown by alias, never by inventory id');
  assert.match(reviewPrompt(unit, point, draft, plan).prompt, /card/);
});

test('the pitch language is decided once: the sample papers\' language when there are papers, else the book\'s', () => {
  const documents = [{ key: 'p1', sourceIds: ['a'] }, { key: 'l1', sourceIds: ['b'] }];
  const sources = [{ id: 'a', text: 'Question 1. Explain the trade-offs of a layered architecture and give an example of coupling between layers.' },
    { id: 'b', text: '软件架构是系统的根本组织结构，包括组件、组件之间的关系以及与环境的关系。' }];
  assert.equal(pitchLanguage({ documents, sources, papers: ['p1'], language: 'zh' }), 'en');
  assert.equal(pitchLanguage({ documents, sources, papers: [], language: 'zh' }), 'zh');
  assert.equal(pitchLanguage({ documents, sources: [{ id: 'a', text: '第一题：解释分层架构的取舍，并举例说明层间耦合。' }], papers: ['p1'], language: 'en' }), 'zh');
  assert.equal(pitchLanguage({ documents, sources: [{ id: 'a', text: '' }], papers: ['p1'], language: 'en' }), 'en', 'a paper with nothing to read: the book\'s');
});

