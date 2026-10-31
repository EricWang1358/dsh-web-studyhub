/* 复习全书 page (ui/book/): what the page keeps between visits and how it reads course.book.open's tree. Pure, no React, no DOM. */
import { ui } from '../i18n.js';
import { browserStorage, readJSON, writeJSON } from '../storage.js';
import { bookIndex, stitchBook } from '../../lib/course-book-links.js';
import { daysUntilExam } from '../../lib/courses.js';

/**
 * The live 目录: every heading of the stitched book (bookIndex), the book's own title left out, each with the chapter (a top heading, level 2) it is in:
 * [{ id, level, title, chapter }]. Built from the files, so a heading the learner writes in their own file is listed too.
 */
export function tocEntries(book) {
  if (book?.status !== 'ok') return [];
  const flat = bookIndex(stitchBook({ title: book.title, nodes: book.nodes, unplaced: book.unplaced })).flat;
  let chapter = null;
  return flat.filter(entry => entry.id && entry.id !== 'book').map(entry => {
    if (entry.level <= 2) chapter = entry.id;
    return { id: entry.id, level: entry.level, title: entry.title, chapter };
  });
}

/** Where the sidebar's 复习全书 leads: the book page once its notes are written or a rebuild waits there for the learner's answer, else the 总纲 page (which offers 生成总纲 / 生成复习全书). */
export const bookEntryPage = book => (book?.status === 'rebuild-pending' || (book?.status === 'ok' && book.notes) ? 'book' : 'outline');

/** What the 期末一周 needs of the course's exam date, as the book page's quiet line says it: { kind: 'none' } (no date: a link to the course settings), { kind: 'later', window }
    (a date beyond the window: the plan starts `window` days before the exam), or null (inside the window, or past: nothing to say). */
export function crunchDateHint(exam, windowDays, now = new Date()) {
  const left = daysUntilExam(exam, now);
  if (left === null) return { kind: 'none' };
  return left > windowDays ? { kind: 'later', window: windowDays } : null;
}

// Where the learner was ({ heading, offset }) survives a reload and the next day: kept in this browser per library and course (ui/storage.js, a small JSON).
// Everything else the page is handed is a one-shot of this page load, in memory and never written: `target` (a node key an entry link opens at), `view`
// (the home's card: 'flip' or 'today'), `back` and `point` (the way back from practice: focus that point's heading), `switched` (the home switched the course),
// `chapter` (the chapter of the heading the way back left from), `folds` (the folds open in the point it left).
const kept = new Map();
const keyOf = (root, course) => JSON.stringify([root, course]);
const PLACE = new Set(['heading', 'offset']);
/** The storage key of a course's place in the book. */
export const placeKey = (root, course) => `study-book-place:${root}:${course}`;
const readPlace = (root, course, storage) => {
  const place = readJSON(placeKey(root, course), null, storage);
  return place && typeof place.heading === 'string' && place.heading ? { heading: place.heading, offset: Number.isFinite(place.offset) ? place.offset : null } : null;
};
/** Where the learner was in the book of a course: { heading, offset } (offset: the heading's distance from the top of the window), and the one-shots above.
    The place is also kept in memory: within one page load that copy is the latest (and the only one when the storage is missing, blocked or full, so the way
    back from practice still lands where the learner left); a fresh page load has only the stored one. */
export function keptBook(root, course, storage = browserStorage()) {
  const place = readPlace(root, course, storage), once = kept.get(keyOf(root, course));
  return place || once ? { ...place, ...once } : null;
}
export function keepBook(root, course, view, storage = browserStorage()) {
  const place = {}, once = {};
  for (const [key, value] of Object.entries(view || {})) (PLACE.has(key) ? place : once)[key] = value;
  if ('heading' in place || 'offset' in place) {
    const before = kept.get(keyOf(root, course))?.heading ? kept.get(keyOf(root, course)) : readPlace(root, course, storage) || {};
    const heading = place.heading ?? before.heading ?? null, offset = place.offset ?? before.offset ?? null;
    if (heading) {
      const next = { heading, offset: Number.isFinite(offset) ? Math.round(offset) : 0 };
      writeJSON(placeKey(root, course), next, storage);
      Object.assign(once, next);
    }
  }
  if (!Object.keys(once).length) return;
  kept.set(keyOf(root, course), { ...(kept.get(keyOf(root, course)) || {}), ...once });
  if (kept.size > 20) kept.delete(kept.keys().next().value);
}

/** 复制编号: how the main chat is told which point is meant: the lowercase hid its book tools match, the number and title, the course. */
export const pointCode = (row, course) => [String(row.hid).toLowerCase(), [row.number, row.title].filter(Boolean).join(' '), course === '' ? ui('未分类课程') : course || '']
  .filter(Boolean).join(' · ');

/** Every node of the tree in reading order with the index of its top chapter: [{ hid, key, number, title, depth, leaf, chapter, node }]. */
export function bookRows(nodes) {
  const rows = [];
  const walk = (list, chapter) => (list || []).forEach((node, at) => {
    const top = chapter ?? at;
    rows.push({ hid: node.hid, key: node.key, number: node.number, title: node.title, depth: node.depth, leaf: node.leaf, chapter: top, node });
    walk(node.children, top);
  });
  walk(nodes, null);
  return rows;
}

/** The row of a heading id or of a node key (the 总纲's `bk:` key), or null. */
export const rowOf = (rows, id) => rows.find(row => row.hid === id || row.key === id) ?? null;

/** The question links of a file that point to gone questions: `missing` is course.book.open's list of 'deckId|cardId'. */
export const goneSet = missing => new Set(Array.isArray(missing) ? missing : []);

/** The files of the book in reading order: [{ file, kind: 'gen' | 'mine' | 'qa' | 'unplaced', row }] (row: the point's, null for 未归位). */
export function bookFiles(book) {
  if (book?.status !== 'ok') return [];
  const out = bookRows(book.nodes).filter(row => row.leaf).flatMap(row => [{ file: row.node.files.gen, kind: 'gen', row }, { file: row.node.files.mine, kind: 'mine', row },
    ...(row.node.files.qa ? [{ file: row.node.files.qa, kind: 'qa', row }] : [])]);
  return [...out, { file: book.unplaced.file, kind: 'unplaced', row: null }];
}
/** The text of one file of the book as course.book.open gave it ('' when the book has no such file). */
export function fileText(book, file) {
  const found = bookFiles(book).find(item => item.file === file);
  if (!found) return '';
  return found.kind === 'unplaced' ? book.unplaced.text : found.row.node[found.kind];
}
/** The file the editor opens first: the learner's own file of the point being read, else the first point's. */
export function defaultFile(book, here) {
  const files = bookFiles(book), row = files.find(item => item.row?.hid === here);
  return (row ? files.find(item => item.row === row.row && item.kind === 'mine') : files.find(item => item.kind === 'mine'))?.file ?? files[0]?.file ?? null;
}

/** The 出处 of a file by footnote number: `[^n]: [「quote」](studyhub://source/<id>)` -> Map<n, { sourceId, quote }>. */
export function citesOf(text) {
  const out = new Map();
  for (const match of String(text ?? '').matchAll(/^\[\^(\d{1,2})\]: \[(.+?)\]\(studyhub:\/\/source\/([^)\s]+)\)/gm)) {
    let sourceId = match[3];
    try { sourceId = decodeURIComponent(sourceId); } catch { /* the id as written */ }
    out.set(Number(match[1]), { sourceId, quote: match[2].replace(/^[「“]|[」”]$/g, '') });
  }
  return out;
}
