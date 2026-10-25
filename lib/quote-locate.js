/* Where a quoted passage stands in a text. Pure, no Node modules (the browser bundle and the backend share it, like lib/sections.js).

   `createLocator(text)` returns `locate(quote)` -> { start, end } (offsets into `text`, end exclusive) or null. A quote is found
     1. as it is written (the first occurrence);
     2. else by its letters and digits only, after NFKC and lower case, the rule lib/quote-match.js checks citations by: a model never echoes a
        converted page byte for byte (line breaks, hyphenation, typographic marks, spacing), and none of that carries meaning. The offsets then
        point at the first and the last matched character of the stored text, so the stored text between them is the verbatim passage. A footnote
        mark (`[^12]`, the book's own, often glued to a closing quotation mark) is not wording: neither side's key holds it;
     3. an elided quote ("first part … last part") when each part is found, in order.
   Text with HTML tags or entities inside is not read through (the key would need the markup decoded): such a quote is not located, and the caller
   says so (a coverage view puts it in the part's range). The letters-and-digits index of a text is built once, when the first quote needs it. */

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

const keyChars = (text) => {
  let key = '';
  for (const char of String(text ?? '').replace(FOOTNOTE_MARK, ' ').normalize('NFKC').toLowerCase()) if (KEEP.test(char)) key += char;
  return key;
};

/** The letters-and-digits key of a text with, for each key character, the offset in the text where it came from and how many UTF-16 units that character took. */
function indexOfText(text) {
  const parts = [], from = [], width = [], marks = new Map([...text.matchAll(FOOTNOTE_MARK)].map(mark => [mark.index, mark.index + mark[0].length]));
  for (let at = 0; at < text.length;) {
    if (marks.has(at)) { at = marks.get(at); continue; }
    const code = text.codePointAt(at), size = code > 0xffff ? 2 : 1, char = text.slice(at, at + size);
    if ((code >= 48 && code <= 57) || (code >= 97 && code <= 122)) { parts.push(char); from.push(at); width.push(size); }
    else if (code >= 65 && code <= 90) { parts.push(char.toLowerCase()); from.push(at); width.push(size); }
    else if (code > 127) {
      const lowered = char.normalize('NFKC').toLowerCase();
      for (const piece of lowered) if (KEEP.test(piece)) { parts.push(piece); from.push(at); width.push(size); }
    }
    at += size;
  }
  return { key: parts.join(''), from, width };
}

/** The letters-and-digits key of a text with, for each key character, the offset in the text it came from and how many UTF-16 units that character
    took (`{ key, from, width }`): where a difference between a quote and the stored text sits, for a caller that reports one (#486). */
export const keyPositions = (text) => indexOfText(String(text ?? ''));

/** A function that finds quotes in `text`; `locate(quote, { from })` may start its search after offset `from` (for parts of an elided quote). */
export function createLocator(text) {
  const value = typeof text === 'string' ? text : '';
  let index = null;
  const keyed = () => (index ||= indexOfText(value));
  const find = (quote, from = 0) => {
    const exact = quote.length >= 1 ? value.indexOf(quote, from) : -1;
    if (exact >= 0) return { start: exact, end: exact + quote.length };
    const keys = [...new Set([keyChars(quote), keyChars(quote.replace(LEGACY_MARK, '$1'))])].filter(wanted => wanted.length >= MIN_KEY);
    if (!keys.length) return null;
    const { key, from: where, width } = keyed();
    // The first key character at or after `from`.
    let low = 0, high = where.length;
    while (low < high) { const middle = (low + high) >> 1; if (where[middle] < from) low = middle + 1; else high = middle; }
    for (const wanted of keys) {
      const hit = key.indexOf(wanted, low);
      if (hit >= 0) return { start: where[hit], end: where[hit + wanted.length - 1] + width[hit + wanted.length - 1] };
    }
    return null;
  };
  return (quote) => {
    const raw = String(quote ?? '').trim();
    if (!raw || !value) return null;
    // A quote that was cut short with an ellipsis (what a record keeps of a long one) is its beginning.
    const cut = raw.replace(/\s*(?:…|\.{3})$/u, '');
    if (cut && cut !== raw) { const head = find(cut); if (head) return head; }
    const whole = find(raw);
    if (whole) return whole;
    const pieces = raw.split(ELLIPSIS).map((piece) => piece.trim()).filter(Boolean);
    if (pieces.length < 2) return null;
    let first = null, last = null;
    for (const piece of pieces) {
      const found = find(piece, last ? last.end : 0);
      if (!found) return null;
      first ||= found; last = found;
    }
    return { start: first.start, end: last.end };
  };
}

/** One-off: where `quote` stands in `text`, or null. */
export const locateQuote = (text, quote) => createLocator(text)(quote);
