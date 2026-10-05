/* 覆盖强度 (coverage strength): how many questions a material deserves and where they go. Phase 3 of docs/plans/coverage-generation. Pure, no I/O and no Node modules:
   the creation form shows what a level means for the chosen sources, and the backend plans a run from the same function, so the number the learner read before pressing
   the button is the number the run is planned with.

   THE ONE TABLE (STRENGTH). Everything a level means is in it, nowhere else:
     lean 精简      the sections that hold ~60% of the weighted content (never fewer than one per recording)      3 questions per 10 000 characters, 1-4 per section
     standard 标准  every leaf section of at least 600 characters (a smaller stub shares its neighbour's question)  6 per 10 000, 1-6 per section      (the default)
     full 完整      every leaf section, however small                                                               10 per 10 000, 1-8 per section
   The densities are questions per 10 000 characters of EVIDENCE of the material's leaf sections (lib/sections.js evidenceChars: a bilingual transcript counts the original language only,
   never its translation; transcript furniture and headings belong to the non-leaf recording section and are never counted). 6 per 10 000 is one question per page and a half of a dense textbook (about 1 700 characters); 3 is one per three pages, a review pass; 10 is one per
   page, a thorough one. Nothing here is a limit on cost: LIMITS holds the sanity bounds only (500 questions in all, 400 from one source), and a plan that reaches them says so
   (`capped`, `dropped`) instead of quietly covering less. The quota range is per SLOT of 10 000 characters (SLOT_CHARS): a longer section may hold that many times the range, so length
   keeps counting beyond one slot, and `assignmentsOf` cuts a quota above the range into slots a planning call can answer.

   WEIGHTS. A section's weight is its length times how much it matters: weight = chars x IMPORTANCE[importance 1..5] x KIND[kind] (lib/section-weights.js asks a light model;
   without it every section is importance 3, kind other, so weight is its length). The weights decide (a) which sections lean must cover, (b) how the goal is shared
   (longer and more important sections get more questions, within the quota range) and (c) the order of the rounds (heaviest first, ties in reading order).

   `strengthPlan(sections, weights, level, { goalCount })` -> { level, goal, leaves, mustCover, quotas, dropped, capped, perTenK }
   `quotasFor(...)` -> the quotas alone: [{ sectionId, quota, reason }] in reading order, quota >= 1, the quotas add up to `goal`. `sectionId` is the section KEY of lib/coverage.js
   (`sourceId#id`), unique across sources. `reason`: 'floor' (the least a covered section gets), 'important' (importance 4-5), 'long' (a long section), 'share' (its share of the goal).
   The result is deterministic: the same input gives the same quotas, whatever the order of `weights`; ties are broken by reading order. `goalCount` (a custom total) rescales
   within the same rules: more than the density gives raises every share, fewer than the must-cover sections keeps the heaviest of them, more than the quota ranges hold is cut to
   what they hold. */
import { sectionKey } from './coverage.js';
import { evidenceOf } from './sections.js';
import { ROUND_LIMIT } from './coverage-round.js';
import { GOAL_QUESTIONS_MAX } from './limits.js';

export const LEVELS = Object.freeze(['lean', 'standard', 'full']);
export const DEFAULT_LEVEL = 'standard';

/** The one table. `auto`: whether a run of this level goes on to its next round by itself (「自动补到完整」 is ticked for it): 精简 is the quick look, whose first round already holds the heaviest sections, so it waits for the learner; 标准 and 完整 asked for completeness, so they go on to the end (lib/coverage-run.js). `minChars`: a leaf shorter than this is a stub (shares its neighbour's question) unless the level covers every leaf. `share`: lean's fraction of the weighted content. */
export const STRENGTH = Object.freeze({
  lean: Object.freeze({ perTenK: 3, minQuota: 1, maxQuota: 4, minChars: 600, share: 0.6, auto: false }),
  standard: Object.freeze({ perTenK: 6, minQuota: 1, maxQuota: 6, minChars: 600, auto: true }),
  full: Object.freeze({ perTenK: 10, minQuota: 1, maxQuota: 8, minChars: 0, auto: true }),
});

/** A section holds `maxQuota` questions per this many characters (a section of 25 000 characters may hold three times the quota range): the quota range is per planning call, the density is per length. */
export const SLOT_CHARS = 10000;
const slotsOf = leaf => Math.max(1, Math.ceil(evidenceOf(leaf) / SLOT_CHARS));

