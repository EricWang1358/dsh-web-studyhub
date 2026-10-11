import { createHash } from 'node:crypto';
import { displayTitle } from '../../../document-title.js';
import { leafSegments, readTextPrint } from '../../../course-book-inputs.js';
import { PASS_CHARS } from './constants.js';

/* What a knowledge point is written FROM: the pages its anchors hold and the pages (or, in a material of one source, the inventory range) of every item of its
   checklist, in the course's order, each once; and the units it is written in: one call, or passes of whole pages of at most PASS_CHARS each (a page
   bigger than that alone is cut at a line). Each unit's checklist is the items whose anchor lies in its pages. Pure. */

const sha = value => createHash('sha1').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const short16 = value => sha(value).slice(0, 16);

/** The passages of a leaf: its anchors' and its items' pages, in document order, each once. */
export function leafSources({ node, checklist }, { byId, docs, documents, ranges }) {
  const own = leafSegments(byId, docs, node.anchors), seen = new Set(own.map(segment => `${segment.sourceId}:${segment.start}`));
  const whole = new Set(own.filter(segment => segment.start === 0 && segment.end >= (byId.get(segment.sourceId)?.text?.length ?? 0)).map(segment => segment.sourceId));
  const docOf = new Map(documents.map(doc => [doc.key, doc])), rangeOf = new Map((ranges || []).map(range => [range.key, range]));
  const extra = [];
  for (const item of checklist) for (const place of item.places) {
    const doc = docOf.get(place.doc), source = byId.get(place.sourceId);
    if (!doc || !source || whole.has(place.sourceId)) continue;
    const piece = doc.sourceIds.length === 1 ? rangeOf.get(place.range)?.pieces.find(each => each.sourceId === place.sourceId) : null;
    const [start, end] = piece ? [piece.start, piece.end] : [0, source.text.length], key = `${place.sourceId}:${start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!piece) whole.add(place.sourceId);
    extra.push({ sourceId: place.sourceId, start, end, text: source.text.slice(start, end), material: displayTitle(doc.title),
      ...(Number.isInteger(source.document?.page) ? { page: source.document.page } : {}) });
  }
  const order = new Map(), position = new Map();
  documents.forEach((doc, at) => doc.sourceIds.forEach((id, k) => { if (!order.has(id)) { order.set(id, at); position.set(id, k); } }));
  return [...own, ...extra].filter(segment => segment.text.trim())
    .sort((a, b) => (order.get(a.sourceId) ?? 1e9) - (order.get(b.sourceId) ?? 1e9) || (position.get(a.sourceId) ?? 0) - (position.get(b.sourceId) ?? 0) || a.start - b.start);
}

/** A passage bigger than a pass cut at a line (else a space). */
function cut(segment) {
  if (segment.text.length <= PASS_CHARS) return [segment];
  const pieces = [];
  for (let from = 0; from < segment.text.length;) {
    let to = Math.min(segment.text.length, from + PASS_CHARS);
    if (to < segment.text.length) { const lineEnd = segment.text.lastIndexOf('\n', to); to = lineEnd > from + PASS_CHARS / 2 ? lineEnd + 1 : to; }
    pieces.push({ ...segment, text: segment.text.slice(from, to), start: segment.start + from, end: segment.start + to });
    from = to;
  }
  return pieces;
}

const holds = (segments, place) => segments.some(segment => segment.sourceId === place.sourceId && place.start >= segment.start
  && place.start < Math.max(segment.end, segment.start + 1));

/** The units a leaf is written in: [{ n, of, segments, checklist }] (an item without a place in any unit goes to the first). */
export function unitsOf(segments, checklist) {
  const groups = [];
  let current = [], size = 0;
  for (const piece of segments.flatMap(cut)) {
    if (current.length && size + piece.text.length > PASS_CHARS) { groups.push(current); current = []; size = 0; }
    current.push(piece); size += piece.text.length;
  }
  if (current.length || !groups.length) groups.push(current);
  const taken = new Set();
  const units = groups.map((group, at) => ({ n: at + 1, of: groups.length, segments: group, checklist: checklist.filter(item => {
    if (taken.has(item.id) || !item.places.some(place => holds(group, place))) return false;
    taken.add(item.id); return true;
  }) }));
  units[0].checklist.unshift(...checklist.filter(item => !taken.has(item.id)));
  return units;
}

/** What a unit read, and the print of its texts (an explanation is out of date when one of them changed). */
export const readOf = segments => segments.map(segment => ({ sourceId: segment.sourceId, start: segment.start, end: segment.end }));
export const textPrint = readTextPrint;
