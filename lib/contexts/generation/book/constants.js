/* The sizes of one review book build. Named here so the plan, the prompts and the reading of the answers agree on them.

   A call is kept modest so a free model's output limit is not reached: a few knowledge points at a time, sized by the characters of their materials. */

/** Knowledge points explained in one call, and the characters of material shown to one call (well under lib/limits.js CALL_CHARS with the rules around them). */
export const LEAVES_PER_CALL = 3;
export const CALL_CHARS = 24000;
/** How much of a knowledge point's material is read, by 讲解详尽程度 (the shared call's LEAF_CHARS and excerpt, a pass's PASS_CHARS, passes and cites per level):
    lib/course-book-reading.js, which the page's 覆盖 figure reads too. */
export { LEAF_CHARS, LEVELS, PASSAGE_MIN, PASS_CHARS } from '../../../course-book-reading.js';
/** The most cites a point explained in a shared call keeps (it is asked for QUOTES_ASK). */
export const CITES_KEPT = 8;
/** Knowledge points whose 考情 one call writes. */
export const EXAM_LEAVES_PER_CALL = 8;
/** What is asked for: bullets, characters of the explanation and the example, the quotes (角标) and their length, the 补充 items, the 考情 note. */
export const POINTS_ASK = 6;
export const EXPLAIN_ASK = 600;
export const EXAMPLE_ASK = 500;
export const QUOTES_ASK = 4;
export const QUOTE_ASK = 80;
export const EXTRA_ASK = 3;
export const EXAM_NOTE_ASK = 120;
/** Knowledge points one bridges call writes the transitions of (consecutive points of one chapter), the characters asked of one transition and kept of it,
    and of the one-line summary of a point's notes it is given. */
export const BRIDGES_PER_CALL = 12;
export const BRIDGE_ASK = 80;
export const BRIDGE_CHARS = 200;
export const SUMMARY_CHARS = 120;
/** A quote with fewer characters than this is not a place (it would be found anywhere). */
export const QUOTE_MIN = 8;