/** The sanity bounds: questions in all (also the most a custom count may ask), and from one source. */
export const LIMITS = Object.freeze({ total: GOAL_QUESTIONS_MAX, perSource: 400 });

/** How much a model-judged importance (1..5) counts, and what kind of passage it is. A chatter section still gets its one question when the level covers every section. */
export const IMPORTANCE = Object.freeze({ 1: 0.4, 2: 0.7, 3: 1, 4: 1.5, 5: 2.2 });
export const KINDS = Object.freeze(['definition', 'method', 'example', 'summary', 'chatter', 'other']);
export const KIND_FACTOR = Object.freeze({ definition: 1.2, method: 1.2, example: 0.9, summary: 0.8, chatter: 0.5, other: 1 });

export const isLevel = value => LEVELS.includes(value);
export const levelOf = value => (isLevel(value) ? value : DEFAULT_LEVEL);
/** Whether a run of this level goes on by itself unless the learner says otherwise (the table's `auto`). */
export const autoCompleteOf = value => STRENGTH[levelOf(value)].auto;

const keyOfSection = section => section.key || sectionKey(section.sourceId, section.id);

/** The weights as a Map(section key -> { importance, kind }): an array of { sectionId, importance, kind } (what the draft keeps), a Map, or nothing. */
function weightMap(weights) {
  if (weights instanceof Map) return weights;
  const map = new Map();
  for (const item of Array.isArray(weights) ? weights : []) if (item && typeof item.sectionId === 'string') map.set(item.sectionId, item);
  return map;
}

const importanceOf = item => (Number.isInteger(item?.importance) && item.importance >= 1 && item.importance <= 5 ? item.importance : 3);
const kindOf = item => (KINDS.includes(item?.kind) ? item.kind : 'other');

/** The weight of one section: its characters times how much it matters. */
export function weightOf(section, item) {
  return Math.max(1, evidenceOf(section)) * IMPORTANCE[importanceOf(item)] * KIND_FACTOR[kindOf(item)];
}

/** Largest-remainder sharing of `total` units over `entries` ({ index, weight, room }) without going over any `room`; stable by (remainder, weight, reading order). */
function share(entries, total) {
  const given = new Map(entries.map(entry => [entry.index, 0]));
  let left = total;
  for (let pass = 0; left > 0 && pass < 64; pass++) {
    const open = entries.filter(entry => given.get(entry.index) < entry.room);
    if (!open.length) break;
    const sum = open.reduce((acc, entry) => acc + entry.weight, 0) || 1;
    const ideal = open.map(entry => ({ entry, raw: entry.weight / sum * left }));
    let used = 0;
    for (const { entry, raw } of ideal) {
      const add = Math.min(Math.floor(raw), entry.room - given.get(entry.index));
      given.set(entry.index, given.get(entry.index) + add);
      used += add;
    }
    left -= used;
    if (left <= 0) break;
    // The units the floors left over go to the biggest remainders (then the heaviest, then the earliest section).
    const remainders = ideal.map(({ entry, raw }) => ({ entry, rest: raw - Math.floor(raw) })).filter(({ entry }) => given.get(entry.index) < entry.room)
      .sort((a, b) => b.rest - a.rest || b.entry.weight - a.entry.weight || a.entry.index - b.entry.index);
    for (const { entry } of remainders) { if (left <= 0) break; given.set(entry.index, given.get(entry.index) + 1); left -= 1; }
  }
  return given;
}

/** The leaves that must get a question at this level, as indexes into `leaves` (see the table). */
function mustCoverOf(leaves, weight, level) {
  const config = STRENGTH[level], all = leaves.map((_, index) => index);
  const large = all.filter(index => evidenceOf(leaves[index]) >= config.minChars);
  // A source whose leaves are all stubs (a short note) still counts: it is covered by its own largest leaf.
  const stubOnly = [...new Set(leaves.map(leaf => leaf.sourceId))].filter(id => !large.some(index => leaves[index].sourceId === id))
    .map(id => all.filter(index => leaves[index].sourceId === id).reduce((best, index) => (evidenceOf(leaves[index]) > evidenceOf(leaves[best]) ? index : best)));
  const base = level === 'full' ? all : [...large, ...stubOnly].sort((a, b) => a - b);
  if (level !== 'lean') return base;
  // Lean: the heaviest sections until they hold `share` of the weighted content, then at least one section of every recording.
  const ranked = [...base].sort((a, b) => weight[b] - weight[a] || a - b), total = base.reduce((sum, index) => sum + weight[index], 0), chosen = new Set();
  let held = 0;
  for (const index of ranked) { if (held >= total * config.share && chosen.size) break; chosen.add(index); held += weight[index]; }
  const recordings = new Map();
  for (const index of all) { const recording = leaves[index].recording; if (recording != null) { if (!recordings.has(recording)) recordings.set(recording, []); recordings.get(recording).push(index); } }
  for (const members of recordings.values()) {
    if (members.some(index => chosen.has(index))) continue;
    chosen.add(members.reduce((best, index) => (weight[index] > weight[best] ? index : best)));
  }
  return [...chosen].sort((a, b) => a - b);
}

