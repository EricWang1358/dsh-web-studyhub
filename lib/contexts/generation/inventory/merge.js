import { INVENTORY_LIMITS, itemId } from '../../../course-book-inventory.js';

/* Near-duplicates merged: the items of every range, in reading order, become one item per kind and name (lib/course-book-inventory.js nameKey: case,
   width, spaces, hyphens and a trailing translation gloss do not matter; symbols and brackets do), so a term taught in a lecture, its second version and a
   handout is ONE item with several places.
   The first mention names it; a definition anywhere makes it a definition; the first gist that says something stays. Pure. */

/** @param settled [[{ kind, name, gist, key?, place }]] the settled items of each range, in reading order. -> [{ id, kind, name, gist, key?, places }] */
export function mergeItems(settled) {
  const byId = new Map();
  for (const list of settled) for (const raw of list) {
    const id = itemId(raw.name, raw.kind);
    const item = byId.get(id);
    if (!item) { byId.set(id, { id, kind: raw.kind, name: raw.name, gist: raw.gist, ...(raw.key ? { key: true } : {}), places: [raw.place] }); continue; }
    if (raw.kind === 'definition') item.kind = 'definition';
    if (!item.gist && raw.gist) item.gist = raw.gist;
    if (raw.key) item.key = true;
    const same = item.places.some(place => place.range === raw.place.range && place.start === raw.place.start);
    if (!same && item.places.length < INVENTORY_LIMITS.places) item.places.push(raw.place);
  }
  return [...byId.values()];
}

/** What an earlier inventory found in the range of `key`, as the model listed it (the quotes are placed again in the range they are reused for). */
export function foundIn(inventory, key) {
  const raws = [];
  for (const item of inventory?.items || []) for (const place of item.places) {
    if (place.range !== key) continue;
    raws.push({ kind: item.kind, name: item.name, gist: item.gist, quote: place.quote, ...(Number.isInteger(place.page) ? { page: place.page } : {}),
      ...(item.key ? { key: true } : {}) });
  }
  return raws;
}
