/* The sizes of one inventory (inventory, lib/course-book-inventory.js). Named here so the ranges, the prompt and the reading of the answers agree on them.
   A call is kept modest so a free model's output limit is not reached: whole pages, at most RANGE_CHARS a range and CALL_CHARS a call. */

/** The characters of one range: whole pages packed in order (a page bigger than this alone is cut at a line). */
export const RANGE_CHARS = 15000;
/** The characters of material one call shows (several small ranges share a call), and the most ranges a call holds. */
export const CALL_CHARS = 15000;
export const RANGES_PER_CALL = 8;
/** The most items one call may list (the rest of a long answer is ignored), and the characters asked of a gist and of an anchor quote. */
export const ITEMS_PER_CALL = 300;
export const GIST_ASK = 120;
export const QUOTE_ASK = 100;
/** A quote with fewer letters than this is no anchor (it would be found anywhere). */
export const QUOTE_MIN = 6;
/** Bump when the prompt or the reading changes what a range yields: every range is read again once. */
export const INVENTORY_PROMPT_VERSION = 1;
