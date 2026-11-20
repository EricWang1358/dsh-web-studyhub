/* Where a quoted passage stands in a text. Pure, no Node modules (the browser bundle and the backend share it, like lib/sections.js).

   `createLocator(text)` returns `locate(quote, options?)` -> { start, end } (offsets into `text`, end exclusive) or null. A quote is found
     1. as it is written (the first occurrence);
     2. else by its letters and digits only, after NFKC and lower case, the rule lib/quote-match.js checks citations by: a model never echoes a
        converted page byte for byte (line breaks, hyphenation, typographic marks, spacing), and none of that carries meaning. The offsets then
        point at the first and the last matched character of the stored text, so the stored text between them is the verbatim passage. A footnote
        mark (`[^12]`, the book's own, often glued to a closing quotation mark) is not wording: neither side's key holds it;
     3. an elided quote ("first part … last part") when each part is found, in order;
     4. else, as a controlled approximate fallback via `approx-string-match` (MIT): strictly bounded by edit rate <= 10% (`MAX_APPROX_EDIT_RATE`),
        requiring a unique top candidate (or strictly highest prefix/suffix context score when multiple candidates tie) so ambiguous or
        contradictory matches never mis-anchor (`missing` / `ambiguous` -> null).
   The letters-and-digits index of a text is built once, when the first quote needs it, maintaining exact UTF-16 code-unit alignment. */

import approxSearch from 'approx-string-match';

const KEEP = /[\p{L}\p{N}\p{M}]/u;
/**
 * A footnote mark of the book or of a converted document: never part of a quote's wording. Only keys as they are written (`[^12]`; a Word endnote's
 * `[^e3]`; a file's `[^h4g-3]`, a writer's `[^o2-3]`, a folded point's `[^3-f1]`), so a negated character class of a lecture (`[^0-9]`, `[^a-z]`) is
 * still wording and a changed one still differs; nor one written as regex code (after `(`, `/`, `\`, `|`, `[` or before `+`, `*`, `{`).
 * The limit: a digits-only class standing alone (`"[^01]"`) cannot be told from a footnote mark, so it is read as one.
 */
