import { randomUUID } from "node:crypto";
import { generateDeck, generateCaseDeck, completeJson } from "./generation.js";
import { norm } from "./domain.js";
import { isRateLimit } from "./rate-limit.js";
import { planAssessment } from "./assessment-quality.js";
import { reserveCount } from "./generation-yield.js";
import { scopeExisting } from "./existing-scope.js";
import { cleanDeckTitle, fallbackDeckTitle } from "./deck-title.js";
import { mergeJevDecided } from "./jev-review.js";
import { citationCheck, quotePages } from "./quote-match.js";
import { summarizePartOutcomes } from "./generation-report.js";
import { buildPartPlans } from "./plan-record.js";
import { REVIEW_PROTOCOL, isPermanentFailure } from "./generation-failure.js";
import { normalizeGenerationPerformance } from "./generation-settings.js";
import { SELECTION_CHARS, CALL_CHARS, CALL_TARGETS } from "./limits.js";
import { sliceRangeOf, withSliceRange } from "./sections.js";
import { planAssigned, assignmentGroups, pieceOfAssignment, PLAN_SHORT } from "./assigned-plan.js";

/* How a big selection is split (the rule, in one place): by page ranges. A group of pages is a run of whole consecutive pages that is
   (a) at most CHUNK_CHARS long, so no model call sees more than it can quote from, and (b) asked for at most MAX_PLAN_TARGETS
   questions, so one planning call has few quotes to ground and one stubborn quote cannot sink many. Each group is planned on its
   own pages; each part (at most 5 questions) of a group is written from the pages its own targets cite and is checked against
   exactly those pages (plus the neighbour a quote runs over into). A page is never cut to satisfy (b); only a page longer than
   CHUNK_CHARS is sliced, and its slices count as one page. */
/** Characters sent to one author call; larger selections are split. */
export const CHUNK_CHARS = CALL_CHARS;
/** The most questions one planning call (one group of pages) is asked for. */
export const MAX_PLAN_TARGETS = CALL_TARGETS;
/** Upper bound for one generation request across all chunks (a request without a coverage plan: the whole selection is sent in calls of CHUNK_CHARS). A request planned from assignments
    (lib/assigned-plan.js: a call sees only the sections assigned to it) is bound per CALL instead, and by LARGE_DOCUMENT_LIMITS.coverageSelectionChars in all. */
export const MAX_SELECTED_CHARS = SELECTION_CHARS;

/** How many times one call is tried again after a 429, and how many calm calls win back one step of the budget. */
const RATE_LIMIT_RETRIES = 4, RECOVER_AFTER = 4;

/** Cut text into pieces of at most `max` characters, preferring paragraph, then line breaks. Each piece is { text, start, end }: where it sits in the stored text
 * (`base` is where `text` itself sits in the stored text: a source that is already a piece of one, lib/coverage-round.js). */
function slices(text, max, base = 0) {
  const out = [];
  let rest = text, at = base;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max * 0.5) cut = window.lastIndexOf("\n");
    if (cut < max * 0.5) cut = max;
    out.push({ text: rest.slice(0, cut), start: at, end: at + cut });
    rest = rest.slice(cut);
    at += cut;
  }
  if (rest.trim()) out.push({ text: rest, start: at, end: at + rest.length });
  return out;
}

