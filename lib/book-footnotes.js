/* The footnotes of a 复习全书 file the main chat writes (book.write, lib/book-agent-write.js): a quote is a footnote, and a footnote is kept only when its
   words are found WORD FOR WORD in the material it names (lib/book-quote.js), else in the point's own passages. Pure.

   Written by the chat as `[^n]: 「exact words」 (sourceId)` (or the book's own form, `[^n]: [「words」](studyhub://source/<id>) · title`, as book.read shows
   it). Kept footnotes are written in the book's form, numbered 1, 2, ... in the order their marks first appear, as ONE list under the 出处 label at the
   end of the file (footnoteProblems checks it); two marks of the same place share one number. Footnote keys arrive namespaced by the writer
   (takeFootnotes: `n-<key>` new text, `o-<key>` the file as it was), so a section's [^1] never takes another section's [^1].
   A mark and its footnote go together (#460):
     - a footnote whose words are not found is taken out with its marks and reported (`dropped`); a mark with no footnote at all likewise;
     - except a footnote whose text is EXACTLY one the file already holds (`known`): when it is not found again (a source gone, a note written by
       hand) it is kept as it was written, renumbered with the others, and named (`unchecked`), so a write elsewhere never deletes marks the file
       already had. A footnote the write adds or whose words it changes is always checked;
     - a footnote no mark points at any more is left out (`unused`): its last mark went;
     - a key the text defines more than once (several 出处 lists of [^1]…[^n]) is several footnotes, each mark bound to the first list after it;
     - a mark of a new text with no footnote of its own takes the file's footnote of that key (`borrowed`, named by the writer).
   The quote of a footnote is read to its own closing quotation mark, and a footnote mark of the book is never part of it (#467). */
import { locateQuote } from './book-quote.js';
import { FOOTNOTE_MARK } from './quote-locate.js';
import { bookLinks, parseBookLink } from './course-book-links.js';
import { isLibraryListSource } from './exam-point-list.js';

