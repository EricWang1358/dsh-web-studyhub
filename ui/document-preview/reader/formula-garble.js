/* 公式乱码 (#1001): a cheap guess, from the converted text of one chapter, that its formulas came out unreadable. A PDF's formulas converted without
   LaTeX often fall apart into a column of one-to-three-character lines (a variable, its subscript, an =, a ∑, an exponent, each on a line of its own).
   Prose, code, tables and formulas written as LaTeX do not look like that. Pure, no DOM; one pass over the lines (a few ms for a long chapter), and the
   reader keeps the answer per chapter. When it says yes the reader suggests 原始 PDF once per material (DocumentViewer.jsx). */

/** A run of at least this many fragment lines in a row is a formula that fell apart (one stray short line is a page number or a label). */
export const RUN_LINES = 3;
/** The chapter is flagged when at least this share of its lines sit in such runs, and at least MIN_STACKED of them do. */
export const GARBLED_SHARE = 0.1;
export const MIN_STACKED = 15;
/** Longest fragment (after trimming). */
const MAX_FRAGMENT = 3;
/* A line longer than this once its ASCII spaces are off is never a fragment (other spaces, like U+3000, are trimmed for the short ones). */
const SHORT_LINE = 16;

/* What a fragment of a formula is made of: Latin letters and digits, Greek, the math operators, arrows and letter-like symbols, super- and subscript
   digits, and the ASCII signs formulas use. */
const FRAGMENT = /^[A-Za-z0-9\u0370-\u03ff\u2070-\u209f\u2100-\u214f\u2190-\u21ff\u2200-\u22ff\u00b1\u00b2\u00b3\u00b7\u00b9\u00d7\u00f7\u2032\u2033=+\-*/^_()[\]{}<>|,.'!:;]+$/;
/* A fragment needs one sign of a formula: a letter, Greek or a math symbol, an = + < > ^ _ or an opening/closing round or square bracket around nothing
   else. Lines of digits alone (a page number, a cell of a numeric table) and lines of braces and semicolons alone (code) are no fragments. */
const SIGN = /[A-Za-z\u0370-\u03ff\u2070-\u209f\u2100-\u214f\u2190-\u21ff\u2200-\u22ff\u00b1\u00b2\u00b3\u00b7\u00b9\u00d7\u00f7\u2032=+<>^_]|^[()[\]]$/;
const NUMBER = /^[0-9.,%-]+$/;
const WORD = /^[A-Za-z]{3}$/;

/** Whether one line, trimmed, is a fragment of a formula that fell apart. A three-letter word (end, sin, lim) is not: code and prose have them. */
export function isFragment(line) {
  if (!line || line.length > MAX_FRAGMENT) return false;
  return FRAGMENT.test(line) && SIGN.test(line) && !NUMBER.test(line) && !WORD.test(line);
}

/** How much of `text` is formula fragments stacked in runs: { lines (non-empty), stacked (lines in runs of RUN_LINES or more), share }. */
export function formulaGarble(text) {
  // One scan over the string, no array of lines: only a short line (the only kind that can be a fragment) is cut out and trimmed.
  const all = String(text || ''), size = all.length;
  let lines = 0, stacked = 0, run = 0;
  for (let start = 0; start <= size;) {
    let end = all.indexOf('\n', start);
    if (end < 0) end = size;
    let from = start, to = end;
    while (from < to && all.charCodeAt(from) <= 32) from += 1;
    while (to > from && all.charCodeAt(to - 1) <= 32) to -= 1;
    start = end + 1;
    const line = to - from <= SHORT_LINE ? all.slice(from, to).trim() : 'long';
    if (!line) continue;
    lines += 1;
    if (isFragment(line)) { run += 1; continue; }
    if (run >= RUN_LINES) stacked += run;
    run = 0;
  }
  if (run >= RUN_LINES) stacked += run;
  return { lines, stacked, share: lines ? stacked / lines : 0 };
}

/** Whether the converted text of a chapter looks like its formulas fell apart (formulaGarble over the thresholds). */
export function looksGarbled(text) {
  const { stacked, share } = formulaGarble(text);
  return stacked >= MIN_STACKED && share >= GARBLED_SHARE;
}
