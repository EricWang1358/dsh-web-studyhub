import { useLayoutEffect } from 'react';
import { liveScope } from './use-async.js';

/* What the rows' facts lines of one picker say follows one rule for the whole scope (#1084, round 8): a run of rows reads the same, and scrolling a long
   list (the window draws more rows) changes no row. The rule is decided from the words of every document in the scope, drawn or not, and the room of the
   facts line, and said on the picker's root in two words. `data-names`, which names a row says:
   'all'   every name, whole;
   'first' only the first name (whole, or a course longer than six characters at 6em at least, cut with 「…」 and its whole name on hover);
   'none'  (a course scope) no name: the format and the size have the line;
   'kind'  (全部课程, #1134) the format, without its pages and size, then the course (6em at least, cut if need be);
   'alone' (全部课程 at its narrowest, where a row has no room even for that) the course alone on the line, its 「· 」 hidden left of the line's start,
           cut with 「…」 and its whole name on hover where it is longer: a course cut to two characters after a long format would say neither.
   `data-chars`, which rows say their characters (#1135: a size is said whole or not at all, never cut, by one rule for the rows of a kind):
   'all' every row; 'unpaged' the rows without pages (a document with pages says its size in pages, its characters give way first); 'none' no row.
   The rule is the first of a short list, most said first, that every row has room for: the characters of a document with pages give way first, then
   the names after the first, then (a course scope) the first name, then the other rows' characters. In 全部课程 the first name is the course the row
   belongs to, the one thing the scope does not say for it, so every row keeps it, and its format with it where the course keeps 6em. The notes come after the names and take what
   is left of the line, each whole or out of sight (ui/source-picker.css), so they never decide. A row so never shows two cut pieces: in 'first',
   'kind' and 'alone' only the name may be cut, in 'none' only the format (where it alone is wider than the line).
   The decision is taken again only when the scope's documents, the line's width or the font change: never because more rows are drawn, nor when the
   index answer lands (the badges' column is the same width coming, with a badge and without). A word a row does not show stays in its checkbox's name. */

/** A little room kept spare: the canvas measures the words a hair differently from the line (rounding, the digits' font). */
const SPARE = 4;

/* The choices, most said first: [names, chars]. A course scope gives its other names way before a note's characters; 全部课程 keeps the course. */
const IN_SCOPE = [['all', 'all'], ['all', 'unpaged'], ['first', 'all'], ['first', 'unpaged'], ['none', 'all'], ['none', 'unpaged'], ['none', 'none']];
const EVERY_COURSE = [['all', 'all'], ['all', 'unpaged'], ['first', 'all'], ['first', 'unpaged'], ['first', 'none'], ['kind', 'none'], ['alone', 'none']];

/**
 * `{ names, chars }` for `rows` (each `{ kind, pages, size, first, later, shortened, multi }`: the widths in px of the format, of its pages with their
 * 「 · 」 (0 where it has none), of its characters with their 「 · 」, of the first name and of each name after it, whether the first may be shortened,
 * whether the row has 选择页面). `names` is '' when no row has a name. `room(row)` is the facts line's width for that row, `gap` the space between two
 * pieces, `em` the line's font size; `everyCourse` keeps the first name on every row (全部课程).
 */
export function decideFacts(rows, { room, gap, em, everyCourse = false, spare = SPARE }) {
  const lead = (row, chars, names) => row.kind + (names === 'kind' ? 0 : row.pages + (chars === 'all' || (chars === 'unpaged' && !row.pages) ? row.size : 0));
  const named = (row, names) => (!row.first || names === 'none' ? 0
    : gap + (names === 'all' ? row.first + row.later.reduce((sum, name) => sum + gap + name, 0) : row.shortened ? Math.min(row.first, 6 * em) : row.first));
  const choices = everyCourse ? EVERY_COURSE : IN_SCOPE;
  const [names, chars] = choices.find(([which, said], at) => at === choices.length - 1 || rows.every(row => lead(row, said, which) + named(row, which) <= room(row) - spare));
  return { names: rows.some(row => row.first) ? names : '', chars };
}

let canvas;
/** The rows' words measured in the facts line's font, or null where there is no canvas (a test without a browser). `dot`: the width of a name's 「· 」. */
function measured(rows, style) {
  try { canvas ??= document.createElement('canvas').getContext('2d'); } catch { canvas = null; }
  if (!canvas) return null;
  canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if ('letterSpacing' in canvas) canvas.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
  const sizes = new Map(), size = text => { if (!text) return 0; if (!sizes.has(text)) sizes.set(text, canvas.measureText(text).width); return sizes.get(text); };
  const widths = rows.map(row => ({ kind: size(row.kind), pages: size(row.pages), size: size(row.size), first: size(row.first), later: row.later.map(size), shortened: row.shortened,
    multi: row.multi }));
  widths.dot = size('· ');
  return widths;
}

/** The facts line's width on a row with 选择页面 and on one without, read from a drawn row of each (a kind not drawn yet takes the other's). */
function rooms(root) {
  const width = selector => root.querySelector(selector)?.getBoundingClientRect().width ?? null;
  const plain = width('.source-picker__row:not(.has-expand) .source-picker__facts'), wide = width('.source-picker__row.has-expand .source-picker__facts');
  return { plain: plain ?? wide, wide: wide ?? plain };
}

/**
 * Keep `data-names` and `data-chars` on the picker's root (`ref`) for `rows`: every document in the scope as `{ kind, pages, size, first, later, shortened,
 * multi }`, the words of its facts line (a new array when the scope or its documents change). `everyCourse`: the scope is 全部课程. The width of a name's
 * 「· 」 is kept on the root as `--picker-dot`: a course said alone hides its 「· 」 left of the line ('alone').
 */
export function useFactsFit(ref, rows, everyCourse) {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    let widths = null, font = '', decided = null;
    const look = () => {
      const facts = root.querySelector('.source-picker__facts');
      if (!facts) return;
      const style = getComputedStyle(facts), face = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily} ${style.letterSpacing}`;
      const width = root.getBoundingClientRect().width;
      // more rows drawn (the list grows taller) is no reason to look again: only another width or font is
      if (decided === width && face === font) return;
      if (face !== font || !widths) { font = face; widths = measured(rows, style); }
      if (!widths) return;
      decided = width;
      const room = rooms(root), em = parseFloat(style.fontSize), gap = parseFloat(style.columnGap) || 0.3 * em;
      const { names, chars } = decideFacts(widths, { room: row => (row.multi ? room.wide : room.plain), gap, em, everyCourse });
      if (names) root.dataset.names = names; else delete root.dataset.names;
      root.dataset.chars = chars;
      root.style.setProperty('--picker-dot', `${widths.dot}px`);
    };
    look();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(look);
    observer.observe(root);
    // A web font that arrives later changes the words' widths, not the boxes the observer watches.
    const scope = liveScope();
    document.fonts?.ready?.then(() => { if (scope.isLive()) { font = ''; look(); } });
    return () => { scope.end(); observer.disconnect(); };
  }, [ref, rows, everyCourse]);
}
