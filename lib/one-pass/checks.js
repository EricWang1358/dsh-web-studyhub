import { enforceAssignment } from '../assigned-plan.js';
import { kindOf } from '../card-kinds.js';
import { ONE_PASS_LIMITS } from './limits.js';

/* The program checks of one pass: what a write call returned is checked here, without a model, before anything else is spent on it.
   A WRITTEN card is what the model returns: { section, topic, objective, quote, prompt, hint, options: [{ text, correct, explanation }], explanation, misconception }.
   A placed card becomes a verified TARGET (the record lib/plan-record.js keeps: targetId, objective, knowledge, citations, and where its quote stands) and a CARD
   with the fields every generated card has. Reasons a card is dropped: options | objective | duplicate | quote-not-found | over-quota. */

const KIND = 'quiz';
/** Text as the program compares it: NFKC, lower case, letters and digits only (objectives and quotes of one pass). */
export const sameText = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const textOf = value => String(value ?? '').trim();
const lengthOf = value => String(value ?? '').replace(/\s/g, '').length;

/** What is wrong with a choice of options ('' when nothing): 3 to 6 options of text, exactly one of them correct. */
export function optionsProblem(options) {
  const { min, max } = kindOf(KIND).options;
  if (!Array.isArray(options) || options.length < min || options.length > max) return `need ${min}–${max} options`;
  if (options.some(option => !textOf(option?.text))) return 'each option requires text';
  return options.filter(option => option.correct === true).length === 1 ? '' : 'invalid correct option count';
}

/** Whether the correct option is longer than the longest wrong one by more than `ratio` (spaces not counted): a learner could pick it by its length. */
export function answerStandsOut(options, ratio = ONE_PASS_LIMITS.optionLengthRatio) {
  const right = options.find(option => option.correct === true), wrong = options.filter(option => option !== right);
  return !!right && wrong.length > 0 && lengthOf(right.text) > Math.max(...wrong.map(option => lengthOf(option.text))) * ratio;
}

/** The options in a random order, numbered in that order: the program decides where the answer stands, never the model. */
export function shuffleOptions(options, random = Math.random) {
  const list = options.map(option => ({ text: textOf(option.text), correct: option.correct === true, explanation: textOf(option.explanation) }));
  for (let index = list.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [list[index], list[other]] = [list[other], list[index]];
  }
  return list.map((option, index) => ({ id: `option-${index + 1}`, ...option }));
}

/** Where to look for a quote, in turn: the text of the section the model named (a sentence that stands in several sections is the named one's), then all the portion's text. */
const searchOrder = (slots, label) => {
  const named = slots.find(slot => slot.label === label)?.pieces || [];
  return [...(named.length ? [named] : []), slots.flatMap(slot => slot.pieces)];
};

/**
 * The placer of one portion. `slots` are its assignments with `label` (what the prompt calls the section) and `pieces` (lib/assigned-plan.js pieceOfAssignment); `existing` the
 * objectives the library and this run hold already. It remembers what it kept, so the quota and the duplicates count every card of the portion, a re-asked section's too.
 * place(written) -> { target } | { reason }
 */
export function createPlacer({ slots, existing = [] }) {
  const objectives = new Set(existing.map(sameText)), state = new Map(), locators = new Map();
  let serial = 0;
  const locate = (written, objective) => {
    let last = 'outside';
    for (const pieces of searchOrder(slots, written.section)) {
      for (const sourceId of new Set(pieces.map(piece => piece.id))) {
        const { kept, dropped } = enforceAssignment([{ objective, knowledge: textOf(written.quote), citations: [{ sourceId, quote: textOf(written.quote) }] }], pieces, slots, state, locators);
        if (kept.length) return { kept: kept[0] };
        last = dropped[0]?.reason || last;
        if (last !== 'outside') return { reason: last };
      }
    }
    return { reason: 'quote-not-found' };
  };
  return written => {
    if (!written || typeof written !== 'object') return { reason: 'options' };
    if (optionsProblem(written.options)) return { reason: 'options' };
    const objective = textOf(written.objective);
    if (!sameText(objective)) return { reason: 'objective' };
    if (objectives.has(sameText(objective))) return { reason: 'duplicate' };
    const found = locate(written, objective);
    if (!found.kept) return { reason: found.reason };
    objectives.add(sameText(objective));
    const { assignment, sectionId, start, end, citations, knowledge } = found.kept;
    return { target: { targetId: `target-${++serial}`, objective, knowledge, citations, assignment, sectionId, start, end } };
  };
}

/** The card of a placed written card: what the model wrote, with the objective and citation the program checked and the options in the program's order. */
export function cardOf(written, target, { random = Math.random } = {}) {
  const options = shuffleOptions(written.options, random);
  return { id: `c-${target.targetId}`, targetId: target.targetId, kind: KIND, topic: textOf(written.topic), objective: target.objective,
    prompt: textOf(written.prompt), answer: options.find(option => option.correct).text, hint: textOf(written.hint), options,
    explanation: textOf(written.explanation), misconception: textOf(written.misconception), citations: structuredClone(target.citations) };
}
