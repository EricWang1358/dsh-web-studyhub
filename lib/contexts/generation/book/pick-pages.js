import { documentIndex, outlineLeaves } from '../../../course-book-inputs.js';
import { parseSpan } from '../../../course-outline-index.js';
import { displayTitle } from '../../../document-title.js';

/* WHICH PAGES A PICK READS (custom plan S2): the one rule the plan of a build (book/plan.js), its sample and the estimates (book/scale.js, lib/custom-estimate.js)
   narrow the inventory by. A scope is Map(document key -> Set of source ids, its pages; or null, the whole document). Pure.

   With an outline the pick is some points (a chapter's, the sample's two, the one point of a gap fill): their anchors' pages (a document key: the whole
   document; a chapter key `doc#i`: that chapter's pages; a span `doc@sA-B`: pages A..B; a span of characters `doc@cX-Y`, inside a material of one text: that text)
   and the pages of the inventory items they hold. Without one the pick is chapters of the materials (lib/custom-skeleton.js basis 'documents': `doc#i`, or a
   document key for a material with no chapters): their pages. A chapter that holds no page of its own (the chapters inside one text) is its whole material.
   A range (inventory/ranges.js: whole pages packed up to RANGE_CHARS) is read when it holds a page of the scope, so a range over a chapter's edge is read whole: its
   print stays the one a whole-book read makes, and a later build of the next chapter, or of the whole book, finds it read (no page is paid twice). */

/** Adds `pages` (a list of source ids, or null for the whole document) of `doc` to the scope. */
function add(scope, doc, pages) {
  if (scope.get(doc) === null) return;
  if (!pages?.length) { scope.set(doc, null); return; }
  if (!scope.has(doc)) scope.set(doc, new Set());
  for (const id of pages) scope.get(doc).add(id);
}

/** The pages an anchor names: [doc key, source ids | null] or null when it names no document of the course. A document key and a chapter key (`doc#i`) are
    both keys of documentIndex (course-book-inputs.js): a chapter's own pages, or its whole document when it holds none of its own. */
function anchorPages(docs, anchor) {
  const found = docs.get(anchor);
  if (found) return [found.item.key, found.chapter?.sourceIds?.length ? found.chapter.sourceIds : null];
  const span = parseSpan(anchor);
  if (span && docs.has(span.doc)) return [docs.get(span.doc).item.key, span.unit === 's' ? docs.get(span.doc).item.sourceIds.slice(span.from, span.to + 1) : null];
  return null;
}

/** The scope of some points (a Set of node ids) of `outline`: their anchors' pages and the pages of the inventory items they hold. */
export function pointPages(documents, outline, points, inventory) {
  const docs = documentIndex(documents), scope = new Map(), wanted = new Set();
  for (const { node } of outlineLeaves(outline.courseOutline.nodes).filter(entry => points.has(entry.node.id))) {
    for (const anchor of node.anchors || []) { const found = anchorPages(docs, anchor); if (found) add(scope, ...found); }
    for (const item of node.items || []) wanted.add(item);
  }
  for (const item of inventory?.courseInventory.items || []) if (wanted.has(item.id)) {
    for (const place of item.places || []) if (place.doc && docs.has(place.doc)) add(scope, place.doc, place.sourceId ? [place.sourceId] : null);
  }
  return scope;
}

/** The chapters of the materials an id list names (`doc#i`, or a document key): { rows: [{ id, doc, index, title, pages: [from, to], chars, sourceIds }], unknown: [id] }
    in the list's order (`pages` as lib/custom-skeleton.js gives them). */
export function materialChapters(documents, ids) {
  const byKey = new Map(documents.map(doc => [doc.key, doc])), rows = [], unknown = [];
  for (const id of ids) {
    const found = /^(.+)#(\d+)$/.exec(id), doc = byKey.get(found ? found[1] : id);
    const chapter = doc && found ? doc.chapters?.find(each => each.index === Number(found[2]) && !each.front) : null;
    if (!doc || (found && !chapter) || (!found && doc.chapters?.some(each => !each.front))) { unknown.push(id); continue; }
    rows.push({ id, doc: doc.key, index: chapter ? chapter.index : null, title: chapter ? chapter.title : displayTitle(doc.title),
      pages: chapter ? [chapter.startPage, chapter.endPage] : [1, Math.max(1, doc.totalPages || doc.pages?.length || 1)], chars: chapter ? chapter.chars : doc.chars ?? 0,
      sourceIds: chapter?.sourceIds?.length ? chapter.sourceIds : null });
  }
  return { rows, unknown };
}

/** The scope of some chapters of the materials (materialChapters rows). */
export function chapterPages(rows) {
  const scope = new Map();
  for (const row of rows) add(scope, row.doc, row.sourceIds);
  return scope;
}

/** Several scopes as one (a pick of chapters still to build and of chapters already built). */
export function joinScopes(...scopes) {
  const scope = new Map();
  for (const one of scopes) for (const [doc, pages] of one) add(scope, doc, pages && [...pages]);
  return scope;
}

/** The chapter of the materials (materialChapters rows) a range reads, or null: what the task console names a call of a build by chapters by. */
export const chapterOfRange = (rows, range) => (rows || [])
  .find(row => row.doc === range.doc && (!row.sourceIds || range.pieces.some(piece => row.sourceIds.includes(piece.sourceId))))
  ?? null;

/** Does a pick of this scope read the range (inventory/ranges.js)? */
export const readsRange = (scope, range) => scope.has(range.doc) && (scope.get(range.doc) === null || range.pieces.some(piece => scope.get(range.doc).has(piece.sourceId)));
