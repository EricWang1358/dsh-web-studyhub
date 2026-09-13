import { randomUUID } from "node:crypto";
import { generateDeck } from "./generation.js";
import { norm } from "./domain.js";

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

/**
 * Generate one draft from any amount of selected material by running the
 * normal author/editor pipeline per chunk. Chunks that fail are reported, and
 * the draft keeps every card that passed; only a total failure throws.
 */
export async function generateBatched(complete, request, progress = () => {}) {
  const chunks = chunkSources(request.sources),
    shares = shareCount(chunks, request.count),
    existing = [...(request.existing || [])],
    cards = [],
    failures = [];
  let title = "",
    summary = "",
    repaired = false;
  const planned = chunks.map((c, i) => [c, shares[i], i]).filter(([, n]) => n > 0);
  for (const [k, [chunk, count, index]] of planned.entries()) {
    const label = planned.length > 1 ? `Part ${k + 1}/${planned.length} · ` : "";
    try {
      const deck = await generateDeck(
        complete,
        { ...request, count, sources: chunk, existing },
        (stage) => progress(label + stage),
      );
      title ||= deck.title;
      summary ||= deck.editorial?.summary || "";
      repaired ||= !!deck.editorial?.repaired;
      for (const card of deck.cards) {
        const seen = cards.some(
          (c) => norm(c.objective) === norm(card.objective) || norm(c.prompt) === norm(card.prompt),
        );
        if (seen) continue;
        cards.push(card);
        existing.push(card.objective);
      }
    } catch (e) {
      failures.push(`Part ${index + 1}: ${e.message}`);
    }
  }
  if (!cards.length)
    throw new Error(failures.join("; ") || "No questions were generated");
  return {
    id: randomUUID(),
    title: title || "新题组",
    cards,
    editorial: {
      reviewedAt: new Date().toISOString(),
      summary,
      repaired,
      parts: planned.length,
      requested: request.count,
      failures,
      notice:
        "Model review is not proof of factual correctness. Inspect sources before publishing.",
    },
  };
}
