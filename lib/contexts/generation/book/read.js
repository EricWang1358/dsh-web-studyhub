import { parseJson } from '../../../generation.js';
import { createLocator } from '../../../quote-locate.js';
import { NOTES_LIMITS } from '../../../course-book.js';
import { QUOTE_MIN } from './constants.js';

/* Reading the model's answers of a review book build. Nothing is trusted: an answer that is not the shape asked for is null (the call is asked once more,
   blueprint/jobs/ask.js); a leaf id that was not asked is ignored; a quote is kept only when it is found WORD FOR WORD in the leaf's own passage
   (lib/quote-locate.js: as written, else by its letters and digits), and then it is stored as the original's own words and place. A mark of a quote that is
   not kept is taken out of the text; the marks are numbered again 1, 2, ... in reading order and written [^n]. */

const object = value => value && typeof value === 'object' && !Array.isArray(value);
function parse(text) { try { const value = parseJson(String(text)); return object(value) ? value : null; } catch { return null; } }
const clean = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const list = (value, max, chars) => (Array.isArray(value) ? value : []).map(item => clean(item, chars)).filter(Boolean).slice(0, max);
const MARK = /\s?\[\^?(\d{1,2})\]/g;

/** Where a quote stands in one of the passages: { sourceId, quote (the original's words), start, end } in the source's own offsets, or null. */
function locate(item, raw) {
  const quote = clean(raw?.quote, NOTES_LIMITS.quoteChars).replace(/\s+/g, ' ');
  if (quote.replace(/\s/g, '').length < QUOTE_MIN) return null;
  const wanted = /^S(\d+)$/.exec(String(raw?.ref ?? ''))?.[1], first = item.segments[Number(wanted) - 1];
  for (const segment of first ? [first, ...item.segments.filter(part => part !== first)] : item.segments) {
    const at = createLocator(segment.text)(quote);
    if (!at) continue;
    const words = segment.text.slice(at.start, at.end).replace(/\s+/g, ' ').trim();
    if (words.length > NOTES_LIMITS.quoteChars) continue;
    return { sourceId: segment.sourceId, quote: words, start: segment.start + at.start, end: segment.start + at.end };
  }
  return null;
}

/** One leaf's answer with its quotes checked and its marks numbered again; `dropped` counts the quotes not found. */
export function settleLeaf(item, raw) {
  const points = list(raw.points, NOTES_LIMITS.points, NOTES_LIMITS.pointChars), explain = clean(raw.explain, NOTES_LIMITS.explainChars);
  const example = clean(raw.example, NOTES_LIMITS.exampleChars), extra = list(raw.extra, NOTES_LIMITS.extra, NOTES_LIMITS.extraChars).map(text => text.replace(MARK, ''));
  const found = new Map();
  let dropped = 0;
  for (const quote of (Array.isArray(raw.quotes) ? raw.quotes : []).filter(object)) {
    const n = Number(quote.n), place = Number.isInteger(n) && !found.has(n) ? locate(item, quote) : null;
    if (place) found.set(n, place); else dropped++;
  }
  const order = [], renumber = text => text.replace(MARK, (mark, n) => {
    const place = found.get(Number(n));
    if (!place) return '';
    if (!order.includes(place) && order.length < NOTES_LIMITS.cites) order.push(place);
    const at = order.indexOf(place);
    return at < 0 ? '' : `${mark.startsWith(' ') ? ' ' : ''}[^${at + 1}]`;
  });
  const marked = { points: points.map(renumber), explain: renumber(explain), example: renumber(example) };
  // A quote found but marked nowhere still points to the original: its mark goes at the end of the explanation.
  let tail = '';
  for (const place of found.values()) if (!order.includes(place) && order.length < NOTES_LIMITS.cites) { order.push(place); tail += ` [^${order.length}]`; }
  if (tail) marked.explain = `${marked.explain}${tail}`.trim();
  return { ...marked, extra, cites: order.map((place, at) => ({ n: at + 1, ...place })), dropped };
}

/** @returns null, or `{ leaves: Map(item index -> settled leaf) }`; a leaf with neither points nor an explanation is not answered. */
export function readNotes(text, batch) {
  const value = parse(text);
  if (!value || !Array.isArray(value.leaves)) return null;
  const leaves = new Map();
  for (const raw of value.leaves.filter(object)) {
    const at = Number(/^k(\d+)$/.exec(String(raw.id ?? '').trim())?.[1]) - 1, item = batch.items[at];
    if (!item || leaves.has(at)) continue;
    const settled = settleLeaf(item, raw);
    if (settled.points.length || settled.explain) leaves.set(at, settled);
  }
  return { leaves };
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
