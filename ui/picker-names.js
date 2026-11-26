import { useLayoutEffect } from 'react';
import { liveScope } from './use-async.js';

/* What the rows' facts lines of one picker say follows one rule for the whole scope (#1084, round 8): a run of rows reads the same, and scrolling a long
   list (the window draws more rows) changes no row. The rule is decided from the words of every document in the scope, drawn or not, and the room of the
   facts line, and said on the picker's root. `data-names`, which names a row says:
   'all'   every name, whole;
   'first' only the first name (whole, or a course longer than six characters at 6em at least, cut with 「…」 and its whole name on hover);
   'none'  (a course scope) no name: the format and the size have the line;
   'kind'  (全部课程, #1134) the format, without its pages and size, then the course (6em at least, cut if need be);
   'alone' (全部课程 at its narrowest, where a row has no room even for that) the course alone on the line, its 「· 」 hidden left of the line's start,
           cut with 「…」 and its whole name on hover where it is longer: a course cut to two characters after a long format would say neither.
   The names are the first of a short list, most said first, that every row has room for, each row with its size in pages where it has pages and in
   characters where it has none ('first' in 全部课程: without its characters). In 全部课程 the first name is the course the row belongs to, the one thing
   the scope does not say for it, so every row keeps it, and its format with it where the course keeps 6em; round 14: a size never cuts it there (below).
   The sizes (#1135; round 11: one Markdown note no longer takes the characters of every Text note) are decided for the rows of a kind, `data-size-group`:
   the rows with pages are one group, a row without pages is in its format's group. A group says its characters where every row of it has room for them
   beside the names (in 全部课程, round 14: beside its whole course, so a size never cuts the course one row further than its neighbours), else none of its rows does (`data-chars-off` lists the groups that do not), so a size is said whole or not at all and the rows of
   a kind read alike. `data-unit="short"`: while a group without pages has no room for its characters in their long words (「180 characters」), the list
   says them all in their short words (「180 chars」, en 320), and the long words come back for every row at once when every such group has room for them
   (one change of words while the window widens, not one each time a kind gains its size); the long words stay in the checkbox's name. A document with
   pages says its characters only where its long words fit: its pages say its size first. `data-chars` sums the groups up for a reader of the page: 'all', 'unpaged' (only the rows with pages leave
   their characters out), 'some' or 'none'.
   The notes come after the names and take what is left of the line, each whole or out of sight (ui/source-picker.css), so they never decide. A row so
   never shows two cut pieces: in 'first', 'kind' and 'alone' only the name may be cut, in 'none' only the format (where it alone is wider than the line).
   The decision is taken again only when the scope's documents, the line's width or the font change: never because more rows are drawn, nor when the
   index answer lands (the badges' column is the same width coming, with a badge and without). In a picker that shows badges the line is as wide on a
   row with 选择页面 as on one without, at every width (ui/source-picker.css), so a wider window never says less. A word a row does not show stays in its checkbox's name. */

/** A little room kept spare: allow for subpixel rounding when the pieces share a line. */
const SPARE = 4;

/* The names, most said first. A course scope gives its other names way before a note's characters; 全部课程 keeps the course. */
const IN_SCOPE = ['all', 'first', 'none'];
const EVERY_COURSE = ['all', 'first', 'kind', 'alone'];
/** The groups whose characters the list decides together (ui/source-picker.css hides each by name): the rows with pages, then a format without pages. */
export const SIZE_GROUPS = ['paged', 'text', 'md', 'tex', 'html', 'txt', 'docx', 'json', 'audio'];
/** The size group of a document: 'paged' where its format says pages (or parts), else its format, a format not listed taking the text's (its label is 文本). */
export const sizeGroup = (format, paged) => (paged ? 'paged' : SIZE_GROUPS.includes(format) ? format : 'text');

/**
 * `{ names, unit, off }` for `rows` (each `{ kind, pages, size, short, first, later, shortened, multi, group }`: the widths in px of the format, of its pages
 * with their 「 · 」 (0 where it has none), of its characters with their 「 · 」 in the long and the short words, of the first name and of each name after
 * it, whether the first may be shortened, whether the row has 选择页面, and its size group). `names` is '' when no row has a name; `unit` 'long' or
 * 'short'; `off` the size groups that leave their characters out, in SIZE_GROUPS order. `room(row)` is the facts line's width for that row, `gap` the
 * space between two pieces, `em` the line's font size; `everyCourse` keeps the first name on every row (全部课程).
 */
