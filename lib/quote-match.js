/* Whether a quote a model gives is really on the page it cites. Pure; one rule for the plan, the author, the repair and the publish check.

   A quote must be the source's own wording, but a model never echoes a MinerU page byte for byte, and none of that carries meaning:
   line-end hyphenation ("architec-\ntural"), markup (**, #, |, $…$, \_), HTML tables and entities, typographic quotes and dashes,
   ligatures, soft hyphens, emoji bullets, line breaks. The comparison therefore runs on a key made only of letters and digits (after
   NFKC and lower case), so wording, numbers and order still have to be right while everything else is ignored. A footnote mark of the book
   (`」[^12]`, lib/quote-locate.js FOOTNOTE_MARK) is not wording either: its digits would otherwise join the key and fail a real quote. An elided quote
   ("first part … last part") must have each part in the page, in order. A quote may run over the end of its page into the next
   one. A quote that is verbatim on ANOTHER page of the same selection is not invented: the id was the model's slip (long
   document-…-p418 ids are easy to garble), and reattributeCitations() fixes exactly that. An invented quote stays rejected. */
import { FOOTNOTE_MARK, keyPositions } from './quote-locate.js';
// The text as a reader sees it (tags out, entities decoded, with the offsets in the stored text): a candidate passage is shown in its words.
import { visibleText } from './answer-card.js';

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

/** The sources of a selection as ordered pages: every slice of a long source (same id) is one page, neighbouring pages are known, and a page
    carries its number (`document.page`) when its source names one, so a diagnosis can say which page it means. */
export function quotePages(sources) {
  if (sources?.byId instanceof Map) return sources;
  const order = [], byId = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    if (typeof source?.id !== 'string') continue;
    if (!byId.has(source.id)) {
      const page = { id: source.id, index: order.length, texts: [] };
      if (Number.isInteger(source.document?.page)) page.page = source.document.page;
      byId.set(source.id, page); order.push(page);
    }
    byId.get(source.id).texts.push(String(source.text ?? ''));
  }
  for (const page of order) { page.text = page.texts.join('\n'); delete page.texts; }
  return { byId, order };
}

const keyedAs = (page, escapes) => (page.keys ||= {})[escapes] ??= keyOf(page.text, escapes);
const wordsOf = (quote) => String(quote ?? '').replace(/\s+/g, ' ').trim();
const usable = (parts) => parts.join('').length >= MIN_KEY;

/* ---------- why a quote is not on its page (#486) ----------

   `quote-not-found` alone leaves a writer guessing between four quite different faults: the passage is not there, it is there with a few
   characters changed, it is there but the page break cuts it (a running header then sits between the two halves, so the joined pages do not
   hold it either), or it is verbatim on another page. The diagnosis below answers with the comparison itself: the requested quote and its
   key, the closest passage of the cited page (and of its two neighbours) with its own key, the first character that differs and how much of
   the quote the passage shares. Only the letters-and-digits key is compared, exactly as the check compares it; nothing here writes, rewrites
   or stores a text. The scan is bounded to the pages the check already reads and to a fixed number of anchors per page, so a diagnosis never
   walks a whole book. */

/** A passage of the page is this passage, not a coincidence, when it shares this fraction of the quote's key ... */
const NEAR_SHARE = 0.5;
/** ... and this many of its letters and digits. */
const NEAR_LENGTH = 12;
/** How far into a neighbouring page a passage cut by the page break may start (a running header, a page number, a title), in key characters. */
const PAGE_EDGE = 240;
/** A passage cut by the page break shares at least this many letters and digits with the quote on the citing page. */
const CUT_LENGTH = 12;
/** Anchor widths of the closest-passage scan, longest first; anchors per width, occurrences of one anchor looked at, alignments kept. */
const ANCHOR_WIDTHS = [12, 8, 5];
const ANCHOR_POSITIONS = 24;
const ANCHOR_HITS = 12;
const ANCHOR_RUNS = 32;
const SNIPPET = 160;

const clip = (text, size = SNIPPET) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > size ? `${value.slice(0, size - 1)}…` : value;
};

/**
 * Every alignment of `key` in `pageKey`, the longest run of equal characters first: [{ quoteStart, pageStart, run }]. Anchors of the key find
 * the places, each found place is grown both ways, and a bounded number of anchors, occurrences and alignments are kept: the cost is a small
 * constant times the length of the quote, whatever the length of the page or of the book.
 */
