/* book.coverage with the course's search index (docs/review-book-agent.md): where the index stands (book.search's `index` summary and status) and, when
   it can be asked, `readNext` pointing at the point's not-yet-opened page that the index ranks highest for the point: its checklist's concepts still
   missing (the quality workflow's, lib/book-agent-view.js conceptsOf) else its headings, with its title. Without an index readNext stays as it was. The
   search itself is generation's book.search, handed in; the rest is pure. */
import { bookOfCourse, filesOf, oneLine, pointList } from './book-agent-view.js';
import { bookIndex } from './course-book-links.js';

const QUERY_CHARS = 300, ALSO = 5;
const USABLE = new Set(['ok', 'partial', 'building']);

/** '1-3,5' -> Set {1, 2, 3, 5}. */
export function pagesIn(ranges) {
  const pages = new Set();
  for (const part of String(ranges ?? '').split(',')) {
    const [from, to = from] = part.split('-').map(Number);
    if (Number.isInteger(from) && Number.isInteger(to)) for (let page = from; page <= to && page - from < 10000; page++) pages.add(page);
  }
  return pages;
}

/** The words a point is searched with: its title, then the concepts still missing (else its headings), each once, at most QUERY_CHARS. */
export function pointQuery({ title, missing = [], headings = [] }) {
  const words = [...new Set([title, ...(missing.length ? missing : headings)].map(item => oneLine(item, 80)).filter(Boolean))];
  return words.join(' ').slice(0, QUERY_CHARS);
}

/**
 * From the hits (best first) the first page of the point's documents that is not opened yet: { readNext: { documentId, from, to, by: 'index' },
 * also: [{ documentId, page }] (the next ones) } or null. `documents` are book.coverage's (opened pages as ranges).
 */
export function rankedReadNext(documents, hits) {
  const opened = new Map(documents.map(item => [item.documentId, pagesIn(item.opened)]));
  const open = hits.filter(hit => opened.has(hit.documentId) && Number.isInteger(hit.page) && !opened.get(hit.documentId).has(hit.page));
  const seen = new Set(), unique = open.filter(hit => !seen.has(`${hit.documentId}#${hit.page}`) && seen.add(`${hit.documentId}#${hit.page}`));
  if (!unique.length) return null;
  const [first, ...rest] = unique;
  return { readNext: { documentId: first.documentId, from: first.page, to: first.page + 1, by: 'index' },
    also: rest.slice(0, ALSO).map(hit => ({ documentId: hit.documentId, page: hit.page })) };
}

/** book.coverage's answer with the index: `search(args)` is book.search. A search that fails leaves the answer as it was. */
export async function coverageWithIndex(state, coverage, search) {
  if (coverage?.status !== 'ok' || typeof search !== 'function') return coverage;
  const book = bookOfCourse(state, { course: coverage.course }), row = book && pointList(book.doc).find(item => item.hid === coverage.hid);
  const headings = row ? bookIndex(filesOf(book.doc, row.node).gen?.file.text ?? '').flat.map(heading => heading.title) : [];
  const query = pointQuery({ title: coverage.title, missing: coverage.concepts?.missing ?? [], headings });
  let found;
  try { found = await search({ course: coverage.course, hid: coverage.hid, query, limit: 20 }); } catch { return coverage; }
  if (!found?.index) return coverage;
  const answer = { ...coverage, index: { status: found.status, ...found.index } };
  const ranked = USABLE.has(found.status) && coverage.readNext ? rankedReadNext(coverage.documents, found.hits || []) : null;
  if (ranked) Object.assign(answer, ranked.readNext && { readNext: ranked.readNext }, ranked.also.length ? { alsoByIndex: ranked.also } : {});
  if (found.hint) answer.indexHint = found.hint;
  return answer;
}
