import { KIT_TYPES_MAX, KIT_TYPE_QUESTIONS } from '../constants.js';
import { ZH_COMMAND_WORDS } from './messages.js';

/* The question types of the exam answer kit, made by the PROGRAM before any call: a question's family is the command word it opens with (compare, explain,
   design, ...: the earliest one found in its text), and a type is the questions of one family that test the same chapter. With more types than KIT_TYPES_MAX
   the chapter is dropped (one type per family); a type of more than KIT_TYPE_QUESTIONS questions is split. Pure. */

/** The command words of each family, English then Chinese (book/kit/messages.js), in the order a tie is settled. 'other' holds the rest. */
export const FAMILIES = Object.freeze([
  ['compare', ['compare', 'contrast', 'difference', 'differences', 'distinguish', 'versus', 'vs.']],
  ['calculate', ['calculate', 'compute', 'how many', 'how much', 'estimate', 'derive', 'determine the value']],
  ['design', ['design', 'propose', 'architect', 'sketch', 'draw', 'model', 'construct']],
  ['evaluate', ['evaluate', 'assess', 'justify', 'critique', 'critically', 'discuss', 'trade-off', 'advantages', 'disadvantages', 'pros and cons']],
  ['apply', ['apply', 'given', 'suppose', 'consider', 'scenario', 'case', 'in the context of']],
  ['explain', ['explain', 'describe', 'what is', 'what are', 'define', 'why', 'how does', 'how do', 'outline']],
  ['list', ['list', 'identify', 'name', 'give', 'state', 'write', 'enumerate']],
].map(([id, words]) => Object.freeze({ id, words: Object.freeze([...words, ...ZH_COMMAND_WORDS[id]]) })));

const latin = /^[a-z]/;
/** Where a command word stands in a text, as a word (an English word not inside another), or -1. */
function indexOf(text, word) {
  if (!latin.test(word)) return text.indexOf(word);
  const found = new RegExp(`(?:^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z])`).exec(text);
  return found ? found.index + (found[0].startsWith(word) ? 0 : 1) : -1;
}

/** The family of a question: the one whose command word comes first in its text; 'other' when none does. */
export function familyOf(text) {
  const lower = String(text ?? '').toLowerCase();
  let best = { id: 'other', at: Infinity };
  for (const family of FAMILIES) for (const word of family.words) {
    const at = indexOf(lower, word);
    if (at >= 0 && at < best.at) best = { id: family.id, at };
  }
  return best.id;
}

/** Split a list into parts of at most `size`, as even as the order allows. */
const parts = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, at) => list.slice(at * size, (at + 1) * size));

/**
 * @param questions [{ id, text, chapter }] in paper order (kit/questions.js)
 * @returns [{ family, chapter, questions }] by chapter, then by where the type's first question stands
 */
export function groupQuestions(questions, { max = KIT_TYPES_MAX, per = KIT_TYPE_QUESTIONS } = {}) {
  const tagged = questions.map((question, at) => ({ question, at, family: familyOf(question.text) }));
  const by = keyOf => {
    const groups = new Map();
    for (const entry of tagged) {
      const key = keyOf(entry);
      if (!groups.has(key)) groups.set(key, { family: entry.family, chapter: entry.question.chapter, first: entry.at, questions: [] });
      groups.get(key).questions.push(entry.question);
    }
    return [...groups.values()];
  };
  let groups = by(entry => `${entry.family}|${entry.question.chapter}`);
  if (groups.length > max) groups = by(entry => entry.family);
  return groups.sort((a, b) => a.chapter - b.chapter || a.first - b.first)
    .flatMap(group => parts(group.questions, per).map(list => ({ family: group.family, chapter: group.chapter, questions: list })));
}
