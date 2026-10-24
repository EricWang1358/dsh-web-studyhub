import { OUTLINE_LIMITS, clip } from '../../../course-outline-book.js';

/* An outline built from the inventory of a very large course, made to fit the record (OUTLINE_LIMITS: at most `nodes` nodes, `items` items a leaf) without
   dropping an item: a leaf holding too many items is split into several in order; then, while there are too many nodes (or more leaves than `leaves`, the
   build's maxPoints, #462), the two neighbouring leaves of one parent that hold the fewest items together are merged (named after both), then a section is
   flattened into its chapter, then (only for the node cap) neighbouring chapters are merged. A cap on points (`leaves`) never merges chapters: what it
   cannot reach is reported (`report.over`). A node marked `fixed` (the Other / not placed chapter and its leaf of loose items) is never merged nor
   flattened. A leaf of the quick outline holds anchors instead of items: it is weighed and merged by them. Pure. */

const isLeaf = node => !node.children;
const fixed = node => node.fixed === true;
const count = chapters => chapters.reduce((sum, chapter) => sum + 1 + chapter.children.reduce((inner, child) => inner + 1 + (child.children?.length ?? 0), 0), 0);
const leafCount = chapters => chapters.reduce((sum, chapter) => sum + chapter.children.reduce((inner, child) => inner + (isLeaf(child) ? 1 : child.children.length), 0), 0);
/** What a leaf holds: its items (an outline from the inventory) or its anchors (the quick outline). */
const heldBy = leaf => (Array.isArray(leaf.items) ? 'items' : 'anchors');
const weight = leaf => (leaf[heldBy(leaf)] || []).length;
const same = (a, b) => String(a).replace(/\s+/g, ' ').trim().toLowerCase() === String(b).replace(/\s+/g, ' ').trim().toLowerCase();
/** Two neighbouring leaves as one: what both hold, in order, under both names (never one name over the other's content, #461). */
function joined(a, b) {
  const field = heldBy(a);
  return { ...a, title: same(a.title, b.title) ? a.title : clip(`${a.title} / ${b.title}`, OUTLINE_LIMITS.titleChars), [field]: [...(a[field] || []), ...(b[field] || [])] };
}

/** A leaf of more than `max` items as consecutive leaves of at most `max`, titled "Title (2)", "Title (3)"… */
export function splitLeaf(leaf, max = OUTLINE_LIMITS.items) {
  if (!Array.isArray(leaf.items) || leaf.items.length <= max) return [leaf];
  const parts = [];
  for (let at = 0; at < leaf.items.length; at += max) parts.push({ ...leaf, title: at ? `${leaf.title} (${at / max + 1})` : leaf.title, items: leaf.items.slice(at, at + max) });
  return parts;
}

/** Merges the lightest pair of neighbouring leaves among the children lists; false when none fits `max` (items; anchors have no such cap). */
function mergeLightest(lists, max) {
  let best = null;
  for (const list of lists) for (let at = 0; at + 1 < list.length; at++) {
    const [a, b] = [list[at], list[at + 1]];
    if (!isLeaf(a) || !isLeaf(b) || fixed(a) || fixed(b) || heldBy(a) !== heldBy(b) || (heldBy(a) === 'items' && a.items.length + b.items.length > max)) continue;
    const size = weight(a) + weight(b);
    if (!best || size < best.size) best = { list, at, size };
  }
  if (!best) return false;
  const [a, b] = best.list.slice(best.at, best.at + 2);
  best.list.splice(best.at, 2, joined(a, b));
  return true;
}

/** The chapters ([{ title, intro, children: [leaf | { title, intro, children: [leaf] }] }]) split and merged to fit; the same objects are changed.
    `report.over`: how many points are left above `leaves` (0 when it holds). */
export function fitOutline(chapters, { nodes = OUTLINE_LIMITS.nodes, items = OUTLINE_LIMITS.items, leaves = Infinity, report = {} } = {}) {
  const split = list => list.flatMap(child => (isLeaf(child) ? splitLeaf(child, items) : [{ ...child, children: split(child.children) }]));
  for (const chapter of chapters) chapter.children = split(chapter.children);
  while (count(chapters) > nodes || leafCount(chapters) > leaves) {
    const lists = chapters.flatMap(chapter => [chapter.children, ...chapter.children.filter(child => !isLeaf(child)).map(section => section.children)]);
    if (mergeLightest(lists, items)) continue;
    const chapter = chapters.find(each => !fixed(each) && each.children.some(child => !isLeaf(child)));
    if (chapter) { chapter.children = chapter.children.flatMap(child => (isLeaf(child) ? [child] : child.children)); continue; }
    if (count(chapters) <= nodes) break;
    const at = chapters.findLastIndex((each, k) => k + 1 < chapters.length && !fixed(each) && !fixed(chapters[k + 1]));
    if (at < 0) break;
    const [a, b] = chapters.splice(at, 2);
    chapters.splice(at, 0, { ...a, children: [...a.children, ...b.children] });
  }
  report.over = Number.isFinite(leaves) ? Math.max(0, leafCount(chapters) - leaves) : 0;
  return chapters;
}
