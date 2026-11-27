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
  /** Pure ASCII (< 128) query flag enabling zero-allocation ASCII scoring. */
  isAscii: boolean;
  /** True if query contains U+0307 (combining dot above, produced by U+0130.toLowerCase()). */
  hasCombiningDot: boolean;
  asciiCodes: Uint8Array | null;
  joinedCodes: Uint8Array | null;
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
  let isAscii = !hasSurrogate;
  if (!hasSurrogate) {
    for (let i = 0; i < joined.length; i++) {
      const code = joined.charCodeAt(i);
      if (code >= 128) isAscii = false;
      if (code !== 32) chars.push(joined[i]);
    }
  } else {
    for (const ch of joined) {
      if (ch !== ' ') chars.push(ch);
    }
  }
  let asciiCodes: Uint8Array | null = null;
  let joinedCodes: Uint8Array | null = null;
  if (isAscii) {
    asciiCodes = new Uint8Array(chars.length);
    for (let i = 0; i < chars.length; i++) asciiCodes[i] = chars[i].charCodeAt(0);
    joinedCodes = new Uint8Array(joined.length);
    for (let i = 0; i < joined.length; i++) joinedCodes[i] = joined.charCodeAt(i);
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
  const hasCombiningDot = !isAscii && joined.includes('\u0307');
  return {
    joined,
    chars,
    hasSurrogate,
    isAscii,
    hasCombiningDot,
    asciiCodes,
    joinedCodes,
    firstAsciiLower,
    firstLiteralChar,
  };
}

function indexOfJoinedAscii(text: string, joinedCodes: Uint8Array, start: number): number {
  const jLen = joinedCodes.length;
  const lastStart = text.length - jLen;
  const first = joinedCodes[0];
  for (let i = start; i <= lastStart; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0x41 && c <= 0x5a) c += 32;
    if (c !== first) continue;
    let k = 1;
    for (; k < jLen; k++) {
      let ck = text.charCodeAt(i + k);
      if (ck >= 0x41 && ck <= 0x5a) ck += 32;
      if (ck !== joinedCodes[k]) break;
    }
    if (k === jLen) return i;
  }
  return -1;
}

const NO_MATCH = -1e9;

/**
 * Single scoring implementation shared by `fuzzyScore` (with `posBuf`) and `fuzzyFilter`
 * (with `posBuf = null` during candidate ranking to avoid per-item object/array allocations).
 */
