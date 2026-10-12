/* What the main chat's book tools (docs/review-book-agent.md) read of a 复习全书, shared by the reads (lib/book-agent-read.js) and book.write: the
   points in reading order with their numbers, the material pages each point stands on (its anchors, the build's own rule: lib/course-book-inputs.js
   leafSegments), the pages its footnotes cite, and how much of those pages source.pages showed (lib/book-reading.js). Pure, no I/O. */
import { buildOutlineIndex } from './course-outline-index.js';
import { documentIndex, leafSegments } from './course-book-inputs.js';
import { courseOf, genFile, mineFile, qaFile, recordOf } from './course-book-files.js';
import { parseBookLink } from './course-book-links.js';
import { coveredChars } from './book-reading.js';
import { currentCourseNotes } from './course-book.js';

/** The concept coverage the quality workflow measured (lib/contexts/generation/book): per point id { covered, total, missing: [name], status }, and the book's
    three levels (materials and pages, points complete, concepts); empty for notes written before it. */
export function conceptsOf(state, course) {
  const notes = currentCourseNotes(state.sources, course)?.courseNotes, points = new Map();
  for (const leaf of notes?.leaves || []) {
    const coverage = leaf.body?.coverage;
    if (coverage) points.set(leaf.id, { covered: Math.max(0, coverage.must - coverage.missing.length), total: coverage.must, missing: coverage.missing.map(item => item.name), status: leaf.body.status });
  }
  return { points, levels: notes?.coverage ?? null };
}

/** A share of a passage that counts as opened (a page whose last line or two were not shown is still read). */
export const OPENED_SHARE = 0.9;
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
export const oneLine = (value, max = 120) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max)}…` : text; };

/** The book of the course `args` names (else the current one): { course, record, doc } or null when it has none. */
export function bookOfCourse(state, args = {}) {
  const course = courseOf(state, args), record = course === null || course === undefined ? null : recordOf(state, course);
  return record ? { course, record, doc: record.bookDoc } : null;
}

/** Every node of the manifest in reading order: { node, hid, n, title, depth, path, leaf }; leaves also get `at` (their place among the leaves). */
export function pointList(doc) {
  const rows = [];
  const walk = (list, prefix, depth, path) => (list || []).forEach((node, at) => {
    const n = `${prefix}${at + 1}`;
    rows.push({ node, hid: node.hid, n, title: node.title, depth, path, leaf: !!node.leaf });
    walk(node.children, `${n}.`, depth + 1, [...path, node.title]);
  });
  walk(doc?.manifest?.nodes, '', 1, []);
  rows.filter(row => row.leaf).forEach((row, at) => { row.at = at; });
  return rows;
}

/** The point of `hid` (a leaf), or an error naming what to do. */
export function pointOf(rows, hid) {
  const row = rows.find(item => item.hid === hid);
  if (!row) fail('书里没有这一节，先用 book.toc 看一下目录 / The book has no point of this id; read book.toc first', 'book-point-missing');
  if (!row.leaf) fail('这是章或节的标题，不是知识点；用 book.toc 找它下面的知识点 / This id is a chapter or section heading, not a knowledge point', 'book-point-not-leaf');
  return row;
}

/** A point's files: { gen, mine, qa? } each { name, file } (qa only when the point has one). */
export function filesOf(doc, node) {
  const out = {};
  for (const [kind, name] of [['gen', genFile(node.id)], ['mine', mineFile(node.id)], ['qa', qaFile(node.id)]]) if (doc.files[name]) out[kind] = { name, file: doc.files[name] };
  return out;
}

/** The course's materials as the build reads them: documents by key and chapter key, each source's document and page. */
export function materialIndex(state, course) {
  const documents = buildOutlineIndex(state, { course }).allDocuments, byId = new Map((state.sources || []).map(source => [source.id, source]));
  const pageOf = new Map();
  for (const item of documents) for (const page of item.pages || []) if (!pageOf.has(page.sourceId)) pageOf.set(page.sourceId, { item, page: page.page });
  return { documents, docs: documentIndex(documents), byId, pageOf };
}

/** The passages a point stands on, with their document and page: [{ sourceId, start, end, text, item, page }]. */
export function placesOf(index, node) {
  return leafSegments(index.byId, index.docs, node.anchors).map(segment => ({ ...segment, ...(index.pageOf.get(segment.sourceId) || { item: null, page: null }) }));
}

/** Page numbers as a short text: [1, 2, 3, 5] -> '1-3,5'. */
export function pageRanges(numbers) {
  const list = [...new Set((numbers || []).filter(Number.isInteger))].sort((a, b) => a - b), parts = [];
  for (let at = 0; at < list.length; at++) {
    let end = at;
    while (end + 1 < list.length && list[end + 1] === list[end] + 1) end++;
    parts.push(end > at ? `${list[at]}-${list[end]}` : `${list[at]}`);
    at = end;
  }
  return parts.join(',');
}

/** How long a text is for a reader: Han characters one each, other words one each (markers, heading ids and link targets left out). */
export function wordCount(text) {
  const plain = String(text ?? '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/\]\([^)]*\)/g, ']');
  return (plain.match(/[㐀-鿿豈-﫿]/g) || []).length + (plain.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
}

const DEFINITION = /^\[\^[\w-]{1,40}\]:(.*)$/;
/** The source ids a text's footnotes cite: a `studyhub://source/<id>` link, else a `(<id>)` at the end of the footnote. */
export function citedSources(text) {
  const ids = new Set();
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const body = DEFINITION.exec(line.trim())?.[1];
    if (body === undefined) continue;
    const link = [...body.matchAll(/\]\((studyhub:\/\/source\/[^)\s]+)\)/g)].map(match => parseBookLink(match[1])).find(Boolean);
    const plain = /[(（]\s*([^()（）\s]+)\s*[)）]\s*$/.exec(body)?.[1];
    if (link?.sourceId) ids.add(link.sourceId); else if (plain) ids.add(plain);
  }
  return ids;
}

