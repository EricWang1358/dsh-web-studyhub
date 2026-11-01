import { foldQuery, foldWithMap, matchOffsets } from '../document-preview/reader/find.js';
import { bookRows } from './model.js';

/* 在书里找 (#489): any words of the book, its titles and the text of every point (explanation, the learner's notes, Q&A) and 未归位. It searches course.book.open's text, not the page,
   because 逐节读 draws one point at a time; matching is the reader's (ui/document-preview/reader/find.js: case, width and extra whitespace ignored). Pure, no React, no DOM. */

/** The most points listed for one search (`total` says how many have it). */
export const SEARCH_ROWS = 60;
const BEFORE = 14, AFTER = 40;
// A line that is the point's own 练 / 问答 links says nothing about the content, and every point has one.
const LINK_LINE = /studyhub:\/\/(practice|qa)\b/;

// Inline code is words as they stand; outside it only PAIRED emphasis is a mark (`int *p` and `a*b` are words on the page, as Markdown draws them).
const INLINE_CODE = /(`+[^`\n]*`+)/;
const unmarked = piece => piece.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2').replace(/\*(?=[^\s*])([^*\n]*?[^\s*])\*/g, '$1');

/** The words of a file as the page shows them: no markers, footnote labels, link targets or Markdown marks. */
export function plainText(markdown) {
  return String(markdown ?? '').split(/\r?\n/).filter(line => !LINK_LINE.test(line)).join('\n')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/\[\^[^\]]+\]:?/g, ' ').replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*+]\s+/gm, '')
    .split(INLINE_CODE).map((piece, at) => (at % 2 ? piece.replace(/`/g, '') : unmarked(piece))).join('');
}

/** What a search looks through, made once per book (folding half a million characters on every key would not keep up with typing). */
export function searchIndex(book) {
  if (book?.status !== 'ok') return [];
  const entry = (hid, number, title, plain) => ({ hid, number, title, plain, titleFold: foldQuery(title), ...foldWithMap(plain) });
  const points = bookRows(book.nodes).map(row => entry(row.hid, row.number, row.title, row.leaf ? [row.node.gen, row.node.mine, row.node.qa].map(plainText).filter(Boolean).join('\n') : ''));
  return String(book.unplaced?.text ?? '').trim() ? [...points, entry('unplaced', '', book.unplaced.title, plainText(book.unplaced.text))] : points;
}

const oneLine = text => text.replace(/\s+/g, ' ');

/** -> null with nothing to look for, else { total, rows: [{ hid, number, title, count, before?, match?, after? }] } in reading order: each point once, how often it has the words, and the
    first place in its text (none when only the title has them). */
export function searchBook(index, query) {
  const needle = foldQuery(query);
  if (!needle) return null;
  const hits = [];
  for (const item of index) {
    const offsets = matchOffsets(item.folded, needle), inTitle = matchOffsets(item.titleFold, needle).length;
    if (!offsets.length && !inTitle) continue;
    const place = {};
    if (offsets.length) {
      const from = item.starts[offsets[0]], to = item.ends[offsets[0] + needle.length - 1];
      Object.assign(place, { before: oneLine(item.plain.slice(Math.max(0, from - BEFORE), from)).trimStart(), match: oneLine(item.plain.slice(from, to)), after: oneLine(item.plain.slice(to, to + AFTER)).trimEnd() });
    }
    hits.push({ hid: item.hid, number: item.number, title: item.title, count: offsets.length + inTitle, ...place });
  }
  return { total: hits.length, rows: hits.slice(0, SEARCH_ROWS) };
}
