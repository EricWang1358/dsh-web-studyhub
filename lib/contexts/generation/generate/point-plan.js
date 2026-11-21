import { currentInventory } from '../../../course-book-inventory.js';
import { currentCourseOutline, outlineStale } from '../../../course-outline-book.js';
import { courseDocuments } from '../../../course-outline-index.js';
import { outlineLeaves, pointDependents, pointQuota, pointSpans } from '../../../evidence/point-link.js';
import { reportUnreadable } from '../../../evidence/point-report.js';
import { TIER_DEFAULT, allocatePointQuotas, assignmentsForPoint, compareText, shareUnits } from './point-allocate.js';
import { passageOf } from './point-round.js';

/* Round-1 knowledge-point plan bridge: reads the course's current inventory-backed outline and replaces Round 1's section assignments (for sections holding coverable points)
   with per-point verified-passage assignments, keeping Round 1's total budget, section floor, and later rounds intact. Falls back cleanly to the section plan when no usable
   outline or coverable points exist. Pure over library state. */

export { allocatePointQuotas, assignmentsForPoint };

/** The leaf section holding most of [start, end) of a source, or null. */
function sectionAt(leaves, { sourceId, start, end }) {
  let best = null, most = 0;
  for (const section of leaves || []) {
    if (section.sourceId !== sourceId) continue;
    const shared = Math.min(end, section.end) - Math.max(start, section.start);
    if (shared > most) { most = shared; best = section; }
  }
  return best;
}

/** Coverable knowledge points of `course` in `sources` and `leaves`, or null when no current inventory-backed outline applies. */
export function roundPointsFor(state, { course, sources, leaves } = {}) {
  if (!state || typeof course !== 'string' || !course || course === '*') return null;
  if (!Array.isArray(sources) || !sources.length || !Array.isArray(leaves) || !leaves.length) return null;
  try {
    const outline = currentCourseOutline(state.sources, course)?.courseOutline;
    if (!outline || outline.from !== 'inventory') return null;
    const inventory = currentInventory(state.sources, course)?.courseInventory;
    if (!inventory) return null;
    if (outlineStale(outline, courseDocuments(state, course).candidates)) return null;
    const byId = new Map(sources.map(source => [source.id, source]));
    const allLeaves = outlineLeaves(outline), dependents = pointDependents(allLeaves), points = [];
    allLeaves.forEach((leaf, order) => {
      const spans = [];
      for (const span of pointSpans(leaf, inventory)) {
        const source = byId.get(span.sourceId);
        if (!source) continue;
        const passage = { sourceId: span.sourceId, ...passageOf(span, source.text) };
        const section = sectionAt(leaves, passage);
        if (!section || !(passage.end > passage.start)) continue;
        spans.push({ ...passage, places: Math.max(1, Number(span.places) || 1), chars: passage.end - passage.start, sectionKey: section.key });
      }
      if (!spans.length) return;
      points.push({ id: leaf.id, title: leaf.title, order, items: leaf.items.length, baseQuota: pointQuota(leaf),
        dependents: dependents.get(leaf.id) || 0, prereqIds: leaf.prereqIds, spans });
    });
    return points.length ? { outline, points } : null;
  } catch (error) {
    reportUnreadable(error, 'the round-1 point plan');
    return null;
  }
}

/** Fallback assignments when total verified point capacity in Round 1 is smaller than Round 1's question budget. */
function remainderAssignments(remaining, pointedKeys, sectionMeta, allocatedBySection) {
  if (!(remaining > 0)) return [];
  const entries = [...pointedKeys].map((sectionKey, index) => {
    const meta = sectionMeta.get(sectionKey), deficit = Math.max(0, (meta?.quota || 0) - (allocatedBySection.get(sectionKey) || 0));
    return { key: sectionKey, meta, weight: deficit > 0 ? deficit * 1000 + (meta?.weight || 1) : Math.max(1, meta?.weight || 1),
      room: remaining, cmp: other => index - other.index, index };
  });
  const { given } = shareUnits(entries, remaining), out = [];
  for (const [sectionKey, add] of given) {
    if (!(add > 0)) continue;
    const base = sectionMeta.get(sectionKey)?.assignments?.[0];
    if (base) out.push({ ...base, key: `${base.key}~rest`, quota: add });
  }
  return out;
}

