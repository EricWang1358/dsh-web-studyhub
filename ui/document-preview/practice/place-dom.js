/* The DOM side of "做这几页的题": where each linked passage is in what the reader has drawn, and which outline entry it falls under.
   It reuses the link layer's own locator (links/link-ranges.js locateGroups), so a question is under the section its
   underline is under. One walk over the text per page of the document, however many questions there are; never on scroll. */
import { locateGroups } from '../links/link-ranges.js';
import { lastAtOrBefore } from './practice-range.js';

const escape = id => String(id).replace(/["\\]/g, '\\$&');

/** The element the reader tagged for an outline entry (a heading, a page section, or the block a kept AI outline points at). */
export const outlineNode = (root, id) => root?.querySelector(`[data-outline-id="${escape(id)}"],[data-ai-outline-id="${escape(id)}"]`) ?? null;

/** The top of `node` in the scroll area's own coordinates (what scrollTop is measured against). */
export function nodeTop(scroller, node) {
  return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

/**
 * `placeOf(link)` for the DOM: the id of the last outline entry that starts at or before the link's passage. An entry is placed
 * by its tagged element, or by the range of a kept AI outline entry that has no block of its own. A passage before the first
 * entry belongs to the first one; a passage that cannot be found in the text (changed since) belongs to none.
 * `items` are the outline entries in document order, `cards` the entries of materials.pages.cards.
 */
export function domPlacer({ root, items, cards }) {
  if (!root) return () => null;
  const document = root.ownerDocument, anchors = [];
  for (const item of items) {
    try {
      const range = document.createRange();
      if (item.range) range.setStart(item.range.startContainer, item.range.startOffset);
      else { const node = outlineNode(root, item.id); if (!node) continue; range.setStartBefore(node); }
      range.collapse(true);
      anchors.push({ id: item.id, range });
    } catch { /* the text changed under this range: the entry is simply not a place */ }
  }
  if (!anchors.length) return () => null;
  const groups = [];
  for (const card of cards) for (const link of card.links || []) if (link.selection?.quote) groups.push({ selection: link.selection, link });
  const where = new Map(locateGroups(root, groups).map(({ group, range }) => [group.link, range]));
  return link => {
    const range = where.get(link);
    if (!range) return null;
    const at = lastAtOrBefore(anchors.length, index => anchors[index].range.compareBoundaryPoints(0 /* Range.START_TO_START */, range) <= 0);
    return anchors[at < 0 ? 0 : at].id;
  };
}
