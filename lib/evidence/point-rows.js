import { inSpan } from '../course-outline-index.js';
import { bookLayout } from '../course-outline-book-view.js';
import { currentInventory } from '../course-book-inventory.js';
import { outlineStale } from '../course-outline-book.js';
import { cardPoints, itemPlaceIndex } from './point-link.js';

/* The rows of a 课程总纲 (lib/course-outline-book-view.js bookLayout) holding the questions the knowledge-point link gives them (lib/evidence/point-link.js), so the
   outline page (lib/course-outline.js), the mastery per point (lib/evidence/course-evidence.js) and the draft page's point report read ONE answer. Without an
   inventory (or for an outline of descriptors, whose leaves name no item) nothing is linked and every row keeps its page placement, as it always did. */

/** The published questions a row holds by its pages: its nodes' whole, and of its spans (a leaf built from the 清点) those placed inside them. Map(ref -> order). */
export function pageRefsOf(index, row) {
  const refs = new Map();
  for (const node of row.nodes || []) for (const [ref, order] of index.nodes.get(node) || []) if (!refs.has(ref)) refs.set(ref, order);
  for (const span of row.spans || []) for (const node of span.nodes) for (const [ref, order] of index.nodes.get(node) || []) if (!refs.has(ref) && inSpan(span, order, span.sources)) refs.set(ref, order);
  return refs;
}

/** The draft questions a row holds by its pages, spans included. Set(ref). */
export function pageDraftRefsOf(index, row) {
  const refs = new Set();
  for (const node of row.nodes || []) for (const ref of index.draftNodes.get(node) || []) refs.add(ref);
  for (const span of row.spans || []) for (const node of span.nodes) for (const [ref, order] of index.draftAt?.get(node) || []) if (inSpan(span, order, span.sources)) refs.add(ref);
  return refs;
}

/** The questions of a row: what the link gave it (`refs`) or its pages'. */
export const rowRefsOf = (index, row) => row.refs ?? pageRefsOf(index, row);
/** The draft questions of a row, by the same rule: what the link gave it (`draftRefs`) or its pages'. Every count of drafted questions reads this. */
export const rowDraftRefsOf = (index, row) => row.draftRefs ?? pageDraftRefsOf(index, row);

/** A row of the pages under a linked leaf (a document, chapter or span it names), holding only the leaf's questions; any row as it is under a leaf that is not linked. */
export function rowWithin(index, row, leaf) {
  if (!leaf?.refs) return row;
  const refs = new Map([...pageRefsOf(index, row)].filter(([ref]) => leaf.refs.has(ref)));
  return { ...row, refs, draftRefs: new Set([...pageDraftRefsOf(index, row)].filter(ref => leaf.draftRefs.has(ref))) };
}

const append = (map, key, value) => { if (!map.has(key)) map.set(key, []); if (!map.get(key).includes(value)) map.get(key).push(value); };

/** The reading place of a published question (the first of its nodes'), for the order a row lists them in. */
const orderOf = (index, ref) => {
  for (const node of index.cards.get(ref)?.nodes || []) { const at = index.nodes.get(node)?.get(ref); if (at) return at; }
  return [Infinity, -1];
};

/** Every question of the course (published and draft) as the link reads it: [{ ref, draft, places, pagePoints }], `pagePoints` the ids of the leaves (and 'other')
    whose pages hold it, read from the rows before they are linked. A question no row of the course holds (未归位: it cites another course's material, an
    uncategorised one, a deleted one or nothing) is left out: it is counted once, under 未归位, never under a leaf as well. */
function pointCards(book, index) {
  const pageOf = new Map(), draftPageOf = new Map();
  for (const row of book.rows.values()) {
    if (!row.leaf || !row.node || row.copies) continue;
    for (const ref of pageRefsOf(index, row).keys()) append(pageOf, ref, row.node.id);
    for (const ref of pageDraftRefsOf(index, row)) append(draftPageOf, ref, row.node.id);
  }
  const placed = ref => (index.cards.has(ref) ? !index.cards.get(ref).reason : !index.draftUnplaced?.has(ref));
  return [...index.places].filter(([ref]) => placed(ref)).map(([ref, places]) => {
    const draft = !index.cards.has(ref);
    return { ref, draft, places, pagePoints: (draft ? draftPageOf : pageOf).get(ref) || [] };
  });
}

/**
 * Give every row of `book` its questions by the link: `refs` (Map ref -> order, published) and `draftRefs` (Set, drafts) on each leaf, 其他 and parent (the union of
 * its children). A leaf that opens to its rows (documents, chapters, spans) opens to its questions instead when one of them is in none of those rows (it quotes an
 * item of the leaf on a page another leaf owns). Returns the link (Map ref -> { points, tier }) or null when there is nothing to link by; `book.pointCards` keeps what
 * it read (lib/evidence/point-link.js pointGaps reads the same cards, so the draft page's report is this answer).
 */
export function linkBookRows(book, index, layout, outline, inventory) {
  const items = itemPlaceIndex(outline, inventory);
  if (!items.size || !index.places) return null;
  const link = new Map(), refs = new Map(), drafts = new Map();
  book.pointCards = pointCards(book, index);
  for (const card of book.pointCards) {
    const { ref, draft } = card, found = cardPoints(card, items);
    card.found = found;
    link.set(ref, found);
    for (const id of found.points) {
      if (draft) { if (!drafts.has(id)) drafts.set(id, new Set()); drafts.get(id).add(ref); } else { if (!refs.has(id)) refs.set(id, new Map()); refs.get(id).set(ref, orderOf(index, ref)); }
    }
  }
  const attach = entry => {
    if (entry.leaf) {
      Object.assign(entry, { refs: refs.get(entry.node.id) || new Map(), draftRefs: drafts.get(entry.node.id) || new Set() });
      if (entry.opensRows) {
        const shown = new Set(entry.anchors.flatMap(anchor => [...pageRefsOf(index, layout.get(anchor) || {}).keys()]));
        if ([...entry.refs.keys()].some(ref => !shown.has(ref))) entry.opensRows = false;
      }
      return entry;
    }
    entry.children.forEach(attach);
    entry.refs = new Map(entry.children.flatMap(child => [...child.refs]));
    entry.draftRefs = new Set(entry.children.flatMap(child => [...child.draftRefs]));
    return entry;
  };
  book.tree.forEach(attach);
  attach(book.other);
  return link;
}

/** The outline record of a course as rows of the engine (lib/course-outline-book-view.js bookLayout), its rows holding the link's questions; `book.link` is the link
    (null when nothing was linked). An outline not built from the 清点 (its leaves name no item) or out of date (the materials changed since: its items' places may
    no longer stand where they were, and the draft page says so) is not linked: its rows keep their pages, every page agrees. */
export function linkedBook(layout, record, index, sources, course) {
  const book = bookLayout(layout, record.courseOutline);
  const linkable = record.courseOutline.from === 'inventory' && !outlineStale(record.courseOutline, index.allDocuments);
  book.link = linkable ? linkBookRows(book, index, layout, record.courseOutline, currentInventory(sources, course)?.courseInventory) : null;
  return book;
}
