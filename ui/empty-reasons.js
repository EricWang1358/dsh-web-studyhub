/* Every empty area in StudyHub is empty for one of three reasons, and the sentence it shows has to be the right one:
     never      nothing has been put here yet: say what this place holds and how to make the first one
     cleared    it held things and they are gone (archived, deleted, done, every mistake corrected): say what happened and
                where the old ones are, so a finished page is not read as "this never worked"
     filtered   a filter or a course scope is what left nothing: say so and offer the way back to all of it
   A page passes what it knows, so a page that grows a filter cannot keep saying "never". The three names are the product's
   words for the reason (docs/voice-and-tone.md rules 1 and 7); the sentences themselves belong to the page, because what a
   place holds is only known there. */

/** The three reasons, by the same names the copy is written against. */
export const EMPTY_REASONS = Object.freeze({ never: 'never', cleared: 'cleared', filtered: 'filtered' });

/**
 * Why an area has nothing to show.
 * filtered: the learner's filter or the course scope left nothing (the rows exist outside it) — it wins, because that is the
 *   one action that brings them back;
 * cleared: the area held things and they are gone, said only with evidence (a count, a history) that it was not always empty;
 * never: nothing was ever put here.
 */
export function emptyReason({ filtered = false, cleared = false } = {}) {
  if (filtered) return EMPTY_REASONS.filtered;
  return cleared ? EMPTY_REASONS.cleared : EMPTY_REASONS.never;
}
