/* 判断题 (kind truefalse): what only this kind has besides its registry entry (lib/card-kinds.js). The stored shape is a choice question with
   exactly the two fixed options of the registry, ids "true" and "false" in that order, one of them correct; the statement is the prompt.
   Grading, exams, mistakes, insights, export and the validator therefore read it as a single-answer choice. Pure, browser-safe. */
import { kindOf } from './card-kinds.js';

export const TRUE_FALSE = 'truefalse';
const VERDICT = { true: /^(true|t|yes|correct|对|正确|是|√|✓)$/i, false: /^(false|f|no|incorrect|wrong|错|错误|否|×|✗)$/i };
const CJK = /[㐀-鿿]/;
const said = (value) => String(value ?? '').trim().replace(/[.。!！]$/, '');

/** Which verdict an option written by a model or a file stands for ("true" / "false"), by its id first and then its text; null when it says neither. */
function verdictOf(option) {
  for (const key of ['id', 'text'])
    for (const [verdict, words] of Object.entries(VERDICT)) if (words.test(said(option?.[key]))) return verdict;
  return null;
}

/**
 * The two options of a true/false card in their fixed order, from options a model or a file wrote with any ids ("a"/"b", "正确"/"错误"): each kept with
 * its correctness and explanation, its text the verdict's word in the statement's language (对 / 错, or True / False). The options as given when they
 * are not exactly one "true" and one "false" option, so the validator says what is wrong with them.
 */
export function trueFalseOptions(options, statement) {
  if (!Array.isArray(options) || options.length !== 2) return options;
  const fixed = kindOf(TRUE_FALSE).fixedOptions;
  const byVerdict = new Map(options.map((option) => [verdictOf(option), option]));
  if (fixed.some(({ id }) => !byVerdict.has(id))) return options;
  const english = !CJK.test(String(statement ?? ''));
  return fixed.map(({ id, label, en }) => ({ ...byVerdict.get(id), id, text: english ? en : label }));
}

/** The options of a true/false item as the answer stage and the author are shown them (a false statement: the interesting case). */
export const TRUE_FALSE_OPTIONS_EXAMPLE = Object.freeze([
  Object.freeze({ id: 'true', text: 'True', correct: false, explanation: 'why the statement is not true, from the quoted evidence' }),
  Object.freeze({ id: 'false', text: 'False', correct: true, explanation: 'why the statement is false, and the true statement' }),
]);

/** The verdict a true/false card or answer item holds: true, false, or null when its options do not say. */
export const verdictHeld = (item) => {
  const right = Array.isArray(item?.options) ? item.options.filter((option) => option?.correct === true) : [];
  return right.length === 1 && ['true', 'false'].includes(right[0].id) ? right[0].id === 'true' : null;
};

/** How many statements of one batch make it worth balancing: three of a kind can be chance, four of a kind teach the learner to guess. */
export const BALANCE_MIN = 4;
/**
 * A batch of true/false items that are all true or all false (BALANCE_MIN or more): the positions of the later half of them, which should hold the other
 * verdict. Empty when the batch is mixed or too small to judge.
 */
export function unbalancedTrueFalse(items) {
  const verdicts = (Array.isArray(items) ? items : []).map(verdictHeld);
  const known = verdicts.filter((verdict) => verdict !== null);
  if (known.length < BALANCE_MIN || new Set(known).size !== 1) return [];
  const at = verdicts.flatMap((verdict, index) => (verdict === null ? [] : [index]));
  return at.slice(Math.ceil(at.length / 2));
}
