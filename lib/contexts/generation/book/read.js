import { parseJson } from '../../../generation.js';
import { createLocator } from '../../../quote-locate.js';
import { NOTES_LIMITS } from '../../../course-book.js';
import { ISSUES_MAX, QUOTE_MIN, UNIT_CITES } from './constants.js';

/* Reading the model's answers of a review book build. Nothing is trusted: an answer that is not the shape asked for is null (asked once more); an id that was
   not asked is ignored; a quote is kept only when it is found WORD FOR WORD in the unit's own pages (lib/quote-locate.js) and is then stored as the original's
   own words and place; the mark of a quote not kept is taken out, the marks are numbered again 1, 2, ... in reading order. */

const object = value => value && typeof value === 'object' && !Array.isArray(value);
function parse(text) { try { const value = parseJson(String(text)); return object(value) ? value : null; } catch { return null; } }
const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const MARK = /\s?\[\^?(\d{1,2})\]/g;

/** Where a quote stands in the unit's pages: { sourceId, quote (the original's words), start, end }, or null. */
function locate(unit, raw) {
  const quote = clean(raw?.quote, NOTES_LIMITS.quoteChars).replace(/\s+/g, ' ');
  if (quote.replace(/\s/g, '').length < QUOTE_MIN) return null;
  const wanted = unit.segments[Number(/^S(\d+)$/.exec(String(raw?.ref ?? ''))?.[1]) - 1];
  for (const segment of wanted ? [wanted, ...unit.segments.filter(part => part !== wanted)] : unit.segments) {
    const at = createLocator(segment.text)(quote);
    if (!at) continue;
    const words = segment.text.slice(at.start, at.end).replace(/\s+/g, ' ').trim();
    if (words.length <= NOTES_LIMITS.quoteChars) return { sourceId: segment.sourceId, quote: words, start: segment.start + at.start, end: segment.start + at.end };
  }
  return null;
}

/** A text with its quotes checked: { text, cites: [{ n, sourceId, quote, start, end }], dropped }. A quote found but marked nowhere gets a mark at the end. */
export function settleText(unit, rawText, rawQuotes) {
  const found = new Map();
  let dropped = 0;
  for (const quote of (Array.isArray(rawQuotes) ? rawQuotes : []).filter(object)) {
    const n = Number(quote.n), place = Number.isInteger(n) && !found.has(n) ? locate(unit, quote) : null;
    if (place) found.set(n, place); else dropped++;
  }
  const order = [];
  // A heading of the model's own stays under the book's: never above the point's level (the book's headings carry its ids).
  let text = clean(rawText, NOTES_LIMITS.unitChars).replace(/^#{1,3}\s+/gm, '#### ').replace(MARK, (mark, n) => {
    const place = found.get(Number(n));
    if (!place) return '';
    if (!order.includes(place) && order.length < UNIT_CITES) order.push(place);
    const at = order.indexOf(place);
    return at < 0 ? '' : `${mark.startsWith(' ') ? ' ' : ''}[^${at + 1}]`;
  });
  let tail = '';
  for (const place of found.values()) if (!order.includes(place) && order.length < UNIT_CITES) { order.push(place); tail += ` [^${order.length}]`; }
  if (tail) text = `${text}${tail}`.trim();
  return { text, cites: order.map((place, at) => ({ n: at + 1, ...place })), dropped };
}

/** A writing or repair answer: null, or { text, cites, claimed: [item id], dropped }. An answer without text is not an answer. */
export function readDraft(text, unit) {
  const value = parse(text);
  if (!value || typeof value.text !== 'string' || !value.text.trim()) return null;
  const byAlias = new Map(unit.checklist.map(item => [item.alias, item.id]));
  const claimed = [...new Set((Array.isArray(value.covered) ? value.covered : []).map(entry => byAlias.get(String(object(entry) ? entry.id : entry).trim())).filter(Boolean))];
  return { ...settleText(unit, value.text, value.quotes), claimed };
}

const KINDS = new Set(['missing', 'namedrop', 'unsupported', 'contradiction', 'undefined', 'transition', 'hard']);
/** A review: null, or { issues: [{ kind, item?, quote?, note }] } (an issue of an unknown kind, or about an item not asked, loses that part). */
export function readReview(text, unit) {
  const value = parse(text);
  if (!value || !Array.isArray(value.issues)) return null;
  const byAlias = new Map(unit.checklist.map(item => [item.alias, item.id]));
  const issues = value.issues.filter(object).filter(raw => KINDS.has(raw.kind)).slice(0, ISSUES_MAX).map(raw => {
    const item = byAlias.get(String(raw.item ?? '').trim());
    return { kind: raw.kind, ...(item ? { item } : {}), ...(clean(raw.quote, 120) ? { quote: clean(raw.quote, 120) } : {}), note: clean(raw.note, 300) };
  });
  return { issues };
}

/** The places of unplaced items: null, or { places: Map(item index -> leaf index) }. */
export function readPlace(text, items, leaves) {
  const value = parse(text);
  if (!value || !Array.isArray(value.places)) return null;
  const places = new Map();
  for (const raw of value.places.filter(object)) {
    const item = Number(/^c(\d+)$/.exec(String(raw.item ?? '').trim())?.[1]) - 1, leaf = Number(/^k(\d+)$/.exec(String(raw.point ?? '').trim())?.[1]) - 1;
    if (items[item] && leaves[leaf] && !places.has(item)) places.set(item, leaf);
  }
  return { places };
}

/** @returns null, or `{ notes: Map(item index -> note) }`. */
export function readExam(text, batch) {
  const value = parse(text);
  if (!value || !Array.isArray(value.leaves)) return null;
  const notes = new Map();
  for (const raw of value.leaves.filter(object)) {
    const at = Number(/^k(\d+)$/.exec(String(raw.id ?? '').trim())?.[1]) - 1;
    if (batch.items[at] && !notes.has(at)) notes.set(at, clean(raw.note, NOTES_LIMITS.examChars).replace(/\s+/g, ' '));
  }
  return { notes };
}