/** The stubs of a plan (leaves that are not must-cover) that share a neighbour's question: Map(stub index -> index of the leaf whose question it shares), the previous leaf of its source else the next. */
function stubShares(leaves, covered, minChars) {
  const shares = new Map(), isCovered = new Set(covered);
  leaves.forEach((leaf, index) => {
    // Only a stub shares: a section the level leaves out on purpose (lean) is not folded into the range of its neighbour.
    if (isCovered.has(index) || evidenceOf(leaf) >= minChars) return;
    for (let at = index - 1; at >= 0 && leaves[at].sourceId === leaf.sourceId; at--) if (isCovered.has(at)) { shares.set(index, at); return; }
    for (let at = index + 1; at < leaves.length && leaves[at].sourceId === leaf.sourceId; at++) if (isCovered.has(at)) { shares.set(index, at); return; }
  });
  return shares;
}

/**
 * The plan of a level for the leaf sections `sections` (reading order; non-leaf sections are ignored) with the model's `weights`.
 * -> { level, goal, leaves, mustCover, quotas: [{ sectionId, quota, reason, shares? }], dropped: [section keys that get no question], capped: string[], perTenK }
 * `mustCover` is how many sections get a question; `dropped` the must-cover sections the goal or the bounds could not afford (the heaviest are kept).
 */
export function strengthPlan(sections, weights, level = DEFAULT_LEVEL, { goalCount } = {}) {
  const chosen = levelOf(level), config = STRENGTH[chosen];
  const leaves = (Array.isArray(sections) ? sections : []).filter(section => section && section.leaf !== false && section.sourceId != null && Number(section.chars) > 0);
  const empty = { level: chosen, goal: 0, leaves: 0, mustCover: 0, quotas: [], dropped: [], capped: [], perTenK: config.perTenK };
  if (!leaves.length) return empty;
  const map = weightMap(weights), keys = leaves.map(keyOfSection), items = keys.map(key => map.get(key));
  const weight = leaves.map((leaf, index) => weightOf(leaf, items[index]));
  const chars = leaves.reduce((sum, leaf) => sum + evidenceOf(leaf), 0), capped = [];
  let covered = mustCoverOf(leaves, weight, chosen);
  // The goal: the density of the level over the material's characters, or the custom total; never above the sanity bound, never below one question per must-cover section.
  const wanted = Number.isInteger(goalCount) && goalCount >= 1 ? goalCount : Math.round(config.perTenK * chars / 10000);
  let goal = Math.min(LIMITS.total, Math.max(1, wanted));
  if (goal < wanted) capped.push('total');
  // Too few questions for every must-cover section (a custom count, the sanity bound): the heaviest keep theirs.
  const dropped = [];
  if (covered.length > goal) {
    const keep = new Set([...covered].sort((a, b) => weight[b] - weight[a] || a - b).slice(0, goal));
    dropped.push(...covered.filter(index => !keep.has(index)).map(index => keys[index]));
    covered = covered.filter(index => keep.has(index));
    capped.push('sections');
  }
  goal = Math.max(goal, covered.length);
  // The quotas: one each, then the rest shared by weight within the quota range.
  const extra = share(covered.map(index => ({ index, weight: weight[index], room: config.maxQuota * slotsOf(leaves[index]) - config.minQuota })), Math.max(0, goal - covered.length * config.minQuota));
  const quota = new Map(covered.map(index => [index, config.minQuota + extra.get(index)]));
  // The bound per source: the lightest sections give up their extra questions first (never below the minimum).
  const bySource = new Map();
  for (const index of covered) { const id = leaves[index].sourceId; if (!bySource.has(id)) bySource.set(id, []); bySource.get(id).push(index); }
  for (const [id, members] of bySource) {
    let sum = members.reduce((acc, index) => acc + quota.get(index), 0);
    if (sum <= LIMITS.perSource) continue;
    capped.push(`source:${id}`);
    const order = [...members].sort((a, b) => weight[a] - weight[b] || b - a);
    for (let pass = 0; sum > LIMITS.perSource && pass < config.maxQuota; pass++)
      for (const index of order) { if (sum <= LIMITS.perSource) break; if (quota.get(index) > config.minQuota) { quota.set(index, quota.get(index) - 1); sum -= 1; } }
  }
  const median = (() => { const sorted = covered.map(index => evidenceOf(leaves[index])).sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] || 0; })();
  const sharing = stubShares(leaves, covered, config.minChars), sharedBy = new Map();
  for (const [stub, host] of sharing) { if (!sharedBy.has(host)) sharedBy.set(host, []); sharedBy.get(host).push(keys[stub]); }
  const quotas = covered.map(index => {
    const value = quota.get(index), importance = importanceOf(items[index]);
    const reason = value <= config.minQuota ? 'floor' : importance >= 4 ? 'important' : evidenceOf(leaves[index]) >= median * 1.5 ? 'long' : 'share';
    return { sectionId: keys[index], quota: value, reason, ...(sharedBy.has(index) ? { shares: sharedBy.get(index) } : {}) };
  });
  const total = quotas.reduce((sum, item) => sum + item.quota, 0);
  return { level: chosen, goal: total, leaves: leaves.length, mustCover: covered.length, quotas, dropped, capped, perTenK: Math.round(total / Math.max(1, chars) * 100000) / 10 };
}

