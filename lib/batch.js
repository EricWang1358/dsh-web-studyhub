import { randomUUID } from "node:crypto";
import { generateDeck, generateCaseDeck, completeJson } from "./generation.js";
import { norm } from "./domain.js";
import { planAssessment } from "./assessment-quality.js";
import { reserveCount } from "./generation-yield.js";
import { scopeExisting } from "./existing-scope.js";
import { cleanDeckTitle } from "./deck-title.js";
import { mergeJevDecided } from "./jev-review.js";
import { citationCheck, quotePages } from "./quote-match.js";
import { summarizePartOutcomes } from "./generation-report.js";
import { normalizeGenerationPerformance } from "./generation-settings.js";
import { SELECTION_CHARS } from "./limits.js";

/* How a big selection is split (the rule, in one place): by page ranges. A group of pages is a run of whole consecutive pages that is
   (a) at most CHUNK_CHARS long, so no model call sees more than it can quote from, and (b) asked for at most MAX_PLAN_TARGETS
   questions, so one planning call has few quotes to ground and one stubborn quote cannot sink many. Each group is planned on its
   own pages; each part (at most 5 questions) of a group is written from the pages its own targets cite and is checked against
   exactly those pages (plus the neighbour a quote runs over into). A page is never cut to satisfy (b); only a page longer than
   CHUNK_CHARS is sliced, and its slices count as one page. */
/** Characters sent to one author call; larger selections are split. */
export const CHUNK_CHARS = 60000;
/** The most questions one planning call (one group of pages) is asked for. */
export const MAX_PLAN_TARGETS = 10;
/** Upper bound for one generation request across all chunks. */
export const MAX_SELECTED_CHARS = SELECTION_CHARS;

/** A call the provider turned away for rate limits: the run slows down and tries it again instead of failing the part. */
const isRateLimit = (error) => /\b429\b|rate.?limit|too many requests|限流/i.test(String(error?.message ?? error));
/** How many times one call is tried again after a 429, and how many calm calls win back one step of the budget. */
const RATE_LIMIT_RETRIES = 4, RECOVER_AFTER = 4;

