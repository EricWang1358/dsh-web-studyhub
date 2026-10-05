/* Coverage: which sections of a material have a question, which were planned and did not come out, and which were never planned (README
   docs/plans/coverage-generation). Pure, no I/O and no Node modules: the backend (the snapshot, the draft's top-up) and the browser (the draft page,
   the 任务 console, the reader's outline) read ONE function, so the numbers on every screen are the same numbers.

   coverageOf({ sources, cards, partPlans, ...sectionOptions }) -> {
     sections: [{ id, key, sourceId, kind, level, title, start, end, chars, leaf: true, state, cards, reason?, parts?, ...extras }],   the LEAF sections, reading order
     covered, plannedFailed, neverPlanned, leaves,                counts of leaf sections per state
     percentLeaves, percentChars, perTenK, units,                 how much is covered, by sections and by characters; questions per 10 000 characters
     chars, coveredChars, cards, unplaced, recorded, groups }

   The unit is the leaf section of lib/sections.js (kept outline, PDF page, transcript part, Markdown heading, fixed window); recordings and chapters are rolled
   up into `groups`. A section is
     covered         at least one question's place falls in it. A question's place is its selection's offsets, else where its quote stands in the source (found even when
                     the quote is written a little differently, lib/quote-locate.js); a question that cites a source with a single section covers it with no offset at all;
     planned-failed  a planned target of a part (the draft's `editorial.partPlans`, lib/plan-record.js) with status failed or omitted falls in it and no question does. The target is located by its
                     offsets, else by searching its quote, else by the range of its part; a part that never got as far as targets has its range. `reason` is the code of lib/generation-failure.js;
     never-planned   neither.
   `recorded` is whether any plan was recorded at all: a draft from before plans were kept has none, and its uncovered sections are never-planned only because nothing is known.
   A question that points into a source with several sections but at no offset we can find is `unplaced`: it covers nothing, and the count says so. */
import { sectionsOf, sectionsBySource, leavesHeldBy } from './sections.js';
import { cardPlaceList } from './card-places.js';
import { createLocator } from './quote-locate.js';

export const COVERED = 'covered', PLANNED_FAILED = 'planned-failed', NEVER_PLANNED = 'never-planned';

/** The key of a section across sources (section ids are unique within a source only). */
export const sectionKey = (sourceId, id) => `${sourceId}#${id}`;

const failedTarget = target => target && (target.status === 'failed' || target.status === 'omitted') && target.reason !== 'pending';
const wholeNumber = value => Number.isInteger(value) && value >= 0;

/** Index of the section of `list` (ordered, tiling) that holds `offset`; the last one at the very end. */
function indexAt(list, offset) {
  let low = 0, high = list.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (list[middle].start <= offset) low = middle; else high = middle - 1;
  }
  return low;
}

const rangesOfPlan = plan => (Array.isArray(plan?.ranges) ? plan.ranges : []).filter(range => typeof range?.sourceId === 'string' && wholeNumber(range.start) && wholeNumber(range.end) && range.end > range.start);

/** The roll-up of the leaves into recordings, chapters or top-level sections: [{ id, kind, title, recording?, leaves, covered, plannedFailed, neverPlanned, chars, coveredChars }]; none unless there are two or more. */
function groupsOf(leaves, all) {
  const recordingTitle = new Map(all.filter(section => section.kind === 'recording').map(section => [section.recording, section.title]));
  const topOf = new Map();
  let top = null;
  for (const section of all) {
    if (top && top.sourceId !== section.sourceId) top = null;
    if (section.level === 1 && !section.leaf) top = section;
    if (section.leaf) topOf.set(sectionKey(section.sourceId, section.id), section.level === 1 ? null : top);
  }
  const order = [], byKey = new Map();
  for (const leaf of leaves) {
    const parent = topOf.get(leaf.key);
    let key, title, kind, extra = {};
    if (leaf.recording != null) { key = `r${leaf.recording}`; kind = 'recording'; title = recordingTitle.get(leaf.recording) || ''; extra = { recording: leaf.recording }; }
    else if (leaf.chapter && typeof leaf.chapter === 'object') { key = `c${leaf.chapter.index}`; kind = 'chapter'; title = leaf.chapter.title || ''; }
    else if (parent) { key = sectionKey(parent.sourceId, parent.id); kind = parent.kind; title = parent.title || ''; }
    else continue;
    let group = byKey.get(key);
    if (!group) { group = { id: key, kind, title, ...extra, leaves: 0, covered: 0, plannedFailed: 0, neverPlanned: 0, chars: 0, coveredChars: 0 }; byKey.set(key, group); order.push(group); }
    group.leaves += 1; group.chars += leaf.chars;
    if (leaf.state === COVERED) { group.covered += 1; group.coveredChars += leaf.chars; }
    else if (leaf.state === PLANNED_FAILED) group.plannedFailed += 1;
    else group.neverPlanned += 1;
  }
  return order.length >= 2 ? order : [];
}

