import { parseJson } from '../../../generation.js';
import { createLocator } from '../../../quote-locate.js';
import { INVENTORY_KINDS, INVENTORY_LIMITS } from '../../../course-book-inventory.js';
import { ITEMS_PER_CALL, QUOTE_MIN } from './constants.js';

/* Reading an inventory answer. Nothing is trusted: an answer not of the shape asked for is null (asked once more); an item of a range that was not asked, or
   without a name, is ignored; an anchor quote is checked WORD FOR WORD in its own range (lib/quote-locate.js) and stored as the original's words and place. An
   item whose quote is not found is KEPT, marked `verified: false` and placed at its range (never silently dropped). */

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clean = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** @returns null, or { found: Map(range index -> [{ kind, name, gist, quote, page?, key? }]) } (a range answered with no item has an empty list). */
export function readInventory(text, call) {
  let value;
  try { value = parseJson(String(text)); } catch { return null; }
  if (!object(value) || !Array.isArray(value.items)) return null;
  const found = new Map(call.ranges.map((_, at) => [at, []]));
  for (const raw of value.items.filter(object).slice(0, ITEMS_PER_CALL)) {
    const at = Number(/^R(\d+)$/.exec(String(raw.range ?? '').trim())?.[1]) - 1, name = clean(raw.name, INVENTORY_LIMITS.nameChars);
    if (!found.has(at) || !name) continue;
    found.get(at).push({ kind: INVENTORY_KINDS.includes(raw.kind) ? raw.kind : 'concept', name, gist: clean(raw.gist, INVENTORY_LIMITS.gistChars),
      quote: clean(raw.quote, INVENTORY_LIMITS.quoteChars), ...(Number.isInteger(raw.page) ? { page: raw.page } : {}), ...(raw.key === true ? { key: true } : {}) });
  }
  return { found };
}

/** Where a quote stands in a range: { sourceId, start, end, page?, quote (the original's words) }, or null. */
function locate(range, quote) {
  if (quote.replace(/[\s\p{P}]/gu, '').length < QUOTE_MIN) return null;
  for (const piece of range.pieces) {
    const at = createLocator(piece.text)(quote);
    if (!at) continue;
    return { sourceId: piece.sourceId, start: piece.start + at.start, end: piece.start + at.end, ...(Number.isInteger(piece.page) ? { page: piece.page } : {}),
      quote: piece.text.slice(at.start, at.end).replace(/\s+/g, ' ').trim().slice(0, INVENTORY_LIMITS.quoteChars) };
  }
  return null;
}

/** The items of one range with their places: an anchor found is verified; one not found is placed at the page it names (else the range's first) unverified. */
export function settleRange(range, raws) {
  return (raws || []).map(raw => {
    const at = locate(range, raw.quote);
    const fallback = range.pieces.find(piece => Number.isInteger(raw.page) && piece.page === raw.page) ?? range.pieces[0];
    const place = at ? { ...at, verified: true } : { sourceId: fallback.sourceId, start: fallback.start, end: fallback.start,
      ...(Number.isInteger(fallback.page) ? { page: fallback.page } : {}), quote: raw.quote, verified: false };
    return { kind: raw.kind, name: raw.name, gist: raw.gist, ...(raw.key ? { key: true } : {}), place: { range: range.key, doc: range.doc, ...place } };
  });
}
