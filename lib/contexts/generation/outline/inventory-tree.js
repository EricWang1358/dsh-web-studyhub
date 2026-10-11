import { OUTLINE_LIMITS, clip, nodeId } from '../../../course-outline-book.js';
import { chapterKey, spanKey } from '../../../course-outline-index.js';
import { basisOf } from './tree.js';
import { fitOutline } from './fit.js';

/* The outline from the inventory, step 3 (the program's): the clusters and the order answer become chapters › sections › knowledge points, every inventory item
   in EXACTLY one leaf (what the model left out goes to a last chapter, Other / unplaced, never away), and each leaf gets the anchors of the pages it teaches so
   the questions, practice and exports keep working on the engine's rows. Pure and deterministic.

   Anchors: every page of a material (a source of a paged material; in a material of one source, its inventory range) belongs to ONE leaf, the one with the
   most items there; a page with no item goes with the page before it (else after). A leaf holding a whole material names it, a set of whole chapters names
   them, anything else names spans (`doc@s3-7`, `doc@c0-1200`: lib/course-outline-index.js spanKey). A material with no item at all is in Other. */

const numberOf = id => Number(/^p(\d+)$/.exec(id)?.[1]);

/** The knowledge points of all cluster answers, numbered p1..pN in batch order, and the items no point holds (each item once, the first point wins). */
export function clustersOf(batches, answers, inventory) {
  const byId = new Map(inventory.items.map(item => [item.id, item])), titles = new Map((inventory.documents || []).map(doc => [doc.key, doc.title]));
  const used = new Set(), clusters = [];
  batches.forEach((batch, at) => {
    for (const point of answers[at]?.points || []) {
      const items = point.items.filter(id => byId.has(id) && !used.has(id));
      if (!items.length) continue;
      items.forEach(id => used.add(id));
      const places = items.map(id => byId.get(id).places[0]), pages = places.map(place => place.page).filter(Number.isInteger);
      clusters.push({ id: `p${clusters.length + 1}`, title: point.title, intro: point.intro, items, names: items.map(id => byId.get(id).name),
        materials: [...new Set(places.map(place => titles.get(place.doc) ?? ''))].filter(Boolean).slice(0, 3),
        ...(pages.length ? { pages: `${Math.min(...pages)}-${Math.max(...pages)}` } : {}) });
    }
  });
  return { clusters, loose: inventory.items.filter(item => !used.has(item.id)).map(item => item.id) };
}

/** The units of a material (its sources, or the ranges of its one source) and which unit a place is in. */
function unitsOf(doc, ranges) {
  if (doc.sourceIds.length !== 1) return { count: doc.sourceIds.length, of: place => doc.sourceIds.indexOf(place.sourceId), multi: true };
  const own = ranges.filter(range => range.doc === doc.key).map(range => ({ start: range.pieces[0].start, end: range.pieces.at(-1).end }));
  const of = place => { const at = own.findIndex(unit => place.start >= unit.start && place.start < unit.end); return at < 0 ? (own.length ? own.length - 1 : 0) : at; };
  return { count: Math.max(1, own.length), of, multi: false, own };
}

/** Which leaf owns each unit of each material: Map(doc key -> [leaf index | -1]). */
function owners(leaves, docs, ranges, byItem) {
  const result = new Map();
  for (const doc of docs) {
    const units = unitsOf(doc, ranges), counts = Array.from({ length: units.count }, () => new Map());
    leaves.forEach((leaf, k) => {
      for (const id of leaf.items) for (const place of byItem.get(id)?.places || []) {
        if (place.doc !== doc.key) continue;
        const at = units.of(place);
        if (at >= 0 && at < units.count) counts[at].set(k, (counts[at].get(k) || 0) + 1);
      }
    });
    const own = counts.map(map => [...map].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? -1);
    if (own.every(k => k < 0)) { result.set(doc.key, { units, own }); continue; }
    // A page without an item goes with the page before it, else the next one that has an owner.
    for (let at = 0; at < own.length; at++) if (own[at] < 0) own[at] = at > 0 && own[at - 1] >= 0 ? own[at - 1] : own.slice(at).find(k => k >= 0);
    result.set(doc.key, { units, own });
  }
  return result;
}

/** Leaf `k`'s pages of a material with chapters as whole chapters, or null when they are not exactly some whole chapters. */
function chapterAnchors(doc, own, k) {
  const mine = own.map((owner, at) => (owner === k ? at : -1)).filter(at => at >= 0);
  const sets = doc.chapters.map(chapter => (chapter.sourceIds || []).map(id => doc.sourceIds.indexOf(id)).filter(at => at >= 0));
  const whole = sets.map((set, at) => (set.length && set.every(page => own[page] === k) ? at : -1)).filter(at => at >= 0);
  const covered = new Set(whole.flatMap(at => sets[at])), shared = whole.some(at => sets.some((other, j) => j !== at && other.some(page => sets[at].includes(page))));
  return !shared && covered.size === mine.length && mine.every(page => covered.has(page)) ? whole.map(at => chapterKey(doc.key, doc.chapters[at].index)) : null;
}

