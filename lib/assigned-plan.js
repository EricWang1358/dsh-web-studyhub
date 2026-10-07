/* ENFORCED PLANNING (README docs/plans/coverage-generation, phase 3). A planner that is only HINTED to spread its knowledge points over a long material clusters at the start of it (one round of 29
   sections raised the covered ones from 7 to 13), so the program does not ask for a spread: it gives each planning call an ASSIGNMENT and checks what comes back.

   An assignment is a few sections of a material with their ranges and quotas: `{ key, sectionId, sourceId, start, end, quota, title? }` (lib/coverage-strength.js assignmentsOf). A call sees ONLY the text of its
   assigned sections (a piece of the source for each, cut at its absolute offsets, so every citation still checks against the full stored text). What it returns is validated here:
     every target's quote is located (lib/quote-locate.js: as written, then letters and digits only, then an elided quote) inside the range of an assigned section, else the target is dropped ('outside');
     at most `quota` targets per section (the rest are dropped: 'over-quota'); a quote that repeats one already kept for the section is dropped ('duplicate');
     a section whose quota is not met is asked again ONCE, alone, with the quota it still lacks and exactly its own range;
     what is still missing is returned as `short` (recorded by lib/batch.js as a failed part of the run with the failure code PLAN_SHORT, so it is a planned-failed section in lib/coverage.js and is said in words),
     never silently dropped.
   `planAssigned(ask, request, { assignments })` -> { targets, dropped, short, lost, reasked }
     targets: the verified targets in reading order, renumbered target-1.., each with `assignment` (the key), `start` / `end` (where its quote stands in the stored text of its source);
     dropped: [{ reason, assignment?, objective }]; short: [{ key, sectionId, sourceId, start, end, quota, planned, missing, chars, returned?, outside?, why?, error? }]; lost: plain-English lines for the run's notes.
       `chars` is the length of the section, `returned` / `outside` what the asking-again gave for it (how many points, how many of them quoted text that is not in the section; only a section asked
       alone has them), `why` ('refused' | 'invalid' | 'reply') why the last reply could not be used at all: lib/generation-failure.js shortCauseOf names the cause from these.
   A failure that repeating cannot fix (a refused key, an account without balance, a stop) is thrown, not turned into dozens of short sections. */
import { planAssessment } from './assessment-quality.js';
import { createLocator } from './quote-locate.js';
import { withSliceRange, sliceRangeOf } from './sections.js';
import { isPermanentFailure, PLAN_SHORT } from './generation-failure.js';
import { CALL_CHARS, CALL_TARGETS } from './limits.js';

export { PLAN_SHORT };

const clip = (value, size) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > size ? `${text.slice(0, size - 1)}…` : text; };

/** Why the last reply for a section could not be used at all, from the error it left: the model said the page lacks the points, its points failed the checks, or its reply could not be read. */
const replyWhy = message => (/insufficient evidence/i.test(message) ? 'refused' : /Assessment plan is not usable/i.test(message) ? 'invalid' : 'reply');

/** The sections that came back short as the draft keeps them (one row per section, bounded): the numbers a screen words as 「要 3 个考点，只给出 1 个」. */
export function shortRecords(short, limit = 80) {
  const by = new Map();
  for (const item of Array.isArray(short) ? short : []) {
    const key = item?.sectionId ?? item?.key;
    if (typeof key !== 'string') continue;
    const row = by.get(key) || { sectionId: key, needed: 0, got: 0, chars: 0 }, add = (field, value) => { if (Number.isFinite(value)) row[field] = (row[field] || 0) + value; };
    add('needed', item.quota); add('got', item.planned); add('chars', item.chars); add('returned', item.returned); add('outside', item.outside);
    if (item.why && !row.why) row.why = item.why;
    by.set(key, row);
  }
  return [...by.values()].slice(0, limit);
}

/** The pieces of the sources that hold an assignment's range: [piece], each a copy of its source with the text cut at the range and the offsets it was cut at. `sources` may be whole sources or pieces. */
export function pieceOfAssignment(assignment, sources, label) {
  const out = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    if (source?.id !== assignment.sourceId || typeof source.text !== 'string') continue;
    const range = sliceRangeOf(source), start = Math.max(assignment.start, range.start), end = Math.min(assignment.end, range.end);
    if (!(end > start)) continue;
    out.push(withSliceRange({ ...source, text: source.text.slice(start - range.start, end - range.start), ...(label ? { section: label } : {}) }, start, end));
  }
  return out;
}

