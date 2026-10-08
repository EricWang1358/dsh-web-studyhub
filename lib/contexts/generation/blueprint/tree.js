import { normTitle } from './title.js';

/* The tree of points while a build runs, and how it is brought inside the limits of a list. Pure: no model, no library.
   A point of the tree is { id, title, parentId?, slidePlaces: [place], paperPlaces: [{ paper, place }], papers }. */

/** A new point found in the slides: it joins the point of the same title (its places are added), else it goes under the 大考点 of the same title (made if there is none). */
export function addExtra(tree, extra) {
  const norm = normTitle(extra.title);
  const same = tree.points.find(point => normTitle(point.title) === norm);
  if (same) { same.slidePlaces.push(...extra.evidence); return same; }
  let parentId;
  if (extra.parent) {
    const found = tree.points.find(point => !point.parentId && normTitle(point.title) === normTitle(extra.parent));
    if (found) parentId = found.id;
    else { const big = { id: `p${++tree.next}`, title: extra.parent, slidePlaces: [], paperPlaces: [], papers: [] }; tree.points.push(big); parentId = big.id; }
  }
  const point = { id: `p${++tree.next}`, title: extra.title, ...(parentId ? { parentId } : {}), slidePlaces: [...extra.evidence], paperPlaces: [], papers: [] };
  tree.points.push(point);
  return point;
}

/**
 * Keep at most `limit` places of the slides for each point: one place per slide (the first quote), and, when there are more slides than slots,
 * the slides that fewer points cite first, so a slide cited for many points (a summary, say) does not fill every slot.
 * The kept places stay in the order they were found. Changes `slidePlaces` of the points.
 */
export function limitSlidePlaces(points, limit) {
  const citedBy = new Map();
  for (const point of points) for (const place of point.slidePlaces) citedBy.set(place.sourceId, (citedBy.get(place.sourceId) ?? new Set()).add(point.id));
  for (const point of points) {
    const firsts = point.slidePlaces.filter((place, at) => point.slidePlaces.findIndex(other => other.sourceId === place.sourceId) === at);
    const keep = new Set(firsts.map((place, at) => at).sort((a, b) => citedBy.get(firsts[a].sourceId).size - citedBy.get(firsts[b].sourceId).size || a - b).slice(0, limit));
    point.slidePlaces = firsts.filter((place, at) => keep.has(at));
  }
}

/**
 * The places of one point inside `limit` (slide places and paper places together). The slide places stay; of the paper places each paper keeps its first place before any paper
 * keeps a second. @returns { evidence: [place], left } where `left` is the number of paper places that did not fit.
 */
export function capEvidence(slidePlaces, paperPlaces, limit) {
  const seen = new Map(), room = Math.max(0, limit - slidePlaces.length);
  const ranked = paperPlaces.map((item, index) => { const rank = seen.get(item.paper) ?? 0; seen.set(item.paper, rank + 1); return { index, rank }; });
  const chosen = new Set(ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).slice(0, room).map(entry => entry.index));
  return { evidence: [...slidePlaces, ...paperPlaces.filter((item, index) => chosen.has(index)).map(item => item.place)], left: paperPlaces.length - chosen.size };
}

const before = (a, b) => a === b ? 0 : a < b ? -1 : 1;

/**
 * At most `limit` points (a top-level point counts as one). The points a sample paper reached come first, then the others in the order of the course
 * (`rank(point)`: where its first slide is); a point that is kept keeps its top-level point. Returns the kept points in their given order.
 */
export function capPoints(points, limit, rank) {
  if (points.length <= limit) return points;
  const parents = new Set(points.map(point => point.parentId).filter(Boolean));
  const order = points.filter(point => !parents.has(point.id)).map((point, index) => ({ point, index, reached: point.paperPlaces.length > 0 ? 0 : 1, rank: rank(point) }))
    .sort((a, b) => a.reached - b.reached || before(a.rank, b.rank) || b.point.slidePlaces.length - a.point.slidePlaces.length || a.index - b.index);
  const keep = new Set();
  for (const { point } of order) {
    const need = [point.id, point.parentId].filter(id => id && !keep.has(id));
    if (keep.size + need.length <= limit) need.forEach(id => keep.add(id));
  }
  return points.filter(point => keep.has(point.id));
}

/**
 * Order the points the way the course goes: top-level points by where their slides come first, each followed by its sub-points in the same order;
 * points no slide mentions come last, in the order they were found. `rank(point)` is the position of the first slide place of the point (Infinity for none).
 */
export function orderTree(points, rank) {
  const children = new Map();
  for (const point of points) if (point.parentId) children.set(point.parentId, [...(children.get(point.parentId) ?? []), point]);
  const own = new Map(points.map((point, index) => [point.id, { rank: rank(point), index }]));
  const key = point => {
    const kids = children.get(point.id) ?? [];
    return { rank: Math.min(own.get(point.id).rank, ...kids.map(kid => own.get(kid.id).rank)), index: own.get(point.id).index };
  };
  const by = (a, b) => before(a.rank, b.rank) || a.index - b.index;
  const bigs = points.filter(point => !point.parentId).map(point => ({ point, ...key(point) })).sort(by);
  return bigs.flatMap(({ point }) => [point, ...(children.get(point.id) ?? []).map(kid => ({ point: kid, ...own.get(kid.id) })).sort(by).map(item => item.point)]);
}
