/* The parts a review book is built by (#708): the chapters of its course outline (the top-level nodes). A build may be asked for some of them only; the
   knowledge points of a chapter are its leaves, and a chapter none of whose points the notes hold an explanation of is not built yet (未生成), which is not the
   same as out of date. Pure. */

/** The most chapters one request may name (an outline holds at most OUTLINE_LIMITS.nodes nodes; a chapter is one). */
export const PART_CHAPTERS_MAX = 800;

/** The knowledge point ids under a node, in order (the leaves; lib/course-book-inputs.js outlineLeaves walks the same way, with paths). */
const leafIds = node => (node.children ? node.children.flatMap(leafIds) : [node.id]);

/** Each chapter of `nodes` (the outline's): { id, title, leaves (its knowledge point ids), points, written (how many of them `leaves` holds a body of) }. */
export function bookParts(nodes, notesLeaves = []) {
  const done = new Set((notesLeaves || []).filter(leaf => leaf.body).map(leaf => leaf.id));
  return (nodes || []).map(top => {
    const leaves = leafIds(top);
    return { id: top.id, title: top.title, leaves, points: leaves.length, written: leaves.filter(id => done.has(id)).length };
  });
}

/** The knowledge point ids of the chapters `ids` of `nodes`, or null when one of them is not a chapter of it (or none is named). */
export function partLeaves(nodes, ids) {
  const byId = new Map(bookParts(nodes).map(part => [part.id, part]));
  if (!ids.length || ids.some(id => !byId.has(id))) return null;
  return new Set(ids.flatMap(id => byId.get(id).leaves));
}

/** The points of the chapters not built yet: a missing explanation there is 未生成, not a gap of the book. */
export const unbuiltLeaves = (nodes, notesLeaves) => new Set(bookParts(nodes, notesLeaves).filter(part => !part.written).flatMap(part => part.leaves));
