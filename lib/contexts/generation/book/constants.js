/* The sizes of one review book build. Named here so the plan, the prompts and the reading of the answers agree on them.

   A call is kept modest so a free model's output limit is not reached: a few knowledge points at a time, sized by the characters of their materials. */

/** Knowledge points explained in one call, and the characters of material shown to one call (well under lib/limits.js CALL_CHARS with the rules around them). */
export const LEAVES_PER_CALL = 3;
export const CALL_CHARS = 24000;
/** The characters of material one knowledge point is explained from; a point with more is shown an excerpt of each of its passages. */
export const LEAF_CHARS = 12000;
/** The least an excerpt keeps of one passage. */
export const PASSAGE_MIN = 400;
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
/** A quote with fewer characters than this is not a place (it would be found anywhere). */
export const QUOTE_MIN = 8;
