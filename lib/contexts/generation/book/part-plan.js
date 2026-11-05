import { courseSkeleton } from '../../../custom-skeleton.js';
import { partLeaves } from '../../../course-book-parts.js';
import { chapterPages, joinScopes, materialChapters, pointPages } from './pick-pages.js';

/* A review book built BY CHAPTERS (深度定制 S2): the first build of some chapters of a course with no outline, and every later build of an outline made that way
   (`courseOutline.parts`, lib/course-outline-book.js). Decided in stage 0 (book/plan.js), before any call. Pure.

   The chapters are those of the materials (lib/custom-skeleton.js basis 'documents': `doc#i`, or the key of a material with no chapters), taught ones only (no
   sample paper, no copy), in the course's order. The rules:
     no outline, chapters named       every one must be such a chapter (else refused: course-book-part-outline, as a pick with no outline always was). They are
                                      ADDED: their pages read, an outline made of them (book/part-outline.js), their points written.
     an outline built by chapters     a chapter it holds (named by its node id, or by its material id: `parts` maps it) is KEPT, its points written only if
                                      not yet (as a pick of #708); one it does not hold yet is added, the outline EXTENDED with it (its other chapters, and every
                                      written point, as they are). No chapters named: the whole book, every chapter not built yet added. A name that is neither:
                                      course-book-part-invalid.
     ... out of date                  (a material it holds changed): made again from the chapters it held and the ones named (`fresh`); the inventory and the
                                      grouping answers are kept by their prints, so only what changed is paid.
     a whole outline (not by chapters) not this file's: a pick names its nodes (book/plan.js, #708).
   The chapters inside one text (they hold no page of their own) are read as their whole material, so they are built as one: building one builds them all. */

/** The taught chapters of the materials, in the course's order, with their pages: materialChapters rows. */
export function taughtChapters(state, course, documents) {
  const ids = courseSkeleton(state, course).documents.filter(doc => !doc.paper && !doc.copyOf).flatMap(doc => doc.chapters.map(chapter => chapter.id));
  return materialChapters(documents, ids).rows;
}

/** The chapters an outline built by chapters (its courseOutline) does not hold yet, 未生成: { pending: [taught chapter rows], order: [every taught chapter id] }, in
    the course's order (nothing for any other outline). */
export function pendingChapters(state, course, documents, outline) {
  if (!outline?.parts?.length) return { pending: [], order: [] };
  const built = new Set(outline.parts.map(part => part.key)), taught = taughtChapters(state, course, documents);
  return { pending: taught.filter(row => !built.has(row.id)), order: taught.map(row => row.id) };
}

/**
 * @param input { state, course, documents, outline (record | null), current (the outline is current and not to be organised again), chapters (asked ids | null),
 *        inventory (the course's inventory record | null) }
 * @returns null (not a build by chapters), { refuse: code }, or { adds: [rows], keep: [node ids], fresh, picked, order, scope }: `keep` the chapters of the outline
 *          the pick names, `order` every taught chapter id in the course's order, `scope` the pages the build reads (book/pick-pages.js).
 */
export function partPlan({ state, course, documents, outline, current, chapters, inventory }) {
  const parts = outline?.courseOutline.parts ?? [];
  if (outline && !parts.length) return null;
  if (!outline && !chapters) return null;
  const taught = taughtChapters(state, course, documents), fresh = !!outline && !current;
  const nodes = outline && current ? outline.courseOutline.nodes : [], tops = new Set(nodes.map(node => node.id));
  const mapped = new Map(current ? parts.map(part => [part.key, part.node]) : []), oldKey = new Map(fresh ? parts.map(part => [part.node, part.key]) : []);
  // A chapter inside one text is built with its whole material: a sibling already built holds it.
  const wholeDoc = new Map(taught.filter(row => !row.sourceIds && mapped.has(row.id)).map(row => [row.doc, mapped.get(row.id)]));
  const adds = [], keep = [], unknown = [];
  for (const id of chapters ?? taught.map(row => row.id)) {
    const row = taught.find(each => each.id === (oldKey.get(id) ?? id)), node = tops.has(id) ? id : mapped.get(id) ?? (row && !row.sourceIds ? wholeDoc.get(row.doc) : undefined);
    if (node) { if (!keep.includes(node)) keep.push(node); } else if (row) adds.push(row); else unknown.push(id);
  }
  if (unknown.length) return { refuse: outline ? 'course-book-part-invalid' : 'course-book-part-outline' };
  // Made again: the chapters it held come along (read and grouped again only where their pages changed).
  if (fresh) for (const part of parts) { const row = taught.find(each => each.id === part.key); if (row && !adds.includes(row)) adds.push(row); }
  const order = new Map(taught.map((row, at) => [row.id, at])), sorted = adds.sort((a, b) => order.get(a.id) - order.get(b.id));
  const kept = chapters && keep.length ? pointPages(documents, outline, partLeaves(nodes, keep), inventory) : new Map();
  return { adds: sorted, keep, fresh, picked: !!chapters, order: taught.map(row => row.id), scope: joinScopes(chapterPages(sorted), kept) };
}