/** Where the targets that failed in a section stand (the first few): a part whose range ends inside a section finds its own failed target by it. */
const atOf = entry => { const at = [...new Set(entry.failed.map(item => item.at).filter(wholeNumber))].slice(0, 3); return at.length ? { at } : {}; };

const clampPercent = (part, whole) => {
  if (!(whole > 0)) return 0;
  const raw = part / whole * 100, rounded = Math.round(raw);
  return part < whole && rounded >= 100 ? 99 : part > 0 && rounded < 1 ? 1 : rounded;
};

/**
 * The coverage of a material.
 * `sources`: the sources of the material in reading order ({ id, text, document?, audio? }); `cards`: its questions, the draft's and/or the published ones
 * (cards that cite its sources: { id?, selections?, citations? }); `partPlans`: the `editorial.partPlans` of the drafts that planned it.
 * Options: `outline` / `chapters` / `level` / `windows` as lib/sections.js sectionsOf; `sections` when the caller has them already; `targets: true` keeps, on each
 * planned-failed section, the targets that can be planned again as they are (`targets`: those with offsets).
 */
export function coverageOf({ sources = [], cards = [], partPlans = [], outline, chapters, level, windows, sections: given, targets: keepTargets = false } = {}) {
  const list = (Array.isArray(sources) ? sources : []).filter(source => source && typeof source.id === 'string' && source.id);
  const all = given || sectionsOf(list, { outline, chapters, level, windows });
  const bySource = sectionsBySource(all), byId = new Map(list.map(source => [source.id, source]));
  const entries = new Map();
  const leafLists = new Map();
  for (const [sourceId, sections] of bySource) leafLists.set(sourceId, sections.filter(section => section.leaf));
  const entryOf = section => { let entry = entries.get(section); if (!entry) { entry = { cards: new Set(), failed: [], targets: [] }; entries.set(section, entry); } return entry; };
  const leafAt = (sourceId, offset) => {
    const sections = bySource.get(sourceId);
    if (!sections?.length) return null;
    for (let at = indexAt(sections, offset); at < sections.length; at++) if (sections[at].leaf) return sections[at];
    return null;
  };
  const locators = new Map();
  const locate = sourceId => { let found = locators.get(sourceId); if (!found) { found = createLocator(byId.get(sourceId)?.text); locators.set(sourceId, found); } return found; };

  // The questions: each covers the leaf section its place falls in.
  let unplaced = 0, counted = 0;
  (Array.isArray(cards) ? cards : []).forEach((card, number) => {
    if (!card) return;
    counted += 1;
    const id = card.id ?? `#${number}`;
    let placed = false;
    for (const place of cardPlaceList(card, byId, locate)) {
      const leaves = leafLists.get(place.sourceId);
      if (!leaves?.length) continue;
      const section = place.start === null ? (leaves.length === 1 ? leaves[0] : null) : leafAt(place.sourceId, place.start);
      if (!section) continue;
      entryOf(section).cards.add(id);
      placed = true;
    }
    if (!placed) unplaced += 1;
  });

  // What was planned and did not come out.
  let recorded = false;
  for (const plan of Array.isArray(partPlans) ? partPlans : []) {
    if (!plan || typeof plan !== 'object') continue;
    recorded = true;
    const ranges = rangesOfPlan(plan), planned = Array.isArray(plan.targets) ? plan.targets : [];
    const inRanges = sourceId => ranges.filter(range => !sourceId || range.sourceId === sourceId).flatMap(range => leavesHeldBy(leafLists.get(range.sourceId) || [], range));
    const mark = (section, reason, target, precise = false) => {
      const entry = entryOf(section);
      entry.failed.push({ part: Number(plan.part) || 0, reason: reason || plan.reason || 'other', precise, ...(precise && wholeNumber(target?.start) ? { at: target.start } : {}) });
      if (target && keepTargets && wholeNumber(target.start) && wholeNumber(target.end) && target.end > target.start) entry.targets.push(target);
    };
    const failed = planned.filter(failedTarget);
    for (const target of failed) {
      let sections = [];
      if (typeof target.sourceId === 'string' && wholeNumber(target.start)) { const found = leafAt(target.sourceId, target.start); if (found) sections = [found]; }
      if (!sections.length && typeof target.sourceId === 'string' && target.quote && byId.has(target.sourceId)) {
        const at = locate(target.sourceId)(target.quote), found = at && leafAt(target.sourceId, at.start);
        if (found) sections = [found];
      }
      if (!sections.length) sections = inRanges(typeof target.sourceId === 'string' ? target.sourceId : undefined).length ? inRanges(typeof target.sourceId === 'string' ? target.sourceId : undefined) : inRanges();
      for (const section of sections) mark(section, target.reason, sections.length === 1 ? { ...target, part: plan.part } : null, sections.length === 1);
    }
    // A part that never got as far as targets (its planning failed, its time ran out): what it was to cover is what did not come out.
    if (!planned.length && plan.status === 'failed') for (const section of inRanges()) mark(section, plan.reason, null);
  }

  const sections = [];
  let covered = 0, plannedFailed = 0, neverPlanned = 0, chars = 0, coveredChars = 0;
  for (const [, leaves] of leafLists) for (const leaf of leaves) {
    const entry = entries.get(leaf), kept = entry?.cards.size || 0;
    // The latest part's failure gives the reason; within a part, a target that was located beats one that is only in the range of its part.
    const latest = entry?.failed.length ? entry.failed.reduce((best, item) => (item.part > best.part || (item.part === best.part && item.precise && !best.precise) ? item : best)) : null;
    const state = kept ? COVERED : latest ? PLANNED_FAILED : NEVER_PLANNED;
    chars += leaf.chars;
    if (state === COVERED) { covered += 1; coveredChars += leaf.chars; } else if (state === PLANNED_FAILED) plannedFailed += 1; else neverPlanned += 1;
    sections.push({ id: leaf.id, key: sectionKey(leaf.sourceId, leaf.id), sourceId: leaf.sourceId, kind: leaf.kind, level: leaf.level, title: leaf.title || '', start: leaf.start, end: leaf.end,
      chars: leaf.chars, leaf: true, state, cards: kept, ...(state === PLANNED_FAILED ? { reason: latest.reason, parts: [...new Set(entry.failed.map(item => item.part))], ...atOf(entry) } : {}),
      ...(leaf.recording != null ? { recording: leaf.recording } : {}), ...(leaf.part != null ? { part: leaf.part } : {}), ...(leaf.page ? { page: leaf.page } : {}),
      ...(leaf.chapter !== undefined ? { chapter: leaf.chapter } : {}), ...(leaf.continued ? { continued: true } : {}), ...(leaf.n ? { n: leaf.n } : {}),
      ...(keepTargets && state === PLANNED_FAILED && entry.targets.length ? { targets: entry.targets } : {}) });
  }
  const kinds = new Set(sections.map(section => section.kind));
  return { sections, covered, plannedFailed, neverPlanned, leaves: sections.length, percentLeaves: clampPercent(covered, sections.length), percentChars: clampPercent(coveredChars, chars),
    perTenK: chars > 0 ? Math.round(counted / chars * 100000) / 10 : 0, units: kinds.size === 1 ? [...kinds][0] : 'section', chars, coveredChars, cards: counted, unplaced, recorded,
    groups: groupsOf(sections, all) };
}

