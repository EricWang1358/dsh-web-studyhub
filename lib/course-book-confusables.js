import { leavesOf } from './course-book-card-numbers.js';

/* 易混概念 (confusable pairs) of the review book (#710 S3): for each pair of term cards the book says are opposite or parallel, a short comparison. The pairs are
   the program's (confusablePairs: the cards' own relations, once for A-B and B-A, a concept with no card skipped); the model only writes each pair's rows. A
   book written before them, or with no such pair, has none.

   As stored on the notes (`courseNotes.confusables`, lib/course-book.js):
     [{ items: [inventory id, inventory id] (the two cards' items), print (what the rows were written from: both cards' words and the language),
        rows: [{ aspect: 'what' | 'when' | 'difference' | 'mistake', cells: [text for the first item, text for the second] }] }]
   Never numbered here and never holding a K code: the numbers (K001…, C001…) are given when the book is viewed, from the book as it is then (confusablesView),
   so a rebuild or a moved point renumbers cleanly and a pair that is no pair any more (its relation or card is gone) simply is not shown.
   Checked where it enters (normalizeConfusables, lenient: a malformed row is dropped, never the book refused). Pure, browser-safe. */

/** The rows of a comparison, in the order they are shown: what each is, when to use it, the key difference, the common mistake. */
export const CONFUSABLE_ASPECTS = Object.freeze(['what', 'when', 'difference', 'mistake']);
/** The relations that make a pair, the most pairs a book keeps and the characters of one cell. */
export const CONFUSABLE_KINDS = Object.freeze(['opposite', 'parallel']);
export const CONFUSABLE_LIMITS = Object.freeze({ pairs: 600, cellChars: 240 });

const PRINT = /^[0-9a-f]{16}$/;
const ITEM_COUNT = 2;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const line = (value, max) => { const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''; return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text; };
const numberOf = code => Number(String(code).slice(1));

/** The identity of a pair: its two items, whichever way round (so A-B and B-A are one). */
export const pairKey = (a, b) => [a, b].sort().join('|');
/** The code of the n-th comparison (1-based). */
export const confusableCode = n => `C${String(n).padStart(3, '0')}`;

/**
 * The pairs of a book: `nodes` the book's nodes with numbered cards (lib/course-book-card-numbers.js withCardNumbers). Every opposite or parallel relation whose
 * target is a card of the book, once for A-B and B-A; the card with the lower code first, the pairs in the order of their codes.
 * -> [{ key, kind, a: card, b: card }] (cards as numbered: code, hid, item, name, alt?, plain?, pitch?)
 */
export function confusablePairs(nodes) {
  const cards = leavesOf(nodes).flatMap(leaf => leaf.cards || []), byCode = new Map(cards.map(card => [card.code, card])), seen = new Set(), pairs = [];
  for (const card of cards) {
    for (const relation of card.relations || []) {
      const other = CONFUSABLE_KINDS.includes(relation.kind) && relation.code ? byCode.get(relation.code) : null;
      if (!other || other === card) continue;
      const key = pairKey(card.item, other.item);
      if (seen.has(key)) continue;
      seen.add(key);
      const [a, b] = numberOf(card.code) < numberOf(other.code) ? [card, other] : [other, card];
      pairs.push({ key, kind: relation.kind, a, b });
    }
  }
  return pairs.sort((x, y) => numberOf(x.a.code) - numberOf(y.a.code) || numberOf(x.b.code) - numberOf(y.b.code));
}

/** The rows as kept: [{ aspect, cells: [a, b] }] with a known aspect, once each, both cells non-empty, in the order the aspects are shown. */
export function confusableRows(raw) {
  const seen = new Set(), rows = [];
  for (const row of (Array.isArray(raw) ? raw : []).filter(object)) {
    const cells = Array.isArray(row.cells) && row.cells.length === ITEM_COUNT ? row.cells.map(cell => line(cell, CONFUSABLE_LIMITS.cellChars)) : [];
    if (!CONFUSABLE_ASPECTS.includes(row.aspect) || seen.has(row.aspect) || cells.length !== ITEM_COUNT || cells.some(cell => !cell)) continue;
    seen.add(row.aspect);
    rows.push({ aspect: row.aspect, cells });
  }
  return rows.sort((a, b) => CONFUSABLE_ASPECTS.indexOf(a.aspect) - CONFUSABLE_ASPECTS.indexOf(b.aspect));
}

/**
 * The comparisons as kept. `isItem(id)`: the items that have a card (a pair of anything else is dropped); one comparison a pair, the first; a pair without a
 * print or without one valid row is dropped. At most CONFUSABLE_LIMITS.pairs. Never throws.
 */
export function normalizeConfusables(raw, { isItem }) {
  const seen = new Set(), kept = [];
  for (const entry of (Array.isArray(raw) ? raw : []).filter(object)) {
    if (kept.length >= CONFUSABLE_LIMITS.pairs) break;
    const items = Array.isArray(entry.items) && entry.items.length === ITEM_COUNT ? entry.items : [];
    if (items.length !== ITEM_COUNT || items[0] === items[1] || !items.every(id => typeof id === 'string' && isItem(id)) || !PRINT.test(String(entry.print))) continue;
    const key = pairKey(items[0], items[1]), rows = confusableRows(entry.rows);
    if (seen.has(key) || !rows.length) continue;
    seen.add(key);
    kept.push({ items: [...items], print: entry.print, rows });
  }
  return kept;
}

/**
 * The comparisons as the book page and the cheat-sheet read them (course.book.open): each pair of the book as it is now that has a stored comparison, numbered
 * C001… in book order, its cards by their K codes and names, the cells in the order of the codes.
 * -> [{ id: 'C001', items: ['K012', 'K045'], names: ['name A', 'name B'], rows: [{ aspect, cells: ['text for A', 'text for B'] }] }]
 */
export function confusablesView(stored, nodes) {
  const byKey = new Map((Array.isArray(stored) ? stored : []).map(entry => [pairKey(entry.items[0], entry.items[1]), entry]));
  const view = [];
  for (const pair of confusablePairs(nodes)) {
    const entry = byKey.get(pair.key);
    if (!entry) continue;
    const flipped = entry.items[0] !== pair.a.item;
    view.push({ id: confusableCode(view.length + 1), items: [pair.a.code, pair.b.code], names: [pair.a.name, pair.b.name],
      rows: entry.rows.map(row => ({ aspect: row.aspect, cells: flipped ? [row.cells[1], row.cells[0]] : [...row.cells] })) });
  }
  return view;
}
