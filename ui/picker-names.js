import { useLayoutEffect } from 'react';
import { liveScope } from './use-async.js';

/* The names on the rows' facts lines of one picker follow one rule for the whole scope (#1084, round 8): a run of rows reads the same, and scrolling a long
   list (the window draws more rows) changes no row. The rule is decided from the words of every document in the scope, drawn or not, and the room of the
   facts line, and said on the picker's root as `data-names`:
   'all'   every row has room for all its names whole: they are shown;
   'first' every row has room for its first name (whole, or a course longer than six characters at 6em): only the first is shown, on every row;
   'none'  some row has no room even for that: no row shows a name.
   In 全部课程 the first name is the course the row belongs to, the one thing the scope does not say for it, so every row keeps it ('first' at least) and
   gives way with the format, the size and the notes, which are then cut in their own words (ui/source-picker.css).
   The decision is taken again only when the scope's documents, the line's width or the font change: never because more rows are drawn, nor when the
   index answer lands (the badges' column is the same width coming, with a badge and without). A name a row does not show stays in its checkbox's name. */

/** A little room kept spare: the canvas measures the words a hair differently from the line (rounding, the digits' font). */
const SPARE = 4;

/**
 * 'all' | 'first' | 'none' for `rows` (each `{ lead, first, later, shortened, multi }`: the widths in px of the format, size and notes, of the first name and
 * of each name after it, whether the first may be shortened, whether the row has 选择页面), '' when no row has a name. `room(row)` is the facts line's
 * width for that row, `gap` the space between two pieces, `em` the line's font size; `everyCourse` keeps the first name on every row (全部课程).
 */
export function decideNames(rows, { room, gap, em, everyCourse = false, spare = SPARE }) {
  let any = false, all = true, first = true;
  for (const row of rows) {
    if (!row.first) continue;
    any = true;
    const width = room(row) - spare, head = row.lead + gap;
    if (head + row.first + row.later.reduce((sum, name) => sum + gap + name, 0) > width) all = false;
    if (head + (row.shortened ? Math.min(row.first, 6 * em) : row.first) > width) first = false;
  }
  return !any ? '' : all ? 'all' : first || everyCourse ? 'first' : 'none';
}

let canvas;
/** The rows' words measured in the facts line's font, or null where there is no canvas (a test without a browser). */
function measured(rows, style) {
  try { canvas ??= document.createElement('canvas').getContext('2d'); } catch { canvas = null; }
  if (!canvas) return null;
  canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if ('letterSpacing' in canvas) canvas.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
  const sizes = new Map(), size = text => { if (!sizes.has(text)) sizes.set(text, canvas.measureText(text).width); return sizes.get(text); };
  return rows.map(row => ({ lead: size(row.lead), first: row.first ? size(row.first) : 0, later: row.later.map(size), shortened: row.shortened, multi: row.multi }));
}

/** The facts line's width on a row with 选择页面 and on one without, read from a drawn row of each (a kind not drawn yet takes the other's). */
function rooms(root) {
  const width = selector => root.querySelector(selector)?.getBoundingClientRect().width ?? null;
  const plain = width('.source-picker__row:not(.has-expand) .source-picker__facts'), wide = width('.source-picker__row.has-expand .source-picker__facts');
  return { plain: plain ?? wide, wide: wide ?? plain };
}

/**
 * Keep `data-names` on the picker's root (`ref`) for `rows`: every document in the scope as `{ lead, first, later, shortened, multi }`, the words of its
 * facts line (a new array when the scope or its documents change). `everyCourse`: the scope is 全部课程.
 */
export function useNamesFit(ref, rows, everyCourse) {
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
      const fit = decideNames(widths, { room: row => (row.multi ? room.wide : room.plain), gap, em, everyCourse });
      if (fit) root.dataset.names = fit; else delete root.dataset.names;
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