function alignments(pageKey, key) {
  if (!pageKey || !key) return [];
  const runs = new Map();
  for (const width of ANCHOR_WIDTHS) {
    if (key.length < width) continue;
    // Anchors that cover the key end to end, so that every stretch of it is looked for (a shared run of at least twice the width holds one whole).
    const places = Math.min(ANCHOR_POSITIONS, Math.max(1, Math.ceil(key.length / width)));
    const step = places > 1 ? (key.length - width) / (places - 1) : 0;
    for (let n = 0; n < places; n++) {
      const start = Math.round(n * step), anchor = key.slice(start, start + width);
      let at = pageKey.indexOf(anchor), hits = 0;
      for (; at >= 0 && hits < ANCHOR_HITS; at = pageKey.indexOf(anchor, at + 1), hits++) {
        let left = 0, right = width;
        while (start - left > 0 && at - left > 0 && key[start - left - 1] === pageKey[at - left - 1]) left++;
        while (start + right < key.length && at + right < pageKey.length && key[start + right] === pageKey[at + right]) right++;
        const quoteStart = start - left, pageStart = at - left, run = left + right, seen = runs.get(`${quoteStart}:${pageStart}`);
        if (!seen || seen.run < run) runs.set(`${quoteStart}:${pageStart}`, { quoteStart, pageStart, run });
      }
    }
  }
  return [...runs.values()].sort((a, b) => b.run - a.run || a.quoteStart - b.quoteStart || a.pageStart - b.pageStart).slice(0, ANCHOR_RUNS);
}

/** The first key character of the quote the page does not have at this alignment, and how many of them differ over the whole window. */
function differenceAt(key, align, pageKey) {
  let difference = null, different = 0;
  for (let index = 0; index < key.length; index++) {
    const at = align + index;
    const found = at >= 0 && at < pageKey.length ? pageKey[at] : null;
    if (found === key[index]) continue;
    different++;
    difference ||= { index, asked: key[index], found };
  }
  return { difference, different };
}

/** A page's text as a reader sees it and, for each reading, the offset of every character of its key (both computed once per page). */
const seenAs = (page) => page.visible ??= visibleText(String(page.text ?? ''));
const positionsAs = (page, escapes) => (page.positions ||= {})[escapes]
  ??= keyPositions(escapes ? seenAs(page).text.replace(/\\[ntr]/g, '  ') : seenAs(page).text);

/**
 * One page's closest passage to a quote key at one alignment: { sourceId, page?, start, end, quote, key, shared, different, similarity, difference }.
 * `key` is the page's own key over the same window, so the two keys can be read side by side; `start`/`end` are offsets in the page's stored
 * text, null when its markup cannot be walked back (the comparison is then still there, only the place in the text is not). `window` (key
 * offsets) narrows the passage to the page's own part of a passage the page break cuts.
 */
function passageOf(page, key, escapes, at, window = null) {
  const pageKey = keyedAs(page, escapes), align = at.pageStart - at.quoteStart;
  const begin = Math.max(0, window ? window.start : align), finish = Math.min(pageKey.length, window ? window.end : align + key.length);
  const { difference, different } = differenceAt(key, align, pageKey);
  const seen = seenAs(page), positions = positionsAs(page, escapes);
  let start = null, end = null, quote = null;
  if (positions.key === pageKey && finish > begin) {
    const first = positions.from[begin], last = positions.from[finish - 1] + positions.width[finish - 1];
    start = seen.from ? seen.from[first] : first;
    end = seen.from ? seen.to[last - 1] : last;
    quote = clip(seen.text.slice(Math.max(0, first - 48), Math.min(seen.text.length, last + 48)));
  }
  return { sourceId: page.id, ...(Number.isInteger(page.page) ? { page: page.page } : {}), start, end, quote,
    key: pageKey.slice(begin, finish), shared: at.run, different, similarity: Math.round(((key.length - different) / key.length) * 1000) / 1000, difference };
}

