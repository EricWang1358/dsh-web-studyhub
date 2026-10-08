import { BLUEPRINT_LIMITS } from '../../../exam-blueprint-material.js';
import { normTitle, questionKey } from './title.js';

export { addExtra, capEvidence, capPoints, limitSlidePlaces, orderTree } from './tree.js';
export { normTitle, questionKey, uniqueLabel } from './title.js';

/* The program's part of the bottom-up build (plan revision 5): the exam points the sample papers name are united here, and the model's help with that is CHECKED, never trusted.
   Pure: no model, no library. A candidate is one distinct title among the points the papers' questions test (a title that differs only in case, spacing or punctuation is the same
   candidate); the model may join candidates that mean the same thing; what comes out always holds every candidate once,
   and its ids depend only on the order the papers named them in.
   The extra points the slides teach are united the same way (candidatesOfExtras, then the same repairGroups). */

/**
 * @param papers [{ key, questions: [{ qid, label, points: [{ title, parent? }] }] }] in reading order (a paper read in several chunks is listed once per chunk with the same key)
 * @returns { candidates: [{ id: 'c1', title, parent?, papers: [key] }], questionCandidates: Map(questionKey -> [candidate id]) }; a key is never overwritten
 */
export function candidatesOf(papers) {
  const candidates = [], byTitle = new Map(), questionCandidates = new Map();
  for (const paper of papers) for (const question of paper.questions) {
    const ids = [];
    for (const point of question.points ?? []) {
      const norm = normTitle(point.title);
      if (!norm) continue;
      let candidate = byTitle.get(norm);
      if (!candidate) {
        candidate = { id: `c${candidates.length + 1}`, title: point.title, ...(point.parent ? { parent: point.parent } : {}), papers: [] };
        candidates.push(candidate); byTitle.set(norm, candidate);
      }
      else if (!candidate.parent && point.parent) candidate.parent = point.parent;
      if (!candidate.papers.includes(paper.key)) candidate.papers.push(paper.key);
      if (!ids.includes(candidate.id)) ids.push(candidate.id);
    }
    const key = questionKey(paper.key, question);
    questionCandidates.set(key, [...new Set([...(questionCandidates.get(key) ?? []), ...ids])]);
  }
  return { candidates, questionCandidates };
}

const named = (value, max = BLUEPRINT_LIMITS.titleChars) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;

/**
 * Check what the model said about joining candidates. Every id in `ids` ends up in exactly one group: an id the model left out stands alone (appended in the order of `ids`),
 * an id it repeated stays in the first group that named it, an id nobody has is ignored, a group left empty is dropped. A title is cut to the longest a point may have.
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
    if (members.length) kept.push({ ...(named(group.title) ? { title: named(group.title) } : {}), ...(named(group.parent) ? { parent: named(group.parent) } : {}), members });
  }
  for (const id of ids) if (!taken.has(id)) { repaired.lost++; kept.push({ members: [id] }); }
  return { groups: kept, repaired };
}

/**
 * The points of the united groups, in two levels. Ids follow the order the papers first named the points in (p1, p2, ...), then the top-level points that only group
 * (after them), whatever order the model's groups came in. A parent title that is the title of another point makes that point the top-level point;
 * one that would make a third level is flattened to the top-level point above it.
 * @returns { leaves: [{ id, title, parentId?, papers, candidates }], bigs: [{ id, title }], idOfCandidate: Map }
 */
export function unionPoints(candidates, groups) {
  const order = new Map(candidates.map((candidate, index) => [candidate.id, index])), byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const sorted = groups.map(group => ({ ...group, members: [...group.members].sort((a, b) => order.get(a) - order.get(b)) }))
    .sort((a, b) => order.get(a.members[0]) - order.get(b.members[0]));
  const leaves = sorted.map((group, index) => {
    const members = group.members.map(id => byId.get(id));
    const parent = group.parent ?? members.find(member => member.parent)?.parent;
    const papers = [...new Set(members.flatMap(member => member.papers))];
    return { id: `p${index + 1}`, title: group.title ?? members[0].title, ...(parent ? { parent } : {}), papers, candidates: group.members };
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

/**
 * The extra points the slide windows found (`extras`: [{ title, parent?, evidence, window }] in window order), one candidate per distinct title (the program), ids x1, x2, ...
 * @returns [{ id, title, parent?, evidence, windows }]
 */
export function candidatesOfExtras(extras) {
  const candidates = [], byTitle = new Map();
  for (const extra of extras) {
    const norm = normTitle(extra.title);
    if (!norm) continue;
    let candidate = byTitle.get(norm);
    if (!candidate) {
      candidate = { id: `x${candidates.length + 1}`, title: extra.title, ...(extra.parent ? { parent: extra.parent } : {}), evidence: [], windows: [] };
      candidates.push(candidate); byTitle.set(norm, candidate);
    }
    else if (!candidate.parent && extra.parent) candidate.parent = extra.parent;
    candidate.evidence.push(...extra.evidence);
    if (!candidate.windows.includes(extra.window)) candidate.windows.push(extra.window);
  }
  return candidates;
}

/** The extra points of the checked groups, in the order their first candidate was found: [{ title, parent?, evidence }] (the evidence of every member). */
export function uniteExtraCandidates(candidates, groups) {
  const order = new Map(candidates.map((candidate, index) => [candidate.id, index])), byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  return groups.map(group => ({ ...group, members: [...group.members].sort((a, b) => order.get(a) - order.get(b)) }))
    .sort((a, b) => order.get(a.members[0]) - order.get(b.members[0]))
    .map(group => {
      const members = group.members.map(id => byId.get(id)), parent = group.parent ?? members.find(member => member.parent)?.parent;
      return { title: group.title ?? members[0].title, ...(parent ? { parent } : {}), evidence: members.flatMap(member => member.evidence) };
    });
}
