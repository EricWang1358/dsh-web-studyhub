import { OUTLINE_LIMITS, nodeId } from '../../../course-outline-book.js';

/* The outline extended by a review book build, when the inventory holds items the outline does not (a range read after the outline was made): the points the
   program placed them in hold them now, and what nothing placed goes to the unplaced point of the last chapter (made when there is none). Every item stays
   in exactly one leaf. Pure: the nodes are copied. */

/** @param extend [{ id, items }] the leaves' new item lists; `unplaced` [item id]; `words` { unplacedChapter, unplacedLeaf, unplacedIntro }. -> nodes */
export function extendNodes(nodes, extend, unplaced, words) {
  const copy = structuredClone(nodes), taken = new Set(['other']), byId = new Map(extend.map(entry => [entry.id, entry.items]));
  const walk = list => list.forEach(node => {
    taken.add(node.id);
    if (node.children) walk(node.children); else if (byId.has(node.id)) node.items = byId.get(node.id).slice(0, OUTLINE_LIMITS.items);
  });
  walk(copy);
  if (!unplaced.length) return copy;
  let chapter = copy.at(-1)?.title === words.unplacedChapter && copy.at(-1).children ? copy.at(-1) : null;
  if (!chapter) { chapter = { id: nodeId(taken, ['chapter', words.unplacedChapter, unplaced.slice(0, 20)]), title: words.unplacedChapter, children: [] }; copy.push(chapter); }
  let leaf = chapter.children.find(node => !node.children && node.title === words.unplacedLeaf);
  if (!leaf) {
    leaf = { id: nodeId(taken, ['leaf', words.unplacedLeaf, unplaced.slice(0, 20)]), title: words.unplacedLeaf, intro: words.unplacedIntro, anchors: [], items: [] };
    chapter.children.push(leaf);
  }
  leaf.items = [...new Set([...(leaf.items || []), ...unplaced])].slice(0, OUTLINE_LIMITS.items);
  return copy;
}
