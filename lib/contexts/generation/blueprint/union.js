import { wsKey } from '../../../case-study.js';

/* The program's part of the bottom-up build (plan revision 5): the exam points the sample papers name are united here, and the model's help with that is CHECKED, never trusted.
   Pure: no model, no library. A candidate is one distinct title among the points the papers' questions test (a title that differs only in case, spacing or punctuation is the same
   candidate); the model may join candidates that mean the same thing; what comes out always holds every candidate once, and its ids depend only on the order the papers named them in. */

/** The key two titles are the same point under: NFKC, lower case, no spaces, no punctuation or symbols. */
export const normTitle = value => wsKey(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

/**
 * @param papers [{ key, questions: [{ label, points: [{ title, parent? }] }] }] in reading order (a paper read in several chunks is listed once per chunk with the same key)
 * @returns { candidates: [{ id: 'c1', title, parent?, papers: [key] }], questionCandidates: Map('<key>\0<label>' -> [candidate id]) }
 */
export function candidatesOf(papers) {
  const candidates = [], byTitle = new Map(), questionCandidates = new Map();
  for (const paper of papers) for (const question of paper.questions) {
    const ids = [];
    for (const point of question.points ?? []) {
      const norm = normTitle(point.title);
      if (!norm) continue;
      let candidate = byTitle.get(norm);
      if (!candidate) { candidate = { id: `c${candidates.length + 1}`, title: point.title, ...(point.parent ? { parent: point.parent } : {}), papers: [] }; candidates.push(candidate); byTitle.set(norm, candidate); }
      else if (!candidate.parent && point.parent) candidate.parent = point.parent;
      if (!candidate.papers.includes(paper.key)) candidate.papers.push(paper.key);
      if (!ids.includes(candidate.id)) ids.push(candidate.id);
    }
    questionCandidates.set(`${paper.key}\u0000${question.label}`, ids);
  }
  return { candidates, questionCandidates };
}

/**
 * Check what the model said about joining candidates. Every id in `ids` ends up in exactly one group: an id the model left out stands alone (appended in the order of `ids`),
 * an id it repeated stays in the first group that named it, an id nobody has is ignored, a group left empty is dropped.
 * @returns { groups: [{ title?, parent?, members: [id] }], repaired: { lost, duplicated, unknown } }
 */
export function repairGroups(groups, ids) {
  const known = new Set(ids), taken = new Set(), repaired = { lost: 0, duplicated: 0, unknown: 0 }, kept = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!group || typeof group !== 'object' || !Array.isArray(group.members)) continue;
    const members = [];
    for (const id of group.members) {
      if (!known.has(id)) { repaired.unknown++; continue; }
      if (taken.has(id)) { repaired.duplicated++; continue; }
      taken.add(id); members.push(id);
    }
    if (members.length) kept.push({ ...(typeof group.title === 'string' && group.title.trim() ? { title: group.title.trim() } : {}),
      ...(typeof group.parent === 'string' && group.parent.trim() ? { parent: group.parent.trim() } : {}), members });
  }
  for (const id of ids) if (!taken.has(id)) { repaired.lost++; kept.push({ members: [id] }); }
  return { groups: kept, repaired };
}

/**
 * The points of the united groups, in two levels. Ids follow the order the papers first named the points in (p1, p2, ...), then the 大考点 that only group (after them), whatever order the
 * model's groups came in. A parent title that is the title of another point makes that point the 大考点; one that would make a third level is flattened to the 大考点 above it.
 * @returns { leaves: [{ id, title, parentId?, papers, candidates }], bigs: [{ id, title }], idOfCandidate: Map }
 */
export function unionPoints(candidates, groups) {
  const order = new Map(candidates.map((candidate, index) => [candidate.id, index])), byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const sorted = groups.map(group => ({ ...group, members: [...group.members].sort((a, b) => order.get(a) - order.get(b)) }))
    .sort((a, b) => order.get(a.members[0]) - order.get(b.members[0]));
  const leaves = sorted.map((group, index) => {
    const members = group.members.map(id => byId.get(id));
    const parent = group.parent ?? members.find(member => member.parent)?.parent;
    return { id: `p${index + 1}`, title: group.title ?? members[0].title, ...(parent ? { parent } : {}), papers: [...new Set(members.flatMap(member => member.papers))], candidates: group.members };
  });
  const leafByNorm = new Map(leaves.map(leaf => [normTitle(leaf.title), leaf])), place = new Map();
  const resolve = leaf => {
    if (place.has(leaf)) return place.get(leaf);
    place.set(leaf, null); // while it is being resolved: a cycle ends here
    let result = null;
    if (leaf.parent) {
      const target = leafByNorm.get(normTitle(leaf.parent));
      if (!target) result = { title: leaf.parent };
      else if (target !== leaf) { const above = resolve(target); result = above && above.leaf !== leaf ? above : above ? null : { leaf: target }; }
    }
    place.set(leaf, result);
    return result;
  };
  const bigs = [], bigByNorm = new Map();
  let next = leaves.length;
  for (const leaf of leaves) {
    const at = resolve(leaf);
    if (!at) continue;
    if (at.leaf) { leaf.parentId = at.leaf.id; continue; }
    const norm = normTitle(at.title);
    if (!bigByNorm.has(norm)) { const big = { id: `p${++next}`, title: at.title }; bigs.push(big); bigByNorm.set(norm, big); }
    leaf.parentId = bigByNorm.get(norm).id;
  }
  const idOfCandidate = new Map(leaves.flatMap(leaf => leaf.candidates.map(id => [id, leaf.id])));
  for (const leaf of leaves) { delete leaf.parent; }
  return { leaves, bigs, idOfCandidate, next };
}

/** A new point found in the slides: it joins the point of the same title (its place is added), else it goes under the 大考点 of the same title (made if there is none). */
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
 * Order the points the way the course goes: 大考点 by where their slides come first, each followed by its 小考点 in the same order; points no slide mentions come last, in the order they were found.
 * `rank(point)` is the position of the first slide place of the point (Infinity for none).
 */
export function orderTree(points, rank) {
  const children = new Map();
  for (const point of points) if (point.parentId) children.set(point.parentId, [...(children.get(point.parentId) ?? []), point]);
  const own = new Map(points.map((point, index) => [point.id, { rank: rank(point), index }]));
  const key = point => {
    const kids = children.get(point.id) ?? [];
    return { rank: Math.min(own.get(point.id).rank, ...kids.map(kid => own.get(kid.id).rank)), index: own.get(point.id).index };
  };
  const by = (a, b) => (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1) || a.index - b.index;
  const bigs = points.filter(point => !point.parentId).map(point => ({ point, ...key(point) })).sort(by);
  return bigs.flatMap(({ point }) => [point, ...(children.get(point.id) ?? []).map(kid => ({ point: kid, ...own.get(kid.id) })).sort(by).map(item => item.point)]);
}
