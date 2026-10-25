/* Whether a quote a model gives is really on the page it cites. Pure; one rule for the plan, the author, the repair and the publish check.

   A quote must be the source's own wording, but a model never echoes a MinerU page byte for byte, and none of that carries meaning:
   line-end hyphenation ("architec-\ntural"), markup (**, #, |, $…$, \_), HTML tables and entities, typographic quotes and dashes,
   ligatures, soft hyphens, emoji bullets, line breaks. The comparison therefore runs on a key made only of letters and digits (after
   NFKC and lower case), so wording, numbers and order still have to be right while everything else is ignored. A footnote mark of the book
   (`」[^12]`, lib/quote-locate.js FOOTNOTE_MARK) is not wording either: its digits would otherwise join the key and fail a real quote. An elided quote
   ("first part … last part") must have each part in the page, in order. A quote may run over the end of its page into the next
   one. A quote that is verbatim on ANOTHER page of the same selection is not invented: the id was the model's slip (long
   document-…-p418 ids are easy to garble), and reattributeCitations() fixes exactly that. An invented quote stays rejected. */
import { FOOTNOTE_MARK } from './quote-locate.js';

const VARIATION_SELECTORS = /[︀-️\u{E0100}-\u{E01EF}]/gu;
const TAGS = /<\/?(?:table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|br|hr|p|div|span|sup|sub|b|i|u|s|em|strong|small|img|a|center|figure|figcaption|ul|ol|li|h[1-6])\b[^>]*>/gi;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', shy: '', copy: '©', reg: '®', trade: '™', times: '×' };
const ELLIPSIS = /\[\s*(?:\.{3,}|…)\s*\]|\.{3,}|(?:\.\s){2,}\.|…|⋯/u;
/** A quote shorter than this many letters and digits proves nothing (it could be matched by markup alone). */
const MIN_KEY = 6;
/** The pieces of an elided quote must be this long, so "the … of" cannot be found anywhere. */
const MIN_PIECE = 6;

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return ' '; }
    }
    return Object.hasOwn(ENTITIES, body.toLowerCase()) ? ENTITIES[body.toLowerCase()] : whole;
  });
}

/** The letters-and-digits key of a text. `escapes` reads a literal backslash-n/t/r as the line break a double-escaped reply meant. */
function keyOf(text, escapes) {
  let value = decodeEntities(String(text ?? '').replace(TAGS, ' ')).replace(FOOTNOTE_MARK, ' ');
  if (escapes) value = value.replace(/\\[ntr]/g, ' ');
  return value.normalize('NFKC').toLowerCase().replace(VARIATION_SELECTORS, '').replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
}

/** The comparison keys of a text: a double-escaped "\n" is a line break in one reading and the start of a LaTeX command (\theta) in the other, so both are kept. */
export function quoteKeys(text) {
  const raw = String(text ?? '');
  const plain = keyOf(raw, false);
  if (!/\\[ntr]/.test(raw)) return [plain];
  const escaped = keyOf(raw, true);
  return escaped === plain ? [plain] : [escaped, plain];
}

/** The text of a quote as one comparison key (the first reading). */
export const quoteKey = (text) => quoteKeys(text)[0];

/** The parts of a quote that is elided with "…" / "..." / "[...]", as comparison keys (one part for an ordinary quote). */
function pieces(quote, escapes) {
  return String(quote ?? '').split(ELLIPSIS).map((piece) => keyOf(piece, escapes)).filter(Boolean);
}

/** Where `parts` occur in order in `haystack`, searching from `from`: { start, end } or null. */
function place(haystack, parts, from = 0) {
  if (!parts.length || (parts.length === 1 ? parts[0].length < 1 : parts.some((part) => part.length < MIN_PIECE))) return null;
  const first = haystack.indexOf(parts[0], from);
  if (first < 0) return null;
  let end = first + parts[0].length;
  for (const part of parts.slice(1)) {
    const at = haystack.indexOf(part, end);
    if (at < 0) return null;
    end = at + part.length;
  }
  return { start: first, end };
}

const ESCAPES = /\\[ntr]/;

/**
 * The ways a quote is compared with a text: each reading of its escapes (only when either side has a literal "\n"-style escape), and for each
 * reading the whole quote and, when it has an ellipsis, its pieces (the ellipsis may be part of the page's own wording, so the whole quote goes first).
 */
