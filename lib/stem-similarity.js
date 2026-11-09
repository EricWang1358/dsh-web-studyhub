/* How alike two question stems are, and which stems of a list are near-duplicates of each other (#853 / #847 / #890).
   Pure and shared: the exam coach (lib/exam-coach.js) and the draft's similar-question check (lib/contexts/authoring/similar-questions.js)
   use this one measure and this one threshold. No model, no tokeniser of its own beyond character bigrams. */

/** At or above this similarity two stems count as the same question said another way. */
export const NEAR_DUPLICATE_SIMILARITY = 0.72;

export function normalizeStemForComparison(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** A stem prepared once: its normalised text, its character bigrams with how often each occurs, and how many bigrams it has. */
function stemProfile(text) {
  const normalized = normalizeStemForComparison(text);
  const grams = new Map();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    const gram = normalized.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }
  return { normalized, grams, size: Math.max(normalized.length - 1, 0) };
}

/** Sørensen–Dice over the bigram multisets of two profiles; equal non-empty stems are 1, a one-character stem matches only itself. */
function profileSimilarity(p1, p2) {
  if (!p1.normalized || !p2.normalized) return 0;
  if (p1.normalized === p2.normalized) return 1;
  if (!p1.size || !p2.size) return 0;
  const [small, large] = p1.grams.size <= p2.grams.size ? [p1.grams, p2.grams] : [p2.grams, p1.grams];
  let overlap = 0;
  for (const [gram, count] of small) if (large.has(gram)) overlap += Math.min(count, large.get(gram));
  return (2 * overlap) / (p1.size + p2.size);
}

/** Character 2-gram Sørensen–Dice similarity for near-duplicate stem detection (#853 / #847). */
export function stemSimilarity(a, b) {
  return profileSimilarity(stemProfile(a), stemProfile(b));
}

// Slack for the bounds below, so that rounding never prunes a pair the exact check would keep.
const EPSILON = 1e-9;

/** The fewest shared bigrams a stem of `size` bigrams needs with any stem it is at least `threshold` similar to: 2o >= t(n+m) and o <= m give o >= t*n/(2-t). */
const minOverlap = (size, threshold) => Math.max(1, Math.ceil((threshold * size) / (2 - threshold) - EPSILON));

/**
 * Every pair [i, j, similarity] with i in `probes` (indexes into `texts`; all of them when left out), j any other index, and
 * stemSimilarity(texts[i], texts[j]) >= threshold. The same pairs as comparing every probe with every text, found without doing that:
 * each stem's bigrams (a bigram that occurs k times counts as k distinct tokens) are ordered rarest first, and a stem is indexed by its
 * first size - minOverlap + 1 of them. Two stems that are similar enough share at least minOverlap tokens, so they share one of those
 * prefixes (prefix filtering); only the stems found that way are compared. A pair is listed once per probe it starts from.
 */
export function similarStemPairs(texts, { probes, threshold = NEAR_DUPLICATE_SIMILARITY } = {}) {
  const profiles = texts.map(stemProfile);
  const tokens = profiles.map(({ grams }) => [...grams].flatMap(([gram, count]) => Array.from({ length: count }, (_, k) => (k ? `${gram}\u0000${k}` : gram))));
  const frequency = new Map();
  for (const list of tokens) for (const token of list) frequency.set(token, (frequency.get(token) || 0) + 1);
  const rarestFirst = (a, b) => frequency.get(a) - frequency.get(b) || (a < b ? -1 : a > b ? 1 : 0);
  const prefixes = tokens.map((list, index) => list.sort(rarestFirst).slice(0, list.length - minOverlap(profiles[index].size, threshold) + 1));
  const postings = new Map(), single = new Map();
  prefixes.forEach((prefix, index) => {
    for (const token of prefix) { if (!postings.has(token)) postings.set(token, []); postings.get(token).push(index); }
    // A one-character stem has no bigram: it can only equal another one-character stem.
    if (!profiles[index].size && profiles[index].normalized) { if (!single.has(profiles[index].normalized)) single.set(profiles[index].normalized, []); single.get(profiles[index].normalized).push(index); }
  });
  const pairs = [], seen = new Int32Array(texts.length).fill(-1);
  for (const i of probes ?? texts.keys()) {
    const probe = profiles[i];
    if (!probe.normalized) continue;
    const low = (threshold * probe.size) / (2 - threshold) - EPSILON, high = (probe.size * (2 - threshold)) / threshold + EPSILON;
    const candidates = probe.size ? prefixes[i].flatMap((token) => postings.get(token)) : single.get(probe.normalized);
    seen[i] = i;
    for (const j of candidates) {
      if (seen[j] === i) continue;
      seen[j] = i;
      if (probe.size && (profiles[j].size < low || profiles[j].size > high)) continue;
      const similarity = profileSimilarity(probe, profiles[j]);
      if (similarity >= threshold) pairs.push([i, j, similarity]);
    }
  }
  return pairs;
}
