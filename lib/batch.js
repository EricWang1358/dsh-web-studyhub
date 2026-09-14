import { randomUUID } from "node:crypto";
import { generateDeck, completeJson } from "./generation.js";
import { norm } from "./domain.js";
import { planAssessment } from "./assessment-quality.js";

/** Characters sent to one author call; larger selections are split. */
export const CHUNK_CHARS = 60000;
/** Upper bound for one generation request across all chunks. */
export const MAX_SELECTED_CHARS = 600000;

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

/**
 * Pack sources into chunks of at most `max` characters. A long source is
 * sliced but keeps its id: every slice is a substring of the stored text, so
 * verbatim citations from a slice still validate against the full source.
 */
export function chunkSources(sources, max = CHUNK_CHARS) {
  const chunks = [];
  let current = [],
    size = 0;
  for (const source of sources)
    for (const text of slices(source.text, max)) {
      if (size + text.length > max && current.length) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push({ ...source, text });
      size += text.length;
    }
  if (current.length) chunks.push(current);
  return chunks;
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
  const chunks = chunkSources(request.sources);
  const kinds = request.kind === "mixed"
    ? [["quiz", Math.ceil(request.count / 2)], ["flashcard", Math.floor(request.count / 2)]]
    : [[request.kind || "quiz", request.count]];
  return kinds.flatMap(([kind, total]) => {
    const shares = shareCount(chunks, total);
    return chunks.flatMap((sources, i) => {
      const parts = [];
      for (let left = shares[i]; left > 0; left -= 5)
        parts.push({ sources, kind, count: Math.min(left, 5) });
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
  const planned = planGeneration(request), outcomes = new Array(planned.length);
  const plans = new Map(), reserved = [...(request.existing || [])];
  const draftId = randomUUID();
  // Plan once per bounded source chunk across all of its batches and kinds.
  // Reserve targets before any author starts so concurrent writers share scope.
  const groups = [...new Set(planned.map((part) => part.sources))];
  for (const [g, sources] of groups.entries()) {
    request.signal?.throwIfAborted();
    const indices = planned.flatMap((part, k) => part.sources === sources ? [k] : []);
    const stage = `Planning evidence and learning targets · Group ${g + 1}/${groups.length}`;
    progress(stage, { part: null });
    try {
      const kinds = new Set(indices.map((k) => planned[k].kind));
      const plan = await planAssessment((system, prompt) => completeJson(
        (sys, text) => complete(sys, text, { stage, part: null }), system, prompt), {
        ...request, sources, count: indices.reduce((sum, k) => sum + planned[k].count, 0),
        kind: kinds.size === 1 ? planned[indices[0]].kind : "mixed", existing: reserved,
      });
      let offset = 0;
      for (const k of indices) {
        plans.set(k, { targets: plan.targets.slice(offset, offset + planned[k].count) });
        offset += planned[k].count;
      }
      reserved.push(...plan.targets.map((target) => target.objective));
    } catch (error) {
      for (const k of indices) outcomes[k] = { error: error.message };
    }
  }
  function snapshot() {
    const cards = [], failures = [], audits = [];
    let title = "", summary = "", repaired = false;
    for (const [k, outcome] of outcomes.entries()) {
      if (!outcome) continue;
      if (outcome.error) { failures.push(`Part ${k + 1}: ${outcome.error}`); continue; }
      const { deck } = outcome;
      title ||= deck.title; summary ||= deck.editorial?.summary || "";
      repaired ||= !!deck.editorial?.repaired;
      if (deck.editorial?.audit) audits.push({ part: k + 1, ...deck.editorial.audit });
      if (deck.cards.length < planned[k].count)
        failures.push(`Part ${k + 1}: retained ${deck.cards.length}/${planned[k].count} reviewed questions; rejected invalid candidates`);
      for (const card of deck.cards) {
        if (cards.some((c) => norm(c.objective) === norm(card.objective) || norm(c.prompt) === norm(card.prompt)))
          failures.push(`Part ${k + 1}: duplicate learning target omitted`);
        else cards.push(card);
      }
    }
    return { id: draftId, title: request.title?.trim() || title || "新题组",
      ...(request.folder ? { folder: request.folder } : {}), cards,
      editorial: { reviewedAt: new Date().toISOString(), summary, repaired,
        parts: planned.length, requested: request.count, generated: cards.length,
        completedParts: outcomes.filter(Boolean).length,
        coverage: { selected: request.sources.length,
          cited: new Set(cards.flatMap((c) => c.citations.map((r) => r.sourceId))).size,
          uncited: request.sources.filter((s) => !cards.some((c) => c.citations.some((r) => r.sourceId === s.id)))
            .map((s) => ({ id: s.id, title: s.title })) },
        failures, audits, notice: "Model review is not proof of factual correctness. Inspect sources before publishing." } };
  }
  let cursor = 0, saves = Promise.resolve(), saveError;
  const save = () => {
    const deck = snapshot();
    if (deck.cards.length) saves = saves.then(() => checkpoint(deck)).catch((error) => { saveError ||= error; });
  };
  async function worker() {
    while (cursor < planned.length && !request.signal?.aborted) {
      const k = cursor++;
      if (outcomes[k]) continue;
      const part = planned[k];
      const plannedSourceIds = new Set(plans.get(k).targets.flatMap((target) => target.citations.map((citation) => citation.sourceId)));
      // Planning saw the whole chunk. Each worker needs the full text of its
      // assigned sources, not unrelated pages assigned to other workers.
      const sources = part.sources.filter((source) => plannedSourceIds.has(source.id));
      let stage = "Writing source-grounded questions";
      try {
        const ownTargets = new Set(plans.get(k).targets.map((target) => target.objective));
        const deck = await generateDeck(
          (system, prompt) => complete(system, prompt, { stage, part: k + 1 }),
          { ...request, ...part, sources, assessmentPlan: plans.get(k),
            existing: reserved.filter((target) => !ownTargets.has(target)), allowPartial: true },
          (next) => { stage = `Part ${k + 1}/${planned.length} · ${next}`; progress(stage, { part: k + 1 }); });
        outcomes[k] = { deck };
      } catch (error) { outcomes[k] = { error: error.message }; }
      save();
      progress(`Completed ${outcomes.filter(Boolean).length}/${planned.length} parts`, { part: k + 1, settled: true });
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, planned.length) }, () => worker()));
  await saves;
  request.signal?.throwIfAborted();
  if (saveError) throw new Error(`Could not save generation progress: ${saveError.message}`);
  const result = snapshot();
  if (!result.cards.length) throw new Error(result.editorial.failures.join("; ") || "No questions were generated");
  return result;
}
