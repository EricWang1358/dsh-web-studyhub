/* Deterministic Load Balance + Sibling Dispersal, ported in pure JS from MIT `open-spaced-repetition/fsrs4anki-helper`.
   Pure functions only: zero I/O, zero Node builtins, zero randomness. Safe opt-in scheduling helpers for
   `lib/exam-alignment.js`, `lib/card-schedule.js`, `lib/plan-weekly.js`, and review queues. */

const DAY_MS = 864e5;

/** FSRS4Anki fuzz factor bands (identical piecewise slopes to fsrs4anki-helper / py-fsrs). */
export const FUZZ_RANGES = Object.freeze([
  Object.freeze({ start: 2.5, end: 7.0, factor: 0.15 }),
  Object.freeze({ start: 7.0, end: 20.0, factor: 0.1 }),
  Object.freeze({ start: 20.0, end: Infinity, factor: 0.05 }),
]);

/** Local calendar day number for an epoch ms timestamp (matches lib/sm2.js and lib/exam-alignment.js). */
export function dayNumberOf(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
}

/** Local calendar day number for a YYYY-MM-DD date string. */
export function dayNumberOfDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

/** Local 00:00 epoch ms for a day number. */
export function startOfLocalDay(dayNum) {
  const d = new Date(dayNum * DAY_MS);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
}

