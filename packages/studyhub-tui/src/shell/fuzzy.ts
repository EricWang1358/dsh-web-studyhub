/**
 * Tiny dependency-free fuzzy matcher (subsequence with contiguity / word-start bonuses).
 * Works for CJK (per-code-point) and Latin text alike.
 */

export interface FuzzyResult<T> {
  item: T;
  score: number;
  /** Code-point indices into the matched label (for highlighting). */
  positions: number[];
}

const BOUNDARY = /[\s\-_/.:·|()[\]]/;
const SURROGATE_RE = /[\uD800-\uDFFF]/;

// Precomputed ASCII boundary table avoids regex overhead inside the inner scoring loop.
const ASCII_BOUNDARY = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  if (BOUNDARY.test(String.fromCharCode(c))) ASCII_BOUNDARY[c] = 1;
}

function isBoundary(ch: string): boolean {
  const code = ch.charCodeAt(0);
  if (code < 128) return ASCII_BOUNDARY[code] === 1;
  return BOUNDARY.test(ch);
}

interface PreparedQuery {
  joined: string;
  chars: string[];
  hasSurrogate: boolean;
}

function prepareQuery(query: string): PreparedQuery | null {
  const joined = query.toLowerCase().trim();
  if (joined.length === 0) return null;
  const hasSurrogate = SURROGATE_RE.test(joined);
  const chars: string[] = [];
  if (!hasSurrogate) {
    for (let i = 0; i < joined.length; i++) {
      const ch = joined[i];
      if (ch !== ' ') chars.push(ch);
    }
  } else {
    for (const ch of joined) {
      if (ch !== ' ') chars.push(ch);
    }
  }
  return { joined, chars, hasSurrogate };
}

function scorePrepared(pq: PreparedQuery, text: string): { score: number; positions: number[] } | null {
  const chars = pq.chars;
  if (chars.length === 0) return { score: 0, positions: [] };
  if (text.length === 0) return null;

  const lower = text.toLowerCase();
  if (!pq.hasSurrogate) {
    // Reject non-matching items with native indexOf before allocating any arrays.
    let utf16Pos = 0;
    for (let i = 0; i < chars.length; i++) {
      const idx = lower.indexOf(chars[i], utf16Pos);
      if (idx < 0) return null;
      utf16Pos = idx + 1;
    }

    // Fast BMP path: without surrogates, UTF-16 indices equal code-point indices.
    if (!SURROGATE_RE.test(lower)) {
      const positions = new Array<number>(chars.length);
      let score = 0;
      let ti = 0;
      let prev = -2;
      for (let i = 0; i < chars.length; i++) {
        const found = lower.indexOf(chars[i], ti);
        if (found < 0) return null;
        let s = 1;
        if (found === prev + 1) s += 4; // contiguous
        if (found === 0 || isBoundary(lower[found - 1])) s += 3; // word start
        if (found === 0) s += 2;
        score += s;
        positions[i] = found;
        prev = found;
        ti = found + 1;
      }
      const idx = lower.indexOf(pq.joined);
      if (idx >= 0) score += 8 + (idx === 0 ? 6 : 0);
      score -= Math.min(10, Math.floor(lower.length / 12));
      return { score, positions };
    }
  }

  // Fallback code-point path when surrogate pairs / astral code points are present.
  const t = Array.from(lower);
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let i = 0; i < chars.length; i++) {
    const qc = chars[i];
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === qc) {
        found = ti;
        break;
      }
      ti += 1;
    }
    if (found < 0) return null;
    let s = 1;
    if (found === prev + 1) s += 4; // contiguous
    if (found === 0 || isBoundary(t[found - 1] ?? '')) s += 3; // word start
    if (found === 0) s += 2;
    score += s;
    positions.push(found);
    prev = found;
    ti = found + 1;
  }
  // Prefer shorter labels & exact substring hits.
  const idx = lower.indexOf(pq.joined);
  if (idx >= 0) score += 8 + (idx === 0 ? 6 : 0);
  score -= Math.min(10, Math.floor(t.length / 12));
  return { score, positions };
}

export function fuzzyScore(query: string, text: string): { score: number; positions: number[] } | null {
  const pq = prepareQuery(query);
  if (!pq) return { score: 0, positions: [] };
  return scorePrepared(pq, text);
}

export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
  getKeywords?: (item: T) => readonly string[] | undefined,
  limit = 200,
): FuzzyResult<T>[] {
  const pq = prepareQuery(query);
  if (!pq) return items.slice(0, limit).map((item) => ({ item, score: 0, positions: [] }));
  const out: FuzzyResult<T>[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const label = getText(item);
    let best = scorePrepared(pq, label);
    if (!best && getKeywords) {
      const kws = getKeywords(item);
      if (kws) {
        for (let j = 0; j < kws.length; j++) {
          const r = scorePrepared(pq, kws[j]);
          if (r && (!best || r.score - 2 > best.score)) {
            best = { score: r.score - 2, positions: [] };
          }
        }
      }
    }
    if (best) out.push({ item, score: best.score, positions: best.positions });
  }
  out.sort((a, b) => b.score - a.score);
  return out.length > limit ? out.slice(0, limit) : out;
}