/** The quotas of a plan: [{ sectionId, quota, reason }], reading order, adding up to the goal. */
export const quotasFor = (sections, weights, level, options) => strengthPlan(sections, weights, level, options).quotas;

/* ---------- assignments and rounds ---------- */

/**
 * What a planning call is given: one assignment per section that gets questions, { key, sectionId, sourceId, start, end, quota, title?, reason, weight, shares? }. The range is the section's
 * own text, widened over the stubs that share its question. `weights` as strengthPlan reads them; `sections` the same leaves the plan was made from.
 */
export function assignmentsOf(plan, sections, weights) {
  const map = weightMap(weights), byKey = new Map((Array.isArray(sections) ? sections : []).map(section => [keyOfSection(section), section])), per = STRENGTH[plan.level].maxQuota;
  return plan.quotas.flatMap(({ sectionId, quota, reason, shares = [] }) => {
    const section = byKey.get(sectionId);
    if (!section) return [];
    const own = [section, ...shares.map(key => byKey.get(key)).filter(Boolean)];
    const start = Math.min(...own.map(item => item.start)), end = Math.max(...own.map(item => item.end)), weight = weightOf(section, map.get(sectionId));
    const base = { sectionId, sourceId: section.sourceId, reason, ...(section.title ? { title: section.title } : {}), ...(shares.length ? { shares } : {}) };
    // A quota above what one planning call answers is cut into slots of the section, each with its own range (the questions of the slots add up to the quota).
    const slots = Math.max(1, Math.ceil(quota / per));
    if (slots === 1) return [{ key: sectionId, ...base, start, end, quota, weight }];
    return Array.from({ length: slots }, (_, index) => ({ key: `${sectionId}~${index + 1}`, ...base, start: start + Math.floor((end - start) * index / slots), end: start + Math.floor((end - start) * (index + 1) / slots),
      quota: Math.floor(quota / slots) + (index < quota % slots ? 1 : 0), weight: weight / slots, slot: index + 1 }));
  });
}

/**
 * The assignments of a plan grouped into rounds of at most `limit` questions (the generation limit of one round): the heaviest assignments first (ties in reading order), a section's quota
 * never split between two rounds. Within a round the assignments are in reading order. -> [{ round, questions, assignments }]
 */
export function roundsOf(assignments, { limit = ROUND_LIMIT } = {}) {
  const order = new Map(assignments.map((assignment, index) => [assignment.key, index]));
  const heavy = [...assignments].sort((a, b) => b.weight - a.weight || order.get(a.key) - order.get(b.key));
  const rounds = [];
  for (const assignment of heavy) {
    // Next fit: a round is closed once the next assignment does not fit, so the rounds stay in the order of the weights.
    let round = rounds.at(-1);
    if (!round || round.questions + assignment.quota > limit) { round = { round: rounds.length + 1, questions: 0, assignments: [] }; rounds.push(round); }
    round.assignments.push(assignment);
    round.questions += assignment.quota;
  }
  for (const round of rounds) round.assignments.sort((a, b) => order.get(a.key) - order.get(b.key));
  return rounds;
}
