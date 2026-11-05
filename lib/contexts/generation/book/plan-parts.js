import { COVERAGE_LEVELS, bookCoverage } from '../../../book-settings.js';

/* WHICH STEPS A REVIEW BOOK BUILD MAKES (custom plan S2): a course's custom plan (lib/custom-plan.js, the course record's `custom`) names the parts of its book, and a build
   makes only the steps those parts need. One decision, here; the Job (jobs/course-book-build.js), the scale before a build (scale.js) and the sample's scale of the
   rest (jobs/sample-stage.js) read it.

   No plan, a plan that makes no book (book.make false: the learner pressed Generate on their own) or the learner's own Add term cards (`cards: true`): every step, today's build.
   Otherwise, by the parts as checkedCustom closed them (PART_NEEDS: terms, formulas and index need explain, confusables needs terms):
     explain      off: no point is written, reviewed or repaired, and no exam note is (they belong to a point's text). What the other parts still need is the
                  inventory and the outline: the answer kit is made from the sample papers' questions placed on the outline's points (kit/plan.js), not from
                  any explanation, so a plan of the kit alone reads, organises and makes the kit.
     terms        off: no card pass. The write call itself still returns its term cards: they come with the text in the same call, and taking them out would
                  change the start every point's request shares (prompts.js); they cost no call, and turning term cards back on finds them there.
     confusables  off: no comparison call; answerKit off: no kit call. The comparisons and the kit the book already has are kept (paid for; a later build with
                  the part back on asks only what changed).
     formulas, index, cheatSheet: views the program makes from what is written, no call: nothing to skip here; the book page hides their entries
                  (ui/book/book-parts.js) while the plan leaves them out. */

/** The custom plan of a course, or null (the same lookup as lib/custom-preview.js). */
export const courseCustom = (state, course) => (state.courses || []).find(item => item && item.name === course)?.custom ?? null;

/** The parts a build makes: null (every part) or the Set of the plan's parts. */
export function planParts(custom, { cardsOnly = false } = {}) {
  if (cardsOnly || custom?.book?.make !== true || !Array.isArray(custom.book.parts)) return null;
  return new Set(custom.book.parts);
}

/** The steps a build runs: { write (and review, repair), exam, cards, confusables, kit } from its plan's `parts`. */
export function bookSteps(parts) {
  const has = id => !parts || parts.has(id);
  return { write: has('explain'), exam: has('explain'), cards: has('terms'), confusables: has('confusables'), kit: has('answerKit') };
}

/** The detail level of a build: the request's, else the plan's (when it makes a book), else the saved setting. */
export function planCoverage(request, custom, settings) {
  if (COVERAGE_LEVELS.includes(request.coverage)) return request.coverage;
  return custom?.book?.make === true && COVERAGE_LEVELS.includes(custom.book.coverage) ? custom.book.coverage : bookCoverage(settings?.book);
}
