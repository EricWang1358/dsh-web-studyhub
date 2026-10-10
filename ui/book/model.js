/* 复习全书 page (ui/book/): what the page keeps between visits and how it reads course.book.open's tree. Pure, no React, no DOM. */
import { bookIndex, stitchBook } from '../../lib/course-book-links.js';

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

const kept = new Map();
const keyOf = (root, course) => JSON.stringify([root, course]);
/** Where the learner was in the book of a course: { heading, offset } (offset: the heading's distance from the top of the window), and `target` (a node key to open at). */
export const keptBook = (root, course) => kept.get(keyOf(root, course)) || null;
export function keepBook(root, course, view) {
  kept.set(keyOf(root, course), { ...(kept.get(keyOf(root, course)) || {}), ...view });
  if (kept.size > 20) kept.delete(kept.keys().next().value);
}

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
