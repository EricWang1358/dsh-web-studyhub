/* 在书里找 (复习全书, docs/review-book.md "Find in the book"): the whole book searched in memory, every point whether it is on screen or not, with the words the
   reader's search uses (ui/document-preview/reader/find.js: case, width and extra spaces ignored). What a point shows is what is searched: its title, its
   notes in reading order (ui/book/point-parts.js pointView: 要点清单 and 补充 too, not the 出处 list), the learner's own text, the Q&A put into the book and
   every AI block (folded or not). A print code typed alone (H12, any case) is a jump to that heading. Pure, no React, no DOM. */
import { foldQuery, foldWithMap, matchOffsets } from '../document-preview/reader/find.js';
import { codeOf } from '../../lib/course-book-lookup.js';
import { bookRows } from './model.js';
import { plainLine, pointView } from './point-parts.js';

/** The most matches a search lists (the reader's limit). */
export const FIND_LIMIT = 1000;
const plain = text => String(text ?? '').split(/\r?\n/).map(plainLine).filter(Boolean).join(' ');

/** Every point's searchable text: [{ hid, number, title, segments: [{ text, block }] }] (block: the AI block's id, null for the rest). */
export function bookCorpus(book) {
  if (book?.status !== 'ok') return [];
  return bookRows(book.nodes).filter(row => row.leaf).map(row => {
    const view = pointView(row.node), segments = [];
    const add = (text, block = null) => { const words = plain(text); if (words) segments.push({ text: words, block }); };
    add(row.node.title);
    view.story.forEach(part => add(part.text));
    add(view.points?.text);
    add(view.extra?.text);
    add(view.mine);
    add(row.node.qa);
    view.blocks.forEach(item => add(item.block.body, item.block.id));
    return { hid: row.hid, number: row.number, title: row.title, segments };
  });
}

/** The matches of `query` in the corpus, in reading order: { total, hits: [{ hid, number, title, block, before, match, after, lead }] } (before / after: a few
    words around it for the list; lead: the folded characters just before it, to find the same match on the page). */
export function findInBook(corpus, query, limit = FIND_LIMIT) {
  const needle = foldQuery(query), hits = [];
  if (!needle) return { total: 0, hits };
  for (const point of corpus) {
    for (const segment of point.segments) {
      segment.fold ??= foldWithMap(segment.text);
      const { folded, starts, ends } = segment.fold;
      for (const at of matchOffsets(folded, needle, limit - hits.length)) {
        const from = starts[at], to = ends[at + needle.length - 1];
        hits.push({ hid: point.hid, number: point.number, title: point.title, block: segment.block, before: segment.text.slice(Math.max(0, from - 24), from),
          match: segment.text.slice(from, to), after: segment.text.slice(to, to + 48), lead: folded.slice(Math.max(0, at - 8), at).replace(/ /g, '') });
      }
      if (hits.length >= limit) return { total: hits.length, hits };
    }
  }
  return { total: hits.length, hits };
}

/** A print code typed alone (h12, H12): the heading of the 目录 that carries it -> { id, code, title }, else null. entries: ui/book/model.js tocEntries. */
export function codeJump(entries, query) {
  const typed = String(query ?? '').trim();
  if (!/^h\d+$/i.test(typed)) return null;
  const entry = (entries || []).find(item => codeOf(item.id).toLowerCase() === typed.toLowerCase());
  return entry ? { id: entry.id, code: codeOf(entry.id), title: entry.title } : null;
}