export function decideFacts(rows, { room, gap, em, everyCourse = false, spare = SPARE }) {
  // `whole`: the first name is said whole, not shortened to 6em
  const named = (row, names, whole) => (!row.first || names === 'none' ? 0
    : gap + (names === 'all' ? row.first + row.later.reduce((sum, name) => sum + gap + name, 0) : row.shortened && !whole ? Math.min(row.first, 6 * em) : row.first));
  const fits = (row, names, chars, whole = false) => row.kind + (names === 'kind' ? 0 : row.pages + chars) + named(row, names, whole) <= room(row) - spare;
  const choices = everyCourse ? EVERY_COURSE : IN_SCOPE;
  const names = choices.find((which, at) => at === choices.length - 1
    || rows.every(row => fits(row, which, row.pages || (everyCourse && which === 'first') ? 0 : row.size)));
  const sized = names !== 'kind' && names !== 'alone';
  // which groups have room for their characters, in the long words and in the short ones. Round 14: in 全部课程 the course is the one fact the scope
  // does not give, so a group says its characters only where every row of it still says its course as the names alone leave it: whole beside them.
  const fitting = width => {
    const said = new Map();
    for (const row of rows) said.set(row.group, (said.get(row.group) ?? true) && sized && fits(row, names, width(row), everyCourse));
    return said;
  };
  const long = fitting(row => row.size), short = fitting(row => row.short);
  const unit = sized && [...long].some(([group, fit]) => !fit && group !== 'paged') ? 'short' : 'long';
  const said = group => (group === 'paged' ? long.get(group) : (unit === 'short' ? short : long).get(group));
  const off = SIZE_GROUPS.filter(group => long.has(group) && !said(group));
  return { names: rows.some(row => row.first) ? names : '', unit, off };
}

/** `data-chars` for `off` of the groups `present`: 'all', 'unpaged' (only the rows with pages leave their characters out), 'some' or 'none'. */
export const charsSummary = (off, present) => (!off.length ? 'all' : off.length === present.size ? 'none' : off.length === 1 && off[0] === 'paged' ? 'unpaged' : 'some');

// Measure in the row's language and font. With Chinese fallback fonts the same middle dot can
// occupy a full character cell here and a narrow Latin glyph on a detached canvas.
function measured(rows, facts) {
  const words = new Set(['· ']);
  for (const row of rows) {
    for (const word of [row.kind, row.pages, row.size, row.short, row.first, ...row.later]) {
      if (word) words.add(word);
    }
  }
  const ruler = document.createElement('span');
  ruler.setAttribute('aria-hidden', 'true');
  ruler.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;pointer-events:none';
  for (const word of words) {
    const span = document.createElement('span');
    span.style.display = 'inline-block';
    span.textContent = word;
    ruler.append(span);
  }
  // Insert the probes together, read all widths in one layout, then remove them before paint.
  facts.append(ruler);
  const sizes = new Map(Array.from(ruler.children, span => [span.textContent, span.getBoundingClientRect().width]));
  ruler.remove();
  const size = text => sizes.get(text) ?? 0;
  const widths = rows.map(row => ({ kind: size(row.kind), pages: size(row.pages), size: size(row.size), short: size(row.short), first: size(row.first), later: row.later.map(size),
    shortened: row.shortened, multi: row.multi, group: row.group }));
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
 * Keep `data-names`, `data-chars-off`, `data-unit` and `data-chars` on the picker's root (`ref`) for `rows`: every document in the scope as `{ kind, pages,
 * size, short, first, later, shortened, multi, group }`, the words of its facts line (a new array when the scope or its documents change). `everyCourse`:
 * the scope is 全部课程. The width of a name's 「· 」 is kept on the root as `--picker-dot`: a course said alone hides its 「· 」 left of the line ('alone').
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
      if (face !== font || !widths) { font = face; widths = measured(rows, facts); }
      decided = width;
      const room = rooms(root), em = parseFloat(style.fontSize), gap = parseFloat(style.columnGap) || 0.3 * em;
      const { names, unit, off } = decideFacts(widths, { room: row => (row.multi ? room.wide : room.plain), gap, em, everyCourse });
      if (names) root.dataset.names = names; else delete root.dataset.names;
      if (unit === 'short') root.dataset.unit = unit; else delete root.dataset.unit;
      if (off.length) root.dataset.charsOff = off.join(' '); else delete root.dataset.charsOff;
      root.dataset.chars = charsSummary(off, new Set(widths.map(row => row.group)));
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
