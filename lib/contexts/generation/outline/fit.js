import { OUTLINE_LIMITS } from '../../../course-outline-book.js';

/* An outline built from the inventory of a very large course, made to fit the record (OUTLINE_LIMITS: at most `nodes` nodes, `items` items a leaf) without
   dropping an item: a leaf holding too many items is split into several in order; then, while there are too many nodes, the two neighbouring leaves of one
   parent that hold the fewest items together are merged, then a section is flattened into its chapter, then neighbouring chapters are merged. Pure. */

const isLeaf = node => !node.children;
const count = chapters => chapters.reduce((sum, chapter) => sum + 1 + chapter.children.reduce((inner, child) => inner + 1 + (child.children?.length ?? 0), 0), 0);

/** A leaf of more than `max` items as consecutive leaves of at most `max`, titled "Title (2)", "Title (3)"… */
export function splitLeaf(leaf, max = OUTLINE_LIMITS.items) {
  if (leaf.items.length <= max) return [leaf];
  const parts = [];
  for (let at = 0; at < leaf.items.length; at += max) parts.push({ ...leaf, title: at ? `${leaf.title} (${at / max + 1})` : leaf.title, items: leaf.items.slice(at, at + max) });
  return parts;
}

/** Merges the lightest pair of neighbouring leaves among the children lists; false when none fits `max`. */
function mergeLightest(lists, max) {
  let best = null;
  for (const list of lists) for (let at = 0; at + 1 < list.length; at++) {
    const [a, b] = [list[at], list[at + 1]];
    if (!isLeaf(a) || !isLeaf(b) || a.items.length + b.items.length > max) continue;
    const weight = a.items.length + b.items.length;
    if (!best || weight < best.weight) best = { list, at, weight };
  }
  if (!best) return false;
  const [a, b] = best.list.slice(best.at, best.at + 2);
  best.list.splice(best.at, 2, { ...a, items: [...a.items, ...b.items] });
  return true;
}

/** The chapters ([{ title, intro, children: [leaf | { title, intro, children: [leaf] }] }]) split and merged to fit; the same objects are changed. */
export function fitOutline(chapters, { nodes = OUTLINE_LIMITS.nodes, items = OUTLINE_LIMITS.items } = {}) {
  const split = list => list.flatMap(child => (isLeaf(child) ? splitLeaf(child, items) : [{ ...child, children: split(child.children) }]));
  for (const chapter of chapters) chapter.children = split(chapter.children);
  while (count(chapters) > nodes) {
    const lists = chapters.flatMap(chapter => [chapter.children, ...chapter.children.filter(child => !isLeaf(child)).map(section => section.children)]);
    if (mergeLightest(lists, items)) continue;
    const chapter = chapters.find(each => each.children.some(child => !isLeaf(child)));
    if (chapter) { chapter.children = chapter.children.flatMap(child => (isLeaf(child) ? [child] : child.children)); continue; }
    if (chapters.length < 2) break;
    const [a, b] = chapters.splice(chapters.length - 2, 2);
    chapters.push({ ...a, children: [...a.children, ...b.children] });
  }
  return chapters;
}
