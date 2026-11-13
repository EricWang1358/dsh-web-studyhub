import { fixedOptionsOf } from '../../lib/card-kinds.js';

/* 题干条 (#1012): what the narrow reader keeps of the question it was opened from, so the learner reads the material with the question in view. Only what
   the question itself shows before an answer: the stem (a cloze's text with its blanks as ＿＿, never what fills them; a flashcard's front, never its back)
   and the options' letters and words (never which one is right, never an explanation). A 判断题 is its statement: 对 / 错 add nothing to it. */

const BLANK = /\{\{[^{}]+\}\}/g;

/** { stem, options: [{ id, mark, text }] } of a question card, or null without one. */
export function stripOf(card) {
  if (!card) return null;
  const clozeText = typeof card.cloze?.text === 'string' ? card.cloze.text : '';
  const stem = clozeText ? clozeText.replace(BLANK, '＿＿') : String(card.prompt || '');
  const options = !fixedOptionsOf(card.kind) && Array.isArray(card.options)
    ? card.options.map((option, index) => ({ id: option.id, mark: String.fromCharCode(65 + index), text: String(option.text ?? '') }))
    : [];
  return { stem, options };
}