/** The pages of the selection other than the cited one that hold the quote verbatim. */
function pagesHolding(pages, ref) {
  const quote = wordsOf(ref?.quote);
  return pages.order.filter((other) => other.id !== ref?.sourceId
    && candidates(other.text, quote).some(({ escapes, parts }) => usable(parts) && !!place(keyedAs(other, escapes), parts))).map((other) => other.id);
}

/** Every reading of a quote as one comparison key, with the escapes reading that produced it. */
function keysOf(quote) {
  return [...new Map(candidates('', quote).map(({ escapes, parts }) => [parts.join(''), escapes])).entries()]
    .filter(([key]) => key.length >= MIN_KEY).map(([key, escapes]) => ({ key, escapes }));
}

/** The one plain sentence of a diagnosis: the fields carry the detail. */
function say(kind, { key, candidate, other, side }) {
  if (kind === 'other-page') return `The quote is verbatim on ${other.id}, not on the page it cites.`;
  if (kind === 'across-page') return side === 'after'
    ? `The passage is in the material, but the page break cuts it: the page holds its first ${candidate.shared} letters and digits and the rest begins on ${other.id}.`
    : `The passage is in the material, but the page break cuts it: its first part ends on ${other.id} and this page holds the rest.`;
  if (kind === 'near-miss') return candidate.difference
    ? `The material holds this passage with ${candidate.different} of its ${key.length} letters and digits different, the first at index ${candidate.difference.index}.`
    : 'The material holds these letters and digits in this order, but not as they are written (punctuation, spacing or markup differs).';
  return `Nothing on the page or its neighbours is close to this quote${candidate
    ? ` (the closest passage shares ${candidate.shared} of its ${key.length} letters and digits)` : ''}.`;
}

/**
 * Why a quote is not on the page it cites (#486): { kind, sourceId, page?, quote, key, candidate, foundIn?, continuedOn?, continuedFrom?, message }.
 * kind is 'absent' (the material has no such passage), 'near-miss' (it has it with a few characters different), 'across-page' (the page break cuts
 * it: the citing page holds one part and the neighbouring page the rest) or 'other-page' (the quote is verbatim on another page, `foundIn`).
 * `quote`/`key` are the requested words and their comparison key. `candidate` is the closest passage: its sourceId, page and offsets in the
 * stored text, its own words and key over the same window, `shared` the longest run of characters equal to the quote's at that alignment, `different`
 * how many of the quote's characters differ there, `similarity` the share that does not, and `difference` the first one that does ({ index } in the
 * key, the character the quote has there, the one the page has — null at the page's own edge). Bounded to the cited page and its two neighbours.
 */
function diagnosisOf(pages, page, ref, foundIn) {
  const asked = wordsOf(ref?.quote), tries = keysOf(asked);
  if (!tries.length) return null;
  const before = pages.order[page.index - 1], after = pages.order[page.index + 1];
  const found = foundIn.length ? pages.byId.get(foundIn[0]) : null;
  let best = null, cut = null, holds = null;
  for (const { key, escapes } of tries) {
    const ownKey = keyedAs(page, escapes), own = alignments(ownKey, key);
    // The page break cuts the passage: this page holds its beginning and the next page the rest (a running header sits in between).
    const head = own.find((at) => at.quoteStart === 0 && at.run >= CUT_LENGTH && at.run < key.length
      && ownKey.length - (at.pageStart + at.run) <= PAGE_EDGE);
    const restAt = head && after ? keyedAs(after, escapes).indexOf(key.slice(head.run)) : -1;
    if (head && restAt >= 0 && restAt <= PAGE_EDGE) cut = { page, key, escapes, at: head, other: after, side: 'after' };
    // ... or the previous page holds the beginning and this page the rest.
    const tail = cut ? null : own.find((at) => at.quoteStart >= CUT_LENGTH && at.quoteStart + at.run === key.length && at.pageStart <= PAGE_EDGE);
    const headAt = tail && before ? keyedAs(before, escapes).lastIndexOf(key.slice(0, tail.quoteStart)) : -1;
    if (tail && headAt >= 0 && keyedAs(before, escapes).length - (headAt + tail.quoteStart) <= PAGE_EDGE)
      cut = { page, key, escapes, at: tail, other: before, side: 'before' };
    // The closest passage of this page, its neighbours, and the page that really holds the quote: the alignment that leaves the fewest of
    // the quote's characters different, not merely the longest equal run, so that two changed characters do not read as a stranger passage.
    for (const other of [page, after, before, found]) {
      if (!other) continue;
      const otherKey = keyedAs(other, escapes);
      for (const at of alignments(otherKey, key)) {
        const matched = key.length - differenceAt(key, at.pageStart - at.quoteStart, otherKey).different;
        const better = !best || matched > best.matched || (matched === best.matched && at.run > best.at.run)
          || (matched === best.matched && at.run === best.at.run && other === page && best.page !== page);
        if (better) best = { page: other, key, escapes, at, matched };
        if (other === found && at.run === key.length && !holds) holds = { page: other, key, escapes, at, matched };
      }
    }
  }
  const pick = holds || cut || best, key = pick?.key ?? tries[0].key;
  // A passage cut by the page break is shown as this page's own part of it, not as a window that starts before the page.
  const ownPart = pick && pick === cut ? { start: cut.at.pageStart, end: cut.at.pageStart + cut.at.run } : null;
  const candidate = pick ? passageOf(pick.page, pick.key, pick.escapes, pick.at, ownPart) : null;
  const kind = holds ? 'other-page' : cut ? 'across-page'
    : best && best.matched >= NEAR_LENGTH && best.matched / key.length >= NEAR_SHARE ? 'near-miss' : 'absent';
  return { kind, sourceId: page.id, ...(Number.isInteger(page.page) ? { page: page.page } : {}), quote: asked, key, candidate,
    ...(cut ? { [cut.side === 'after' ? 'continuedOn' : 'continuedFrom']: cut.other.id } : {}),
    ...(foundIn.length ? { foundIn } : {}),
    message: say(kind, { key, candidate, other: holds?.page ?? cut?.other, side: cut?.side }) };
}

