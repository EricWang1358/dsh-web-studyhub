import { OUTLINE_LIMITS, clip, nodeId } from '../../../course-outline-book.js';
import { PAPER_PLACES } from './constants.js';

/* The program's part of a course outline build: the model's answers are CHECKED and shaped here, never trusted. Pure and deterministic: the same answers give
   the same outline. An id the model invents is dropped and counted (`invalid`), an id used twice keeps its first place (`repeated`), a row of the course no
   leaf holds goes to Other (`leftover`), never away; at most three levels; titles and notes are cut to size; node ids come from their content. */

/** For each document key, its units (its chapter keys when it has chapters, else itself). */
function unitIndex(plan) {
  const docUnits = new Map();
  for (const unit of plan.described.units) {
    const doc = plan.described.unitDoc.get(unit);
    if (!docUnits.has(doc)) docUnits.set(doc, []);
    docUnits.get(doc).push(unit);
  }
  return { docUnits, unitsOf: anchor => docUnits.get(anchor) ?? (plan.described.unitDoc.has(anchor) ? [anchor] : []) };
}

/** What the reduce call is told about a point: the names of the materials it comes from, and their smallest number and earliest date. */
function aboutOf(plan) {
  const about = new Map();
  for (const item of plan.described.descriptors) {
    about.set(item.id, item);
    for (const chapter of item.chapters || []) about.set(chapter.id, { ...item, title: `${item.title} · ${chapter.title}` });
  }
  return about;
}

/**
 * The knowledge points of all map answers, with ids p1..pN in batch order. A batch may only name its own materials; every unit is claimed once, by the first point.
 * @returns { points: [{ id, title, intro, anchors, materials, hints }], claimed: Set(unit), counts: { invalid, repeated } }
 */
export function pointsOf(plan, answers) {
  const { unitsOf } = unitIndex(plan), about = aboutOf(plan), claimed = new Set(), counts = { invalid: 0, repeated: 0 }, points = [];
  plan.batches.forEach((batch, at) => {
    const own = new Set(batch.descriptors.flatMap(item => [item.id, ...(item.chapters || []).map(chapter => chapter.id)]));
    for (const raw of answers[at]?.points || []) {
      const anchors = [], names = [];
      for (const alias of raw.ids) {
        if (!own.has(alias)) { counts.invalid++; continue; }
        let gained = false;
        for (const anchor of plan.described.aliases.get(alias)) {
          const units = unitsOf(anchor), free = units.filter(unit => !claimed.has(unit));
          free.forEach(unit => claimed.add(unit));
          if (free.length) { gained = true; anchors.push(...(free.length === units.length ? [anchor] : free)); }
        }
        if (gained) names.push(about.get(alias)); else counts.repeated++;
      }
      if (!anchors.length) continue;
      const numbers = names.map(item => item.number).filter(Number.isInteger), dates = names.map(item => item.date).filter(Boolean).sort();
      points.push({ id: `p${points.length + 1}`, title: clip(raw.title, OUTLINE_LIMITS.titleChars), intro: clip(raw.intro, OUTLINE_LIMITS.introChars), anchors,
        materials: [...new Set(names.map(item => item.title))].slice(0, 3),
        hints: { ...(numbers.length ? { number: Math.min(...numbers) } : {}), ...(dates.length ? { date: dates[0] } : {}) } });
    }
  });
  return { points, claimed, counts };
}

/** The rows no point holds: a document none of whose units is held is one anchor, else its units that are not held. */
export function leftoverOf(plan, held) {
  const { docUnits } = unitIndex(plan), anchors = [];
  for (const [doc, units] of docUnits) {
    const left = units.filter(unit => !held.has(unit));
    if (left.length === units.length) anchors.push(doc); else anchors.push(...left);
  }
  return anchors;
}

/** The grounds of the order the model claims, kept only where the library has them (a syllabus, numbered names, dated names); logic always may. */
function basisOf(plan, claimed) {
  const items = plan.described.descriptors;
  const has = { syllabus: !!plan.syllabus, numbering: items.some(item => Number.isInteger(item.number) || item.version),
    dates: items.some(item => item.date || item.part), logic: true };
  const codes = [...new Set(claimed)].filter(code => has[code]);
  const kept = codes.length ? codes : [has.numbering ? 'numbering' : 'logic'];
  return { codes: kept, ...(kept.includes('syllabus') ? { syllabus: plan.syllabus.titles.join('、') } : {}) };
}