/** A definition line; a chat writing Chinese may type the full-width colon. */
export const DEFINITION = /^\[\^([\w-]{1,44})\][:：][ \t]*(.*)$/;
const MARK = /( ?)\[\^([\w-]{1,44})\](?!:)/g;
/** A mark as the text writes it (keys of at most 40 characters: the writer's prefix must still fit a MARK). */
const RAW_MARK = /\[\^([\w-]{1,40})\](?!:)/g;
/** The pairs a footnote's quote may be put in; one that opens again inside (「…「…」…」) closes once more. */
const PAIRS = { '「': '」', '『': '』', '“': '”', '‘': '’', '"': '"', "'": "'" };
const SOURCE_TAIL = /^\s*(?:\[\^[\w-]{1,44}\]\s*)*(?:[(（]\s*([^()（）\s]+)\s*[)）])?/;
const LABELS = { zh: '出处', en: 'Sources' };
const QUOTES = { zh: text => `「${text}」`, en: text => `“${text}”` };
const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The words and the source a footnote's text names: { quote, sourceId|null }, or null when it holds no quote. */
export function parseFootnote(body) {
  const text = String(body ?? '').trim();
  const link = /^\[\s*(.+?)\s*\]\((studyhub:\/\/source\/[^)\s]+)\)/.exec(text);
  if (link) return { quote: unmark(unquote(link[1])), sourceId: parseBookLink(link[2])?.sourceId ?? null };
  const end = closingAt(text);
  if (end > 1) return { quote: unmark(text.slice(1, end)), sourceId: SOURCE_TAIL.exec(text.slice(end + 1))[1] ?? null };
  const plain = /^[「“"『‘'](.+?)[」”"』’']\s*(?:[(（]\s*([^()（）\s]+)\s*[)）])?/.exec(text);
  if (plain) return { quote: unmark(plain[1]), sourceId: plain[2] ?? null };
  return null;
}
const unquote = text => text.replace(/^[「“"『‘']/, '').replace(/[」”"』’']$/, '').trim();
const unmark = text => text.replace(FOOTNOTE_MARK, '').trim();
/** Where the quotation mark that opens `text` is closed (-1: it is not), counting the same pair opened again inside. */
function closingAt(text) {
  const open = text[0], close = PAIRS[open];
  if (!close) return -1;
  for (let at = 1, depth = 1; at < text.length; at++) {
    if (text[at] === close && --depth === 0) return at;
    if (text[at] === open && open !== close) depth++;
  }
  return -1;
}

/**
 * The footnote definitions of `lines` taken out and every mark named for the definition it means: `<prefix>-<key>`, or `<prefix><g>-<key>` for the
 * g-th different definition of a key the text defines more than once (a file with several 出处 lists of [^1]…[^n]). A mark means the first definition
 * of its key after it (the list that closes its part), else the last one; the same words defined twice are one footnote. A mark with no definition here
 * takes `fallback`'s (`{ prefix, has }`: the file's footnotes, for a new section), else keeps `<prefix>-<key>` with nothing behind it.
 * -> { lines, pool: Map id -> footnote text, defined: Set of keys, missing / borrowed: Map key -> how many marks have no definition / took
 * `fallback`'s }. Pure, deterministic.
 */
export function takeFootnotes(lines, prefix, fallback = null) {
  const kept = [], byKey = new Map(), pool = new Map(), missing = new Map(), borrowed = new Map();
  for (const line of lines) {
    const found = DEFINITION.exec(line.trim());
    if (!found) { kept.push(line); continue; }
    const [, key, value] = found, list = byKey.get(key) ?? [], ids = [...new Set(list.map(item => item.id))];
    const id = ids.find(known => squash(pool.get(known)) === squash(value)) ?? (ids.length ? `${prefix}${ids.length + 1}-${key}` : `${prefix}-${key}`);
    if (!pool.has(id)) pool.set(id, value);
    byKey.set(key, [...list, { id, at: kept.length }]);
  }
  const bind = (key, at) => {
    const list = byKey.get(key);
    if (list) return (list.find(item => item.at > at) ?? list.at(-1)).id;
    if (fallback?.has(`${fallback.prefix}-${key}`)) { borrowed.set(key, (borrowed.get(key) ?? 0) + 1); return `${fallback.prefix}-${key}`; }
    missing.set(key, (missing.get(key) ?? 0) + 1);
    return `${prefix}-${key}`;
  };
  return { lines: kept.map((line, at) => line.replace(RAW_MARK, (mark, key) => `[^${bind(key, at)}]`)), pool, defined: new Set(byKey.keys()), missing, borrowed };
}

/**
 * What is wrong with the footnotes of a settled text (the writer's check before anything is saved): [] when the definitions are one list [^1]…[^n]
 * in order, each marked, and every mark has its definition. Pure.
 */
export function footnoteProblems(text) {
  const keys = [], marks = new Set(), problems = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const found = DEFINITION.exec(line.trim());
    if (found) keys.push(found[1]);
    else for (const mark of line.matchAll(MARK)) marks.add(mark[2]);
  }
  keys.forEach((key, at) => { if (key !== String(at + 1)) problems.push(`footnote ${at + 1} of the list is [^${key}]`); });
  for (const key of marks) if (!keys.includes(key)) problems.push(`[^${key}] has no footnote`);
  for (const key of new Set(keys)) if (!marks.has(key)) problems.push(`[^${key}] is marked nowhere`);
  return problems;
}

/** The footnote texts of a file (its definitions, spaces squashed): what settleFootnotes may keep as written. */
export const knownFootnotes = text => new Set(String(text ?? '').split(/\r?\n/).map(line => DEFINITION.exec(line.trim())).filter(Boolean).map(found => squash(found[2])));

/** The label line of the 出处 list (either language), which the writer takes out and puts back with the footnotes. */
export const isLabelLine = line => /^\*\*(出处|Sources)\*\*$/.test(line.trim());

/**
 * Settles the footnotes of `body` (a text without definition lines) against `pool` (Map key -> footnote text): -> { text, dropped: [{ n, quote, reason }],
 * unused: [n], unchecked: [{ n (its number in the saved file), was (as the text wrote it) }] } where `text` is the body with its marks numbered and, when any is kept, the label and the footnotes in the book's form
 * appended (see the top of this file for what is dropped, left out or kept as written). `segments`: the point's passages; `byId`: the library's sources;
 * `known`: the footnote texts of the file as it was (knownFootnotes), the only ones kept as written when they are not found again.
 */
export function settleFootnotes(body, pool, { segments = [], byId = new Map(), language = 'zh', known = new Set() } = {}) {
  const places = new Map(), verdicts = new Map(), kept = [], dropped = [], used = new Set(), unchecked = [];
  const shownKey = key => key.replace(/^[no]\d*-/, '');
  // A footnote the file already had, word for word: kept as written when it is not found again.
  const ownKey = key => known.has(squash(pool.get(key)));
  const verify = key => {
    if (verdicts.has(key)) return verdicts.get(key);
    const parsed = parseFootnote(pool.get(key));
    let verdict;
    if (!parsed) verdict = { reason: 'no-quote' };
    else {
      const source = parsed.sourceId ? byId.get(parsed.sourceId) : null;
      const own = source && !isLibraryListSource(source) && typeof source.text === 'string' ? [{ sourceId: source.id, start: 0, text: source.text }] : [];
      const place = locateQuote(own, parsed.quote) ?? locateQuote(segments, parsed.quote);
      verdict = place ? { place } : { reason: parsed.quote.replace(/\s/g, '').length < 8 ? 'too-short' : 'not-found', quote: parsed.quote };
    }
    verdicts.set(key, verdict);
    return verdict;
  };
  const text = String(body ?? '').replace(MARK, (mark, space, key) => {
    used.add(key);
    if (!pool.has(key)) { if (!dropped.some(item => item.key === key)) dropped.push({ key, n: shownKey(key), quote: '', reason: 'no-footnote' }); return ''; }
    const verdict = verify(key);
    if (!verdict.place && !ownKey(key)) {
      if (!dropped.some(item => item.key === key)) dropped.push({ key, n: shownKey(key), quote: clip(squash(verdict.quote), 80), reason: verdict.reason });
      return '';
    }
    const written = squash(pool.get(key));
    const at = verdict.place ? `${verdict.place.sourceId}|${verdict.place.start}|${verdict.place.end}` : `written|${written}`;
    if (!places.has(at)) {
      places.set(at, places.size + 1);
      kept.push(verdict.place ?? { written });
      if (!verdict.place) unchecked.push({ n: String(places.size), was: shownKey(key) });
    }
    return `${space}[^${places.get(at)}]`;
  });
  const unused = [...new Set([...pool.keys()].filter(key => !used.has(key) && (verify(key).place || ownKey(key))).map(shownKey))];
  // A new footnote that names a quote but is not marked anywhere and not found is dropped too.
  for (const key of pool.keys()) if (!used.has(key) && !ownKey(key) && !verify(key).place && !dropped.some(item => item.key === key)) dropped.push({ key, n: shownKey(key), quote: clip(squash(verify(key).quote), 80), reason: verify(key).reason });
  const label = LABELS[language === 'en' ? 'en' : 'zh'], quote = QUOTES[language === 'en' ? 'en' : 'zh'];
  const lines = kept.map((place, at) => {
    if (place.written !== undefined) return `[^${at + 1}]: ${place.written}`;
    const title = squash(byId.get(place.sourceId)?.title);
    // The original's words whole (at most the quote limit already): a clipped quote would not be found again on the next write.
    return `[^${at + 1}]: [${quote(squash(place.quote.replace(FOOTNOTE_MARK, '')).replace(/[[\]]/g, ' '))}](${bookLinks.source(place.sourceId)})${title ? ` · ${clip(title.replace(/[[\]]/g, ' '), 120)}` : ''}`;
  });
  const settled = lines.length ? `${text.replace(/\s+$/, '')}\n\n**${label}**\n\n${lines.join('\n')}` : text.replace(/\s+$/, '');
  return { text: settled, dropped: dropped.map(({ n, quote: words, reason }) => ({ n, quote: words, reason })), unused, unchecked, kept: kept.length };
}
