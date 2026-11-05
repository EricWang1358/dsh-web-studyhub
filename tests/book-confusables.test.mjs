/* 易混概念 (#710 S3), the parts that need no build: the pairs the program takes from the term cards' opposite and parallel relations (A-B and B-A once, a
   concept with no card skipped), the stored comparisons as they are checked where they enter (a malformed row is dropped, never the book), and the view the
   book page and the cheat-sheet read (C001 ids, K codes in book order, the cells in the order of the codes). Fakes only: no model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCardNumbers } from '../lib/course-book-card-numbers.js';
import { CONFUSABLE_ASPECTS, CONFUSABLE_LIMITS, confusablePairs, confusablesView, normalizeConfusables, pairKey } from '../lib/course-book-confusables.js';

const ID = n => `i${String(n).padStart(11, '0')}`;
const card = (n, name, relations = []) => ({ item: ID(n), name, plain: `${name} plainly`, pitch: `${name} in an answer.`, ...(relations.length ? { relations } : {}) });
const leaf = (hid, cards) => ({ hid, leaf: true, children: [], ...(cards ? { cards } : {}) });
/** Four cards over two points: Cache (K001) opposite Buffer (K002, named), TCP (K003) parallel UDP (K004) said by both, UDP also opposite a concept with no card. */
const nodes = () => withCardNumbers([
  leaf('h1', [card(1, 'Cache', [{ kind: 'opposite', name: 'buffer' }, { kind: 'related', item: ID(3), name: 'TCP' }]), card(2, 'Buffer', [{ kind: 'opposite', item: ID(1), name: 'Cache' }])]),
  leaf('h2', [card(3, 'TCP', [{ kind: 'parallel', item: ID(4), name: 'UDP' }, { kind: 'part', item: ID(4), name: 'UDP' }]),
    card(4, 'UDP', [{ kind: 'parallel', item: ID(3), name: 'TCP' }, { kind: 'opposite', name: 'Not UDP' }])]),
  leaf('h3'),
]);
const rows = [{ aspect: 'what', cells: ['A is a', 'B is a'] }, { aspect: 'difference', cells: ['A differs', 'B differs'] }];

test('the pairs: opposite and parallel only, A-B and B-A once, by item or by name, a concept with no card skipped, in the order of the codes', () => {
  const pairs = confusablePairs(nodes());
  assert.deepEqual(pairs.map(pair => [pair.a.code, pair.b.code, pair.kind]), [['K001', 'K002', 'opposite'], ['K003', 'K004', 'parallel']],
    'related and part make no pair; both directions of a pair make one; "Not UDP" has no card');
  assert.equal(pairs[0].key, pairKey(ID(2), ID(1)), 'the key does not depend on the order');
  assert.equal(pairs[0].a.name, 'Cache');
  assert.deepEqual(confusablePairs(withCardNumbers([leaf('h1')])), []);
  assert.deepEqual(confusablePairs([]), []);
  // A card related to itself, or to a name only another card has by its other name, is not a pair of two cards.
  const self = withCardNumbers([leaf('h1', [card(1, 'Cache', [{ kind: 'opposite', item: ID(1), name: 'Cache' }])])]);
  assert.deepEqual(confusablePairs(self), []);
});

test('moving a point renumbers the pairs: the new order of the codes decides which card comes first', () => {
  const moved = withCardNumbers([leaf('h2', [card(3, 'TCP', [{ kind: 'parallel', item: ID(4), name: 'UDP' }]), card(4, 'UDP')]),
    leaf('h1', [card(1, 'Cache', [{ kind: 'opposite', item: ID(2), name: 'Buffer' }]), card(2, 'Buffer')])]);
  assert.deepEqual(confusablePairs(moved).map(pair => [pair.a.code, pair.a.name, pair.b.name]), [['K001', 'TCP', 'UDP'], ['K003', 'Cache', 'Buffer']]);
});

