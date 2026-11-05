import { courseSkeleton } from '../../../custom-skeleton.js';
import { partLeaves } from '../../../course-book-parts.js';
import { partsNow } from '../../../course-outline-book.js';
import { chapterPages, joinScopes, materialChapters, pointPages } from './pick-pages.js';

/* A review book built BY CHAPTERS (custom plan S2): the first build of some chapters of a course with no outline, and every later build of an outline made that way
   (`courseOutline.parts`, lib/course-outline-book.js). Decided in stage 0 (book/plan.js), before any call. Pure.

   The chapters are those of the materials (lib/custom-skeleton.js basis 'documents': `doc#i`, or the key of a material with no chapters), taught ones only (no
   sample paper, no copy), in the course's order. The rules:
     no outline, chapters named       every one must be such a chapter (else refused: course-book-part-outline, as a pick with no outline always was). They are
                                      ADDED: their pages read, an outline made of them (book/part-outline.js), their points written.
     an outline built by chapters     a chapter it holds (named by its node id, or by its material id: `parts` maps it, found again by title and pages after
                                      the material is converted anew: lib/course-outline-book.js partsNow) is KEPT, its points written only if not yet (as a pick
                                      of #708); one it does not hold yet is added, the outline EXTENDED with it (its other chapters, and every written point, as
                                      they are). No chapters named: the whole book, every chapter not built yet added. A name that is neither:
                                      course-book-part-invalid.
     ... out of date                  (one of ITS chapters changed: outlineStale) those chapters are made again (`redo`), alone: the others stay exactly as they
                                      are, and with no chapters named nothing else is added (an update is not a build of the rest). A chapter the material no longer has
                                      is kept, recorded lost (the page says so), never dropped.
     a whole outline (not by chapters) not this file's: a pick names its nodes (book/plan.js, #708).
   The chapters inside one text (they hold no page of their own) are read as their whole material, so they are built as one: building one builds them all. */

/** The taught chapters of the materials, in the course's order, with their pages: materialChapters rows. */
export function taughtChapters(state, course, documents) {
  const ids = courseSkeleton(state, course).documents.filter(doc => !doc.paper && !doc.copyOf).flatMap(doc => doc.chapters.map(chapter => chapter.id));
  return materialChapters(documents, ids).rows;
}

/** The chapters an outline built by chapters (its courseOutline) does not hold yet, not built: { pending: [taught chapter rows], order: [every taught chapter id],
    keyOf: Map(node id -> its chapter id now), lost: Set of node ids the materials no longer have }, in the course's order (nothing for any other outline). */
export function pendingChapters(state, course, documents, outline) {
  if (!outline?.parts?.length) return { pending: [], order: [], keyOf: new Map(), lost: new Set() };
  const now = partsNow(outline.parts, documents), built = new Set(now.filter(entry => !entry.lost).map(entry => entry.key)), taught = taughtChapters(state, course, documents);
  return { pending: taught.filter(row => !built.has(row.id)), order: taught.map(row => row.id), keyOf: new Map(now.map(entry => [entry.part.node, entry.key])),
    lost: new Set(now.filter(entry => entry.lost).map(entry => entry.part.node)) };
}

/**
 * @param input { state, course, documents, outline (record | null), chapters (asked ids | null), inventory (the course's inventory record | null) }
 * @returns null (not a build by chapters), { refuse: code }, or { adds: [rows], keep: [node ids], redo: [node ids], settle, picked, order, scope }: `adds` the chapters
 *          it builds (new ones and those made again), `keep` the chapters of the outline the pick names, `redo` the nodes of the chapters made again, `order` every
 *          taught chapter id in the course's order, `scope` the pages the build reads (book/pick-pages.js).
 */
export function partPlan({ state, course, documents, outline, chapters, inventory }) {
  const parts = outline?.courseOutline.parts ?? [];
  if (outline && !parts.length) return null;
  if (!outline && !chapters) return null;
  const taught = taughtChapters(state, course, documents), now = partsNow(parts, documents);
  const nodes = outline?.courseOutline.nodes ?? [], tops = new Set(nodes.map(node => node.id));
  const mapped = new Map(now.filter(entry => !entry.lost).map(entry => [entry.key, entry.part.node]));
  // Its chapters that changed are made again; a lost one stays as it is.
  const redo = now.filter(entry => entry.changed && !entry.lost && taught.some(row => row.id === entry.key)), again = new Set(redo.map(entry => entry.part.node));
  // A chapter inside one text is built with its whole material: a sibling already built holds it.
  const wholeDoc = new Map(taught.filter(row => !row.sourceIds && mapped.has(row.id)).map(row => [row.doc, mapped.get(row.id)]));
  const adds = redo.map(entry => taught.find(row => row.id === entry.key)), keep = [], unknown = [];
  // Out of date with no chapters named (更新): its own chapters only. A chapter newly lost is only recorded (`settle`: the outline rewritten, no call).
  const stale = now.some(entry => entry.changed), settle = now.some(entry => entry.changed && entry.lost);
  for (const id of chapters ?? (stale ? [] : taught.map(row => row.id))) {
    const row = taught.find(each => each.id === id), node = tops.has(id) ? id : mapped.get(id) ?? (row && !row.sourceIds ? wholeDoc.get(row.doc) : undefined);
    if (node) { if (!keep.includes(node) && !again.has(node)) keep.push(node); } else if (row) { if (!adds.includes(row)) adds.push(row); } else unknown.push(id);
  }
  if (unknown.length) return { refuse: outline ? 'course-book-part-invalid' : 'course-book-part-outline' };
  const order = new Map(taught.map((row, at) => [row.id, at])), sorted = adds.sort((a, b) => order.get(a.id) - order.get(b.id));
  const kept = chapters && keep.length ? pointPages(documents, outline, partLeaves(nodes, keep), inventory) : new Map();
  return { adds: sorted, keep, redo: [...again], settle, picked: !!chapters, order: taught.map(row => row.id), scope: joinScopes(chapterPages(sorted), kept) };
}
