import { STRENGTH, levelOf } from '../../../coverage-strength.js';

/* Pure deterministic Round-1 knowledge-point quota & span allocation:
   Pass 1 (section-floor): one highest-priority point per represented section so every Round-1 section keeps >= 1 question.
   Pass 2 (point): breadth-first 1 question per remaining uncovered point.
   Pass 3 (large): boost large points (>= POINT_LIMITS.largeItems) up to baseQuota.
   Pass 4 (share): largest-remainder weighted surplus up to each point's verified-evidence capacity (capped by STRENGTH[level].maxQuota). */

export const TIER_DEFAULT = 99;
export const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Deterministic priority: focus tier, transitive dependents, item count, section weight, verified chars, outline reading order, id. */
export function comparePoints(a, b) {
  return (a.focusTier - b.focusTier)
    || (b.dependents - a.dependents)
    || (b.items - a.items)
    || (b.sectionWeight - a.sectionWeight)
    || (b.chars - a.chars)
    || (a.order - b.order)
    || compareText(a.id, b.id);
}

/** Largest-remainder integer sharing of `total` over `entries` ({ key, weight, room, cmp }) without exceeding `room`. */
export function shareUnits(entries, total) {
  const given = new Map(entries.map(entry => [entry.key, 0]));
  let left = total;
  for (let pass = 0; left > 0 && pass < 64; pass++) {
    const open = entries.filter(entry => given.get(entry.key) < entry.room);
    if (!open.length) break;
    const sum = open.reduce((acc, entry) => acc + entry.weight, 0) || 1;
    const ideal = open.map(entry => ({ entry, raw: entry.weight / sum * left }));
    let used = 0;
    for (const { entry, raw } of ideal) {
      const add = Math.min(Math.floor(raw), entry.room - given.get(entry.key));
      given.set(entry.key, given.get(entry.key) + add);
      used += add;
    }
    left -= used;
    if (left <= 0) break;
    const rem = ideal.map(({ entry, raw }) => ({ entry, rest: raw - Math.floor(raw) }))
      .filter(({ entry }) => given.get(entry.key) < entry.room)
      .sort((a, b) => (b.rest - a.rest) || a.entry.cmp(b.entry));
    for (const { entry } of rem) { if (left <= 0) break; given.set(entry.key, given.get(entry.key) + 1); left -= 1; }
  }
  return { given, left };
}

/** Normalize points for allocation inside `sectionKeys`, computing primary section, capacity, and priority signals. */
function preparePoints(points, { maxPerPoint, sectionKeys, sectionMeta }) {
  const allowed = sectionKeys instanceof Set ? sectionKeys : Array.isArray(sectionKeys) ? new Set(sectionKeys) : null;
  return (Array.isArray(points) ? points : []).flatMap((point, index) => {
    const spans = (point?.spans || []).filter(span => (!allowed || allowed.has(span.sectionKey)) && span.end > span.start);
    if (!spans.length) return [];
    const sectionKey = spans[0].sectionKey;
    const places = spans.reduce((sum, span) => sum + Math.max(1, Number(span.places) || 1), 0);
    const chars = spans.reduce((sum, span) => sum + (span.end - span.start), 0);
    const focusTier = Math.min(...spans.map(span => sectionMeta?.get(span.sectionKey)?.focusTier ?? point.focusTier ?? TIER_DEFAULT));
    const sectionWeight = Math.max(...spans.map(span => sectionMeta?.get(span.sectionKey)?.weight ?? point.sectionWeight ?? 0));
    return [{ ...point, order: Number.isInteger(point.order) ? point.order : index, spans, sectionKey, chars, focusTier, sectionWeight,
      capacity: Math.max(1, Math.min(maxPerPoint, places)) }];
  });
}

