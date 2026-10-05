import { partStatusOf, partReasonCodes, failureReason } from './generation-report.js';
import { rangesOf, PART_PLAN_RANGES } from './part-plan.js';
import { sliceRangeOf } from './sections.js';
import { createLocator } from './quote-locate.js';

/* What was planned for each part of a generation, kept on the draft (`editorial.partPlans`) whether the part kept its questions or failed entirely.
   Until now the targets of a part lived only in the run's memory and a failed part took its plan with it, so nothing could say afterwards which
   knowledge points were planned and never came out, or why. Later phases (coverage by section) read this record. Pure; bounded.

   partPlans[] = per part { part, sourceIds, ranges?, targets: [{ targetId, objective, knowledge?, sourceId, quote?, start?, end?, status: 'kept' | 'failed' | 'omitted', reason? }],
                            status: 'pending' | 'passed' | 'partial' | 'failed', reason?, attempts, truncated? }
   `reason` is a code of lib/generation-failure.js (review-protocol, quote, plan, quality, timeout, ...). `attempts` is how many times the part went through
   the pipeline (the first run, then each fill round that ran it again). `ranges` are the offsets the part was cut from ([{ sourceId, start, end }], lib/part-plan.js), `start` / `end`
   the offsets of a target's quote in its source: lib/coverage.js puts a failed target on its section by them (else by the quote, else by the part's range), and a top-up
   plans a failed target again as it was (its verbatim quote is the stored text between the offsets). */

export const PART_PLAN_LIMITS = Object.freeze({ targets: 400, quote: 200, objective: 200, knowledge: 240 });

const clip = (value, size) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > size ? text.slice(0, size - 1) + '…' : text; };

/** The offsets of a quote in the source it cites, found in the pieces the part was cut from (a piece is the stored text between its slice offsets): { start, end } or {}. */
function placeOf(part, citation, locators) {
  if (!citation?.sourceId || !citation.quote) return {};
  for (const piece of Array.isArray(part?.sources) ? part.sources : []) {
    if (piece?.id !== citation.sourceId || typeof piece.text !== 'string') continue;
    if (!locators.has(piece)) locators.set(piece, createLocator(piece.text));
    const found = locators.get(piece)(citation.quote);
    if (found) { const base = sliceRangeOf(piece).start; return { start: base + found.start, end: base + found.end }; }
  }
  return {};
}

/** The targets a part was planned with, in the record's shape; `kept` is the set of target ids that have a question in the part's deck. */
function targetRecords(part, outcome, own, status, partReason, kept, locators) {
  const omitted = new Map((outcome?.deck?.editorial?.omitted || []).map((item) => [clip(item.objective, PART_PLAN_LIMITS.objective), item]));
  const base = (target) => {
    const first = target.citations?.[0], knowledge = clip(target.knowledge, PART_PLAN_LIMITS.knowledge);
    return { targetId: String(target.targetId ?? ''), objective: clip(target.objective, PART_PLAN_LIMITS.objective), ...(knowledge ? { knowledge } : {}),
      ...(first?.sourceId ? { sourceId: first.sourceId } : {}), ...(first?.quote ? { quote: clip(first.quote, PART_PLAN_LIMITS.quote) } : {}), ...placeOf(part, first, locators) };
  };
  const rows = own.map((target) => {
    const record = base(target);
    if (kept.has(target.targetId)) return { ...record, status: 'kept' };
    if (status === 'pending') return { ...record, status: 'omitted', reason: 'pending' };
    if (status === 'failed') return { ...record, status: 'failed', reason: partReason };
    const why = omitted.get(record.objective), codes = why ? [...new Set((why.reasons || []).map(failureReason))].filter((code) => code !== 'other') : [];
    return { ...record, status: 'omitted', reason: codes[0] || partReason };
  });
  // Targets a fill round added to this part (they carry a question, or were dropped like any other).
  const ownIds = new Set(own.map((target) => target.targetId));
  for (const target of outcome?.deck?.editorial?.evidenceWorkflow?.targets || []) {
    if (ownIds.has(target.targetId) || !kept.has(target.targetId)) continue;
    rows.push({ ...base(target), status: 'kept' });
  }
  return rows;
}

/**
 * The record of every part of a run, in order. `planned` are the planned parts ({ sources, count }), `outcomes` what each produced ({ deck?, error?, pending? }),
 * `plans` the run's Map of part index -> { targets } (a part whose planning failed has none), `runs` a Map of part index -> attempts, `notes` the extra reason
 * lines of a part (lib/batch.js). At most PART_PLAN_LIMITS.targets targets are kept in all; a part past the bound is still listed, without targets and with
 * `truncated: true`.
 */
export function buildPartPlans({ planned, outcomes, plans = new Map(), runs = new Map(), notes = new Map() }) {
  let room = PART_PLAN_LIMITS.targets;
  const locators = new Map();
  return planned.map((part, k) => {
    const outcome = outcomes[k], status = partStatusOf(part.count, outcome), own = plans.get(k)?.targets || [];
    const reason = status === 'passed' || status === 'pending' ? undefined : partReasonCodes(outcome, notes.get(k))[0];
    const kept = new Set((outcome?.deck?.cards || []).map((card) => card.targetId).filter(Boolean));
    const all = targetRecords(part, outcome, own, status, reason, kept, locators), targets = all.slice(0, Math.max(0, room));
    room -= targets.length;
    const sourceIds = [...new Set(own.flatMap((target) => (target.citations || []).map((ref) => ref.sourceId)).filter(Boolean))];
    const ranges = rangesOf(Array.isArray(part.sources) ? part.sources : []).slice(0, PART_PLAN_RANGES);
    return { part: k + 1, sourceIds: sourceIds.length ? sourceIds : [...new Set((part.sources || []).map((source) => source.id))], ...(ranges.length ? { ranges } : {}), targets, status,
      ...(reason ? { reason } : {}), attempts: runs.get(k) || (outcome ? 1 : 0), ...(targets.length < all.length ? { truncated: true } : {}) };
  });
}

/** Earlier parts and a continuation's parts as one list: the continuation is numbered after the parts already done, and the whole stays within the bound. */
export function mergePartPlans(before = [], after = [], offset = before.length) {
  const shifted = (after || []).map((entry) => ({ ...entry, part: offset + entry.part }));
  let room = PART_PLAN_LIMITS.targets;
  return [...(before || []), ...shifted].map((entry) => {
    const targets = (entry.targets || []).slice(0, Math.max(0, room));
    room -= targets.length;
    return targets.length < (entry.targets || []).length ? { ...entry, targets, truncated: true } : { ...entry, targets };
  });
}