function scorePreparedCore(pq: PreparedQuery, text: string, posBuf: Int32Array | null): number {
  const chars = pq.chars;
  const qLen = chars.length;
  if (qLen === 0) return 0;
  const tLen = text.length;
  if (tLen === 0) return NO_MATCH;
  // Across all of Unicode, only U+0130 ('İ' -> 'i\u0307') expands on toLowerCase(); otherwise
  // a string shorter than qLen UTF-16 code units cannot contain a qLen-char subsequence.
  if (!pq.hasCombiningDot && tLen < qLen) return NO_MATCH;

  // Single-pass zero-allocation ASCII fast path (bails to general Unicode path if any char >= 128).
  let firstCharSearchStart = 0;
  let asciiMatchedFirst = false;
  if (pq.isAscii && pq.asciiCodes && pq.joinedCodes) {
    const qCodes = pq.asciiCodes;
    let qi = 0;
    let target = qCodes[0];
    let score = 0;
    let prev = -2;
    let prevCode = 0;
    let firstPos = -1;
    let nonAsciiAt = -1;

    for (let i = 0; i < tLen; i++) {
      let c = text.charCodeAt(i);
      if (c >= 128) {
        nonAsciiAt = i;
        break;
      }
      if (c >= 0x41 && c <= 0x5a) c += 32;
      if (qi < qLen && c === target) {
        if (qi === 0) firstPos = i;
        let s = 1;
        if (i === prev + 1) s += 4;
        if (i === 0 || ASCII_BOUNDARY[prevCode] === 1) s += 3;
        if (i === 0) s += 2;
        score += s;
        if (posBuf !== null) posBuf[qi] = i;
        prev = i;
        qi += 1;
        if (qi < qLen) target = qCodes[qi];
      }
      prevCode = c;
    }

    if (nonAsciiAt < 0) {
      if (qi < qLen) return NO_MATCH;
      const idx = indexOfJoinedAscii(text, pq.joinedCodes, firstPos);
      if (idx >= 0) score += 8 + (idx === 0 ? 6 : 0);
      score -= Math.min(10, Math.floor(tLen / 12));
      return score;
    }
    firstCharSearchStart = nonAsciiAt;
    asciiMatchedFirst = qi > 0;
  }

  // Fast zero-allocation pre-rejection before text.toLowerCase().
  const firstLower = pq.firstAsciiLower;
  if (firstLower >= 0) {
    if (!asciiMatchedFirst) {
      const firstUpper = firstLower - 32;
      let foundFirst = false;
      for (let i = firstCharSearchStart; i < tLen; i++) {
        const c = text.charCodeAt(i);
        // Include U+0130 ('İ' -> 'i\u0307') and U+212A ('K' -> 'k') for exact Unicode case folding.
        if (c === firstLower || c === firstUpper || c === 0x0130 || c === 0x212a) {
          foundFirst = true;
          break;
        }
      }
      if (!foundFirst) return NO_MATCH;
    }
  } else if (pq.firstLiteralChar.length > 0) {
    if (text.indexOf(pq.firstLiteralChar) < 0) return NO_MATCH;
  }

  const lower = text.toLowerCase();
  if (!pq.hasSurrogate) {
    let score = 0;
    let ti = 0;
    let prev = -2;
    for (let i = 0; i < qLen; i++) {
      const found = lower.indexOf(chars[i], ti);
      if (found < 0) return NO_MATCH;
      let s = 1;
      if (found === prev + 1) s += 4; // contiguous
      if (found === 0 || isBoundaryCharCode(lower, found - 1)) s += 3; // word start
      if (found === 0) s += 2;
      score += s;
      if (posBuf !== null) posBuf[i] = found;
      prev = found;
      ti = found + 1;
    }

    // Fast BMP path: without surrogates, UTF-16 indices equal code-point indices.
    if (!hasSurrogateCodeUnit(lower)) {
      const idx = lower.indexOf(pq.joined);
      if (idx >= 0) score += 8 + (idx === 0 ? 6 : 0);
      score -= Math.min(10, Math.floor(lower.length / 12));
      return score;
    }
  }

  // Fallback code-point path when surrogate pairs / astral code points are present.
  const t = Array.from(lower);
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
    if (found < 0) return NO_MATCH;
    let s = 1;
    if (found === prev + 1) s += 4; // contiguous
    if (found === 0 || isBoundary(t[found - 1] ?? '')) s += 3; // word start
    if (found === 0) s += 2;
    score += s;
    if (posBuf !== null) posBuf[i] = found;
    prev = found;
    ti = found + 1;
  }
  // Prefer shorter labels & exact substring hits.
  const idx = lower.indexOf(pq.joined);
  if (idx >= 0) score += 8 + (idx === 0 ? 6 : 0);
  score -= Math.min(10, Math.floor(t.length / 12));
  return score;
}

function scorePrepared(
  pq: PreparedQuery,
  text: string,
  capturePositions = true,
): { score: number; positions: number[] } | null {
  const qLen = pq.chars.length;
  if (qLen === 0) return { score: 0, positions: [] };
  const posBuf = capturePositions ? (qLen <= POS_SCRATCH.length ? POS_SCRATCH : new Int32Array(qLen)) : null;
  const score = scorePreparedCore(pq, text, posBuf);
  if (score === NO_MATCH) return null;
  if (!capturePositions || posBuf === null) return { score, positions: EMPTY_POSITIONS };
  const positions = new Array<number>(qLen);
  for (let i = 0; i < qLen; i++) positions[i] = posBuf[i];
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
  const candidates: Array<{ item: T; score: number; matchedLabel: string | null }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const label = getText(item);
    const labelScore = scorePreparedCore(pq, label, null);
    if (labelScore !== NO_MATCH) {
      candidates.push({ item, score: labelScore, matchedLabel: label });
      continue;
    }
    if (getKeywords) {
      const kws = getKeywords(item);
      if (kws) {
        let bestKwScore = NO_MATCH;
        for (let j = 0; j < kws.length; j++) {
          const r = scorePreparedCore(pq, kws[j], null);
          if (r !== NO_MATCH && (bestKwScore === NO_MATCH || r - 2 > bestKwScore)) {
            bestKwScore = r - 2;
          }
        }
        if (bestKwScore !== NO_MATCH) candidates.push({ item, score: bestKwScore, matchedLabel: null });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const count = candidates.length > limit ? limit : candidates.length;
  const out = new Array<FuzzyResult<T>>(count);
  for (let i = 0; i < count; i++) {
    const c = candidates[i];
    const positions = c.matchedLabel !== null ? (scorePrepared(pq, c.matchedLabel, true)?.positions ?? []) : [];
    out[i] = { item: c.item, score: c.score, positions };
  }
  return out;
}