/**
 * The assignments of a plan grouped into planning calls: in reading order, a group holds at most `chunkChars` characters of text (the most one call is given) and `maxTargets` questions (the most one
 * planning call is asked for). A range longer than one call is cut into pieces that share its quota (the pieces keep the section id).
 */
export function assignmentGroups(assignments, { chunkChars = CALL_CHARS, maxTargets = CALL_TARGETS } = {}) {
  const items = [];
  for (const assignment of Array.isArray(assignments) ? assignments : []) {
    const length = assignment.end - assignment.start, pieces = Math.max(1, Math.ceil(length / chunkChars));
    if (pieces === 1) { items.push(assignment); continue; }
    // The quota is shared by the pieces, spread evenly: a quota smaller than the number of pieces goes to evenly spaced pieces.
    const quotas = Array.from({ length: pieces }, () => 0);
    if (assignment.quota >= pieces) quotas.forEach((_, index) => { quotas[index] = Math.floor(assignment.quota / pieces) + (index < assignment.quota % pieces ? 1 : 0); });
    else for (let n = 0; n < assignment.quota; n++) quotas[Math.floor((n + 0.5) * pieces / assignment.quota)] += 1;
    quotas.forEach((quota, index) => {
      if (quota > 0) items.push({ ...assignment, key: `${assignment.key}/${index + 1}`, start: assignment.start + Math.floor(length * index / pieces), end: assignment.start + Math.floor(length * (index + 1) / pieces), quota });
    });
  }
  const groups = [];
  let current = null;
  for (const item of items) {
    const size = item.end - item.start;
    if (!current || current.chars + size > chunkChars || current.questions + item.quota > maxTargets) { current = { assignments: [], chars: 0, questions: 0 }; groups.push(current); }
    current.assignments.push(item);
    current.chars += size;
    current.questions += item.quota;
  }
  return groups.map(({ assignments: list, chars, questions }) => ({ assignments: list, chars, questions }));
}

const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/**
 * What a plan's targets are worth once the program has checked where they stand: `{ kept, dropped }`. `pieces` are what the planner was given (pieceOfAssignment), `assignments` what each piece
 * was assigned, `state` a Map(assignment key -> targets kept so far) that the caller keeps across calls so the quota counts everything kept for a section.
 */
export function enforceAssignment(targets, pieces, assignments, state = new Map(), locators = new Map()) {
  const kept = [], dropped = [];
  const locate = (citation) => {
    for (const piece of pieces) {
      if (piece.id !== citation.sourceId) continue;
      if (!locators.has(piece)) locators.set(piece, createLocator(piece.text));
      const found = locators.get(piece)(citation.quote);
      if (found) { const base = sliceRangeOf(piece).start; return { sourceId: piece.id, start: base + found.start, end: base + found.end }; }
    }
    return null;
  };
  for (const target of Array.isArray(targets) ? targets : []) {
    const citation = target?.citations?.[0], place = citation && typeof citation.quote === 'string' ? locate(citation) : null;
    const item = place && assignments.find(entry => entry.sourceId === place.sourceId && place.start >= entry.start && place.start < entry.end);
    if (!item) { dropped.push({ reason: 'outside', objective: target?.objective }); continue; }
    const have = state.get(item.key) || [];
    if (have.length >= item.quota) { dropped.push({ reason: 'over-quota', assignment: item.key, objective: target.objective }); continue; }
    if (have.some(other => overlap(other, place) > Math.min(other.end - other.start, place.end - place.start) / 2)) { dropped.push({ reason: 'duplicate', assignment: item.key, objective: target.objective }); continue; }
    const { section: _claimed, ...rest } = target;
    const entry = { ...rest, assignment: item.key, sectionId: item.sectionId, start: place.start, end: place.end };
    state.set(item.key, [...have, entry]);
    kept.push(entry);
  }
  return { kept, dropped };
}