/** YYYY-MM-DD date string for a day number. */
export function dateStringOfDay(dayNum) {
  const d = new Date(dayNum * DAY_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Day of week (0 = Sunday .. 6 = Saturday) for a day number. */
export function weekdayOfDay(dayNum) {
  return new Date(dayNum * DAY_MS).getUTCDay();
}

/**
 * FSRS4Anki interval fuzz tolerance window `[min, max]` in whole days.
 * Intervals shorter than 2.5 days keep their exact interval (no fuzz).
 */
export function fuzzRange(intervalDays, { minInterval = 2, maxInterval = 36500 } = {}) {
  const raw = Number(intervalDays);
  if (!Number.isFinite(raw) || raw <= 0) return { min: 1, max: 1, delta: 0 };
  const cap = Math.max(1, Math.round(Number(maxInterval) || 36500));
  const clamped = Math.min(Math.max(1, Math.round(raw)), cap);
  if (raw < 2.5) return { min: clamped, max: clamped, delta: 0 };
  let delta = 1.0;
  for (const band of FUZZ_RANGES) {
    delta += band.factor * Math.max(Math.min(raw, band.end) - band.start, 0);
  }
  const floor = Math.max(1, Math.round(Number(minInterval) || 2));
  const min = Math.min(cap, Math.max(floor, Math.round(raw - delta)));
  const max = Math.min(cap, Math.max(min, Math.round(raw + delta)));
  return { min, max, delta: Math.round(delta * 1000) / 1000 };
}

/** Normalize restDates / studyWeekdays into fast lookup structures. */
export function normalizeRestRules({ restDates, restDays, studyWeekdays } = {}) {
  const blocked = new Set();
  for (const item of restDays || []) {
    if (Number.isInteger(item)) blocked.add(item);
    else if (typeof item === 'string') {
      const n = dayNumberOfDate(item);
      if (n !== null) blocked.add(n);
    }
  }
  for (const item of restDates || []) {
    const n = dayNumberOfDate(item);
    if (n !== null) blocked.add(n);
  }
  const weekdays = Array.isArray(studyWeekdays) && studyWeekdays.length
    ? new Set(studyWeekdays.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))
    : studyWeekdays instanceof Set && studyWeekdays.size
      ? studyWeekdays
      : null;
  return {
    restDaySet: blocked,
    studyWeekdays: weekdays && weekdays.size ? weekdays : null,
  };
}

/** True when `dayNum` is a configured rest day or outside `studyWeekdays`. */
export function isRestDay(dayNum, rules) {
  if (!rules) return false;
  if (rules.restDaySet?.has(dayNum)) return true;
  if (rules.studyWeekdays && !rules.studyWeekdays.has(weekdayOfDay(dayNum))) return true;
  return false;
}

const normKeyText = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Extract deterministic sibling group keys for a card (same source/page, same knowledge point `hid`,
 * same `taskFamilyId`, or same variant `origin`). Two cards sharing any key are treated as siblings.
 */
export function siblingGroupKeys(card, { sourcesById = null, deckId = '', originTargets = null, fallbackTopic = false } = {}) {
  if (!card || typeof card !== 'object') return [];
  const keys = new Set();
  const addSource = sourceId => {
    if (typeof sourceId !== 'string' || !sourceId.trim()) return;
    const id = sourceId.trim();
    keys.add(`src:${id}`);
    const src = sourcesById instanceof Map ? sourcesById.get(id) : null;
    const doc = src?.document;
    if (doc && Number.isInteger(doc.page)) {
      const docKey = doc.materialId || doc.id || doc.filename || '';
      if (docKey) keys.add(`page:${docKey}:${doc.page}`);
    }
  };
  for (const sel of Array.isArray(card.selections) ? card.selections : []) addSource(sel?.sourceId);
  for (const cit of Array.isArray(card.citations) ? card.citations : []) addSource(cit?.selection?.sourceId || cit?.sourceId);

  const hid = typeof card.hid === 'string' && card.hid.trim()
    ? card.hid.trim()
    : (typeof card.outlineKey === 'string' && card.outlineKey.trim() ? card.outlineKey.trim() : '');
  if (hid) keys.add(`hid:${hid}`);

  if (typeof card.taskFamilyId === 'string' && card.taskFamilyId.trim()) {
    keys.add(`family:${card.taskFamilyId.trim()}`);
  }
  if (typeof card.origin?.cardId === 'string' && card.origin.cardId.trim()) {
    keys.add(`origin:${card.origin.deckId || deckId || ''}:${card.origin.cardId.trim()}`);
  }
  if (originTargets instanceof Set && card.id) {
    const selfOrigin = `${deckId || ''}:${card.id}`;
    if (originTargets.has(selfOrigin)) keys.add(`origin:${selfOrigin}`);
  }
  if (!keys.size && fallbackTopic) {
    const topic = normKeyText(card.topic);
    if (topic) keys.add(`topic:${deckId || ''}:${topic}`);
  }
  return [...keys];
}

/** Primary sibling key for a card, or null when the card has no source/page/knowledge-point link. */
export function siblingGroupKey(card, options = {}) {
  return siblingGroupKeys(card, options)[0] ?? null;
}

/** Build a Set of `${deckId}:${cardId}` referenced as `card.origin` across decks so originals pair with their variants. */
export function collectOriginTargets(decks) {
  const targets = new Set();
  for (const deck of Array.isArray(decks) ? decks : []) {
    for (const card of deck?.cards || []) {
      if (typeof card?.origin?.cardId === 'string' && card.origin.cardId.trim()) {
        targets.add(`${card.origin.deckId || deck.id || ''}:${card.origin.cardId.trim()}`);
      }
    }
  }
  return targets;
}

/**
 * Deterministically pick the best review day in `[minDay, maxDay]` balancing review load,
 * avoiding rest days and overloaded days, and dispersing away from `siblingDays`.
 */
export function pickBalancedDay({
  targetDay,
  minDay,
  maxDay,
  dailyLoad = null,
  restRules = null,
  easyDayWeights = null,
  dailyCap = null,
  siblingDays = null,
  minSiblingGap = 2,
  preferLowerLoad = true,
} = {}) {
  const lo = Math.round(Number(minDay ?? targetDay));
  const hi = Math.max(lo, Math.round(Number(maxDay ?? targetDay)));
  const anchor = Math.min(hi, Math.max(lo, Math.round(Number(targetDay ?? lo))));
  const loadMap = dailyLoad instanceof Map ? dailyLoad : new Map();
  const siblings = Array.isArray(siblingDays) ? siblingDays.filter(Number.isFinite) : [];
  const gap = Math.max(1, Math.round(Number(minSiblingGap) || 2));
  const cap = Number.isFinite(dailyCap) && dailyCap > 0 ? dailyCap : null;

  const candidates = [];
  for (let day = lo; day <= hi; day++) {
    if (!isRestDay(day, restRules)) candidates.push(day);
  }
  // If every day in the permissible window is a rest day, fall back to the full window so nothing is dropped.
  const pool = candidates.length ? candidates : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

  let best = null;
  for (const day of pool) {
    const load = Number(loadMap.get(day)) || 0;
    const weekday = weekdayOfDay(day);
    const weight = easyDayWeights && Number.isFinite(easyDayWeights[weekday]) ? easyDayWeights[weekday] : 1;
    const effectiveLoad = preferLowerLoad ? (weight > 0 ? load / weight : load * 100) : 0;
    const overCapPenalty = cap !== null && load >= cap ? 1000 + (load - cap + 1) * 100 : 0;

    let sameDayCount = 0;
    let nearPenalty = 0;
    let minSiblingDist = Infinity;
    for (const sDay of siblings) {
      const dist = Math.abs(day - sDay);
      if (dist < minSiblingDist) minSiblingDist = dist;
      if (dist === 0) sameDayCount++;
      else if (dist < gap) nearPenalty += (gap - dist) * 50;
    }
    const siblingPenalty = sameDayCount * 500 + nearPenalty + (siblings.length && Number.isFinite(minSiblingDist) ? 1 / (1 + minSiblingDist) : 0);
    const score = overCapPenalty + siblingPenalty + effectiveLoad;
    const distFromTarget = Math.abs(day - anchor);

    if (
      !best
      || score < best.score - 1e-9
      || (Math.abs(score - best.score) <= 1e-9 && (
        distFromTarget < best.distFromTarget
        || (distFromTarget === best.distFromTarget && day < best.day)
      ))
    ) {
      best = { day, score, load, distFromTarget, minSiblingDist };
    }
  }

  return {
    day: best.day,
    moved: best.day !== anchor,
    load: best.load,
    minSiblingDist: best.minSiblingDist,
  };
}

/**
 * Load-balanced and optionally sibling-dispersed exam-alignment day assignment for `items`
 * (sorted lowest recall first; each `{ floor, siblingKeys? }`) across `[today, examDay - 1]`.
 * Items whose `floor >= examDay` take `examDay`. Returns day numbers parallel to `items`.
 */
export function spreadBalancedDays(items, today, examDay, {
  existingLoad = null,
  restDates = null,
  restDays = null,
  studyWeekdays = null,
  easyDayWeights = null,
  dailyCap = null,
  loadBalance = true,
  disperseSiblings = false,
  minSiblingGap = 2,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  const restRules = normalizeRestRules({ restDates, restDays, studyWeekdays });
  const dailyLoad = new Map(existingLoad instanceof Map ? existingLoad : []);
  const siblingDaysByKey = new Map();
  const out = new Array(list.length);

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const floor = Math.max(today, Number.isFinite(item?.floor) ? item.floor : today);
    if (floor >= examDay) {
      out[i] = examDay;
      dailyLoad.set(examDay, (dailyLoad.get(examDay) || 0) + 1);
      continue;
    }
    const keys = disperseSiblings && Array.isArray(item?.siblingKeys) ? item.siblingKeys : [];
    const siblingDays = [];
    for (const key of keys) {
      const days = siblingDaysByKey.get(key);
      if (days) siblingDays.push(...days);
    }
    const span = Math.max(1, examDay - floor);
    const idealTarget = floor + (i % span);
    const picked = pickBalancedDay({
      targetDay: idealTarget,
      minDay: floor,
      maxDay: examDay - 1,
      dailyLoad,
      restRules,
      easyDayWeights,
      dailyCap,
      siblingDays,
      minSiblingGap,
      preferLowerLoad: loadBalance,
    });
    out[i] = picked.day;
    dailyLoad.set(picked.day, (dailyLoad.get(picked.day) || 0) + 1);
    for (const key of keys) {
      if (!siblingDaysByKey.has(key)) siblingDaysByKey.set(key, []);
      siblingDaysByKey.get(key).push(picked.day);
    }
  }
  return out;
}

/**
 * Pure FSRS4Anki-style batch sibling dispersal over scheduled cards.
 * Each item: `{ deckId, card, dueDay, intervalDays, floorDay?, maxDay?, siblingKeys? }`.
 * Returns `{ assignments: Map<cardId, dayNum>, moves: [{ deckId, cardId, fromDay, toDay }] }`.
 */
export function disperseSiblingsSchedule(items, {
  today,
  existingLoad = null,
  restDates = null,
  restDays = null,
  studyWeekdays = null,
  easyDayWeights = null,
  dailyCap = null,
  minSiblingGap = 2,
  maximumInterval = 36500,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  const restRules = normalizeRestRules({ restDates, restDays, studyWeekdays });
  const dailyLoad = new Map(existingLoad instanceof Map ? existingLoad : []);
  const assignments = new Map();
  for (const item of list) {
    assignments.set(item.card.id, item.dueDay);
    if (!(existingLoad instanceof Map)) {
      dailyLoad.set(item.dueDay, (dailyLoad.get(item.dueDay) || 0) + 1);
    }
  }

  const byKey = new Map();
  for (const item of list) {
    for (const key of item.siblingKeys || []) {
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(item);
    }
  }

  // Deterministic order: groups with most siblings first, then lexical key.
  const groups = [...byKey.entries()]
    .filter(([, members]) => members.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const movedSet = new Map();
  for (const [, members] of groups) {
    const ordered = [...members].sort((a, b) =>
      assignments.get(a.card.id) - assignments.get(b.card.id)
      || (Number(a.intervalDays) || 0) - (Number(b.intervalDays) || 0)
      || String(a.card.id).localeCompare(String(b.card.id)),
    );
    // Keep the first sibling anchored; disperse subsequent siblings within their allowed fuzz window.
    for (let idx = 1; idx < ordered.length; idx++) {
      const item = ordered[idx];
      const currentDay = assignments.get(item.card.id);
      const otherDays = ordered.filter((_, j) => j !== idx).map(other => assignments.get(other.card.id));
      const minDistNow = Math.min(...otherDays.map(d => Math.abs(currentDay - d)));
      if (minDistNow >= minSiblingGap && !isRestDay(currentDay, restRules)) continue;

      const interval = Math.max(1, Number(item.intervalDays) || 1);
      const fuzz = fuzzRange(interval, { maxInterval: maximumInterval });
      const baseOriginDay = currentDay - interval;
      const minWindow = Math.max(
        Number.isFinite(today) ? today : -Infinity,
        Number.isFinite(item.floorDay) ? item.floorDay : -Infinity,
        baseOriginDay + fuzz.min,
      );
      const maxWindow = Math.min(
        Number.isFinite(item.maxDay) ? item.maxDay : Infinity,
        baseOriginDay + fuzz.max,
      );
      if (maxWindow <= minWindow) continue;

      // Temporarily remove this card's current load before re-evaluating candidates.
      dailyLoad.set(currentDay, Math.max(0, (dailyLoad.get(currentDay) || 1) - 1));
      const picked = pickBalancedDay({
        targetDay: currentDay,
        minDay: minWindow,
        maxDay: maxWindow,
        dailyLoad,
        restRules,
        easyDayWeights,
        dailyCap,
        siblingDays: otherDays,
        minSiblingGap,
        preferLowerLoad: true,
      });
      dailyLoad.set(picked.day, (dailyLoad.get(picked.day) || 0) + 1);
      if (picked.day !== currentDay) {
        assignments.set(item.card.id, picked.day);
        movedSet.set(item.card.id, { deckId: item.deckId, cardId: item.card.id, fromDay: item.dueDay, toDay: picked.day });
      }
    }
  }

  const moves = [...movedSet.values()].filter(m => m.fromDay !== m.toDay);
  return { assignments, moves };
}

/**
 * Queue-time sibling dispersal: deterministically reorders review queue entries within each tier
 * so sibling cards (same source/page/hid/origin) are spaced apart to prevent cue leakage,
 * while strictly respecting prerequisite edges (`card.requires`).
 */
export function disperseReviewQueue(entries, {
  sources = [],
  sourcesById = null,
  tierOf = null,
  minGap = 2,
  fallbackTopic = false,
} = {}) {
  const list = Array.isArray(entries) ? [...entries] : [];
  if (list.length <= 2) return list;
  const bySource = sourcesById instanceof Map
    ? sourcesById
    : new Map((Array.isArray(sources) ? sources : []).filter(s => s?.id).map(s => [s.id, s]));
  const originTargets = new Set();
  for (const entry of list) {
    const c = entry?.card ?? entry;
    if (typeof c?.origin?.cardId === 'string' && c.origin.cardId.trim()) {
      originTargets.add(`${c.origin.deckId || entry?.deckId || ''}:${c.origin.cardId.trim()}`);
    }
  }

  const meta = list.map((entry, index) => {
    const card = entry?.card ?? entry;
    const deckId = entry?.deckId ?? '';
    const ref = `${deckId}:${card?.id ?? index}`;
    const prereqs = new Set(
      (Array.isArray(card?.requires) ? card.requires : [])
        .filter(r => r?.cardId)
        .map(r => `${r.deckId || deckId}:${r.cardId}`),
    );
    return {
      entry,
      index,
      ref,
      tier: typeof tierOf === 'function' ? tierOf(entry) : 0,
      keys: siblingGroupKeys(card, { sourcesById: bySource, deckId, originTargets, fallbackTopic }),
      prereqs,
    };
  });

  const inBatch = new Set(meta.map(m => m.ref));
  for (const item of meta) {
    for (const req of [...item.prereqs]) if (!inBatch.has(req)) item.prereqs.delete(req);
  }

  const remaining = [...meta];
  const placed = [];
  const placedRefs = new Set();
  const lastSeenAt = new Map();
  const gap = Math.max(1, Math.round(Number(minGap) || 2));

  while (remaining.length) {
    const currentTier = remaining[0].tier;
    // Only consider ready candidates in the same leading tier so priority ordering between tiers is preserved.
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      if (cand.tier !== currentTier) break;
      let blocked = false;
      for (const req of cand.prereqs) if (!placedRefs.has(req)) { blocked = true; break; }
      if (blocked) continue;

      let minDist = Infinity;
      for (const key of cand.keys) {
        if (lastSeenAt.has(key)) {
          const dist = placed.length - lastSeenAt.get(key);
          if (dist < minDist) minDist = dist;
        }
      }
      // Prefer candidates whose siblings are at least `gap` slots away; tie-break by original order.
      const separation = Number.isFinite(minDist) ? Math.min(minDist, gap + 2) : gap + 3;
      const score = separation * 10000 - i;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) bestIdx = 0; // cycle fallback: take next in original order
    const chosen = remaining.splice(bestIdx, 1)[0];
    for (const key of chosen.keys) lastSeenAt.set(key, placed.length);
    placedRefs.add(chosen.ref);
    placed.push(chosen.entry);
  }
  return placed;
}

/**
 * Deterministically assign weekly study points across `dates` balancing existing + new load
 * and optionally dispersing sibling points across distinct days of the week.
 */
export function balanceWeeklyItems(items, dates, {
  cost = () => 1,
  existingLoad = null,
  preloadFirst = 0,
  disperseSiblings = false,
  siblingKeyOf = null,
} = {}) {
  const chunks = new Map(dates.map(date => [date, []]));
  if (!dates.length || !Array.isArray(items) || !items.length) return chunks;

  const dayLoads = new Map();
  dates.forEach((date, idx) => {
    const base = existingLoad instanceof Map
      ? (Number(existingLoad.get(date)) || 0)
      : (existingLoad && typeof existingLoad === 'object' ? (Number(existingLoad[date]) || 0) : 0);
    dayLoads.set(date, base + (idx === 0 ? preloadFirst : 0));
  });

  const siblingDays = new Map();
  const keyFn = typeof siblingKeyOf === 'function'
    ? siblingKeyOf
    : item => item?.chapter ?? item?.doc ?? item?.sourceId ?? item?.parentId ?? null;

  for (const item of items) {
    const weight = Math.max(0, Number(cost(item)) || 0);
    const key = disperseSiblings ? keyFn(item) : null;
    const usedDates = key ? (siblingDays.get(key) || []) : [];

    let bestDate = dates[0];
    let bestScore = Infinity;
    for (let idx = 0; idx < dates.length; idx++) {
      const date = dates[idx];
      const currentLoad = dayLoads.get(date) || 0;
      const sameDaySiblings = key ? usedDates.filter(d => d === date).length : 0;
      const adjacentSiblings = key ? usedDates.filter(d => Math.abs(dates.indexOf(d) - idx) === 1).length : 0;
      const score = sameDaySiblings * 10000 + adjacentSiblings * 250 + currentLoad;
      if (score < bestScore - 1e-9) {
        bestScore = score;
        bestDate = date;
      }
    }
    chunks.get(bestDate).push(item);
    dayLoads.set(bestDate, (dayLoads.get(bestDate) || 0) + weight);
    if (key) {
      if (!siblingDays.has(key)) siblingDays.set(key, []);
      siblingDays.get(key).push(bestDate);
    }
  }
  return chunks;
}
