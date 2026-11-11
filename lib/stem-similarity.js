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

/** Bigram ids handed out in order of first sight: within one dictionary the same two characters (UTF-16 code units) always get the same small integer. */
function gramDictionary() {
  const rows = new Map();
  let next = 0;
  const idOf = (first, second) => {
    let row = rows.get(first);
    if (!row) rows.set(first, (row = new Map()));
    let id = row.get(second);
    if (id === undefined) row.set(second, (id = next++));
    return id;
  };
  idOf.size = () => next;
  return idOf;
}

/** A stem prepared once: its normalised text, how many bigrams it has, and their ids sorted (a bigram that occurs twice is there twice). */
function stemProfile(text, idOf) {
  const normalized = normalizeStemForComparison(text);
  const size = Math.max(normalized.length - 1, 0), grams = new Int32Array(size);
  for (let i = 0; i < size; i += 1) grams[i] = idOf(normalized.charCodeAt(i), normalized.charCodeAt(i + 1));
  return { normalized, size, grams: grams.sort() };
}

/** Sørensen–Dice over the bigram multisets of two profiles of one dictionary; equal non-empty stems are 1, a one-character stem matches only itself. */
function profileSimilarity(p1, p2) {
  if (!p1.normalized || !p2.normalized) return 0;
  if (p1.normalized === p2.normalized) return 1;
  if (!p1.size || !p2.size) return 0;
  let overlap = 0;
  for (let i = 0, j = 0; i < p1.size && j < p2.size;) {
    if (p1.grams[i] === p2.grams[j]) { overlap += 1; i += 1; j += 1; } else if (p1.grams[i] < p2.grams[j]) i += 1; else j += 1;
  }
  return (2 * overlap) / (p1.size + p2.size);
}

/** Character 2-gram Sørensen–Dice similarity for near-duplicate stem detection (#853 / #847). */
export function stemSimilarity(a, b) {
  const idOf = gramDictionary();
  return profileSimilarity(stemProfile(a, idOf), stemProfile(b, idOf));
}

// Slack for the bounds below, so that rounding never prunes a pair the exact check would keep.
const EPSILON = 1e-9;

/** The fewest shared bigrams a stem of `size` bigrams needs with any stem it is at least `threshold` similar to: 2o >= t(n+m) and o <= m give o >= t*n/(2-t). */
const minOverlap = (size, threshold) => Math.max(1, Math.ceil((threshold * size) / (2 - threshold) - EPSILON));

const TOKEN_SPAN = 2 ** 32;

/** Each stem's tokens, rarest first in one total order (frequency, then token), and how many tokens there are. The first occurrence of a bigram in a stem
    is the token of its id; a second or later one is a token of its own, so the overlap of two token sets is the overlap of the two bigram multisets. */
function rarestFirstTokens(profiles, distinct) {
  const frequency = [], repeats = new Map();
  const tokens = profiles.map(({ grams }) => {
    const list = new Array(grams.length);
    for (let i = 0, k = 0; i < grams.length; i += 1) {
      k = i && grams[i] === grams[i - 1] ? k + 1 : 0;
      const key = k && `${grams[i]}:${k}`;
      if (key && !repeats.has(key)) repeats.set(key, distinct + repeats.size);
      list[i] = key ? repeats.get(key) : grams[i];
      frequency[list[i]] = (frequency[list[i]] || 0) + 1;
    }
    return list;
  });
  // Tokens are fewer than all the bigrams in memory and a frequency is at most the number of stems: frequency * 2^32 + token is an exact
  // double, so a plain numeric sort orders by both.
  const ordered = tokens.map((list) => Float64Array.from(list, (token) => frequency[token] * TOKEN_SPAN + token).sort().map((key) => key % TOKEN_SPAN));
  return { ordered, count: distinct + repeats.size };
}