/** Pack pieces (already no longer than `max`, or kept whole when they are) into runs of at most `max` characters, in order. */
function pack(pieces, max) {
  const chunks = [];
  let current = [],
    size = 0;
  for (const piece of pieces) {
    if (size + piece.text.length > max && current.length) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(piece);
    size += piece.text.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * Pack sources into chunks of at most `max` characters. A long source is
 * sliced but keeps its id: every slice is a substring of the stored text, so
 * verbatim citations from a slice still validate against the full source.
 */
export function chunkSources(sources, max = CHUNK_CHARS) {
  // A slice keeps where it was cut (lib/sections.js sliceRangeOf), so a run can say which part of the source each of its parts covers.
  return pack(sources.flatMap((source) => slices(source.text, max, sliceRangeOf(source).start).map(({ text, start, end }) => withSliceRange({ ...source, text }, start, end))), max);
}

/** The groups of pages for `count` questions: chunks of CHUNK_CHARS, re-cut evenly (never inside a page) until no group is asked for more than MAX_PLAN_TARGETS. */
function pageGroups(sources, count) {
  const base = chunkSources(sources), atoms = base.flat();
  if (count <= MAX_PLAN_TARGETS || atoms.length < 2) return base;
  const total = atoms.reduce((sum, piece) => sum + piece.text.length, 0);
  for (let n = Math.max(base.length, Math.ceil(count / MAX_PLAN_TARGETS)); ; n++) {
    const groups = pack(atoms, Math.ceil(total / n));
    if (n >= atoms.length || Math.max(...shareCount(groups, count)) <= MAX_PLAN_TARGETS) return groups;
  }
}

/** Share `count` across chunks by size (largest remainder); chunks may receive 0. */
export function shareCount(chunks, count) {
  if (!chunks.length) return [];
  const sizes = chunks.map((c) => c.reduce((n, s) => n + s.text.length, 0)),
    total = sizes.reduce((a, b) => a + b, 0) || 1,
    raw = sizes.map((n) => (n / total) * count),
    shares = raw.map(Math.floor);
  const order = raw
    .map((r, i) => [r - Math.floor(r), i])
    .sort((a, b) => b[0] - a[0]);
  for (let k = 0; shares.reduce((a, b) => a + b, 0) < count; k++)
    shares[order[k % order.length][1]]++;
  return shares;
}

/** Keep repair scope small. Mixed requests share one draft and one queue slot. */
export function planGeneration(request) {
  // A case-study paper is one scenario with its questions: one part (WP12).
  if (request.kind === "case") return [{ sources: request.sources, kind: "case", count: request.count }];
  // A top-up for the sections with no question (lib/coverage-round.js) also brings planned targets that failed: each group is a part of its own that is written again from
  // those targets as they were (`preplan`), never planned again. They come after the parts that are planned from the text.
  const again = (Array.isArray(request.reuse) ? request.reuse : []).filter((group) => group?.targets?.length).map((group, index) => ({
    sources: group.sources, kind: request.kind === "mixed" ? (index % 2 ? "flashcard" : "quiz") : request.kind || "quiz", count: group.targets.length, preplan: group.targets }));
  return [...planFresh(request), ...again];
}

/** The kinds of the questions of a call that is asked for `total` questions: one kind, or a mixed run's quiz questions and flashcards in turn (half each, the odd one a quiz). */
const kindShares = (kind, total) => (kind === "mixed" ? [["quiz", Math.ceil(total / 2)], ["flashcard", Math.floor(total / 2)]] : [[kind || "quiz", total]]);

/** The calls of an assignment run: [{ assignments, chars, questions, sources }], `sources` being the pieces of the sources that hold the assigned ranges (each remembers where it was cut). */
export function assignedGroupsOf(request) {
  return assignmentGroups(request.assignments, { chunkChars: CHUNK_CHARS, maxTargets: MAX_PLAN_TARGETS })
    .map((group) => ({ ...group, sources: group.assignments.flatMap((item) => pieceOfAssignment(item, request.sources)) }));
}

/** The parts of an assignment run as they are known before anything is planned (the estimate and the job card read them): each call's questions in parts of at most batchSize. */
function planAssignedParts(request) {
  const { batchSize } = normalizeGenerationPerformance(request.performance);
  return assignedGroupsOf(request).flatMap((group) => kindShares(request.kind, group.questions).flatMap(([kind, total]) => {
    const parts = [];
    for (let left = total; left > 0; left -= batchSize) parts.push({ sources: group.sources, kind, count: Math.min(left, batchSize), assignments: group.assignments });
    return parts;
  }));
}

function planFresh(request) {
  if (Array.isArray(request.assignments) && request.assignments.length) return planAssignedParts(request);
  if (!(request.count > 0) && !request.sources?.length) return [];
  const chunks = pageGroups(request.sources, request.count);
  const { batchSize } = normalizeGenerationPerformance(request.performance);
  if (request.kindCounts && (request.kind !== "mixed" ||
      !Number.isInteger(request.kindCounts.quiz) || request.kindCounts.quiz < 0 ||
      !Number.isInteger(request.kindCounts.flashcard) || request.kindCounts.flashcard < 0 ||
      request.kindCounts.quiz + request.kindCounts.flashcard !== request.count))
    throw new Error("Invalid mixed question counts");
  const kinds = request.kind === "mixed"
    ? request.kindCounts
      ? [["quiz", request.kindCounts.quiz], ["flashcard", request.kindCounts.flashcard]]
      : [["quiz", Math.ceil(request.count / 2)], ["flashcard", Math.floor(request.count / 2)]]
    : [[request.kind || "quiz", request.count]];
  return kinds.flatMap(([kind, total]) => {
    const shares = shareCount(chunks, total);
    return chunks.flatMap((sources, i) => {
      const parts = [];
      for (let left = shares[i]; left > 0; left -= batchSize)
        parts.push({ sources, kind, count: Math.min(left, batchSize) });
      return parts;
    });
  });
}

/**
 * Generate one draft from any amount of selected material by running the
 * normal author/editor pipeline per chunk. Chunks that fail are reported, and
 * the draft keeps every card that passed; only a total failure throws.
 */
export async function generateBatched(complete, request, progress = () => {}, checkpoint = async () => {}) {
  if (request.kind === "case") return generateCaseDeck((system, prompt, context = {}) => complete(system, prompt, { ...context, part: 1 }),
    request, (stage) => progress(stage, { part: 1 }), checkpoint);
  // An assignment run (lib/assigned-plan.js) makes its parts when each call's plan has been checked by the program: here are only the parts that bring their own targets.
  const assigned = Array.isArray(request.assignments) && request.assignments.length > 0;
  const planned = planGeneration(request).filter((part) => !part.assignments), outcomes = new Array(planned.length);
  const assignedGroups = assigned ? assignedGroupsOf(request) : [];
  // The targets to write again are in the parts now: no prompt carries them a second time.
  request = { ...request, reuse: undefined };
  const plans = new Map(), reserved = [], notes = new Map();
  // Parts that bring their own targets (a top-up writing failed targets again) are not planned: they start with their plan.
  const preplanned = planned.flatMap((part, k) => (part.preplan ? [k] : []));
  for (const k of preplanned) { plans.set(k, { targets: structuredClone(planned[k].preplan) }); reserved.push(...planned[k].preplan.map((target) => target.objective)); }
  // How often each part went through the pipeline (the first run, then each fill round that ran it again), the review calls a part has spent over all of
  // them, and the authored candidates a part keeps when only its review failed (lib/generation.js `error.authored`): the fill rounds review them again.
  const tries = new Map(), reviewCalls = new Map(), retained = new Map();
  // Verified targets planned beyond what the parts of a group were asked for (lib/generation-yield.js reserveCount), per group of pages.
  // A part that ends short claims from its group's pool; claiming is a synchronous splice, so parts running in parallel never share a target.
  const pools = new Map();
  const performance = normalizeGenerationPerformance(request.performance);
  // `request.control` (lib/job-control.js) is the learner's live hand on a running job: concurrency and pause are read at the moment a call is admitted.
  let { concurrency } = performance;
  if (Number.isInteger(request.control?.values.concurrency)) concurrency = request.control.values.concurrency;
  // Planning and all dependent model stages share one budget. Waiting calls
  // leave the FIFO on cancellation before they can reach the model. The budget is the configured concurrency until the provider answers 429:
  // then it is halved (never below 1) and the call is tried again after a back-off, and it climbs back one step at a time while calls succeed.
  let activeCalls = 0, budget = concurrency, calm = 0;
  const waitingCalls = [], readyParts = [], runningParts = new Set();
  let partError;
  const abortWaiting = () => {
    for (const next of waitingCalls.splice(0)) next.reject(request.signal.reason);
  };
  const drain = () => {
    while (activeCalls < budget && waitingCalls.length) {
      const next = waitingCalls.shift();
      if (request.signal?.aborted) { next.reject(request.signal.reason); continue; }
      activeCalls++;
      next.resolve();
    }
  };
  const throttle = (reason) => request.onThrottle?.({ reason, concurrency: budget, configured: concurrency });
  // The lane of a running call: the lowest free slot, counting from 1. A call keeps it across its retries, and the 任务 console draws it there.
  const slots = new Set(), takeSlot = () => { let slot = 1; while (slots.has(slot)) slot++; slots.add(slot); return slot; };
  let waits = 0;
  /** Wait `ms`, leaving at once (with the stop reason) when the run is cancelled. */
  const pause = (ms) => new Promise((resolve, reject) => {
    if (request.signal?.aborted) return reject(request.signal.reason);
    const timer = setTimeout(() => { request.signal?.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(request.signal.reason); };
    request.signal?.addEventListener("abort", stop, { once: true });
  });
  const limitedComplete = async (...args) => {
    for (let attempt = 0; ; attempt++) {
      request.signal?.throwIfAborted();
      // A paused run (a coverage run; lib/job-control.js) starts no new call: the calls that are running finish, and this one waits here until the learner goes on (a cancel ends the wait with the stop reason).
      await request.control?.waitIfPaused?.(request.signal);
      const queued = Date.now();
      await new Promise((resolve, reject) => {
        waitingCalls.push({ resolve, reject });
        drain();
      });
      // How long this call waited for a free slot, kept on its step (generation details: queue vs model call).
      const [system, prompt, context = {}] = args, waitedMs = Date.now() - queued;
      // A call that queued before the pause was asked and is admitted now still does not start: it keeps its place in the budget and waits (the pause time is not queue time).
      try { await request.control?.waitIfPaused?.(request.signal); } catch (error) { activeCalls--; drain(); throw error; }
      const slot = takeSlot();
      let waitFor = null;
      try {
        request.signal?.throwIfAborted();
        const value = await complete(system, prompt, { ...context, waitedMs, slot });
        if (++calm >= RECOVER_AFTER && budget < concurrency) { budget++; calm = 0; throttle("recovered"); }
        return value;
      } catch (error) {
        if (!isRateLimit(error) || attempt >= RATE_LIMIT_RETRIES || request.signal?.aborted) throw error;
        calm = 0;
        if (budget > 1) budget = Math.max(1, Math.floor(budget / 2));
        throttle("rate-limit");
        waitFor = { id: `wait-${++waits}`, slot, reason: "rate-limit", ms: (request.rateLimitBackoffMs ?? 2000) * 2 ** attempt, attempt };
      } finally { slots.delete(slot); activeCalls--; drain(); }
      request.onWait?.({ phase: "start", ...waitFor });
      try { await pause(waitFor.ms); } finally { request.onWait?.({ phase: "end", ...waitFor }); }
    }
  };
  const startParts = () => {
    while (runningParts.size < concurrency && readyParts.length && !request.signal?.aborted) {
      const task = runPart(readyParts.shift()).catch(error => { partError ||= error; }).finally(() => {
        runningParts.delete(task);
        startParts();
      });
      runningParts.add(task);
    }
  };
  // A change from the console: the new ceiling is the budget again unless a 429 had lowered it (it then climbs to the new ceiling, never above it). Calls already running are left alone;
  // a lowered ceiling only makes the NEXT calls wait. Pause is read where a call is admitted (limitedComplete), not here: a plain run has no `paused` in its control, so it never waits.
  request.control?.on((changed) => {
    if (changed.concurrency !== undefined) {
      const was = concurrency;
      concurrency = changed.concurrency;
      budget = budget === was ? concurrency : Math.min(budget, concurrency);
      drain();
      startParts();
    }
  });
  const draftId = randomUUID();
  // What the library already holds is narrowed to what these materials could repeat (lib/existing-scope.js);
  // `reserved` is only what this run has planned, which every later call must not repeat.
  const libraryScope = new Map();
  const library = (sources) => {
    if (!libraryScope.has(sources))
      libraryScope.set(sources, scopeExisting(request.existing, sources, { pinned: request.pinnedExisting }));
    return libraryScope.get(sources);
  };
  // Plan once per bounded source chunk across all of its batches and kinds. The groups hold different pages, so up to `concurrency - 1` of them
  // are planned at the same time (one slot always stays free for the dependent stages of a group that is already planned): the slowest planning no
  // longer delays every group after it, and a group's dependent stages start the moment its own quotes pass. With a budget of 1 or 2 the planning
  // is serial, as it always was, and each plan sees every earlier reservation. Plans made at the same time are told apart when they are applied.
  const groups = [...new Set(planned.filter((part) => !part.preplan).map((part) => part.sources))], groupCount = groups.length + assignedGroups.length;
  const sameKey = (text) => norm(text).replace(/[\p{P}\p{Z}\s]/gu, "");
  async function planGroups() {
    let next = 0, failure;
    const worker = async () => {
      while (next < groupCount && !failure) {
        const g = next++;
        try { await (g < groups.length ? planGroup(groups[g], g) : planAssignedGroup(assignedGroups[g - groups.length], g)); } catch (error) { failure ||= error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(groupCount, Math.max(1, concurrency - 1)) }, worker));
    if (failure) throw failure;
  }
  async function planGroup(sources, g) {
    request.signal?.throwIfAborted();
    const indices = planned.flatMap((part, k) => part.sources === sources ? [k] : []);
    for (const k of indices) tries.set(k, 1);
    const stage = `Planning evidence and learning targets · Group ${g + 1}/${groupCount}`;
    progress(stage, { part: null });
    try {
      const kinds = new Set(indices.map((k) => planned[k].kind));
      const asked = indices.reduce((sum, k) => sum + planned[k].count, 0);
      const plan = await planAssessment((system, prompt) => completeJson(
        (sys, text) => limitedComplete(sys, text, { stage, part: null, group: g + 1 }), system, prompt), {
        ...request, sources, count: asked + reserveCount(asked),
        kind: kinds.size === 1 ? planned[indices[0]].kind : "mixed", existing: [...library(sources), ...reserved],
      }, { salvage: true });
      // Groups planned at the same time may have picked the same knowledge point: the earlier applied plan keeps it.
      const taken = new Set(reserved.map(sameKey));
      const repeated = plan.targets.filter((target) => taken.has(sameKey(target.objective)));
      if (repeated.length) plan.targets = plan.targets.filter((target) => !repeated.includes(target));
      // Targets whose quotes could not be grounded were dropped by the plan (salvage); the verified ones go to the parts in order,
      // and a part that gets fewer than it was planned for says why (`notes`) instead of silently writing fewer.
      let offset = 0;
      const lost = [...(plan.dropped || []).flatMap((item) => item.issues), ...repeated.map(() => "duplicate learning target planned by another group of pages")];
      for (const k of indices) {
        const targets = plan.targets.slice(offset, offset + planned[k].count);
        offset += targets.length;
        if (targets.length < planned[k].count && lost.length) notes.set(k, lost);
        if (targets.length) plans.set(k, { targets });
        else outcomes[k] = { error: `Assessment plan is not usable: ${lost.slice(0, 3).join("; ")}` };
      }
      // Reserve objectives stay in `reserved`: no other group may plan the same knowledge point.
      reserved.push(...plan.targets.map((target) => target.objective));
      pools.set(sources, plan.targets.slice(offset));
      readyParts.push(...indices.filter(k => plans.has(k)));
      startParts();
    } catch (error) {
      for (const k of indices) outcomes[k] = { error: error.message };
    }
  }
  /**
   * A call of an assignment run: the planner is given the sections assigned to it and the program checks what comes back (lib/assigned-plan.js: where every quote stands, at most the quota per
   * section, a section short of its quota asked again once). The parts are made from the verified targets, in reading order; what is still missing becomes ONE failed part whose range is exactly
   * the sections concerned, with the code plan-short, so it is a planned-failed section in the coverage view and a line in the failures: never silently dropped.
   */
  async function planAssignedGroup(group, g) {
    request.signal?.throwIfAborted();
    const stage = `Planning evidence and learning targets · Group ${g + 1}/${groupCount}`;
    progress(stage, { part: null });
    const base = request.kind || "quiz", mixed = base === "mixed";
    const addPart = (part, outcome) => {
      const k = planned.push(part) - 1;
      tries.set(k, 1);
      if (outcome) outcomes[k] = outcome;
      return k;
    };
    try {
      const result = await planAssigned((system, prompt) => completeJson(
        (sys, text) => limitedComplete(sys, text, { stage, part: null, group: g + 1 }), system, prompt), {
        ...request, sources: group.sources, count: group.questions, kind: base, existing: [...library(group.sources), ...reserved],
      }, { assignments: group.assignments });
      reserved.push(...result.targets.map((target) => target.objective));
      // A mixed run gives its quiz questions and flashcards in turn along the reading order, so both kinds are spread over the sections.
      const lists = mixed ? [["quiz", result.targets.filter((_, at) => at % 2 === 0)], ["flashcard", result.targets.filter((_, at) => at % 2 === 1)]] : [[base, result.targets]];
      for (const [kind, list] of lists) for (let at = 0; at < list.length; at += performance.batchSize) {
        const chunk = list.slice(at, at + performance.batchSize), keys = new Set(chunk.map((target) => target.assignment));
        const k = addPart({ sources: group.sources, kind, count: chunk.length, assignments: group.assignments.filter((item) => keys.has(item.key)) });
        plans.set(k, { targets: chunk });
        readyParts.push(k);
      }
      pools.set(group.sources, []);
      if (result.short.length) {
        const asked = result.short.reduce((sum, item) => sum + item.quota, 0), got = result.short.reduce((sum, item) => sum + item.planned, 0);
        const k = addPart({ sources: result.short.flatMap((item) => pieceOfAssignment(item, request.sources)), kind: mixed ? "quiz" : base, count: result.short.reduce((sum, item) => sum + item.missing, 0), short: result.short },
          { error: `The plan came back short (${PLAN_SHORT}): ${got} of ${asked} knowledge points for ${result.short.length} section(s) the plan could not fill after asking again`, final: true });
        notes.set(k, result.short.map((item) => `${item.title ? `"${item.title}"` : item.key}: ${item.planned} of ${item.quota} knowledge points${item.error ? ` (${item.error})` : ""}`));
      }
      startParts();
    } catch (error) {
      // The whole call failed (a refused key, a stop, a plan that could not be read): one failed part for it, which a fill round plans again unless the failure is final.
      addPart({ sources: group.sources, kind: mixed ? "quiz" : base, count: group.questions, assignments: group.assignments },
        { error: error.message, ...(request.signal?.aborted || isPermanentFailure(error) ? { final: true } : {}) });
    }
  }
  function snapshot() {
    const cards = [], failures = [], audits = [], omitted = [], answerParts = [], jevSignals = {}, jevDecidedParts = [];
    const suggestions = [];
    let jevThreshold, repairedInRun = 0, repairTried = 0, reserveUsed = 0, fillRoundsUsed = 0, fillRejected = 0, reviewReasks = 0;
    const contentKey = (text) => norm(text).replace(/[\p{P}\p{Z}\s]/gu, '');
    let title = "", summary = "", repaired = false;
    for (const [k, outcome] of outcomes.entries()) {
      if (!outcome) continue;
      if (outcome.error) { failures.push(`Part ${k + 1}: ${outcome.error}`); if (!outcome.deck) continue; }
      const { deck } = outcome;
      title ||= deck.title; summary ||= deck.editorial?.summary || "";
      repaired ||= !!deck.editorial?.repaired;
      suggestions.push(...(deck.editorial?.suggestions || []));
      fillRoundsUsed += deck.editorial?.fillRounds || 0; fillRejected += deck.editorial?.fillRejected || 0; reviewReasks += deck.editorial?.reviewReasks || 0;
      repairedInRun += deck.editorial?.repairedInRun || 0; repairTried += deck.editorial?.repairTried || 0; reserveUsed += deck.editorial?.reserveUsed || 0;
      for (const item of deck.editorial?.omitted || []) omitted.push({ part: k + 1, ...item });
      // EXPERIMENTAL Jev pre-check signals (lib/jev-triage.js) of every part, kept for the cards that survive below.
      if (deck.editorial?.jev?.signals) { Object.assign(jevSignals, deck.editorial.jev.signals); jevThreshold ??= deck.editorial.jev.threshold; }
      // EXPERIMENTAL: who decided the review of this part's cards (lib/jev-review.js); merged into one record for the run below.
      if (deck.editorial?.jevDecided) jevDecidedParts.push(deck.editorial.jevDecided);
      if (deck.editorial?.audit) audits.push({ part: k + 1, ...deck.editorial.audit,
        reviewRounds: deck.editorial.reviewRounds, candidateReviewSummary: deck.editorial.candidateReviewSummary,
        omittedIssues: deck.editorial.omittedIssues || [] });
      if (deck.editorial?.evidenceWorkflow) answerParts.push({ part: k + 1, ...deck.editorial.evidenceWorkflow });
      if (!outcome.pending && deck.cards.length < planned[k].count) {
        const why = [...(deck.editorial?.omittedIssues || []), ...(notes.get(k) || [])];
        failures.push(`Part ${k + 1}: retained ${deck.cards.length}/${planned[k].count} reviewed questions; omitted or missing candidates` +
          (why.length ? `: ${why.join('; ')}` : ''));
      }
      for (const card of deck.cards) {
        if (cards.some((c) => contentKey(c.objective) === contentKey(card.objective) || contentKey(c.prompt) === contentKey(card.prompt)))
          failures.push(`Part ${k + 1}: duplicate learning target omitted`);
        else cards.push(card);
      }
    }
    const targets = [...plans.values()].flatMap((plan) => plan.targets);
    const sourceCoverage = [...new Map(request.sources.map(({ id, title }) => [id, { id, title }])).values()].map(({ id, title }) => ({
      id, title,
      planned: targets.filter((target) => target.citations.some((ref) => ref.sourceId === id)).length,
      accepted: cards.filter((card) => card.citations.some((ref) => ref.sourceId === id)).length,
    }));
    const reviewedCards = Object.fromEntries(cards.flatMap((card) => {
      const receipt = outcomes.find((outcome) => outcome?.deck?.cards.some((item) => item.id === card.id))
        ?.deck.editorial?.reviewedCards?.[card.id];
      return receipt ? [[card.id, receipt]] : [];
    }));
    // The name is the request's, else the first real title a part wrote (a recovered fragment writes none), else the material's own name; never a placeholder.
    return { id: draftId, title: cleanDeckTitle(request.title?.trim() || title) || fallbackDeckTitle(request.sources, request.language), course: request.course ?? '',
      ...(request.mergeTargetId !== undefined ? { mergeTargetId: request.mergeTargetId } : {}),
      ...(request.folder ? { folder: request.folder } : {}), cards,
      editorial: { reviewedAt: new Date().toISOString(), summary, repaired,
        ...(suggestions.length ? { suggestions: suggestions.filter((item) => !item.cardId || cards.some((card) => card.id === item.cardId)).slice(0, 40) } : {}),
        ...(fillRoundsUsed ? { fillRoundsUsed } : {}), ...(fillRejected ? { fillRejected } : {}),
        ...(repairedInRun ? { repairedInRun } : {}), ...(repairTried ? { repairTried } : {}), ...(reserveUsed ? { reserveUsed } : {}),
        ...(request.coverageSpec ? { coverageSpec: request.coverageSpec } : {}),
        parts: planned.length, requested: request.count, generated: cards.length,
        completedParts: outcomes.filter((outcome) => outcome && !outcome.pending).length,
        generation: {
          sourceIds: [...new Set(request.sources.map((source) => source.id))],
          referenceSourceIds: request.referenceSourceIds || [],
          referenceLimits: request.referenceLimits,
          referenceFormat: request.referenceFormat,
          course: request.course ?? '',
          ...(request.mergeTargetId !== undefined ? { mergeTargetId: request.mergeTargetId } : {}),
          kind: request.kind || "quiz",
          ...(request.coverageLevel ? { coverageLevel: request.coverageLevel } : {}),
          performance,
          language: request.language,
          difficulty: request.difficulty,
          focus: request.focus,
          constraints: request.constraints,
          role: request.role,
        },
        coverage: { selected: request.sources.length,
          cited: new Set(cards.flatMap((c) => c.citations.map((r) => r.sourceId))).size,
          sources: sourceCoverage,
          uncited: request.sources.filter((s) => !cards.some((c) => c.citations.some((r) => r.sourceId === s.id)))
            .map((s) => ({ id: s.id, title: s.title })) },
        failures, audits, reviewedCards, ...(omitted.length ? { omitted } : {}),
        evidenceWorkflow: { version: 1, parts: answerParts },
        // How many parts passed, kept only some questions or failed, and why (lib/generation-report.js): the job card, the draft and the agent read this.
        partReport: summarizePartOutcomes({ planned, outcomes, notes, attempts: tries }),
        // What was planned for every part, the failed ones too, and what became of each target (lib/plan-record.js): the coverage view reads it.
        partPlans: buildPartPlans({ planned, outcomes, plans, runs: tries, notes }),
        ...(reviewReasks ? { reviewReasks } : {}),
        ...(jevDecidedParts.length ? { jevDecided: mergeJevDecided(jevDecidedParts, id => cards.some(card => card.id === id)) } : {}),
        ...(Object.keys(jevSignals).some(id => cards.some(card => card.id === id)) ? { jev: { version: 1, threshold: jevThreshold,
          signals: Object.fromEntries(Object.entries(jevSignals).filter(([id]) => cards.some(card => card.id === id))) } } : {}),
        notice: "Model review is not proof of factual correctness. Inspect sources before publishing." } };
  }
  let saves = Promise.resolve(), saveError;
  const save = () => {
    const deck = snapshot();
    if (deck.cards.length) saves = saves.then(() => checkpoint(deck)).catch((error) => { saveError ||= error; });
  };
  /** New verified targets for the gap of a part (fill round 2 and later): one plan call over the group's pages, told what exists and what was rejected. */
  let fillTargets = 0;
  /** How `count` missing questions of an assignment part are shared by its sections: the sections whose planned targets were rejected (`avoid`) first, then in turn along the part. */
  function missingQuotas(part, k, count, avoid) {
    const rejected = new Set(avoid.map(norm)), lost = new Map();
    for (const target of plans.get(k)?.targets || []) if (rejected.has(norm(target.objective))) lost.set(target.assignment, (lost.get(target.assignment) || 0) + 1);
    const quotas = new Map(part.assignments.map((item) => [item.key, 0]));
    let left = count;
    for (const item of part.assignments) { const n = Math.min(lost.get(item.key) || 0, item.quota, left); quotas.set(item.key, n); left -= n; }
    for (let turn = 0; left > 0 && turn < count * part.assignments.length; turn++) {
      const item = part.assignments[turn % part.assignments.length];
      if (quotas.get(item.key) < item.quota) { quotas.set(item.key, quotas.get(item.key) + 1); left -= 1; }
    }
    return part.assignments.map((item) => ({ ...item, quota: quotas.get(item.key) })).filter((item) => item.quota > 0);
  }
  async function replan(part, k, count, avoid, round) {
    try {
      const stage = `Planning evidence and learning targets · Fill round ${round}`;
      if (part.assignments?.length) {
        // A part of an assignment run is planned again the same way: its own sections, the missing questions shared over them, checked by the program.
        const list = missingQuotas(part, k, count, avoid);
        const result = await planAssigned((system, prompt) => completeJson(
          (sys, text) => limitedComplete(sys, text, { stage, part: k + 1, attempt: tries.get(k), fill: round }), system, prompt), {
          ...request, sources: part.sources, count: list.reduce((sum, item) => sum + item.quota, 0), kind: part.kind, existing: [...library(part.sources), ...reserved, ...avoid],
        }, { assignments: list });
        reserved.push(...result.targets.map((target) => target.objective));
        return result.targets.map((target) => ({ ...target, targetId: `fill-${++fillTargets}` }));
      }
      const plan = await planAssessment((system, prompt) => completeJson(
        (sys, text) => limitedComplete(sys, text, { stage, part: k + 1, attempt: tries.get(k), fill: round }), system, prompt), {
        ...request, sources: part.sources, count, kind: part.kind, existing: [...library(part.sources), ...reserved, ...avoid],
      }, { salvage: true });
      reserved.push(...plan.targets.map((target) => target.objective));
      // A plan numbers its own targets from 1: renumber so they never meet a first-batch id in the draft's evidence record.
      return plan.targets.map((target) => ({ ...target, targetId: `fill-${++fillTargets}` }));
    } catch (error) { if (request.signal?.aborted) throw error; return []; }
  }
  async function runPart(k) {
    if (outcomes[k] || request.signal?.aborted) return;
    const part = planned[k], { preplan: _preplan, ...partRequest } = part;
    if (!plans.has(k)) return;
    // Planning saw the whole group. This part is written from, and checked against, only the pages its own targets cite, plus the
    // neighbouring page when a quote runs over a page boundary: never unrelated pages assigned to other workers.
    const pages = quotePages(part.sources), own = plans.get(k).targets;
    const sourcesFor = (targets) => {
      const ids = new Set(targets.flatMap((target) => target.citations.map((citation) => citation.sourceId)));
      for (const target of targets) for (const citation of target.citations) { const check = citationCheck(pages, citation); if (check.neighbour) ids.add(check.neighbour); }
      return part.sources.filter((source) => ids.has(source.id));
    };
    const sources = sourcesFor(own);
    let stage = "Writing source-grounded questions";
    // A part whose only failure was the review is not written again: its authored candidates go back to the review.
    const resume = retained.get(k);
    try {
      const ownTargets = new Set(own.map((target) => target.objective));
      const deck = await generateDeck(
        // The context of a call (a review re-ask says so: `kind: 'review', retry`) goes to the console with the part and the stage.
        (system, prompt, context = {}) => limitedComplete(system, prompt, { stage, part: k + 1, attempt: tries.get(k), ...context }),
        { ...request, ...partRequest, count: own.length, sources, assessmentPlan: plans.get(k), fillRounds: performance.fillRounds,
          // Read when the review is done, so the 即时控制 box takes effect for the parts that have not reached that point yet.
          applySuggestions: () => (typeof request.control?.values.applySuggestions === "boolean" ? request.control.values.applySuggestions : performance.applySuggestions === true),
          // The deck is named from the request, the parts' own titles or the materials (snapshot): a part that wrote no title leaves it empty.
          deferTitle: true, ...(resume ? { resumeAuthored: resume } : {}),
          existing: [...library(part.sources), ...reserved.filter((target) => !ownTargets.has(target))], allowPartial: true,
          claimReserve: async (n, { round = 1, avoid = [] } = {}) => {
            const want = Math.max(0, n | 0), targets = (pools.get(part.sources) || []).splice(0, want);
            // Round 1 is the verified reserve; from round 2 the missing targets are planned anew from the group's pages, avoiding every rejected objective.
            if (targets.length < want && round >= 2) targets.push(...await replan(part, k, want - targets.length, avoid, round));
            return { targets, sources: sourcesFor(targets) };
          } },
        (next, extra) => { stage = `Part ${k + 1}/${planned.length} · ${next}`; progress(stage, { part: k + 1, ...extra }); },
        async (deck) => { outcomes[k] = { deck, pending: true }; save(); await saves; if (saveError) throw saveError; });
      outcomes[k] = { deck };
      retained.delete(k);
    } catch (error) {
      // The failure stays on record with its true reason. A review that stayed unreadable keeps the authored candidates, and the calls it spent add up over the
      // fill rounds ("after 9 attempts"); a stop or a refused key is final, nothing runs it again.
      let message = error.message;
      if (error?.code === REVIEW_PROTOCOL) {
        const total = (reviewCalls.get(k) || 0) + (error.attempts || 0);
        reviewCalls.set(k, total);
        message = message.replace(/after \d+ attempts?/, `after ${total} attempts`);
        if (error.authored) retained.set(k, error.authored);
      }
      outcomes[k] = { ...outcomes[k], pending: false, error: message, ...(request.signal?.aborted || isPermanentFailure(error) ? { final: true } : {}) };
    }
    save();
    progress(`Completed ${outcomes.filter(Boolean).length}/${planned.length} parts`, { part: k + 1, settled: true, fill: null });
  }
  /**
   * The fill rounds of the parts that failed (at most `fillRounds` rounds, and only for parts that kept no question). A part whose review failed is reviewed again from its
   * retained candidates (cheap: one review); a part that had no usable output is written again from its plan, and one whose planning failed is planned by itself first.
   * A stop, a spent time budget or a refused key ends it; after the rounds the part stays failed with its last true reason.
   */
  async function retryFailedParts() {
    const failed = () => planned.flatMap((part, k) => { const outcome = outcomes[k]; return outcome?.error && !outcome.pending && !outcome.final && !outcome.deck?.cards?.length ? [k] : []; });
    for (let round = 1; round <= performance.fillRounds && !request.signal?.aborted; round++) {
      // The parts of the first pass finish first: only then is it known which of them failed.
      while (runningParts.size) await Promise.all([...runningParts]);
      await saves;
      const todo = failed();
      if (!todo.length) return;
      progress(`Retrying ${todo.length} failed part(s) · fill round ${round}`, { part: null });
      const before = new Map(todo.map((k) => [k, outcomes[k]]));
      for (const k of todo) { tries.set(k, (tries.get(k) || 1) + 1); outcomes[k] = undefined; }
      await Promise.all(todo.filter((k) => !plans.has(k)).map(async (k) => {
        const targets = await replan(planned[k], k, planned[k].count, [], round);
        if (targets.length) plans.set(k, { targets });
      }));
      for (const k of todo) { if (plans.has(k)) readyParts.push(k); else outcomes[k] = before.get(k); }
      startParts();
      while (runningParts.size) await Promise.all([...runningParts]);
      await saves;
    }
  }
  request.signal?.addEventListener('abort', abortWaiting, { once: true });
  try {
    for (const k of preplanned) tries.set(k, 1);
    readyParts.push(...preplanned); startParts();
    await planGroups(); await retryFailedParts();
  }
  finally {
    try {
      while (runningParts.size) await Promise.all([...runningParts]);
      await saves;
    }
    finally { request.signal?.removeEventListener('abort', abortWaiting); }
  }
  request.signal?.throwIfAborted();
  if (partError) throw partError;
  if (saveError) throw new Error(`Could not save generation progress: ${saveError.message}`);
  const result = snapshot();
  // A run that kept nothing still knows what it planned and why each part failed: `result` rides on the error so a coverage run can record it (the sections it asked for are planned-and-failed, not unknown).
  if (!result.cards.length) throw Object.assign(new Error(result.editorial.failures.join("; ") || "No questions were generated"), { result });
  return result;
}
