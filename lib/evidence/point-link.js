/* 知识点查缺 (knowledge-point gap check), the link: which knowledge points a question is about. A knowledge point is a leaf of a course outline built from the
   资料清点 (lib/course-outline-book.js: `items` names the inventory items it teaches; lib/course-book-inventory.js: each item has places in the source text, a
   `verified` one standing word for word where the model said).

   The one rule, for the outline page, the mastery per point and the draft page alike:
     tier 1  a place of the question (a selection, a citation's verified place or where its quote stands, lib/card-places.js cardPlaceList) overlaps a VERIFIED
             place of an item of the same source: the question is about the point holding that item (several points when its places reach several);
     tier 0  only when no place does: the points that own its pages (`pagePoints`, the outline's page anchors as lib/course-outline.js always placed it).
   Nothing is stored on a question: the link is computed on read, so a rebuilt outline (new leaf ids) is read as it is. Pure, no Node modules. */

/** The numbers of the gap check, in one place. `largeItems`: a point of at least this many items asks for `largeQuota` questions in a top-up, any other `quota`
    (plan §15: points of 3–44 items, one question is too few for the large ones). `gapChars`: verified places of one source closer than this are one passage;
    `padChars` / `maxChars`: the text a top-up writes a point from is that passage with this much around it, never longer. `listed`: the uncovered points an
    answer lists (the rest are counted). */
export const POINT_LIMITS = Object.freeze({ largeItems: 20, quota: 1, largeQuota: 2, gapChars: 1500, padChars: 400, maxChars: 6000, listed: 30 });

/** The leaves of an outline in reading order: { id, title, items, prereqIds }. */
export function outlineLeaves(outline) {
  const out = [];
  const walk = list => (Array.isArray(list) ? list : []).forEach(node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.children) && node.children.length) walk(node.children);
    else out.push({ id: node.id, title: node.title || '', items: Array.isArray(node.items) ? node.items : [], prereqIds: Array.isArray(node.prereqIds) ? node.prereqIds : [] });
  });
  walk(outline?.nodes);
  return out;
}

const verifiedPlaces = item => (item?.places || []).filter(place => place?.verified === true && Number.isInteger(place.start) && Number.isInteger(place.end) && place.end > place.start);

/** The verified places of every item a leaf holds, by source: Map(sourceId -> [{ start, end, point }]) sorted by start. Empty without an inventory or items. */
export function itemPlaceIndex(outline, inventory) {
  const byItem = new Map((inventory?.items || []).map(item => [item.id, item])), index = new Map();
  for (const leaf of outlineLeaves(outline)) for (const id of leaf.items) for (const place of verifiedPlaces(byItem.get(id))) {
    if (!index.has(place.sourceId)) index.set(place.sourceId, []);
    index.get(place.sourceId).push({ start: place.start, end: place.end, point: leaf.id });
  }
  for (const list of index.values()) list.sort((a, b) => a.start - b.start || a.end - b.end);
  return index;
}

const overlaps = (a, b) => Math.max(a.start, b.start) < Math.min(a.end, b.end);

/** The points a question is about: `{ points, tier }` (tier 1 by its places, 0 by its pages, null when neither names one). `places` [{ sourceId, start, end }]
    (offsets may be null: an unlocated quote), `pagePoints` the ids of the leaves that own its pages, in the order the caller found them. */
export function cardPoints({ places = [], pagePoints = [] } = {}, index) {
  const found = [];
  for (const place of places) {
    if (!Number.isInteger(place?.start) || !Number.isInteger(place?.end) || place.end <= place.start) continue;
    for (const entry of index?.get(place.sourceId) || []) {
      if (entry.start >= place.end) break;
      if (overlaps(entry, place) && !found.includes(entry.point)) found.push(entry.point);
    }
  }
  if (found.length) return { points: found, tier: 1 };
  const pages = [...new Set(pagePoints)];
  return pages.length ? { points: pages, tier: 0 } : { points: [], tier: null };
}

/** The passages of a point: its items' verified places, per source, merged when closer than `gapChars`: [{ sourceId, start, end, places }], the passage holding
    the most places first (then reading order). None when no place of it was verified: such a point cannot be written from. */
export function pointSpans(leaf, inventory, { gapChars = POINT_LIMITS.gapChars } = {}) {
  const byItem = new Map((inventory?.items || []).map(item => [item.id, item])), bySource = new Map();
  for (const id of leaf?.items || []) for (const place of verifiedPlaces(byItem.get(id))) {
    if (!bySource.has(place.sourceId)) bySource.set(place.sourceId, []);
    bySource.get(place.sourceId).push(place);
  }
  const spans = [];
  for (const [sourceId, places] of bySource) {
    let current = null;
    for (const place of [...places].sort((a, b) => a.start - b.start)) {
      if (current && place.start - current.end <= gapChars) { current.end = Math.max(current.end, place.end); current.places += 1; continue; }
      current = { sourceId, start: place.start, end: place.end, places: 1 };
      spans.push(current);
    }
  }
  return spans.map((span, at) => ({ span, at })).sort((a, b) => b.span.places - a.span.places || a.at - b.at).map(({ span }) => span);
}

/** How many questions a top-up asks for a point. */
export const pointQuota = leaf => ((leaf?.items?.length ?? 0) >= POINT_LIMITS.largeItems ? POINT_LIMITS.largeQuota : POINT_LIMITS.quota);

/** For each point, how many points rest on it, directly or through others (its prerequisites' graph is acyclic: lib/course-outline-book.js). */
function dependentsOf(leaves) {
  const needs = new Map(leaves.map(leaf => [leaf.id, leaf.prereqIds.filter(id => id !== leaf.id)])), memo = new Map();
  const below = id => {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, new Set());
    const all = new Set();
    for (const dep of needs.get(id) || []) { all.add(dep); for (const deeper of below(dep)) all.add(deeper); }
    memo.set(id, all);
    return all;
  };
  const count = new Map(leaves.map(leaf => [leaf.id, 0]));
  for (const leaf of leaves) for (const dep of below(leaf.id)) if (count.has(dep)) count.set(dep, count.get(dep) + 1);
  return count;
}

/**
 * The gap check over some questions: `{ points: [{ id, title, cards, prereqIds, dependents, coverable, quota }], uncovered: [id], unplaced }`.
 * `cards` [{ places, pagePoints }] (cardPoints's input); `uncovered` the points without a question, the ones others rest on first (a prerequisite always before
 * what needs it), then reading order; `unplaced` how many questions reach no point (其他 is not one); `coverable`: the point has text to be written from.
 */
export function pointGaps(outline, inventory, cards = []) {
  const leaves = outlineLeaves(outline), index = itemPlaceIndex(outline, inventory), counts = new Map(leaves.map(leaf => [leaf.id, 0]));
  let unplaced = 0;
  for (const card of cards) {
    const own = cardPoints(card, index).points.filter(id => counts.has(id));
    if (!own.length) unplaced += 1;
    for (const id of own) counts.set(id, counts.get(id) + 1);
  }
  const dependents = dependentsOf(leaves);
  const points = leaves.map(leaf => ({ id: leaf.id, title: leaf.title, cards: counts.get(leaf.id), prereqIds: leaf.prereqIds, dependents: dependents.get(leaf.id),
    coverable: pointSpans(leaf, inventory).length > 0, quota: pointQuota(leaf) }));
  const uncovered = points.map((point, at) => ({ point, at })).filter(({ point }) => !point.cards)
    .sort((a, b) => b.point.dependents - a.point.dependents || a.at - b.at).map(({ point }) => point.id);
  return { points, uncovered, unplaced };
}
