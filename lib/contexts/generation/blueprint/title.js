import { wsKey } from '../../../case-study.js';

/* How the titles and labels of a build are told apart. Pure. */

/** The key two titles are the same point under: NFKC, lower case, no spaces, no punctuation or symbols, except the ones that name things (C, C++ and C# are three points). */
const MEANING = '+#*';
export const normTitle = value => wsKey(value).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, char => MEANING.includes(char) ? char : '');

/** The key a question is known by inside a paper: the program's own (chunk and order), never the printed label, which can repeat. */
export const questionKey = (paperKey, question) => `${paperKey}\u0000${question.qid ?? question.label}`;

/** The label shown for a question: the printed one, told apart from an earlier one of the same paper by " (2)", " (3)" and so on. `taken` holds the labels the paper has. */
export function uniqueLabel(taken, printed, max = 40) {
  let label = printed, count = 1;
  while (taken.has(label)) { count++; const suffix = ` (${count})`; label = `${printed.slice(0, max - suffix.length)}${suffix}`; }
  taken.add(label);
  return label;
}
