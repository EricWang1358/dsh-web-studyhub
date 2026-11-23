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

// Precomputed ASCII boundary table avoids regex overhead inside the inner scoring loop.
const ASCII_BOUNDARY = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  if (BOUNDARY.test(String.fromCharCode(c))) ASCII_BOUNDARY[c] = 1;
}

const POS_SCRATCH = new Int32Array(256);
const EMPTY_POSITIONS: number[] = [];

function hasSurrogateCodeUnit(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) return true;
  }
  return false;
}

function isBoundaryCharCode(s: string, idx: number): boolean {
  const code = s.charCodeAt(idx);
  if (code < 128) return ASCII_BOUNDARY[code] === 1;
  if (code === 0x00b7 || code === 0x3000 || code === 0x00a0) return true;
  if (code >= 0x4e00 && code <= 0x9fff) return false;
  return BOUNDARY.test(s[idx]);
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
  /** ASCII a-z charCode (0x61..0x7A) of chars[0], or -1 if chars[0] is not a-z. */
  firstAsciiLower: number;
  /** Non-case-folding BMP char (CJK 0x4E00..0x9FFF or digit 0x30..0x39) for zero-alloc pre-check, or ''. */
  firstLiteralChar: string;
}

function prepareQuery(query: string): PreparedQuery | null {
  const joined = query.toLowerCase().trim();
  if (joined.length === 0) return null;
  const hasSurrogate = hasSurrogateCodeUnit(joined);
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
  let firstAsciiLower = -1;
  let firstLiteralChar = '';
  if (chars.length > 0) {
    const c0 = chars[0].charCodeAt(0);
    if (c0 >= 0x61 && c0 <= 0x7a) {
      firstAsciiLower = c0;
    } else if ((c0 >= 0x4e00 && c0 <= 0x9fff) || (c0 >= 0x30 && c0 <= 0x39)) {
      firstLiteralChar = chars[0];
    }
  }
  return { joined, chars, hasSurrogate, firstAsciiLower, firstLiteralChar };
}

function scorePrepared(
  pq: PreparedQuery,
  text: string,
  capturePositions = true,
): { score: number; positions: number[] } | null {
  const chars = pq.chars;
  const qLen = chars.length;
  if (qLen === 0) return { score: 0, positions: [] };
  if (text.length === 0) return null;

  // Fast zero-allocation pre-rejection before text.toLowerCase().
  const firstLower = pq.firstAsciiLower;
  if (firstLower >= 0) {
    const firstUpper = firstLower - 32;
    let foundFirst = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      // Include U+0130 ('İ' -> 'i\u0307') and U+212A ('K' -> 'k') for exact Unicode case folding.
      if (c === firstLower || c === firstUpper || c === 0x0130 || c === 0x212a) {
        foundFirst = true;
        break;
      }
    }
    if (!foundFirst) return null;
  } else if (pq.firstLiteralChar.length > 0) {
    if (text.indexOf(pq.firstLiteralChar) < 0) return null;
  }

  const lower = text.toLowerCase();
  if (!pq.hasSurrogate) {
    // Single-pass indexOf + scoring using reusable scratch buffer; allocate positions only on full match.
    const posBuf = qLen <= POS_SCRATCH.length ? POS_SCRATCH : new Int32Array(qLen);
    let score = 0;
    let ti = 0;
    let prev = -2;
    for (let i = 0; i < qLen; i++) {
      const found = lower.indexOf(chars[i], ti);
      if (found < 0) return null;
      let s = 1;
      if (found === prev + 1) s += 4; // contiguous
      if (found === 0 || isBoundaryCharCode(lower, found - 1)) s += 3; // word start
      if (found === 0) s += 2;
      score += s;
      posBuf[i] = found;
      prev = found;
      ti = found + 1;
    }

    // Fast BMP path: without surrogates, UTF-16 indices equal code-point indices.
    if (!hasSurrogateCodeUnit(lower)) {
      const idx = lower.indexOf(pq.joined);
      if (idx >= 0) score += 8 + (idx === 0 ? 6 : 0);
      score -= Math.min(10, Math.floor(lower.length / 12));
      if (!capturePositions) return { score, positions: EMPTY_POSITIONS };
      const positions = new Array<number>(qLen);
      for (let i = 0; i < qLen; i++) positions[i] = posBuf[i];
      return { score, positions };
    }
  }

  // Fallback code-point path when surrogate pairs / astral code points are present.
  const t = Array.from(lower);
  const positions: number[] = capturePositions ? [] : EMPTY_POSITIONS;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let i = 0; i < qLen; i++) {
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
    if (capturePositions) positions.push(found);
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
  return scorePrepared(pq, text, true);
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
    let best = scorePrepared(pq, label, true);
    if (!best && getKeywords) {
      const kws = getKeywords(item);
      if (kws) {
        for (let j = 0; j < kws.length; j++) {
          const r = scorePrepared(pq, kws[j], false);
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