/** The numbers of a coverage without its sections. */
export const coverageSummary = coverage => ({ covered: coverage.covered, plannedFailed: coverage.plannedFailed, neverPlanned: coverage.neverPlanned, leaves: coverage.leaves,
  percentLeaves: coverage.percentLeaves, percentChars: coverage.percentChars, perTenK: coverage.perTenK, units: coverage.units, cards: coverage.cards, unplaced: coverage.unplaced, recorded: coverage.recorded });

/**
 * What the snapshot keeps per document: [covered, plannedFailed, neverPlanned, recorded (1 | 0), units]. The snapshot is paid for in characters (tests/perf-budget.test.mjs), a row needs
 * only these, and everything else (leaves, the percentage) follows from them by `coverageFromDigest`, the same arithmetic as coverageOf.
 */
export const coverageDigest = coverage => [coverage.covered, coverage.plannedFailed, coverage.neverPlanned, coverage.recorded ? 1 : 0, coverage.units];

/** A digest as the coverage numbers the chip and the lines of ui/coverage/copy.js read: { covered, plannedFailed, neverPlanned, leaves, percentLeaves, units, recorded }; null for anything else. */
export function coverageFromDigest(digest) {
  if (!Array.isArray(digest) || digest.length < 4) return null;
  const [covered, plannedFailed, neverPlanned, recorded, units] = digest, leaves = covered + plannedFailed + neverPlanned;
  return leaves > 0 ? { covered, plannedFailed, neverPlanned, leaves, percentLeaves: clampPercent(covered, leaves), units: typeof units === 'string' ? units : 'section', recorded: recorded === 1 } : null;
}