/** Apply Round-1 per-point allocation to a `coveragePlan` result; returns `made` unchanged when no usable points cover Round 1. */
export function applyRound1PointPlan(made, { state, course, sources, leaves, points: precomputed } = {}) {
  if (!made?.rounds?.length) return made;
  const resolved = precomputed !== undefined ? precomputed : roundPointsFor(state, { course, sources, leaves });
  if (!resolved?.points?.length) return made;
  const [round1, ...laterRounds] = made.rounds;
  const sectionOrder = new Map((leaves || []).map((leaf, index) => [leaf.key, index]));
  const sectionMeta = new Map();
  for (const item of round1.assignments) {
    const prev = sectionMeta.get(item.sectionId) || { quota: 0, weight: 0, focusTier: TIER_DEFAULT, assignments: [] };
    prev.quota += item.quota;
    prev.weight += Number(item.weight) || 0;
    prev.focusTier = Math.min(prev.focusTier, Number.isInteger(item.focusTier) ? item.focusTier : TIER_DEFAULT);
    prev.assignments.push(item);
    sectionMeta.set(item.sectionId, prev);
  }
  const r1Keys = new Set(sectionMeta.keys());
  const candidates = resolved.points.filter(point => point.spans.some(span => r1Keys.has(span.sectionKey)));
  if (!candidates.length) return made;
  const pointedKeys = new Set(candidates.map(point => point.spans.find(span => r1Keys.has(span.sectionKey)).sectionKey));
  const unpointed = round1.assignments.filter(item => !pointedKeys.has(item.sectionId));
  const pointBudget = [...pointedKeys].reduce((sum, key) => sum + (sectionMeta.get(key)?.quota || 0), 0);
  const { allocations, remaining } = allocatePointQuotas(candidates, pointBudget, { level: made.plan.level, sectionKeys: pointedKeys, sectionMeta });
  if (!allocations.length) return made;
  const pointAssignments = allocations.flatMap(({ point, quota }) => assignmentsForPoint(point, quota, sectionOrder));
  const bySection = new Map();
  for (const item of pointAssignments) bySection.set(item.sectionId, (bySection.get(item.sectionId) || 0) + item.quota);
  const rest = remainderAssignments(remaining, pointedKeys, sectionMeta, bySection);
  const nextAssignments = [...unpointed, ...pointAssignments, ...rest].sort((a, b) =>
    ((sectionOrder.get(a.sectionId) ?? 0) - (sectionOrder.get(b.sectionId) ?? 0)) || (a.start - b.start) || (a.end - b.end) || compareText(a.key, b.key));
  const allAssignments = [...nextAssignments, ...laterRounds.flatMap(round => round.assignments)];
  const sectionTotals = new Map();
  for (const item of allAssignments) sectionTotals.set(item.sectionId, (sectionTotals.get(item.sectionId) || 0) + item.quota);
  const nextQuotas = made.plan.quotas.map(item => (sectionTotals.has(item.sectionId) ? { ...item, quota: sectionTotals.get(item.sectionId) } : item));
  const pointIds = allocations.map(({ point }) => point.id);
  const pointQuotas = allocations.map(({ point, quota, reason }) => ({ pointId: point.id, title: point.title, sectionId: point.sectionKey, quota, reason }));
  const nextRound1 = { ...round1, questions: nextAssignments.reduce((sum, item) => sum + item.quota, 0), assignments: nextAssignments, pointIds };
  return { plan: { ...made.plan, quotas: nextQuotas, pointQuotas }, assignments: allAssignments, rounds: [nextRound1, ...laterRounds] };
}
