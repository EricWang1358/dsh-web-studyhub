/* The main chat's reads of the 复习全书 (docs/review-book-agent.md): small answers, each well under the host's 8 192-character cut of a tool result,
   so a chat can work through the book one point at a time without course.book.open (which answers the whole book). Pure: the state as read, the
   reading record (lib/book-reading.js); no write.

   book.toc { course?, offset?, limit? } -> the points in order (chapters and sections as rows too): hid, number, title, and for a knowledge point the
     words and version of each file, whether the generated file is the learner's (forked) and how many of its pages were opened.
   book.read { course?, hid, file?, offset? } -> one point: its files' text (at most READ_CHARS together; `more` says where to go on), their headings,
     the previous and next point with one line each, the material pages it stands on, and its reading coverage.
   book.coverage { course?, hid } -> per document the point's pages: opened, partly opened, not opened, cited; with where to read next. */
import { bookOfCourse, citedSources, coverageOf, filesOf, materialIndex, oneLine, placesOf, pointList, pointOf, wordCount } from './book-agent-view.js';
import { bookIndex, shownLine } from './course-book-links.js';
import { suggestionsOf } from './course-book-files.js';

export const TOC_LIMIT = 30, TOC_MAX = 40, READ_CHARS = 4500, READ_FILE_CHARS = 5500, HEADINGS_SHOWN = 30;
const intOf = (value, fallback, min, max) => (Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback);
const noBook = (course, reason = 'no-book') => ({ status: 'empty', course: course ?? null, reason });

/** A file's first line of content as a summary: labels, headings, footnotes and markers left out. */
export function summaryOf(text, max = 100) {
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = shownLine(raw).trim();
    if (!line || /^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*$/.test(line) || /^\[\^[\w-]+\]:/.test(line) || /^<!--/.test(line) || /^\[[^\]]*\]\(studyhub:/.test(line)) continue;
    const plain = line.replace(/^[-*>]\s+|^\d+\.\s+/, '').replace(/\[\^[\w-]+\]/g, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    if (plain.trim()) return oneLine(plain, max);
  }
  return '';
}

const fileFacts = (doc, node) => Object.fromEntries(Object.entries(filesOf(doc, node)).map(([kind, { file }]) => [kind, { v: file.version, words: wordCount(file.text) }]));

/** book.toc (see the top of this file). */
export function bookToc(state, args = {}, reading = null) {
  const book = bookOfCourse(state, args);
  if (!book) return noBook(args.course);
  const { course, record, doc } = book, rows = pointList(doc), index = materialIndex(state, course);
  const offset = intOf(args.offset, 0, 0, rows.length), limit = intOf(args.limit, TOC_LIMIT, 1, TOC_MAX), page = rows.slice(offset, offset + limit);
  const points = page.map(row => {
    if (!row.leaf) return { hid: row.hid, n: row.n, title: oneLine(row.title, 60) };
    const files = filesOf(doc, row.node), cited = citedSources(Object.values(files).map(item => item.file.text).join('\n'));
    const { totals } = coverageOf(placesOf(index, row.node), reading, cited);
    return { hid: row.hid, n: row.n, title: oneLine(row.title, 60), files: fileFacts(doc, row.node), ...(files.gen?.file.forked ? { forked: true } : {}),
      read: `${totals.opened}/${totals.pages}`, ...(totals.cited ? { cited: totals.cited } : {}) };
  });
  return { status: 'ok', course, title: record.title, language: doc.language || 'zh', points: rows.filter(row => row.leaf).length, rows: rows.length,
    offset, nextOffset: offset + limit < rows.length ? offset + limit : null, toc: points,
    note: 'read: pages of the point opened with source.pages / pages it stands on; files: v version, words' };
}

/** A file's text from `offset`, at most `budget` characters, with its headings. */
function fileView(name, file, offset, budget) {
  const text = String(file.text ?? ''), start = Math.min(offset, text.length), part = text.slice(start, start + budget);
  const headings = bookIndex(text).flat.slice(0, HEADINGS_SHOWN).map(heading => ({ id: heading.id, level: heading.level, title: oneLine(heading.title, 60) }));
  return { view: { name, version: file.version, ...(file.forked ? { forked: true } : {}), words: wordCount(text), chars: text.length, ...(headings.length ? { headings } : {}),
    ...(start ? { from: start } : {}), text: part }, cut: start + part.length < text.length ? start + part.length : null };
}

/** book.read (see the top of this file). */
export function bookRead(state, args = {}, reading = null) {
  const book = bookOfCourse(state, args);
  if (!book) return noBook(args.course);
  const { course, doc } = book, rows = pointList(doc), row = pointOf(rows, args.hid), leaves = rows.filter(item => item.leaf);
  const files = filesOf(doc, row.node), index = materialIndex(state, course), places = placesOf(index, row.node);
  const only = args.file === undefined ? null : String(args.file);
  if (only !== null && !files[only]) throw Object.assign(new Error('file must be gen, mine or qa (a file this point has)'), { code: 'book-file-invalid' });
  let left = only ? READ_FILE_CHARS : READ_CHARS, more = null;
  const shown = {};
  for (const kind of only ? [only] : ['gen', 'mine', 'qa']) {
    if (!files[kind]) continue;
    const { view, cut } = fileView(files[kind].name, files[kind].file, only ? intOf(args.offset, 0, 0, Number.MAX_SAFE_INTEGER) : 0, Math.max(0, left));
    left -= view.text.length;
    if (cut !== null && !more) more = { file: kind, offset: cut };
    if (!suggestionsOf(files[kind].file).length) shown[kind] = view; else shown[kind] = { ...view, suggestions: suggestionsOf(files[kind].file).length };
  }
  const neighbour = item => (item ? { hid: item.hid, n: item.n, title: oneLine(item.title, 60), summary: summaryOf(filesOf(doc, item.node).gen?.file.text) } : null);
  const cited = citedSources(Object.values(files).map(item => item.file.text).join('\n')), { documents, totals } = coverageOf(places, reading, cited);
  return { status: 'ok', course, hid: row.hid, n: row.n, title: row.title, path: row.path, language: doc.language || 'zh',
    previous: neighbour(leaves[row.at - 1]), next: neighbour(leaves[row.at + 1]), files: shown, ...(more ? { more } : {}),
    materials: documents.map(item => ({ documentId: item.documentId, title: item.title, pages: item.pages })),
    reading: totals };
}

/** book.coverage (see the top of this file). */
export function bookCoverage(state, args = {}, reading = null) {
  const book = bookOfCourse(state, args);
  if (!book) return noBook(args.course);
  const { course, doc } = book, row = pointOf(pointList(doc), args.hid), files = filesOf(doc, row.node);
  const cited = citedSources(Object.values(files).map(item => item.file.text).join('\n'));
  const { documents, totals } = coverageOf(placesOf(materialIndex(state, course), row.node), reading, cited);
  const first = documents.find(item => item.unopened || item.partial);
  const from = first ? Number(String(first.partial || first.unopened).split(/[,-]/)[0]) : null;
  return { status: 'ok', course, hid: row.hid, title: oneLine(row.title, 80), documents, totals,
    ...(first ? { readNext: { documentId: first.documentId, from, to: from + 3 } } : {}),
    note: totals.pages ? `${totals.opened} of ${totals.pages} pages opened` : 'this point stands on no readable page' };
}
