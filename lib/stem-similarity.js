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

/** Each stem's tokens, rarest first in one total order (frequency, then token). The first occurrence of a bigram in a stem is the token of its id;
    a second or later one is a token of its own, so the overlap of two token sets is the overlap of the two bigram multisets. */
function rarestFirstTokens(profiles, distinct) {
  const frequency = new Map(), repeats = new Map();
  const tokens = profiles.map(({ grams }) => {
    const list = new Array(grams.length);
    for (let i = 0, k = 0; i < grams.length; i += 1) {
      k = i && grams[i] === grams[i - 1] ? k + 1 : 0;
      const key = k && `${grams[i]}:${k}`;
      if (key && !repeats.has(key)) repeats.set(key, distinct + repeats.size);
      list[i] = key ? repeats.get(key) : grams[i];
      frequency.set(list[i], (frequency.get(list[i]) || 0) + 1);
    }
    return list;
  });
  // Tokens are fewer than all the bigrams in memory and a frequency is at most the number of stems: frequency * 2^32 + token is an exact
  // double, so a plain numeric sort orders by both.
  return tokens.map((list) => Float64Array.from(list, (token) => frequency.get(token) * TOKEN_SPAN + token).sort().map((key) => key % TOKEN_SPAN));
}

const append = (map, key, value) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };

/**
 * Every pair [i, j, similarity] with i in `probes` (indexes into `texts`; all of them when left out), j any other index, and
 * stemSimilarity(texts[i], texts[j]) >= threshold. The same pairs as comparing every probe with every text, found without doing that:
 * a stem is indexed by its first size - minOverlap + 1 tokens, rarest first. Two stems that are similar enough share at least minOverlap
 * tokens, so they share one of those prefixes (prefix filtering); only the stems found that way, and of a length that could reach the
 * threshold, are compared. A pair is listed once per probe it starts from.
 */
export function similarStemPairs(texts, { probes, threshold = NEAR_DUPLICATE_SIMILARITY } = {}) {
  const idOf = gramDictionary(), profiles = texts.map((text) => stemProfile(text, idOf));
  const prefixes = rarestFirstTokens(profiles, idOf.size()).map((tokens, index) => tokens.subarray(0, tokens.length - minOverlap(profiles[index].size, threshold) + 1));
  const postings = new Map(), single = new Map();
  prefixes.forEach((prefix, index) => {
    for (const token of prefix) append(postings, token, index);
    // A one-character stem has no bigram: it can only equal another one-character stem.
    if (!profiles[index].size && profiles[index].normalized) append(single, profiles[index].normalized, index);
  });
  const pairs = [], seen = new Int32Array(texts.length).fill(-1);
  for (const i of probes ?? texts.keys()) {
    const probe = profiles[i];
    if (!probe.normalized) continue;
    const low = (threshold * probe.size) / (2 - threshold) - EPSILON, high = (probe.size * (2 - threshold)) / threshold + EPSILON;
    seen[i] = i;
    for (const list of probe.size ? Array.from(prefixes[i], (token) => postings.get(token)) : [single.get(probe.normalized)]) {
      for (const j of list) {
        if (seen[j] === i) continue;
        seen[j] = i;
        if (probe.size && (profiles[j].size < low || profiles[j].size > high)) continue;
        const similarity = profileSimilarity(probe, profiles[j]);
        if (similarity >= threshold) pairs.push([i, j, similarity]);
      }
    }
  }
  return pairs;
}