function candidates(text, quote) {
  const readings = ESCAPES.test(String(text ?? '')) || ESCAPES.test(String(quote ?? '')) ? [false, true] : [false];
  return readings.flatMap((escapes) => {
    const whole = [keyOf(quote, escapes)], split = pieces(quote, escapes);
    return (split.length > 1 ? [whole, split] : [whole]).map((parts) => ({ escapes, parts }));
  });
}

/** Whether the quote is in the text, modulo everything that carries no meaning (see the top of this file). */
export function quoteFound(sourceText, quote) {
  const source = new Map();
  const keyed = (escapes) => source.get(escapes) ?? (source.set(escapes, keyOf(sourceText, escapes)), source.get(escapes));
  return candidates(sourceText, quote).some(({ escapes, parts }) => parts.join('').length >= 1 && !!place(keyed(escapes), parts));
}

/** The sources of a selection as ordered pages: every slice of a long source (same id) is one page, and neighbouring pages are known. */
export function quotePages(sources) {
  if (sources?.byId instanceof Map) return sources;
  const order = [], byId = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    if (typeof source?.id !== 'string') continue;
    if (!byId.has(source.id)) { const page = { id: source.id, index: order.length, texts: [] }; byId.set(source.id, page); order.push(page); }
    byId.get(source.id).texts.push(String(source.text ?? ''));
  }
  for (const page of order) { page.text = page.texts.join('\n'); delete page.texts; }
  return { byId, order };
}

const keyedAs = (page, escapes) => (page.keys ||= {})[escapes] ??= keyOf(page.text, escapes);

/** The same key as keyOf, with the place in the cleaned text every key character came from: the diagnosis quotes the page back. */
function keyedWithMap(text, escapes) {
  let value = decodeEntities(String(text ?? '').replace(TAGS, ' '));
  if (escapes) value = value.replace(/\\[ntr]/g, ' ');
  const chars = [], map = [];
  for (let at = 0; at < value.length; at++) {
    for (const char of value[at].normalize('NFKC').toLowerCase()) {
      if (VARIATION_ONE.test(char)) continue;
      if (/[\p{L}\p{N}\p{M}]/u.test(char)) { chars.push(char); map.push(at); }
    }
  }
  return { key: chars.join(''), map, text: value.replace(/\s+/g, ' ').trim() };
}
const VARIATION_ONE = new RegExp(VARIATION_SELECTORS.source, 'u');

const commonPrefix = (a, b) => { let at = 0; while (at < a.length && at < b.length && a[at] === b[at]) at++; return at; };

/* Why a quote is not on its page (#486): the normalised sides, the closest place on the page with a short piece of its own text, the first character
   that differs, and whether the page simply ends in the middle of the quote (that is a cut, not a wrong quote). Cheap on purpose: it runs only when a
   citation has already failed, and it seeds the alignment with the first characters of the quote instead of scanning every offset. */
function quoteDiagnosis(page, quote, escapes, parts) {
  const wanted = parts.join('');
  const { key, map, text } = keyedWithMap(page.text, escapes);
  let best = { at: -1, lcp: 0 };
  const consider = (at) => { const lcp = commonPrefix(key.slice(at), wanted); if (lcp > best.lcp) best = { at, lcp }; };
  if (key && wanted) {
    const seed = wanted.slice(0, Math.min(6, wanted.length));
    for (let at = key.indexOf(seed); at >= 0; at = key.indexOf(seed, at + 1)) consider(at);
    for (let size = Math.min(wanted.length, 12); size >= 4 && best.at < 0; size--) {
      const at = key.indexOf(wanted.slice(0, size));
      if (at >= 0) consider(at);
    }
    if (best.at < 0) best = { at: 0, lcp: commonPrefix(key, wanted) };
  }
  const snippet = best.at >= 0 && best.lcp > 0 ? text.slice(map[best.at], map[best.at + best.lcp - 1] + 1) : '';
  const ratio = wanted.length ? Number((best.lcp / wanted.length).toFixed(3)) : 0;
  const cut = best.at >= 0 && best.at + best.lcp >= key.length && best.lcp < wanted.length;
  const kind = cut && best.lcp >= 4 ? 'truncated' : best.lcp >= 4 && ratio >= 0.6 ? 'near-miss' : 'absent';
  return { kind, requested: { quote: wordsOf(quote), key: wanted },
    closest: { sourceId: page.id, page: page.index, matchedChars: best.lcp, similarity: ratio, quote: snippet },
    firstDifference: { index: best.lcp, requested: wanted[best.lcp] ?? null, source: best.at >= 0 ? key[best.at + best.lcp] ?? null : key[best.lcp] ?? null } };
}
const wordsOf = (quote) => String(quote ?? '').replace(/\s+/g, ' ').trim();
const usable = (parts) => parts.join('').length >= MIN_KEY;

