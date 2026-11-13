/* Code fences and headings of a Markdown text, read the way CommonMark reads them (#1029). Pure and browser-safe: the book (lib/course-book-links.js,
   lib/book-section-ops.js, lib/course-book-lookup.js, lib/course-book-ai-text.js, lib/course-book-export.js) and the note written from a question
   (lib/contexts/notes/question-note.js) all decide "is this line code?" and "which lines are headings?" here, so they never disagree.

   A fence opens with 3 or more backticks or tildes (a backtick fence's info string holds no backtick) and is closed only by a fence of the SAME character at
   least as long as the opening one, with nothing after it but spaces. Every other fence-looking line inside is code. Leading spaces are not counted (a fence
   in a list item is indented), as the book always read them.

   A heading is an ATX line (`## Title`) or a setext one: one or more text lines under which a line of `=` (level 1) or `-` (level 2) stands. A `---` after a
   blank line, a list item, a quote, a heading or a fence is a thematic break, not an underline. */

const OPEN = /^\s*(`{3,}|~{3,})([^\n]*)$/;
const CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const ATX = /^(#{1,6})\s+(.*?)\s*$/;
const UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
/** A line that starts a block of its own: a quote, a list item, an HTML line (the book's comment markers), a table row, a thematic break, an indented code line. */
const BLOCK_START = /^(?:\s*(?:>|[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|<|\|)|\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$| {4,}|\t)/;

/** What the lines hold of code fences: { mask, open }. `mask[i]` is true for a fence line and for every line inside a fence; `open` is { char, length } of a fence
    still open at the end, else null. */
function scan(lines) {
  const mask = [];
  let open = null;
  for (const line of lines) {
    if (open) {
      mask.push(true);
      const close = CLOSE.exec(line);
      if (close && close[1][0] === open.char && close[1].length >= open.length) open = null;
      continue;
    }
    const found = OPEN.exec(line);
    if (found && !(found[1][0] === '`' && found[2].includes('`'))) { open = { char: found[1][0], length: found[1].length }; mask.push(true); } else mask.push(false);
  }
  return { mask, open };
}

/** One boolean per line: the line is a fence line or inside a fence. */
export const fenceMask = lines => scan(lines).mask;

/** The line that closes the fence a text leaves open (its character, at least its length), or '' when no fence is open. */
export function closingFence(lines) {
  const { open } = scan(lines);
  return open ? open.char.repeat(open.length) : '';
}

/** The headings of the lines, outside code fences, in order: [{ at, last, end, level, text, setext }]. `at` is the heading's first line, `last` the line that
    ends its text (where its id comment is written), `end` its last line (the underline of a setext heading). `text` is the title as written (a setext
    title over several lines is joined with spaces). */
export function markdownHeadings(lines) {
  const { mask } = scan(lines), out = [];
  let floor = 0;
  lines.forEach((line, at) => {
    if (mask[at]) return;
    const atx = ATX.exec(line);
    if (atx) { out.push({ at, last: at, end: at, level: atx[1].length, text: atx[2], setext: false }); floor = at + 1; return; }
    const underline = UNDERLINE.exec(line);
    if (!underline || at <= floor) return;
    let first = at - 1;
    const paragraph = index => index >= floor && lines[index].trim() !== '' && !mask[index] && !ATX.test(lines[index]);
    if (!paragraph(first) || BLOCK_START.test(lines[first])) return;
    // A line that starts a block of its own (a list item, a quote, another break) ends the walk back at once: the lines over an underline are read once, not again for the next.
    while (paragraph(first - 1)) { first -= 1; if (BLOCK_START.test(lines[first])) return; }
    out.push({ at: first, last: at - 1, end: at, level: underline[1][0] === '=' ? 1 : 2, text: lines.slice(first, at).map(row => row.trim()).join(' '), setext: true });
    floor = at + 1;
  });
  return out;
}

/** A heading written as one ATX line: `level` and `text` as given; the lines of a setext heading below its first become empty, so no line moves. `heading` is
    an item of markdownHeadings (its `at` and `end`). Changes `out` in place. */
export function writeAtx(out, heading, level, text) {
  out[heading.at] = `${'#'.repeat(level)} ${text}`;
  for (let line = heading.at + 1; line <= heading.end; line += 1) out[line] = '';
}

/** The lines with every setext heading written as an ATX heading of its level (an id comment in its text stays in it). The reader, the 目录 and the export of
    the book know ATX headings only, so every place that takes a file into the book writes them this way. Lines without a setext heading come back as they were. */
export function atxLines(lines) {
  const out = lines.slice();
  for (const heading of markdownHeadings(lines)) if (heading.setext) writeAtx(out, heading, heading.level, heading.text);
  return out;
}
