import { pointsOfChars } from './contexts/generation/outline/estimate.js';
import { CHAIN_LOW } from './contexts/generation/book/scale.js';
import { CARD_PASS, CONFUSABLE_PAIRS, KIT_QUESTION_CHARS, KIT_TYPES_MAX, KIT_TYPE_QUESTIONS } from './contexts/generation/book/constants.js';
import { strengthPlan } from './coverage-strength.js';
import { CALL_CHARS } from './limits.js';
import { normalizeGenerationPerformance, splitCount } from './generation-settings.js';
import { tokensOfChars } from './token-estimate.js';

/* What a 定制方案 (lib/custom-plan.js) would ask of the model, BEFORE an outline or an inventory exists: calls and tokens read, from the characters of the chosen
   chapters alone (lib/custom-skeleton.js), so every figure here is rough (`rough: true` while anything is counted). It reuses the repo's estimators for the sizes and
   adds none of its own except the three below that no estimator can know before the book is written. Pure; no price anywhere (the owner's rule: calls and tokens).

   BOOK, from the same rules the outline and the book build estimate with:
     points      per chosen chapter, pointsOfChars (outline/estimate.js), at least one a chapter.
     calls       the inventory that reads the chosen material (CALL_CHARS a call), a write and a review a point (book/scale.js CHAIN_LOW; a point of the default cut is
                 about 3 200 characters, under LEAF_CHARS, so one unit, and the 讲解详尽程度 only changes a point bigger than that: coverage is not in the estimate), the
                 term cards (CARD_PASS.units a call), the confusable pairs (CONFUSABLE_PAIRS a call), the answer kit (a type a call, from the sample papers' size).
                 Only the ticked parts, as checkedCustom closed them: formulas, index and the cheat sheet are made by the program, no call. Nothing without parts.
     readTokens  the material is read once for the inventory and twice a point (write, review), the cards read their units' text, the kit reads the papers.
   QUESTIONS, lib/coverage-strength.js strengthPlan over the chosen chapters as sections: count is its goal (a material gets a question at every level). The calls are
     the parts the generation settings cut a kind's share into (batchSize), each a plan, a blueprint, an author and a review call; the material is read twice.
   The three guesses (sizes the estimate only, like outline/estimate.js POINTS_PER_CHAPTER): PAIRS_PER_POINT, QUESTION_CALLS and QUESTION_READS. The schedule and the
   variants add nothing: the schedule is made by the program, and a variant is only written once an answer is wrong. */

/** Opposite or parallel pairs the term cards of a point typically make; the cards do not exist yet. */
export const PAIRS_PER_POINT = 0.5;
/** The calls of one part of questions: plan, blueprint, author, review (lib/token-estimate.js, the 'generate' estimate). */
export const QUESTION_CALLS = 4;
/** Times the chosen material is read by the questions' calls: the author and the review. */
export const QUESTION_READS = 2;

const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);

function bookEstimate(chosen, paperChars, book) {
  if (!book.make || !book.parts.length) return { points: 0, calls: 0, readTokens: 0 };
  const chars = sum(chosen, row => row.chars), points = sum(chosen, row => pointsOfChars(row.chars)), has = id => book.parts.includes(id);
  const pairs = Math.round(points * PAIRS_PER_POINT);
  const kitTypes = Math.min(KIT_TYPES_MAX, Math.max(1, Math.ceil(Math.ceil(paperChars / KIT_QUESTION_CHARS) / KIT_TYPE_QUESTIONS)));
  const calls = Math.ceil(chars / CALL_CHARS) + CHAIN_LOW * points + (has('terms') ? Math.ceil(points / CARD_PASS.units) : 0)
    + (has('confusables') ? Math.ceil(pairs / CONFUSABLE_PAIRS) : 0) + (has('answerKit') && paperChars > 0 ? kitTypes : 0);
  const read = chars + CHAIN_LOW * chars + (has('terms') ? points * (CARD_PASS.chars / CARD_PASS.units) : 0) + (has('answerKit') ? paperChars : 0);
  return { points, calls, readTokens: tokensOfChars(read) };
}

function questionsEstimate(chosen, questions, performance) {
  if (!questions.make || !questions.kinds.length) return { count: 0, calls: 0, readTokens: 0 };
  const sections = chosen.map(row => ({ sourceId: row.doc, id: String(row.index), chars: row.chars, leaf: true }));
  const { goal } = strengthPlan(sections, [], questions.strength);
  const { batchSize } = normalizeGenerationPerformance(performance);
  const parts = sum(splitCount(questions.kinds, goal), ([, count]) => Math.ceil(count / batchSize));
  return { count: goal, calls: parts * QUESTION_CALLS, readTokens: tokensOfChars(QUESTION_READS * sum(chosen, row => row.chars)) };
}

/** @param pick { chosen: [{ doc, index, chars }], paperChars } (custom-skeleton.js chosenChapters); `custom` a checked 定制方案; `performance` the library's generation settings.
    @returns { book: { points, calls, readTokens }, questions: { count, calls, readTokens }, total: { calls, readTokens }, rough } */
export function estimateCustom({ chosen, paperChars }, custom, performance) {
  const book = bookEstimate(chosen, paperChars, custom.book), questions = questionsEstimate(chosen, custom.questions, performance);
  const total = { calls: book.calls + questions.calls, readTokens: book.readTokens + questions.readTokens };
  return { book, questions, total, rough: total.calls > 0 };
}