/**
 * Check one citation `{ sourceId, quote }` against the pages. `{ ok: true, span: 'page' | 'across', neighbour? }` when its quote is on that page
 * (`across`: it starts there and runs on into `neighbour`, the page before or after); otherwise `{ ok: false, reason }` with reason
 * 'unknown-source', 'too-short' or 'quote-not-found', and `foundIn`: the other pages that hold the quote verbatim (not searched with `locate: false`,
 * which a check over a whole library does not need).
 */
export function citationCheck(pagesOrSources, ref, { locate = true } = {}) {
  const pages = quotePages(pagesOrSources), page = pages.byId.get(ref?.sourceId);
  const quote = wordsOf(ref?.quote);
  const searchable = quote.length >= 12 && candidates('', quote).some(({ parts }) => usable(parts));
  const holds = (target) => candidates(target.text, quote).some(({ escapes, parts }) => usable(parts) && !!place(keyedAs(target, escapes), parts));
  if (page && searchable) {
    for (const { escapes, parts } of candidates(page.text, quote)) {
      if (!usable(parts)) continue;
      if (place(keyedAs(page, escapes), parts)) return { ok: true, span: 'page' };
      for (const neighbour of [pages.order[page.index - 1], pages.order[page.index + 1]]) {
        if (!neighbour) continue;
        const before = neighbour.index < page.index, own = keyedAs(page, escapes), other = keyedAs(neighbour, escapes);
        const joined = before ? other + own : own + other, join = before ? other.length : own.length;
        for (let from = 0; ;) {
          const hit = place(joined, parts, from);
          if (!hit) break;
          if (hit.start < join && hit.end > join) return { ok: true, span: 'across', neighbour: neighbour.id };
          from = hit.start + 1;
        }
      }
    }
  }
  const foundIn = !searchable || !locate ? [] : pages.order.filter((other) => other.id !== ref?.sourceId && holds(other)).map((other) => other.id);
  if (!page) return { ok: false, reason: 'unknown-source', foundIn };
  if (!searchable) return { ok: false, reason: 'too-short', foundIn };
  const reading = candidates(page.text, quote)[0];
  return { ok: false, reason: 'quote-not-found', foundIn, diagnostics: quoteDiagnosis(page, quote, reading.escapes, reading.parts) };
}

/**
 * Citations whose page id is wrong but whose quote is verbatim on exactly the pages given are pointed at the first page that holds it;
 * nothing else changes (an invented quote stays as it is). { citations, changed }.
 */
export function reattributeCitations(citations, sources) {
  const pages = quotePages(sources);
  let changed = 0;
  const fixed = (Array.isArray(citations) ? citations : []).map((ref) => {
    if (!ref || typeof ref !== 'object' || typeof ref.quote !== 'string') return ref;
    const check = citationCheck(pages, ref);
    if (check.ok || !check.foundIn?.length || check.reason === 'too-short') return ref;
    changed++;
    return { ...ref, sourceId: check.foundIn[0] };
  });
  return { citations: fixed, changed };
}

/** The citations of a card that are not on their page: [{ index, sourceId, quote, reason, foundIn }]. */
export function citationProblems(card, sources) {
  const pages = quotePages(sources), problems = [];
  (Array.isArray(card?.citations) ? card.citations : []).forEach((ref, index) => {
    if (!ref || typeof ref !== 'object') return;
    const check = citationCheck(pages, ref);
    if (!check.ok) problems.push({ index, sourceId: ref.sourceId, quote: String(ref.quote ?? ''), reason: check.reason, foundIn: check.foundIn,
      ...(check.diagnostics ? { diagnostics: check.diagnostics } : {}) });
  });
  return problems;
}
