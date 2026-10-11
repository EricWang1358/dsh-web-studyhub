/* The footnotes of a 复习全书 file the main chat writes (book.write, lib/book-agent-write.js): a quote is a footnote, and a footnote is kept only when its
   words are found WORD FOR WORD in the material it names (lib/book-quote.js), else in the point's own passages. Pure.

   Written by the chat as `[^n]: 「exact words」 (sourceId)` (or the book's own form, `[^n]: [「words」](studyhub://source/<id>) · title`, as book.read shows
   it). Kept footnotes are written in the book's form, numbered 1, 2, ... in the order their marks first appear, under the 出处 label at the end of the
   file; a mark whose footnote is missing or not found is taken out, and the footnote is reported (`dropped`). Two marks of the same place share one
   number. Footnote keys arrive namespaced by the writer (`n-<key>` new text, `o-<key>` the file as it was), so a section's [^1] never takes another
   section's [^1]. */
import { locateQuote } from './book-quote.js';
import { bookLinks, parseBookLink } from './course-book-links.js';
import { isLibraryListSource } from './exam-point-list.js';

export const DEFINITION = /^\[\^([\w-]{1,44})\]:[ \t]*(.*)$/;
const MARK = /( ?)\[\^([\w-]{1,44})\](?!:)/g;
const LABELS = { zh: '出处', en: 'Sources' };
const QUOTES = { zh: text => `「${text}」`, en: text => `“${text}”` };
const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The words and the source a footnote's text names: { quote, sourceId|null }, or null when it holds no quote. */
export function parseFootnote(body) {
  const text = String(body ?? '').trim();
  const link = /^\[\s*(.+?)\s*\]\((studyhub:\/\/source\/[^)\s]+)\)/.exec(text);
  if (link) return { quote: unquote(link[1]), sourceId: parseBookLink(link[2])?.sourceId ?? null };
  const plain = /^[「“"『‘'](.+?)[」”"』’']\s*(?:[(（]\s*([^()（）\s]+)\s*[)）])?/.exec(text);
  if (plain) return { quote: plain[1].trim(), sourceId: plain[2] ?? null };
  return null;
}
const unquote = text => text.replace(/^[「“"『‘']/, '').replace(/[」”"』’']$/, '').trim();

/** The label line of the 出处 list (either language), which the writer takes out and puts back with the footnotes. */
export const isLabelLine = line => /^\*\*(出处|Sources)\*\*$/.test(line.trim());

/**
 * Settles the footnotes of `body` (a text without definition lines) against `pool` (Map key -> footnote text): -> { text, dropped: [{ n, quote, reason }],
 * unused: [n] } where `text` is the body with its marks numbered and, when any is kept, the label and the footnotes in the book's form appended.
 * `segments`: the point's passages; `byId`: the library's sources.
 */
export function settleFootnotes(body, pool, { segments = [], byId = new Map(), language = 'zh' } = {}) {
  const places = new Map(), verdicts = new Map(), kept = [], dropped = [], used = new Set();
  const shownKey = key => key.replace(/^[no]-/, '');
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
    if (!verdict.place) {
      if (!dropped.some(item => item.key === key)) dropped.push({ key, n: shownKey(key), quote: clip(squash(verdict.quote), 80), reason: verdict.reason });
      return '';
    }
    const at = `${verdict.place.sourceId}|${verdict.place.start}|${verdict.place.end}`;
    if (!places.has(at)) { places.set(at, places.size + 1); kept.push(verdict.place); }
    return `${space}[^${places.get(at)}]`;
  });
  const unused = [...pool.keys()].filter(key => !used.has(key) && verify(key).place).map(shownKey);
  // A footnote that names a quote but is not marked anywhere and not found is dropped too.
  for (const key of pool.keys()) if (!used.has(key) && !verify(key).place && !dropped.some(item => item.key === key)) dropped.push({ key, n: shownKey(key), quote: clip(squash(verify(key).quote), 80), reason: verify(key).reason });
  const label = LABELS[language === 'en' ? 'en' : 'zh'], quote = QUOTES[language === 'en' ? 'en' : 'zh'];
  const lines = kept.map((place, at) => {
    const title = squash(byId.get(place.sourceId)?.title);
    // The original's words whole (at most the quote limit already): a clipped quote would not be found again on the next write.
    return `[^${at + 1}]: [${quote(squash(place.quote).replace(/[[\]]/g, ' '))}](${bookLinks.source(place.sourceId)})${title ? ` · ${clip(title.replace(/[[\]]/g, ' '), 120)}` : ''}`;
  });
  const settled = lines.length ? `${text.replace(/\s+$/, '')}\n\n**${label}**\n\n${lines.join('\n')}` : text.replace(/\s+$/, '');
  return { text: settled, dropped: dropped.map(({ n, quote: words, reason }) => ({ n, quote: words, reason })), unused, kept: kept.length };
}