/** Can every leaf holding part of a material name its part as whole chapters (else they all use spans, so chapter and span rows never overlap)? */
function chaptersFit(doc, { units, own }) {
  if (!units.multi || !doc.chapters?.length) return false;
  return [...new Set(own.filter(k => k >= 0))].every(k => own.every(owner => owner === k) || chapterAnchors(doc, own, k));
}

/** The anchors of leaf `k` in one material. */
function anchorsIn(doc, { units, own }, k, chapters) {
  const mine = own.map((owner, at) => (owner === k ? at : -1)).filter(at => at >= 0);
  if (!mine.length) return [];
  if (mine.length === own.length) return [doc.key];
  if (chapters) return chapterAnchors(doc, own, k);
  const runs = [];
  for (const at of mine) { const last = runs.at(-1); if (last && last[1] === at - 1) last[1] = at; else runs.push([at, at]); }
  return runs.map(([from, to]) => (units.multi ? spanKey(doc.key, 's', from, to) : spanKey(doc.key, 'c', units.own[from].start, units.own[to].end)));
}

/**
 * The outline: { nodes, other: { anchors }, counts, orderBasis }. `reduce` is the order answer (read.js readReduce) or null (then one chapter per cluster batch
 * material order); `words` names the last chapter and its leaf of loose items ({ unplacedChapter, unplacedLeaf, unplacedIntro }).
 */
export function inventoryOutline(plan, inventory, { clusters, loose }, reduce, ranges, words) {
  const byCluster = new Map(clusters.map(cluster => [cluster.id, cluster])), used = new Set(), taken = new Set(['other']), counts = { invalid: 0, repeated: 0, merged: 0 };
  const leaf = raw => {
    const members = [];
    for (const id of raw.ids) {
      if (!byCluster.has(id)) counts.invalid++; else if (used.has(id)) counts.repeated++; else { used.add(id); members.push(byCluster.get(id)); }
    }
    if (!members.length) return null;
    counts.merged += members.length - 1;
    const title = clip(raw.title || members[0].title, OUTLINE_LIMITS.titleChars), items = members.flatMap(member => member.items);
    return { title, intro: clip(members[0].intro, OUTLINE_LIMITS.introChars), items };
  };
  const parent = (raw, children) => (children.length
    ? { title: clip(raw.title, OUTLINE_LIMITS.titleChars) || children[0].title, intro: clip(raw.intro, OUTLINE_LIMITS.introChars), children } : null);
  const chapters = (reduce?.chapters || []).map(chapter => parent(chapter, [...chapter.leaves.map(leaf).filter(Boolean),
    ...chapter.sections.map(section => parent(section, section.leaves.map(leaf).filter(Boolean))).filter(Boolean)])).filter(Boolean);
  // What the order left out (every point when it gave no answer) and the items no point holds: the last chapter, never dropped.
  const left = clusters.filter(cluster => !used.has(cluster.id)).sort((a, b) => numberOf(a.id) - numberOf(b.id))
    .map(cluster => ({ title: clip(cluster.title, OUTLINE_LIMITS.titleChars),
    intro: clip(cluster.intro, OUTLINE_LIMITS.introChars), items: cluster.items }));
  if (loose.length) left.push({ title: words.unplacedLeaf, intro: words.unplacedIntro, items: loose });
  if (left.length) chapters.push({ title: words.unplacedChapter, intro: '', children: left });
  // A very large course: a leaf of too many items is split, too many nodes are merged; never an item dropped.
  fitOutline(chapters);
  const leaves = [], walk = node => (node.children ? node.children.forEach(walk) : leaves.push(node));
  chapters.forEach(walk);
  const byItem = new Map(inventory.items.map(item => [item.id, item])), docs = plan.described.documents;
  const own = owners(leaves, docs, ranges, byItem);
  const fits = new Map(docs.map(doc => [doc.key, chaptersFit(doc, own.get(doc.key))]));
  leaves.forEach((node, k) => { node.anchors = docs.flatMap(doc => anchorsIn(doc, own.get(doc.key), k, fits.get(doc.key))); });
  const other = docs.filter(doc => own.get(doc.key).own.every(k => k < 0)).map(doc => doc.key);
  const shape = node => (node.children
    ? { id: nodeId(taken, ['section', node.title, node.children.map(child => child.title)]), title: node.title, ...(node.intro ? { intro: node.intro } : {}),
      children: node.children.map(shape) }
    : { id: nodeId(taken, ['leaf', node.title, node.anchors, node.items.slice(0, 20)]), title: node.title, ...(node.intro ? { intro: node.intro } : {}), anchors: node.anchors,
      items: node.items });
  const nodes = chapters.map(shape);
  const units = plan.described.units.length, otherUnits = plan.described.units.filter(unit => other.includes(plan.described.unitDoc.get(unit))).length;
  return { nodes, other: { anchors: other }, orderBasis: basisOf(plan, reduce?.basis || []),
    counts: { units, leftover: otherUnits, invalid: counts.invalid, repeated: counts.repeated, merged: counts.merged, items: inventory.items.length, unplaced: loose.length } };
}
