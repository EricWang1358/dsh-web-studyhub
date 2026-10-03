/* Whether a quote a model gives is really on the page it cites. Pure; one rule for the plan, the author, the repair and the publish check.

   A quote must be the source's own wording, but a model never echoes a MinerU page byte for byte, and none of that carries meaning:
   line-end hyphenation ("architec-\ntural"), markup (**, #, |, $…$, \_), HTML tables and entities, typographic quotes and dashes,
   ligatures, soft hyphens, emoji bullets, line breaks. The comparison therefore runs on a key made only of letters and digits (after
   NFKC and lower case), so wording, numbers and order still have to be right while everything else is ignored. An elided quote
   ("first part … last part") must have each part in the page, in order. A quote may run over the end of its page into the next
   one. A quote that is verbatim on ANOTHER page of the same selection is not invented: the id was the model's slip (long
   document-…-p418 ids are easy to garble), and reattributeCitations() fixes exactly that. An invented quote stays rejected. */

const VARIATION_SELECTORS = /[︀-️\u{E0100}-\u{E01EF}]/gu;
const TAGS = /<\/?(?:table|thead|tbody|tfoot|tr|td|th|caption|colgroup|col|br|hr|p|div|span|sup|sub|b|i|u|s|em|strong|img|a|center|figure|figcaption|ul|ol|li|h[1-6])\b[^>]*>/gi;
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
  let value = decodeEntities(String(text ?? '').replace(TAGS, ' '));
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
  return { ok: false, reason: searchable ? 'quote-not-found' : 'too-short', foundIn };
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
    if (!check.ok) problems.push({ index, sourceId: ref.sourceId, quote: String(ref.quote ?? ''), reason: check.reason, foundIn: check.foundIn });
  });
  return problems;
}
