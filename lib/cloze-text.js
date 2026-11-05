/* The {{id}} blanks of a cloze text and the formulas around them, with the scanner the cards draw with (lib/math-scan.js).
   A blank belongs in the prose: the learner types its value and the program compares the text (lib/domain.js gradeCloze), and the formula around a blank
   could not be drawn. Generation keeps to that (lib/assessment-quality.js clozeIssues); a text written before the rule still draws (clozeRuns). */
import { formulaAt } from './math-scan.js';
import { stripCodeMarkup } from './notation.js';

export const CLOZE_MARK = /\{\{\s*([^{}\s]+)\s*\}\}/g;

/* A cloze cut out of a longer sentence (#cloze-whole-sentence): it opens on a word that answers a clause before it (但是…, 所以…, However…), or keeps
   the first half of a pair without its second (虽然… with no 但/却/也/还/仍). The half kept states one case as the rule. 但凡 and a hyphenated word
   (Thus-far) are not connectives. */
const LEADING = /^(?:但是|但(?!凡)|可是|然而|不过|却|而是|而且|并且|所以|因此|因而|于是|否则|不然|反而|(?:but|however|therefore|thus|hence|otherwise|whereas|yet)\b(?!-))/i;
const PAIRS = [[/虽然|尽管|虽说/, /但|却|也|还|仍|可是|然而|不过/], [/不仅|不但|不只/, /而且|也|还|更|并且/]];
const OPENING = /^[\s>*_"'“‘「『（(]+/;

/** The words that show a cloze text is half a sentence ('但是', '虽然…'), or null for a whole one. */
export function clozeFragment(text) {
  const body = String(text ?? '').replace(OPENING, '');
  const lead = body.match(LEADING);
  if (lead) return `${lead[0]}…`;
  for (const [first, second] of PAIRS) {
    const at = body.search(first);
    if (at >= 0 && !second.test(body.slice(at + 2))) return `${body.slice(at, at + 2)}…`;
  }
  return null;
}
const HAS_MARK = /\{\{\s*[^{}\s]+\s*\}\}/;

/** The formulas of `text` that hold a blank: [{ start, end, source }]. */
function formulasWithBlanks(text) {
  const found = [];
  for (let i = 0; i < text.length;) {
    const at = formulaAt(text, i);
    if (!at) { i++; continue; }
    if (HAS_MARK.test(at.formula.raw)) found.push({ start: i, end: at.end, source: at.formula.source });
    i = at.end;
  }
  return found;
}

/** The text as pieces: { code: false, v } prose and { code: true, v } the inside of an inline code span (`…`, one line; its backticks dropped). Code is no formula scanner's business ($HOME is a variable). */
function codePieces(text) {
  const pieces = [];
  let last = 0;
  for (const match of text.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
    if (match.index > last) pieces.push({ code: false, v: text.slice(last, match.index) });
    pieces.push({ code: true, v: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) pieces.push({ code: false, v: text.slice(last) });
  return pieces;
}

/** The ids of the blanks that sit inside a formula. */
export function blanksInFormula(text) {
  return codePieces(String(text ?? '')).filter((piece) => !piece.code)
    .flatMap((piece) => formulasWithBlanks(piece.v)).flatMap(({ source }) => [...source.matchAll(CLOZE_MARK)].map((match) => match[1]));
}

/**
 * The text as the review screen shows it: { t: 'text', v } runs, drawn with their formulas, { t: 'code', v } runs (an inline code span, without its backticks) and { t: 'blank', id } slots.
 * A blank inside a formula splits it: the formula is closed before the blank and opened again after it (as \(…\), which always draws), so both halves still draw. A blank inside a code
 * span splits it the same way: each half stays a code run beside the blank.
 */
export function clozeRuns(source) {
  const text = String(source ?? ''), runs = [];
  const add = (value) => {
    if (!value) return;
    const last = runs.at(-1);
    if (last?.t === 'text') last.v += value; else runs.push({ t: 'text', v: value });
  };
  const split = (segment, wrap) => {
    let last = 0;
    for (const match of segment.matchAll(CLOZE_MARK)) {
      add(wrap(segment.slice(last, match.index)));
      runs.push({ t: 'blank', id: match[1] });
      last = match.index + match[0].length;
    }
    add(wrap(segment.slice(last)));
  };
  const prose = (piece) => {
    let last = 0;
    for (const formula of formulasWithBlanks(piece)) {
      split(piece.slice(last, formula.start), (value) => value);
      split(formula.source, (value) => value.trim() ? `\\(${value}\\)` : '');
      last = formula.end;
    }
    split(piece.slice(last), (value) => value);
  };
  for (const piece of codePieces(text)) {
    if (!piece.code) { prose(piece.v); continue; }
    let last = 0;
    for (const match of piece.v.matchAll(CLOZE_MARK)) {
      if (match.index > last) runs.push({ t: 'code', v: piece.v.slice(last, match.index) });
      runs.push({ t: 'blank', id: match[1] });
      last = match.index + match[0].length;
    }
    if (last < piece.v.length) runs.push({ t: 'code', v: piece.v.slice(last) });
  }
  return runs;
}

/** Whether a blank's value is written as a formula or TeX, which a learner cannot type the way the program compares it. */
export const formulaValue = (value) => /\$|\\[A-Za-z()[\]]/.test(String(value ?? ''));

/** A value that is only a plain token in $…$ ("$12$", "$x$") without its dollars, and any code markup (backticks) dropped; anything else as it was. */
export function plainValue(value) {
  if (typeof value !== 'string') return value;
  const bare = stripCodeMarkup(value);
  return /^\s*\$([^$\\{}^_]+)\$\s*$/.exec(bare)?.[1]?.trim() || bare;
}