/** Deterministically allocate `budget` questions across knowledge points: section floor -> breadth-first -> large points -> weighted surplus. */
export function allocatePointQuotas(points, budget, { level = 'standard', sectionKeys, sectionMeta } = {}) {
  const total = Math.max(0, Math.floor(Number(budget) || 0));
  const maxPerPoint = STRENGTH[levelOf(level)].maxQuota;
  const prepared = preparePoints(points, { maxPerPoint, sectionKeys, sectionMeta });
  if (!prepared.length || !total) return { allocations: [], remaining: total };
  const quota = new Map(prepared.map(point => [point.id, 0])), reason = new Map();
  let remaining = total;

  // Pass 1: one highest-priority point per represented section.
  const bySection = new Map();
  for (const point of prepared) {
    if (!bySection.has(point.sectionKey)) bySection.set(point.sectionKey, []);
    bySection.get(point.sectionKey).push(point);
  }
  const sectionBest = [...bySection.values()].map(list => [...list].sort(comparePoints)[0]).sort(comparePoints);
  for (const point of sectionBest) {
    if (remaining <= 0) break;
    quota.set(point.id, 1); reason.set(point.id, 'section-floor'); remaining -= 1;
  }

  // Pass 2: breadth-first across every still-uncovered knowledge point.
  for (const point of [...prepared].filter(item => !quota.get(item.id)).sort(comparePoints)) {
    if (remaining <= 0) break;
    quota.set(point.id, 1); reason.set(point.id, 'point'); remaining -= 1;
  }

  // Pass 3: boost large points up to their baseQuota (within capacity).
  if (remaining > 0) {
    for (const point of [...prepared].filter(item => quota.get(item.id) < Math.min(item.baseQuota, item.capacity)).sort(comparePoints)) {
      if (remaining <= 0) break;
      const add = Math.min(remaining, Math.min(point.baseQuota, point.capacity) - quota.get(point.id));
      quota.set(point.id, quota.get(point.id) + add); reason.set(point.id, 'large'); remaining -= add;
    }
  }

  // Pass 4: largest-remainder surplus sharing up to each point's sustainable capacity.
  if (remaining > 0) {
    const entries = prepared.filter(point => quota.get(point.id) < point.capacity).map(point => ({
      key: point.id, point, room: point.capacity - quota.get(point.id),
      weight: Math.max(1, point.items) * (1 + Math.min(point.dependents, 5) * 0.15),
      cmp: other => comparePoints(point, other.point),
    }));
    const { given, left } = shareUnits(entries, remaining);
    for (const [id, add] of given) if (add > 0) { quota.set(id, quota.get(id) + add); reason.set(id, 'share'); }
    remaining = left;
  }

  const allocations = prepared.filter(point => quota.get(point.id) > 0)
    .sort((a, b) => (a.order - b.order) || compareText(a.id, b.id))
    .map(point => ({ point, quota: quota.get(point.id), reason: reason.get(point.id) || 'point' }));
  return { allocations, remaining };
}

/** Turn one allocated knowledge point into 1+ assignments (splitting across distinct verified spans when quota > 1). */
export function assignmentsForPoint(point, quota, sectionOrder) {
  const spans = point.spans || [];
  if (!spans.length || !(quota > 0)) return [];
  const make = (span, q, slot) => ({ key: slot === 0 ? `point:${point.id}` : `point:${point.id}~${slot + 1}`,
    sectionId: span.sectionKey, sourceId: span.sourceId, start: span.start, end: span.end, quota: q, title: point.title, pointId: point.id });
  if (quota === 1 || spans.length === 1) return [make(spans[0], quota, 0)];
  const counts = new Map(spans.map((_, index) => [index, 0]));
  let left = quota;
  for (let i = 0; i < spans.length && left > 0; i++) { counts.set(i, 1); left -= 1; }
  if (left > 0) {
    const entries = spans.map((span, index) => ({ key: index, room: Math.max(0, Math.max(1, span.places) - counts.get(index)),
      weight: Math.max(1, span.places), cmp: other => index - other.key })).filter(entry => entry.room > 0);
    const { given, left: after } = shareUnits(entries, left);
    for (const [index, add] of given) counts.set(index, counts.get(index) + add);
    left = after;
    for (let i = 0; left > 0; i = (i + 1) % spans.length) { counts.set(i, counts.get(i) + 1); left -= 1; }
  }
  return spans.map((span, index) => ({ span, q: counts.get(index) })).filter(item => item.q > 0)
    .sort((a, b) => ((sectionOrder?.get(a.span.sectionKey) ?? 0) - (sectionOrder?.get(b.span.sectionKey) ?? 0)) || (a.span.start - b.span.start))
    .map((item, slot) => make(item.span, item.q, slot));
}