test('stored comparisons are checked where they enter: unknown items, repeats, unknown aspects, rows without both cells and long cells are dropped, never the book', () => {
  const isItem = id => [ID(1), ID(2), ID(3), ID(4)].includes(id), print = 'a'.repeat(16);
  const long = 'x'.repeat(CONFUSABLE_LIMITS.cellChars + 50);
  const kept = normalizeConfusables([
    { items: [ID(1), ID(2)], print, rows: [{ aspect: 'mistake', cells: ['m1', 'm2'] }, { aspect: 'what', cells: [` ${long} `, 'b'] }, { aspect: 'bogus', cells: ['x', 'y'] },
      { aspect: 'when', cells: ['only one'] }, { aspect: 'when', cells: ['', 'b'] }, { aspect: 'what', cells: ['again', 'again'] }, 'junk', null] },
    { items: [ID(2), ID(1)], print, rows },
    { items: [ID(3), ID(3)], print, rows },
    { items: [ID(3), ID(99)], print, rows },
    { items: [ID(3), ID(4)], print: 'not a print', rows },
    { items: [ID(3), ID(4)], print, rows: [{ aspect: 'bogus', cells: ['x', 'y'] }] },
    { items: [ID(3), ID(4)], print, rows, extra: 'ignored' },
    'junk', null, { items: 'no' },
  ], { isItem });
  assert.equal(kept.length, 2, JSON.stringify(kept));
  assert.deepEqual(kept[0].items, [ID(1), ID(2)]);
  assert.deepEqual(kept[0].rows.map(row => row.aspect), ['what', 'mistake'], 'in the order the aspects are shown, each once');
  assert.equal(kept[0].rows[0].cells[0].length, CONFUSABLE_LIMITS.cellChars, 'a long cell is cut');
  assert.deepEqual(Object.keys(kept[1]).sort(), ['items', 'print', 'rows'], 'nothing else is kept');
  assert.deepEqual(normalizeConfusables(undefined, { isItem }), []);
  assert.deepEqual(normalizeConfusables('x', { isItem }), []);
  const many = Array.from({ length: CONFUSABLE_LIMITS.pairs + 5 }, (_, at) => ({ items: [ID(1000 + at), ID(2000 + at)], print, rows }));
  assert.equal(normalizeConfusables(many, { isItem: () => true }).length, CONFUSABLE_LIMITS.pairs, 'a book holds at most the limit');
  assert.deepEqual(CONFUSABLE_ASPECTS, ['what', 'when', 'difference', 'mistake']);
});

test('the view: C001… in book order, K codes and names of the cards as the book shows them now, cells in the order of the codes; a pair that is not one any more is gone', () => {
  const stored = [{ items: [ID(4), ID(3)], print: 'b'.repeat(16), rows: [{ aspect: 'what', cells: ['UDP is', 'TCP is'] }, { aspect: 'mistake', cells: ['UDP slip', 'TCP slip'] }] },
    { items: [ID(1), ID(2)], print: 'a'.repeat(16), rows },
    { items: [ID(1), ID(3)], print: 'c'.repeat(16), rows }];
  const view = confusablesView(stored, nodes());
  assert.deepEqual(view, [
    { id: 'C001', items: ['K001', 'K002'], names: ['Cache', 'Buffer'], rows },
    { id: 'C002', items: ['K003', 'K004'], names: ['TCP', 'UDP'], rows: [{ aspect: 'what', cells: ['TCP is', 'UDP is'] }, { aspect: 'mistake', cells: ['TCP slip', 'UDP slip'] }] },
  ], 'the pair stored as UDP-TCP shows TCP first; Cache-TCP is no pair (a related relation), so its comparison is not shown');
  assert.deepEqual(confusablesView([], nodes()), []);
  assert.deepEqual(confusablesView(undefined, nodes()), []);
  // The book was moved: the codes and the ids follow the book as it is now.
  const moved = withCardNumbers([leaf('h2', [card(3, 'TCP', [{ kind: 'parallel', item: ID(4), name: 'UDP' }]), card(4, 'UDP')]),
    leaf('h1', [card(1, 'Cache', [{ kind: 'opposite', item: ID(2), name: 'Buffer' }]), card(2, 'Buffer')])]);
  assert.deepEqual(confusablesView(stored, moved).map(each => [each.id, each.items, each.names]), [['C001', ['K001', 'K002'], ['TCP', 'UDP']], ['C002', ['K003', 'K004'], ['Cache', 'Buffer']]]);
});
