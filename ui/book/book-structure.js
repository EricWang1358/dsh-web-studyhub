/* 复习全书 structure on the page (#470, docs/review-book.md "Structure"): where the point being read sits in course.book.open's tree, the places it
   can move to, and the two places a `course.book.move` asks for. Pure (no React), so the dialogs and their tests read the same rules. Every change is
   compare-and-set on the book's structureVersion (lib/course-book-structure.js). */
import { ui, errorMessage } from '../i18n.js';

/** The node of `hid` in `nodes` with where it sits: { node, parent, siblings, index } (parent null at the top), or null. */
export function nodeAt(nodes, hid, parent = null) {
  for (const [index, node] of (nodes || []).entries()) {
    if (node.hid === hid) return { node, parent, siblings: nodes, index };
    const found = nodeAt(node.children, hid, node);
    if (found) return found;
  }
  return null;
}

/** A node and everything below it: a move never goes into these. */
const subtree = node => [node, ...(node.children || []).flatMap(subtree)];

/** Where the node can be moved to (course.book.move's `toParent`: a chapter, a section, or 'book' for the top level), in reading order, the node
    itself and what is below it left out: [{ value, label }] for a Select. The top level is offered only when the node is not there already (a chapter
    already there changes order with 上移/下移, not by naming the top level again). */
export function moveTargets(book, hid) {
  const found = nodeAt(book?.nodes, hid);
  if (!found) return [];
  const inside = new Set(subtree(found.node).map(node => node.hid)), out = [];
  if (found.parent) out.push({ value: 'book', label: ui('书的顶层') });
  const walk = list => (list || []).forEach(node => {
    if (!node.leaf && !inside.has(node.hid)) out.push({ value: node.hid, label: [node.number, node.title].filter(Boolean).join(' ') });
    walk(node.children);
  });
  walk(book.nodes);
  return out;
}

/** The points a section of 未归位 can go to, in reading order: [{ value, label }] for a Combobox. */
export function placeTargets(book) {
  const out = [], walk = list => (list || []).forEach(node => { if (node.leaf) out.push({ value: node.hid, label: [node.number, node.title].filter(Boolean).join(' ') }); walk(node.children); });
  walk(book?.nodes);
  return out;
}

/** The place one sibling up (`delta` -1) or down (1), or null at that end: { beforeHid } going up, { afterHid } going down (the move takes the
    node out first, then puts it before or after the neighbour). */
export function shiftPlace(book, hid, delta) {
  const found = nodeAt(book?.nodes, hid);
  if (!found) return null;
  const at = found.index + delta, anchor = at >= 0 && at < found.siblings.length ? found.siblings[at] : null;
  if (!anchor) return null;
  return delta < 0 ? { beforeHid: anchor.hid } : { afterHid: anchor.hid };
}

/** What the dialogs say when a structure change is refused: a stale version is said short (the book has been read again meanwhile), anything else
    as the action said it. */
export const structureFailureText = failure => (failure?.code === 'course-book-conflict'
  ? ui('这本书的结构刚被改过，已经重新读了一遍；再按一次就好。') : null);

/** What the delete dialog says when the change fails: the stale-version line, else the reason the action gave, and only when none came back the generic line. */
export const deleteFailureText = failure => structureFailureText(failure)
  ?? ((failure?.message || typeof failure === 'string') && errorMessage(failure) || ui('这次没有成功，也没有拿到具体原因。可以再试一次。'));

/** The one success line of each change (the page's feedback region). */
export const STRUCTURE_DONE = Object.freeze({ 'course.book.rename': '已改名', 'course.book.move': '已移动', 'course.book.delete': '已删除这个知识点', 'course.book.place': '已放回' });
