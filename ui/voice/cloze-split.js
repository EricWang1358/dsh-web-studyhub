import { clozeRuns } from '../../lib/cloze-text.js';

/* A spoken cloze answer (#1031) goes into the same blanks as typing, split here, locally, with no model: the learner names each blank
   (「第一空 …，第二空 …」, 「第 2 个空 …」, "first blank …", "blank 2 …"). A transcript that does not name every blank exactly once fills none
   (`{ mismatch: true }`): the page shows it above the blanks to copy from, and nothing is graded that the learner did not put there. */

/** The blank ids of a cloze card, in the order they stand in the text. */
export const clozeBlankIds = (card) => [...new Set(clozeRuns(card?.cloze?.text).filter((run) => run.t === 'blank').map((run) => run.id))];

const HAN = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const ORDINAL = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const MARK = /第\s*([一二两三四五六七八九十]|\d{1,2})\s*个?\s*(?:空|处|格)|\bblank\s+(\d{1,2})\b|\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+blank\b/gi;
const LEAD = /^[\s：:，,、。.;；]*(?:是|为|填|is\b)?[\s：:，,、]*/i;
const TAIL = /[\s，,、。.;；！!？?]+$/;

const numberOf = (match) => (match[1] ? HAN[match[1]] ?? Number(match[1]) : match[2] ? Number(match[2]) : ORDINAL[match[3].toLowerCase()]);
const clean = (text) => text.replace(LEAD, '').replace(TAIL, '').trim();

/** `{ values: { [blankId]: text } }` when the transcript names every blank once, else `{ mismatch: true }`. One blank takes the whole sentence. */
export function splitSpokenBlanks(text, ids) {
  const said = String(text ?? '').trim();
  if (!said || !ids?.length) return { mismatch: true };
  const marks = [...said.matchAll(MARK)];
  if (!marks.length) return ids.length === 1 && clean(said) ? { values: { [ids[0]]: clean(said) } } : { mismatch: true };
  if (marks.length !== ids.length || clean(said.slice(0, marks[0].index))) return { mismatch: true };
  const values = {};
  for (const [at, match] of marks.entries()) {
    const n = numberOf(match), value = clean(said.slice(match.index + match[0].length, marks[at + 1]?.index ?? said.length));
    if (!Number.isInteger(n) || n < 1 || n > ids.length || values[ids[n - 1]] !== undefined || !value) return { mismatch: true };
    values[ids[n - 1]] = value;
  }
  return { values };
}
