import { createHash } from 'node:crypto';
import { displayTitle } from '../../../document-title.js';
import { isLibraryListSource } from '../../../exam-point-list.js';
import { CALL_CHARS, INVENTORY_PROMPT_VERSION, RANGES_PER_CALL, RANGE_CHARS } from './constants.js';

/* The page ranges of a course, decided by the program before any call: EVERY material of the course (its sources in order; a converted PDF's sources are its
   pages) cut into ranges of whole pages of at most RANGE_CHARS, and the calls that read them (consecutive ranges, at most CALL_CHARS a call). Pure.
   A sample paper is not read here (it is what the exam asks, not what the course teaches; the outline reads it on its own); a material without readable text
   gets no range and says why. A range's `print` is its texts and the language, never its place: a copy of a material is read once. */

const sha = value => createHash('sha1').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const short = value => sha(value).slice(0, 16);

/** A source too big for one range is cut at a line (else a space), so no range is bigger than RANGE_CHARS. */
function piecesOf(source) {
  const text = source.text, page = Number.isInteger(source.document?.page) ? { page: source.document.page } : {}, pieces = [];
  for (let from = 0; from < text.length;) {
    let to = Math.min(text.length, from + RANGE_CHARS);
    if (to < text.length) {
      const lineEnd = text.lastIndexOf('\n', to), space = text.lastIndexOf(' ', to);
      to = lineEnd > from + RANGE_CHARS / 2 ? lineEnd + 1 : space > from + RANGE_CHARS / 2 ? space + 1 : to;
    }
    if (text.slice(from, to).trim()) pieces.push({ sourceId: source.id, start: from, end: to, text: text.slice(from, to), ...page });
    from = to;
  }
  return pieces;
}

/** The ranges of one material: its pieces in order, packed into ranges of at most RANGE_CHARS. */
function rangesOfDocument(doc, sources, language) {
  const ranges = [];
  let current = [], size = 0;
  const flush = () => {
    if (!current.length) return;
    const pages = current.map(piece => piece.page).filter(Number.isInteger);
    ranges.push({ key: `${doc.key}~${ranges.length + 1}`, doc: doc.key, material: displayTitle(doc.title), pieces: current, chars: size,
      ...(pages.length ? { from: Math.min(...pages), to: Math.max(...pages) } : {}),
      print: short(['inventory', INVENTORY_PROMPT_VERSION, language === 'en' ? 'en' : 'zh', current.map(piece => sha(piece.text))]) });
    current = []; size = 0;
  };
  for (const piece of sources.flatMap(piecesOf)) {
    if (current.length && size + piece.text.length > RANGE_CHARS) flush();
    current.push(piece); size += piece.text.length;
  }
  flush();
  return ranges;
}

/**
 * @param documents the course's documents (buildOutlineIndex allDocuments); `papers` a Set of document keys read as sample papers (no range).
 * @returns { ranges: [{ key, doc, material, pieces: [{ sourceId, start, end, text, page? }], chars, from?, to?, print }], documents: [{ key, title, pages,
 *            ranges, paged, reason? }] } in the course's order.
 */
export function courseRanges(state, documents, { papers = new Set(), language = 'zh' } = {}) {
  const byId = new Map((state.sources || []).map(source => [source.id, source])), ranges = [], docs = [];
  for (const doc of Array.isArray(documents) ? documents : []) {
    const title = displayTitle(doc.title);
    if (papers.has(doc.key)) { docs.push({ key: doc.key, title, pages: doc.sourceIds.length, ranges: 0, paged: false, reason: 'paper' }); continue; }
    const sources = doc.sourceIds.map(id => byId.get(id)).filter(source => source && !isLibraryListSource(source) && typeof source.text === 'string' && source.text.trim());
    if (!sources.length) { docs.push({ key: doc.key, title, pages: doc.sourceIds.length, ranges: 0, paged: false, reason: 'no-text' }); continue; }
    const own = rangesOfDocument(doc, sources, language), paged = sources.every(source => Number.isInteger(source.document?.page));
    ranges.push(...own);
    docs.push({ key: doc.key, title, pages: paged ? sources.length : 1, ranges: own.length, paged });
  }
  return { ranges, documents: docs };
}

/** The calls that read `ranges` (those not known yet), one per print: consecutive ranges, at most CALL_CHARS and RANGES_PER_CALL a call. */
export function inventoryCalls(ranges) {
  const asked = new Set(), calls = [];
  let current = [], size = 0;
  const flush = () => {
    if (current.length) calls.push({ number: calls.length + 1, ranges: current, key: `inv:${short(current.map(range => range.print))}` });
    current = []; size = 0;
  };
  for (const range of ranges) {
    if (asked.has(range.print)) continue;
    asked.add(range.print);
    if (current.length && (current.length >= RANGES_PER_CALL || size + range.chars > CALL_CHARS)) flush();
    current.push(range); size += range.chars;
  }
  flush();
  return calls;
}

/** What a range's heading names: its material and its pages (a–b), else the material alone. */
export const rangeLabel = range => (Number.isInteger(range.from) ? { material: range.material, from: range.from, to: range.to } : { material: range.material });