/** The assignment as the planner reads it: its id, title and quota, and the passages already used for it (a re-ask must not choose them again). */
const briefOf = (slot, kept = []) => ({ id: slot.label, ...(slot.title ? { title: clip(slot.title, 80) } : {}), quota: slot.quota,
  ...(kept.length ? { alreadyPlanned: kept.map(target => clip(target.citations?.[0]?.quote, 80)).filter(Boolean) } : {}) });

/**
 * Plan the assignments of ONE call. `ask` and `request` are what lib/assessment-quality.js planAssessment takes (`request.sources`: the sources or the pieces they were cut into; `request.existing`:
 * objectives not to repeat; `request.signal`). The result is the plan the program checked, never the planner's own word for where its targets are.
 */
export async function planAssigned(ask, request, { assignments, salvage = true } = {}) {
  const { assignments: _all, coverageSpec: _spec, ...base } = request;
  const slots = (Array.isArray(assignments) ? assignments : []).map((assignment, index) => {
    const label = `a${index + 1}`;
    return { ...assignment, label, pieces: pieceOfAssignment(assignment, request.sources, label) };
  });
  const state = new Map(), locators = new Map(), dropped = [], errors = new Map(), lastAsk = new Map();
  const usable = slots.filter(slot => slot.pieces.length);
  const keptOf = slot => state.get(slot.key) || [];
  const objectives = () => [...(request.existing || []), ...slots.flatMap(slot => keptOf(slot).map(target => target.objective))];
  async function askFor(list, count) {
    request.signal?.throwIfAborted();
    try {
      return await planAssessment(ask, { ...base, sources: list.flatMap(slot => slot.pieces), assignments: list.map(slot => briefOf(slot, keptOf(slot))), count, existing: objectives() }, { salvage });
    } catch (error) {
      if (request.signal?.aborted || isPermanentFailure(error)) throw error;
      for (const slot of list) errors.set(slot.key, String(error?.message || error).slice(0, 200));
      return { targets: [], failed: true };
    }
  }
  const absorb = (plan, list) => {
    const { dropped: gone } = enforceAssignment(plan.targets, list.flatMap(slot => slot.pieces), list, state, locators);
    dropped.push(...gone);
    return { returned: Array.isArray(plan.targets) ? plan.targets.length : 0, outside: gone.filter(item => item.reason === 'outside').length };
  };
  let reasked = 0;
  if (usable.length) {
    const asked = usable.reduce((sum, slot) => sum + slot.quota, 0);
    absorb(await askFor(usable, asked), usable);
    // A section whose quota is not met is asked again ONCE, alone, for what it lacks, over exactly its own range.
    const lacking = usable.filter(slot => keptOf(slot).length < slot.quota);
    reasked = lacking.length;
    await Promise.all(lacking.map(async slot => {
      const missing = slot.quota - keptOf(slot).length;
      errors.delete(slot.key);
      const again = await askFor([{ ...slot, quota: missing }], missing);
      lastAsk.set(slot.key, again.failed ? { failed: true } : absorb(again, [slot]));
    }));
  }
  const short = slots.filter(slot => keptOf(slot).length < slot.quota).map(slot => ({ key: slot.key, sectionId: slot.sectionId ?? slot.key, sourceId: slot.sourceId, start: slot.start, end: slot.end, quota: slot.quota,
    planned: keptOf(slot).length, missing: slot.quota - keptOf(slot).length, chars: Math.max(0, slot.end - slot.start), ...(slot.title ? { title: slot.title } : {}),
    ...(lastAsk.has(slot.key) && !lastAsk.get(slot.key).failed ? lastAsk.get(slot.key) : {}), ...(errors.has(slot.key) ? { error: errors.get(slot.key), why: replyWhy(errors.get(slot.key)) } : {}) }));
  const targets = slots.flatMap(slot => [...keptOf(slot)].sort((a, b) => a.start - b.start)).map((target, index) => ({ ...target, targetId: `target-${index + 1}` }));
  const lost = [...short.map(item => `The plan came back short for ${item.title ? `"${clip(item.title, 40)}"` : 'a section'}: ${item.planned} of ${item.quota} knowledge points (${PLAN_SHORT})`),
    ...['outside', 'over-quota', 'duplicate'].flatMap(reason => { const n = dropped.filter(item => item.reason === reason).length; return n ? [`${n} planned target(s) dropped: ${reason}`] : []; })];
  return { targets, dropped, short, lost, reasked };
}