/** The sections of a coverage that have no question, planned-and-failed first, then never planned, each in reading order. */
export const uncoveredSections = coverage => [...coverage.sections.filter(section => section.state === PLANNED_FAILED), ...coverage.sections.filter(section => section.state === NEVER_PLANNED)];

/**
 * The coverage of a range (what one part of a run was cut from): ranges are [{ sourceId, start, end }]. A section belongs to the range that holds most of it,
 * so over the parts of a run the counts add up to the whole. -> { leaves, covered, plannedFailed, neverPlanned, sections, borrowed }
 * `borrowed` are planned-and-failed sections of the NEIGHBOUR that hold a failed target lying inside the range (a part's range ends in the middle of a section, and the section belongs to the part
 * that holds most of it): they are not counted, but a list of what the part lost names them.
 */
export function coverageInRange(coverage, ranges) {
  const bySource = new Map();
  for (const section of coverage?.sections || []) { if (!bySource.has(section.sourceId)) bySource.set(section.sourceId, []); bySource.get(section.sourceId).push(section); }
  const seen = new Set(), found = [];
  for (const range of Array.isArray(ranges) ? ranges : []) {
    if (!wholeNumber(range?.start) || !wholeNumber(range?.end) || !(range.end > range.start)) continue;
    for (const section of leavesHeldBy(bySource.get(range.sourceId) || [], range)) if (!seen.has(section.key)) { seen.add(section.key); found.push(section); }
  }
  const count = state => found.filter(section => section.state === state).length, inside = (section, range) => section.sourceId === range.sourceId && (section.at || []).some(at => at >= range.start && at < range.end);
  const borrowed = (coverage?.sections || []).filter(section => section.state === PLANNED_FAILED && !seen.has(section.key) && (Array.isArray(ranges) ? ranges : []).some(range => inside(section, range)));
  return { leaves: found.length, covered: count(COVERED), plannedFailed: count(PLANNED_FAILED), neverPlanned: count(NEVER_PLANNED), sections: found, borrowed };
}