/**
 * How much of a point's own pages were opened and cited, per document: { documents: [{ documentId, title, pages, opened, partial, unopened, cited }],
 * totals: { pages, opened, partial, cited, citedOutside } }. A page is opened when source.pages showed OPENED_SHARE of the point's passage on it.
 */
export function coverageOf(places, reading, cited) {
  const docs = new Map(), anchored = new Set();
  for (const place of places) {
    if (!place.item) continue;
    anchored.add(place.sourceId);
    const key = place.item.key;
    if (!docs.has(key)) docs.set(key, { item: place.item, pages: new Map() });
    const length = Math.max(1, place.end - place.start), covered = coveredChars(reading?.sources?.[place.sourceId], place.start, place.end);
    const old = docs.get(key).pages.get(place.page) || { length: 0, covered: 0, cited: false };
    docs.get(key).pages.set(place.page, { length: old.length + length, covered: old.covered + covered, cited: old.cited || cited.has(place.sourceId) });
  }
  const totals = { pages: 0, opened: 0, partial: 0, cited: 0, citedOutside: [...cited].filter(id => !anchored.has(id)).length };
  const documents = [...docs.values()].map(({ item, pages }) => {
    const list = [...pages].map(([page, value]) => ({ page, ...value, opened: value.covered >= OPENED_SHARE * value.length, partial: value.covered > 0 && value.covered < OPENED_SHARE * value.length }));
    totals.pages += list.length; totals.opened += list.filter(page => page.opened).length; totals.partial += list.filter(page => page.partial).length; totals.cited += list.filter(page => page.cited).length;
    const of = test => pageRanges(list.filter(test).map(page => page.page));
    return { documentId: item.documentId || item.key, title: oneLine(item.title, 80), pages: of(() => true), opened: of(page => page.opened), partial: of(page => page.partial),
      unopened: of(page => !page.opened && !page.partial), cited: of(page => page.cited) };
  });
  return { documents, totals };
}