/**
 * The diagnosis of a quote that is not on the page it cites, for a caller that has only the pages and the citation (see diagnosisOf for the shape).
 * null when the page is unknown or the quote has too few letters and digits to compare.
 */
export function quoteDiagnosis(pagesOrSources, ref) {
  const pages = quotePages(pagesOrSources), page = pages.byId.get(ref?.sourceId);
  if (!page) return null;
  return diagnosisOf(pages, page, ref, pagesHolding(pages, ref));
}

/**
 * Check one citation `{ sourceId, quote }` against the pages. `{ ok: true, span: 'page' | 'across', neighbour? }` when its quote is on that page
 * (`across`: it starts there and runs on into `neighbour`, the page before or after); otherwise `{ ok: false, reason }` with reason
 * 'unknown-source', 'too-short' or 'quote-not-found', and `foundIn`: the other pages that hold the quote verbatim (not searched with `locate: false`,
 * which a check over a whole library does not need). A quote that is not found carries `diagnosis` (see diagnosisOf): why it is not there, which
 * is what lets a writer correct the quote instead of guessing at the normalisation rule.
 */
export function citationCheck(pagesOrSources, ref, { locate = true } = {}) {
  const pages = quotePages(pagesOrSources), page = pages.byId.get(ref?.sourceId);
  const quote = wordsOf(ref?.quote);
  const searchable = quote.length >= 12 && candidates('', quote).some(({ parts }) => usable(parts));
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
  const foundIn = !searchable || !locate ? [] : pagesHolding(pages, ref);
  if (!page) return { ok: false, reason: 'unknown-source', foundIn };
  if (!searchable) return { ok: false, reason: 'too-short', foundIn };
  const diagnosis = diagnosisOf(pages, page, ref, foundIn);
  return { ok: false, reason: 'quote-not-found', foundIn, ...(diagnosis ? { diagnosis } : {}) };
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

/** The citations of a card that are not on their page: [{ index, sourceId, quote, reason, foundIn, diagnosis? }]. */
export function citationProblems(card, sources) {
  const pages = quotePages(sources), problems = [];
  (Array.isArray(card?.citations) ? card.citations : []).forEach((ref, index) => {
    if (!ref || typeof ref !== 'object') return;
    const check = citationCheck(pages, ref);
    if (!check.ok) problems.push({ index, sourceId: ref.sourceId, quote: String(ref.quote ?? ''), reason: check.reason, foundIn: check.foundIn,
      ...(check.diagnosis ? { diagnosis: check.diagnosis } : {}) });
  });
  return problems;
}