/**
 * The outline from the points and the reduce answer: chapters › sections › leaves (or chapters › leaves), every leaf one or more points.
 * @returns { nodes, other: { anchors }, counts: { units, leftover, invalid, repeated, merged }, orderBasis }
 */
export function assemble(plan, mapped, reduce) {
  const { points, counts: base } = mapped, byId = new Map(points.map(point => [point.id, point]));
  const counts = { ...base, merged: 0 }, used = new Set(), taken = new Set(['other']);
  let budget = OUTLINE_LIMITS.nodes;
  const leaf = raw => {
    const members = [];
    for (const id of raw.ids) {
      if (!byId.has(id)) counts.invalid++; else if (used.has(id)) counts.repeated++; else { used.add(id); members.push(byId.get(id)); }
    }
    if (!members.length) return null;
    if (budget-- <= 0) { members.forEach(member => used.delete(member.id)); return null; }
    counts.merged += members.length - 1;
    const anchors = members.flatMap(member => member.anchors), title = clip(raw.title || members[0].title, OUTLINE_LIMITS.titleChars);
    return { id: nodeId(taken, ['leaf', title, anchors]), title, ...(members[0].intro ? { intro: members[0].intro } : {}), anchors };
  };
  const parent = (raw, children, kind) => {
    if (!children.length || budget-- <= 0) return null;
    const title = clip(raw.title, OUTLINE_LIMITS.titleChars) || children[0].title, intro = clip(raw.intro, OUTLINE_LIMITS.introChars);
    return { id: nodeId(taken, [kind, title, children.map(child => child.id)]), title, ...(intro ? { intro } : {}), children };
  };
  const nodes = (reduce?.chapters || []).map(chapter => {
    const direct = chapter.leaves.map(leaf).filter(Boolean);
    const sections = chapter.sections.map(section => parent(section, section.leaves.map(leaf).filter(Boolean), 'section')).filter(Boolean);
    return parent(chapter, [...direct, ...sections], 'chapter');
  }).filter(Boolean);
  // What the model left out or could not place stays in the outline, under 其他.
  const held = new Set();
  const { unitsOf } = unitIndex(plan);
  const walk = node => (node.children ? node.children.forEach(walk) : node.anchors.forEach(anchor => unitsOf(anchor).forEach(unit => held.add(unit))));
  nodes.forEach(walk);
  const other = leftoverOf(plan, held);
  counts.leftover = plan.described.units.filter(unit => !held.has(unit)).length;
  counts.units = plan.described.units.length;
  return { nodes, other: { anchors: other }, counts, orderBasis: basisOf(plan, reduce?.basis || []) };
}

/** The leaves in reading order, with the short ids a paper call answers with (k1, k2, ...). */
export function leavesOf(nodes) {
  const leaves = [];
  const walk = (node, path) => (node.children ? node.children.forEach(child => walk(child, [...path, node.title])) : leaves.push({ node, path }));
  nodes.forEach(node => walk(node, []));
  return leaves.map((item, at) => ({ ...item, alias: `k${at + 1}` }));
}

/** Marks the leaves the paper questions test with the questions' places (at most PAPER_PLACES per paper, OUTLINE_LIMITS.evidence in all); returns how many ids were unknown. */
export function markPapers(leaves, results) {
  const byAlias = new Map(leaves.map(item => [item.alias, item.node]));
  let invalid = 0;
  for (const { paper, questions } of results) for (const question of questions) for (const alias of question.points) {
    const node = byAlias.get(alias);
    if (!node) { invalid++; continue; }
    const evidence = (node.exam ??= { evidence: [] }).evidence;
    if (evidence.length >= OUTLINE_LIMITS.evidence || evidence.filter(place => place.paper === paper).length >= PAPER_PLACES) continue;
    if (!evidence.some(place => place.sourceId === question.sourceId && place.quote === question.quote))
      evidence.push({ sourceId: question.sourceId, quote: question.quote, paper, start: question.start, end: question.end });
  }
  return invalid;
}