/**
 * Every pair [i, j, similarity] with i in `probes` (indexes into `texts`; all of them when left out), j any other index, and
 * stemSimilarity(texts[i], texts[j]) >= threshold (0 < threshold <= 1). The same pairs as comparing every probe with every text, found without doing that:
 * - prefix filter: a stem is indexed by its first size - minOverlap + 1 tokens, rarest first. Two stems that are similar enough share at least minOverlap
 *   tokens, so they share one of those prefixes; only stems found that way, and of a length that could reach the threshold, are candidates;
 * - position filter: a shared prefix token at place p of the probe and place q of the other stem leaves at most min(n - p, m - q) - 1 more shared tokens
 *   after it, so a candidate that cannot reach the overlap the threshold needs is dropped before the exact check (stems of a small vocabulary share
 *   many bigrams, and this is what keeps their exact checks few).
 * A pair is listed once per probe it starts from. `stats`, when given, gets { candidates, compared }: stems reached through the index, and exact checks.
 */
export function similarStemPairs(texts, { probes, threshold = NEAR_DUPLICATE_SIMILARITY, stats } = {}) {
  if (!(threshold > 0 && threshold <= 1)) throw new RangeError(`similarStemPairs: threshold must be in (0, 1], not ${threshold}`);
  const idOf = gramDictionary(), profiles = texts.map((text) => stemProfile(text, idOf));
  const { ordered, count } = rarestFirstTokens(profiles, idOf.size());
  const prefixLength = (index) => profiles[index].size - minOverlap(profiles[index].size, threshold) + 1;
  // postings[token]: the stems whose prefix holds it, with the token's place in each, as [stem, place, stem, place, ...].
  const postings = new Array(count), single = new Map();
  ordered.forEach((tokens, index) => {
    for (let place = 0, end = prefixLength(index); place < end; place += 1) (postings[tokens[place]] ??= []).push(index, place);
    // A one-character stem has no bigram: it can only equal another one-character stem.
    if (!profiles[index].size && profiles[index].normalized) (single.get(profiles[index].normalized) ?? single.set(profiles[index].normalized, []).get(profiles[index].normalized)).push(index);
  });
  // shared[j]: the prefix tokens the current probe and stem j share so far, or -1 once j can no longer reach the threshold; stamp[j]: the probe it is for.
  const pairs = [], shared = new Int32Array(texts.length), stamp = new Int32Array(texts.length).fill(-1), sizes = Int32Array.from(profiles, (profile) => profile.size);
  const half = threshold / 2;
  let candidates = 0, compared = 0;
  for (const i of probes ?? texts.keys()) {
    const probe = profiles[i], n = probe.size;
    if (!probe.normalized) continue;
    if (!n) {
      for (const j of single.get(probe.normalized)) if (j !== i) { candidates += 1; compared += 1; pairs.push([i, j, 1]); }
      continue;
    }
    const low = (threshold * n) / (2 - threshold) - EPSILON, high = (n * (2 - threshold)) / threshold + EPSILON, reached = [];
    stamp[i] = i; shared[i] = -1;
    for (let p = 0, end = prefixLength(i), tokens = ordered[i]; p < end; p += 1) {
      const list = postings[tokens[p]];
      for (let k = 0; k < list.length; k += 2) {
        const j = list[k], m = sizes[j];
        if (stamp[j] !== i) {
          stamp[j] = i;
          if (m < low || m > high) { shared[j] = -1; continue; }
          shared[j] = 0; reached.push(j);
        } else if (shared[j] < 0) continue;
        // The shared count is a whole number, so "below the overlap needed" is "below t(n+m)/2".
        const left = n - p < m - list[k + 1] ? n - p : m - list[k + 1];
        if (shared[j] + left < half * (n + m) - EPSILON) shared[j] = -1; else shared[j] += 1;
      }
    }
    candidates += reached.length;
    for (const j of reached) {
      if (shared[j] < 0) continue;
      compared += 1;
      const similarity = profileSimilarity(probe, profiles[j]);
      if (similarity >= threshold) pairs.push([i, j, similarity]);
    }
  }
  if (stats) Object.assign(stats, { candidates: (stats.candidates ?? 0) + candidates, compared: (stats.compared ?? 0) + compared });
  return pairs;
}