/** Cut text into pieces of at most `max` characters, preferring paragraph, then line breaks. */
function slices(text, max) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max * 0.5) cut = window.lastIndexOf("\n");
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
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
  return pack(sources.flatMap((source) => slices(source.text, max).map((text) => ({ ...source, text }))), max);
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
  const planned = planGeneration(request), outcomes = new Array(planned.length);
  const plans = new Map(), reserved = [], notes = new Map();
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
      const queued = Date.now();
      await new Promise((resolve, reject) => {
        waitingCalls.push({ resolve, reject });
        drain();
      });
      // How long this call waited for a free slot, kept on its step (generation details: queue vs model call).
      const [system, prompt, context = {}] = args, waitedMs = Date.now() - queued, slot = takeSlot();
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
  // a lowered ceiling only makes the NEXT calls wait. A generation run has no safe boundary to pause at, so there is no pause here.
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
  const groups = [...new Set(planned.map((part) => part.sources))];
  const sameKey = (text) => norm(text).replace(/[\p{P}\p{Z}\s]/gu, "");
  async function planGroups() {
    let next = 0, failure;
    const worker = async () => {
      while (next < groups.length && !failure) {
        const g = next++;
        try { await planGroup(groups[g], g); } catch (error) { failure ||= error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(groups.length, Math.max(1, concurrency - 1)) }, worker));
    if (failure) throw failure;
  }
  async function planGroup(sources, g) {
    request.signal?.throwIfAborted();
    const indices = planned.flatMap((part, k) => part.sources === sources ? [k] : []);
    const stage = `Planning evidence and learning targets · Group ${g + 1}/${groups.length}`;
    progress(stage, { part: null });
    try {
      const kinds = new Set(indices.map((k) => planned[k].kind));
      const asked = indices.reduce((sum, k) => sum + planned[k].count, 0);
      const plan = await planAssessment((system, prompt) => completeJson(
        (sys, text) => limitedComplete(sys, text, { stage, part: null }), system, prompt), {
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
  function snapshot() {
    const cards = [], failures = [], audits = [], omitted = [], answerParts = [], jevSignals = {}, jevDecidedParts = [];
    const suggestions = [];
    let jevThreshold, repairedInRun = 0, repairTried = 0, reserveUsed = 0, fillRoundsUsed = 0, fillRejected = 0;
    const contentKey = (text) => norm(text).replace(/[\p{P}\p{Z}\s]/gu, '');
    let title = "", summary = "", repaired = false;
    for (const [k, outcome] of outcomes.entries()) {
      if (!outcome) continue;
      if (outcome.error) { failures.push(`Part ${k + 1}: ${outcome.error}`); if (!outcome.deck) continue; }
      const { deck } = outcome;
      title ||= deck.title; summary ||= deck.editorial?.summary || "";
      repaired ||= !!deck.editorial?.repaired;
      suggestions.push(...(deck.editorial?.suggestions || []));
      fillRoundsUsed += deck.editorial?.fillRounds || 0; fillRejected += deck.editorial?.fillRejected || 0;
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
    const sourceCoverage = request.sources.map(({ id, title }) => ({
      id, title,
      planned: targets.filter((target) => target.citations.some((ref) => ref.sourceId === id)).length,
      accepted: cards.filter((card) => card.citations.some((ref) => ref.sourceId === id)).length,
    }));
    const reviewedCards = Object.fromEntries(cards.flatMap((card) => {
      const receipt = outcomes.find((outcome) => outcome?.deck?.cards.some((item) => item.id === card.id))
        ?.deck.editorial?.reviewedCards?.[card.id];
      return receipt ? [[card.id, receipt]] : [];
    }));
    return { id: draftId, title: cleanDeckTitle(request.title?.trim() || title) || "新题组", course: request.course ?? '',
      ...(request.mergeTargetId !== undefined ? { mergeTargetId: request.mergeTargetId } : {}),
      ...(request.folder ? { folder: request.folder } : {}), cards,
      editorial: { reviewedAt: new Date().toISOString(), summary, repaired,
        ...(suggestions.length ? { suggestions: suggestions.filter((item) => !item.cardId || cards.some((card) => card.id === item.cardId)).slice(0, 40) } : {}),
        ...(fillRoundsUsed ? { fillRoundsUsed } : {}), ...(fillRejected ? { fillRejected } : {}),
        ...(repairedInRun ? { repairedInRun } : {}), ...(repairTried ? { repairTried } : {}), ...(reserveUsed ? { reserveUsed } : {}),
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
        partReport: summarizePartOutcomes({ planned, outcomes, notes }),
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
  async function replan(part, k, count, avoid, round) {
    try {
      const stage = `Planning evidence and learning targets · Fill round ${round}`;
      const plan = await planAssessment((system, prompt) => completeJson(
        (sys, text) => limitedComplete(sys, text, { stage, part: k + 1 }), system, prompt), {
        ...request, sources: part.sources, count, kind: part.kind, existing: [...library(part.sources), ...reserved, ...avoid],
      }, { salvage: true });
      reserved.push(...plan.targets.map((target) => target.objective));
      // A plan numbers its own targets from 1: renumber so they never meet a first-batch id in the draft's evidence record.
      return plan.targets.map((target) => ({ ...target, targetId: `fill-${++fillTargets}` }));
    } catch (error) { if (request.signal?.aborted) throw error; return []; }
  }
  async function runPart(k) {
    if (outcomes[k] || request.signal?.aborted) return;
    const part = planned[k];
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
    try {
      const ownTargets = new Set(own.map((target) => target.objective));
      const deck = await generateDeck(
        (system, prompt) => limitedComplete(system, prompt, { stage, part: k + 1 }),
        { ...request, ...part, count: own.length, sources, assessmentPlan: plans.get(k), fillRounds: performance.fillRounds,
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
    } catch (error) { outcomes[k] = { ...outcomes[k], pending: false, error: error.message }; }
    save();
    progress(`Completed ${outcomes.filter(Boolean).length}/${planned.length} parts`, { part: k + 1, settled: true, fill: null });
  }
  request.signal?.addEventListener('abort', abortWaiting, { once: true });
  try { await planGroups(); }
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
  if (!result.cards.length) throw new Error(result.editorial.failures.join("; ") || "No questions were generated");
  return result;
}
