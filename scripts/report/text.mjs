/* Text helpers shared by the report kit: XML/HTML escaping, a width measure that knows CJK, and line wrapping.
   Widths are in em (1 em = the font size). CJK and full-width forms count 1 em, narrow ASCII less, capitals and m/w more:
   the measure errs on the wide side, so a box sized from it is never too small for the real font. */

/** Escape for XML and HTML text and attributes; characters XML cannot hold at all are dropped. */
export function esc(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|[\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
const NARROW = new Set([..." .,;:!|'`il"]);
const BROAD = new Set([..."mwMW@%"]);

/** Width of one character in em. */
export function charWidth(ch) {
  if (WIDE.test(ch)) return 1;
  if (ch === " ") return 0.3;
  if (NARROW.has(ch)) return 0.32;
  if (BROAD.has(ch) || (ch >= "A" && ch <= "Z")) return 0.78;
  const code = ch.codePointAt(0);
  return code < 0x250 ? 0.58 : 1;
}

/** Width of a string in em. */
export function textWidth(text) {
  let total = 0;
  for (const ch of String(text)) total += charWidth(ch);
  return total;
}

const NO_LINE_START = new Set([..."，。、！？：；）」』》】〉”’…—,.!?:;)]}%"]);
const NO_LINE_END = new Set([..."（「『《【〈“‘([{"]);
const isWide = (ch) => WIDE.test(ch);
const isSpace = (ch) => ch === " " || ch === "\t";

/* Break units: one per CJK character, one per run of other characters (a word plus the space after it). */
function units(paragraph) {
  const out = [];
  let word = "";
  for (const ch of paragraph) {
    if (isWide(ch)) { if (word) out.push(word); word = ""; out.push(ch); continue; }
    word += ch;
    if (isSpace(ch)) { out.push(word); word = ""; }
  }
  if (word) out.push(word);
  return out;
}

/** Cut a unit wider than the line into pieces that each fit. */
function pieces(unit, limit) {
  const out = [];
  let piece = "";
  for (const ch of unit) {
    if (piece && textWidth(piece + ch) > limit) { out.push(piece); piece = ""; }
    piece += ch;
  }
  if (piece) out.push(piece);
  return out;
}

/** Wrap text to a width. Returns { lines: string[], widths: number[] (px), width: widest line (px) }.
 *  A line never gets wider than maxWidth (unless one character alone is wider); closing punctuation is kept off the start of a line
 *  and opening brackets off the end; a "\n" in the text starts a new line. */
export function wrapText(text, maxWidth, fontSize) {
  const limit = Math.max(maxWidth / fontSize, 1);
  const lines = [];
  for (const paragraph of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const queue = units(paragraph).flatMap((unit) => textWidth(unit) > limit ? pieces(unit, limit) : [unit]);
    let line = [];
    const flush = () => { lines.push(line.join("").replace(/\s+$/, "")); line = []; };
    for (const unit of queue) {
      const trimmed = unit.trimEnd();
      if (line.length && textWidth(line.join("") + trimmed) > limit) {
        const first = [...unit][0];
        let carry = [];
        // keep a closing mark off the line start by taking the last unit down with it; same for an opening bracket at the end
        if (NO_LINE_START.has(first) && line.length > 1) carry = [line.pop()];
        while (line.length > 1 && NO_LINE_END.has([...line[line.length - 1].trimEnd()].pop())) carry.unshift(line.pop());
        flush();
        line = carry;
      }
      line.push(unit);
    }
    flush();
  }
  const widths = lines.map((line) => textWidth(line) * fontSize);
  return { lines, widths, width: Math.max(0, ...widths) };
}

/** Escape, then allow **bold** and `code` in author text. */
export function inline(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

/** Escaped text with line breaks kept. */
export function withBreaks(text) {
  return inline(String(text ?? "").replace(/\r\n?/g, "\n")).replace(/\n/g, "<br>");
}