export const FOOTNOTE_MARK = /(?<![(/\\|[])\[\^(?:[a-z][a-z0-9]*-)?e?\d{1,3}(?:-f\d{1,3})?\](?![+*{])/g;
/**
 * What an older release stored for a material's own mark inside a footnote's quote (the brackets made spaces: `理由 ^4 都`). Left out of the quote
 * only as a second try, when the quote is not found with it (a quote may hold a real ` ^2 `).
 */
const LEGACY_MARK = /(^|\s)\^(?:[a-z][a-z0-9]*-)?e?\d{1,3}(?:-f\d{1,3})?(?=\s|$)/g;
const ELLIPSIS = /\[\s*(?:\.{3,}|…)\s*\]|\.{3,}|(?:\.\s){2,}\.|…|⋯/u;
/** A quote with fewer letters and digits than this proves nothing. */
export const MIN_KEY = 6;
/** Controlled approximate fallback bounds: never exceed 10% edit rate or run on tiny keys. */
export const MAX_APPROX_EDIT_RATE = 0.1;
export const MIN_APPROX_KEY = 10;
const CONTEXT_WINDOW_CHARS = 32;

const keyChars = (text) => {
  let key = '';
  for (const char of String(text ?? '').replace(FOOTNOTE_MARK, ' ').normalize('NFKC').toLowerCase()) if (KEEP.test(char)) key += char;
  return key;
};

/** The letters-and-digits key of a text with, for each UTF-16 code unit of `key`, the offset in `text` where its source character starts and its UTF-16 width. */
function indexOfText(text) {
  const parts = [], from = [], width = [], marks = new Map([...text.matchAll(FOOTNOTE_MARK)].map(mark => [mark.index, mark.index + mark[0].length]));
  const pushPiece = (piece, at, size) => {
    parts.push(piece);
    for (let i = 0; i < piece.length; i++) { from.push(at); width.push(size); }
  };
  for (let at = 0; at < text.length;) {
    if (marks.has(at)) { at = marks.get(at); continue; }
    const code = text.codePointAt(at), size = code > 0xffff ? 2 : 1, char = text.slice(at, at + size);
    if ((code >= 48 && code <= 57) || (code >= 97 && code <= 122)) pushPiece(char, at, size);
    else if (code >= 65 && code <= 90) pushPiece(char.toLowerCase(), at, size);
    else if (code > 127) {
      const lowered = char.normalize('NFKC').toLowerCase();
      for (const piece of lowered) if (KEEP.test(piece)) pushPiece(piece, at, size);
    }
    at += size;
  }
  return { key: parts.join(''), from, width };
}

/** Cluster overlapping `approx-string-match` hits into disjoint candidate spans, picking the best span per cluster. */
function clusterApproxMatches(matches, wantedLen) {
  if (!matches.length) return [];
  const sorted = [...matches].sort((a, b) => a.start - b.start || a.errors - b.errors || Math.abs((a.end - a.start) - wantedLen) - Math.abs((b.end - b.start) - wantedLen));
  const clusters = [];
  let current = null;
  for (const hit of sorted) {
    if (!current || hit.start >= current.clusterEnd) {
      current = { best: hit, clusterEnd: hit.end };
      clusters.push(current);
      continue;
    }
    if (hit.end > current.clusterEnd) current.clusterEnd = hit.end;
    const best = current.best;
    const betterErrors = hit.errors < best.errors;
    const sameErrorsCloserLen = hit.errors === best.errors
      && Math.abs((hit.end - hit.start) - wantedLen) < Math.abs((best.end - best.start) - wantedLen);
    if (betterErrors || sameErrorsCloserLen) current.best = hit;
  }
  return clusters.map(c => c.best);
}

/** Fraction of trailing `prefixKey` matching `key` immediately before `absStart` (allowing minor 1-char slip at boundary). */
function scorePrefix(key, absStart, prefixKey) {
  if (!prefixKey) return 0;
  const tail = prefixKey.slice(-CONTEXT_WINDOW_CHARS);
  const avail = key.slice(Math.max(0, absStart - tail.length), absStart);
  if (!avail) return 0;
  let matched = 0;
  const len = Math.min(tail.length, avail.length);
  for (let i = 1; i <= len; i++) {
    if (avail[avail.length - i] === tail[tail.length - i]) matched++;
  }
  return matched / tail.length;
}

/** Fraction of leading `suffixKey` matching `key` immediately after `absEnd`. */
function scoreSuffix(key, absEnd, suffixKey) {
  if (!suffixKey) return 0;
  const head = suffixKey.slice(0, CONTEXT_WINDOW_CHARS);
  const avail = key.slice(absEnd, absEnd + head.length);
  if (!avail) return 0;
  let matched = 0;
  const len = Math.min(head.length, avail.length);
  for (let i = 0; i < len; i++) {
    if (avail[i] === head[i]) matched++;
  }
  return matched / head.length;
}

/**
 * Controlled approximate fallback on normalized `key`:
 * - Enforces edit rate `errors / wanted.length <= maxEditRate` (capped at 10%).
 * - Clusters overlapping matches into disjoint spans and requires either a unique match
 *   or a strictly unique top context score (`prefix` / `suffix`) — otherwise reports `ambiguous` / `missing`.
 */
function sameDigitSequence(a, b) {
  const da = a.match(/\d+/g);
  const db = b.match(/\d+/g);
  if (!da && !db) return true;
  if (!da || !db || da.length !== db.length) return false;
  for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) return false;
  return true;
}

function findApproxDetailed(indexed, low, wanted, { prefix = '', suffix = '', maxEditRate = MAX_APPROX_EDIT_RATE } = {}) {
  const { key, from: where, width } = indexed;
  const clampedRate = Math.min(Math.max(0, Number(maxEditRate) || 0), MAX_APPROX_EDIT_RATE);
  if (wanted.length < MIN_APPROX_KEY || clampedRate <= 0) return { status: 'missing' };
  const maxErrors = Math.floor(wanted.length * clampedRate);
  if (maxErrors < 1 || low >= key.length) return { status: 'missing' };

  const slice = key.slice(low);
  const rawMatches = approxSearch(slice, wanted, maxErrors).filter(hit =>
    hit.end > hit.start && hit.errors / wanted.length <= clampedRate && sameDigitSequence(slice.slice(hit.start, hit.end), wanted));
  if (!rawMatches.length) return { status: 'missing' };

  const disjoint = clusterApproxMatches(rawMatches, wanted.length);
  const prefixKey = keyChars(prefix);
  const suffixKey = keyChars(suffix);
  const hasContext = prefixKey.length > 0 || suffixKey.length > 0;

  const scored = disjoint.map(hit => {
    const absStart = low + hit.start;
    const absEnd = low + hit.end;
    const lastIdx = absEnd - 1;
    const editRate = hit.errors / wanted.length;
    const editScore = 1 - editRate;
    const pScore = scorePrefix(key, absStart, prefixKey);
    const sScore = scoreSuffix(key, absEnd, suffixKey);
    const contextScore = pScore + sScore;
    return {
      start: where[absStart],
      end: where[lastIdx] + width[lastIdx],
      errors: hit.errors,
      editRate,
      contextScore,
      score: editScore + contextScore,
    };
  }).sort((a, b) => b.score - a.score || a.errors - b.errors || b.contextScore - a.contextScore);

  const best = scored[0];
  if (scored.length === 1) {
    // When caller explicitly supplied surrounding context and it completely disagrees, refuse to mis-anchor.
    if (hasContext && best.contextScore === 0) return { status: 'missing' };
    return { status: 'approx', start: best.start, end: best.end, errors: best.errors, editRate: best.editRate, score: best.score };
  }

  const second = scored[1];
  // Multiple disjoint approximate occurrences: require distinguishing prefix/suffix context with a strictly higher score.
  if (hasContext && best.contextScore > 0 && best.contextScore > second.contextScore && best.score > second.score) {
    return { status: 'approx', start: best.start, end: best.end, errors: best.errors, editRate: best.editRate, score: best.score };
  }
  return { status: 'ambiguous' };
}

/** A function that finds quotes in `text`; `locate(quote, { from, prefix, suffix, approx, maxEditRate })` may start after `from` or pass context for controlled approximate disambiguation. */
export function createLocator(text) {
  const value = typeof text === 'string' ? text : '';
  let index = null;
  const keyed = () => (index ||= indexOfText(value));
  const lowerBound = (where, from) => {
    let low = 0, high = where.length;
    while (low < high) { const middle = (low + high) >> 1; if (where[middle] < from) low = middle + 1; else high = middle; }
    return low;
  };
  const findStrictOrNormalized = (quote, from = 0) => {
    const exact = quote.length >= 1 ? value.indexOf(quote, from) : -1;
    if (exact >= 0) return { status: 'exact', start: exact, end: exact + quote.length };
    const keys = [...new Set([keyChars(quote), keyChars(quote.replace(LEGACY_MARK, '$1'))])].filter(wanted => [...wanted].length >= MIN_KEY);
    if (!keys.length) return null;
    const indexed = keyed();
    const { key, from: where, width } = indexed;
    const low = lowerBound(where, from);
    for (const wanted of keys) {
      const hit = key.indexOf(wanted, low);
      if (hit >= 0) {
        const last = hit + wanted.length - 1;
        return { status: 'normalized', start: where[hit], end: where[last] + width[last] };
      }
    }
    return null;
  };
  const findApprox = (quote, { from = 0, prefix = '', suffix = '', maxEditRate = MAX_APPROX_EDIT_RATE } = {}) => {
    const keys = [...new Set([keyChars(quote), keyChars(quote.replace(LEGACY_MARK, '$1'))])].filter(wanted => wanted.length >= MIN_APPROX_KEY);
    if (!keys.length) return { status: 'missing' };
    const indexed = keyed();
    const low = lowerBound(indexed.from, from);
    let sawAmbiguous = false;
    for (const wanted of keys) {
      const res = findApproxDetailed(indexed, low, wanted, { prefix, suffix, maxEditRate });
      if (res.status === 'approx') return res;
      if (res.status === 'ambiguous') sawAmbiguous = true;
    }
    return { status: sawAmbiguous ? 'ambiguous' : 'missing' };
  };
  const detailed = (quote, options = {}) => {
    const raw = String(quote ?? '').trim();
    if (!raw || !value) return { status: 'missing' };
    const from = Number.isInteger(options?.from) && options.from > 0 ? options.from : 0;
    // A quote that was cut short with an ellipsis (what a record keeps of a long one) is its beginning.
    const cut = raw.replace(/\s*(?:…|\.{3})$/u, '');
    if (cut && cut !== raw) {
      const head = findStrictOrNormalized(cut, from);
      if (head) return head;
    }
    const whole = findStrictOrNormalized(raw, from);
    if (whole) return whole;
    const pieces = raw.split(ELLIPSIS).map((piece) => piece.trim()).filter(Boolean);
    if (pieces.length >= 2) {
      let first = null, last = null;
      let ok = true;
      for (const piece of pieces) {
        const found = findStrictOrNormalized(piece, last ? last.end : from);
        if (!found) { ok = false; break; }
        first ||= found; last = found;
      }
      if (ok && first && last) return { status: 'normalized', start: first.start, end: last.end };
      return { status: 'missing' };
    }
    if (options?.approx === false) return { status: 'missing' };
    return findApprox(cut && cut !== raw ? cut : raw, { ...options, from });
  };
  const locate = (quote, options = {}) => {
    const res = detailed(quote, options);
    return res.status === 'exact' || res.status === 'normalized' || res.status === 'approx'
      ? { start: res.start, end: res.end }
      : null;
  };
  locate.detailed = detailed;
  return locate;
}

/** One-off: where `quote` stands in `text`, or null. */
export const locateQuote = (text, quote, options) => createLocator(text)(quote, options);

/** Detailed locator exposing `{ status: 'exact' | 'normalized' | 'approx' | 'ambiguous' | 'missing', start?, end?, errors?, editRate?, score? }`. */
export const locateQuoteDetailed = (text, quote, options) => createLocator(text).detailed(quote, options);
