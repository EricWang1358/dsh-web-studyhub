/* The numbers of the 术语卡 (#710 S1): K001, K002 … through the whole book in reading order, given each time the book is viewed and never stored, so a
   rebuild or a moved point renumbers cleanly. A relation becomes a link (`code`, `hid`) when its target has a card: by its item, else by a card's name or
   other name (case and spaces aside). An item carded twice keeps its first card. Pure, browser-safe. */

/** The code of the n-th card (1-based). */
export const cardCode = n => `K${String(n).padStart(3, '0')}`;

const keyOf = name => String(name ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
export const leavesOf = nodes => (nodes || []).flatMap(node => (node.leaf ? [node] : leavesOf(node.children)));

/** The cards of the leaves in order, numbered and linked: Map(hid -> [card with code, hid, relations linked]). */
function numbered(leaves) {
  const all = [], byItem = new Map(), byName = new Map();
  for (const leaf of leaves) for (const card of leaf.cards || []) {
    if (byItem.has(card.item)) continue;
    const own = { ...card, code: cardCode(all.length + 1), hid: leaf.hid };
    all.push(own);
    byItem.set(card.item, own);
    for (const name of [card.name, card.alt]) if (name && !byName.has(keyOf(name))) byName.set(keyOf(name), own);
  }
  const byHid = new Map();
  for (const card of all) {
    const relations = card.relations?.map(relation => {
      const target = (relation.item && byItem.get(relation.item)) || byName.get(keyOf(relation.name));
      return target && target !== card ? { ...relation, code: target.code, hid: target.hid } : relation;
    });
    byHid.set(card.hid, [...(byHid.get(card.hid) || []), { ...card, ...(relations ? { relations } : {}) }]);
  }
  return byHid;
}

/** The book's nodes (course.book.open's tree, each leaf's stored `cards`) with every leaf's cards numbered and linked; a book without cards is returned as it is. */
export function withCardNumbers(nodes) {
  const leaves = leavesOf(nodes);
  if (!leaves.some(leaf => leaf.cards?.length)) return nodes;
  const byHid = numbered(leaves);
  const walk = list => list.map(node => {
    if (node.leaf) { const { cards: _stored, ...rest } = node, cards = byHid.get(node.hid); return cards ? { ...rest, cards } : rest; }
    return node.children?.length ? { ...node, children: walk(node.children) } : node;
  });
  return walk(nodes);
}
