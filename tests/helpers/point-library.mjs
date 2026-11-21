import { courseOutlineMaterial, materialsFingerprint } from '../../lib/course-outline-book.js';
import { inventoryMaterial } from '../../lib/course-book-inventory.js';
import { buildOutlineIndex } from '../../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../../lib/source-groups.js';

/* A small course for the knowledge-point gap check (lib/evidence/point-link.js): one two-page PDF, an outline built from the inventory with four points, the
   inventory with the places of their items, and a deck. Page 1 belongs to point A; point B teaches on page 1 too but owns no page; C owns page 2; D has only an
   unverified place (it can never be written from). B rests on A, C on B. */

export const COURSE = 'C';
export const SENTENCES = { a1: 'Alpha one: the first idea of the course is written down here.', a2: 'Alpha two: the second idea extends the first one carefully.',
  b: 'Beta rule: every request is checked twice before it is accepted.', filler: 'Filler line: nothing in this sentence names any listed item at all.',
  c: 'Gamma claim: a replicated log keeps every copy in the same order.', d: 'Delta words appear nowhere as written by the model.' };
const stamp = '2026-11-01T00:00:00.000Z';

export const itemIds = { a1: 'i0000000000a', a2: 'i0000000000b', b: 'i0000000000c', c: 'i0000000000d', d: 'i0000000000e' };

/** The two pages. `spread`: B's sentence stands alone, far (more than a passage's margin) from any other sentence of page 1. */
export function pointPages({ spread = false } = {}) {
  const gap = spread ? '\n'.repeat(1200) : '\n\n';
  const page = (n, text) => ({ id: `doc-p${n}`, title: `Notes · p. ${n}`, text, createdAt: stamp, courses: [COURSE],
    document: { materialId: 'document-notes', page: n, totalPages: 2, format: 'pdf', origin: 'converted', converter: 'marker', filename: 'Notes.pdf', extractionVersion: 2 } });
  return [page(1, [`${SENTENCES.a1}\n\n${SENTENCES.a2}`, SENTENCES.b, SENTENCES.filler].join(gap)), page(2, `${SENTENCES.c}\n\n${SENTENCES.d}`)];
}

/** Where a sentence stands in a page's text, as an inventory place. */
const placeOf = (source, sentence, verified = true) => {
  const start = source.text.indexOf(sentence);
  if (start < 0) throw new Error(`not in ${source.id}: ${sentence}`);
  return { range: `${source.id}#r`, doc: 'k', sourceId: source.id, start: verified ? start : 0, end: verified ? start + sentence.length : 0, quote: sentence, verified };
};

/** A question citing a sentence of a page. */
export const cardOn = (id, source, sentence, extra = {}) => ({ id, kind: 'quiz', prompt: `Question ${id}?`, answer: 'A', options: ['A', 'B', 'C', 'D'], topic: id,
  citations: [{ sourceId: source.id, quote: sentence }], ...extra });

/** The outline and inventory records of a library state holding the two pages (as `state.sources`): { outline, inventory, docKey }. */
export function pointRecords(state, { from = 'inventory' } = {}) {
  const pages = state.sources.filter(source => /^doc-p\d$/.test(source.id)), [p1, p2] = pages;
  const docKey = groupSourcesByDocument(pages, { documents: state.documents }).find(item => item.sourceIds.includes(p1.id)).key;
  const fingerprint = materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments);
  const items = from === 'inventory';
  const leaf = (id, title, anchors, ids, prereqIds) => ({ id, title, anchors, ...(items ? { items: ids } : {}), ...(prereqIds ? { prereqIds } : {}) });
  const outline = { ...courseOutlineMaterial({ title: '总纲 · C', course: COURSE, orderBasis: { codes: [] }, fingerprint, from, other: { anchors: [] }, counts: {},
    nodes: [{ id: 'ch1', title: 'Chapter 1', children: [
      leaf('pa', 'Point A', [`${docKey}@s0-0`], [itemIds.a1, itemIds.a2]),
      leaf('pb', 'Point B', [], [itemIds.b], ['pa']),
    ] }, { id: 'ch2', title: 'Chapter 2', children: [
      leaf('pc', 'Point C', [`${docKey}@s1-1`], [itemIds.c], ['pb']),
      leaf('pd', 'Point D', [], [itemIds.d]),
    ] }] }), createdAt: stamp };
  const item = (key, name, places) => ({ id: itemIds[key], kind: 'concept', name, gist: '', places });
  const inventory = { ...inventoryMaterial({ title: '清点 · C', course: COURSE, ranges: [], documents: [], items: [
    item('a1', 'Alpha one', [placeOf(p1, SENTENCES.a1)]), item('a2', 'Alpha two', [placeOf(p1, SENTENCES.a2)]), item('b', 'Beta rule', [placeOf(p1, SENTENCES.b)]),
    item('c', 'Gamma claim', [placeOf(p2, SENTENCES.c)]), item('d', 'Delta', [placeOf(p2, 'Delta words', false)]),
  ] }), createdAt: stamp };
  return { outline, inventory, docKey };
}

/**
 * The library: { state, sources: { p1, p2 }, docKey, outline (the record), inventory (the record) }. `cards` are the deck's questions (default: one on A's first
 * item, one on B's item, one on a page-1 sentence of no item); `drafts` as given. `from` 'descriptors' writes the same outline without items.
 */
export function pointLibrary({ cards, drafts = [], from = 'inventory', withInventory = true, spread = false } = {}) {
  const [p1, p2] = pointPages({ spread });
  const deckCards = cards ?? [cardOn('q1', p1, SENTENCES.a1), cardOn('q2', p1, SENTENCES.b), cardOn('q3', p1, SENTENCES.filler)];
  const state = { revision: 1, sources: [p1, p2], documents: [], decks: [{ id: 'deck', title: 'Notes deck', course: COURSE, cards: deckCards }], drafts, attempts: [], runs: [], courses: [] };
  const { outline, inventory, docKey } = pointRecords(state, { from });
  state.sources = [p1, p2, outline, ...(withInventory ? [inventory] : [])];
  return { state, sources: { p1, p2 }, docKey, outline, inventory };
}
