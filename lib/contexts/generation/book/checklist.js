import { MUST_KINDS } from './constants.js';

/* The MUST-COVER checklist of each knowledge point, decided by the program: the inventory items the point teaches (the outline built from the inventory names
   them, `node.items`), each a must or optional by the build's detail level (MUST_KINDS; a stressed item and an item of a point the sample papers test are
   always a must). Items the outline does not hold yet (a range read after it was made) are placed by their anchor: the first point whose pages hold the
   anchor; what no anchor places is placed by one cheap model call, else in the unplaced point. Pure. */

/** Must or optional. */
export function priorityOf(item, level, tested) {
  return item.key || tested || (MUST_KINDS[level] || MUST_KINDS.standard).includes(item.kind) ? 'must' : 'optional';
}

/** Is a place inside one of the passages (same source, its start inside)? */
const inside = (place, segments) => segments.some(segment => segment.sourceId === place.sourceId && place.start >= segment.start
  && place.start < Math.max(segment.end, segment.start + 1));

/**
 * The items of every leaf. `leaves` [{ id, items? (node.items), segments }] in reading order; `inventory` the courseInventory; `placed` Map(item id -> leaf id)
 * the place call gave the items no anchor placed.
 * -> { byLeaf: Map(leaf id -> [item id]), unplaced: [item id] }: an item in exactly one leaf, or unplaced.
 */
export function assignItems(leaves, inventory, placed = new Map()) {
  const known = new Set((inventory?.items || []).map(item => item.id)), held = new Set(), byLeaf = new Map(leaves.map(leaf => [leaf.id, []]));
  for (const leaf of leaves) for (const id of leaf.items || []) if (known.has(id) && !held.has(id)) { held.add(id); byLeaf.get(leaf.id).push(id); }
  const unplaced = [];
  for (const item of inventory?.items || []) {
    if (held.has(item.id)) continue;
    const verified = item.places.filter(place => place.verified), places = verified.length ? verified : item.places;
    const leaf = leaves.find(each => places.some(place => inside(place, each.segments))) ?? leaves.find(each => each.id === placed.get(item.id));
    if (leaf) { byLeaf.get(leaf.id).push(item.id); held.add(item.id); } else unplaced.push(item.id);
  }
  return { byLeaf, unplaced };
}

/** The checklist of a leaf as the writer and the reviewer see it: c1, c2 ... (aliases the program maps back), most important first within reading order. */
export function checklistOf(ids, inventory, { level, tested, titles }) {
  const byId = new Map((inventory?.items || []).map(item => [item.id, item]));
  return ids.map(id => byId.get(id)).filter(Boolean).map((item, at) => {
    const place = item.places.find(each => each.verified) ?? item.places[0];
    return { alias: `c${at + 1}`, id: item.id, kind: item.kind, name: item.name, gist: item.gist, priority: priorityOf(item, level, tested),
      ...(item.key ? { key: true } : {}), material: titles.get(place.doc) ?? '', ...(Number.isInteger(place.page) ? { page: place.page } : {}), places: item.places };
  });
}
