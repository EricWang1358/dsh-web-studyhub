/* The sizes of one review book build. Named here so the plan, the prompts and the reading of the answers agree on them.
   A call is kept modest so a free model's output limit is not reached: one knowledge point a call, a big one in passes of its own pages. */

/** The characters of material one writing call shows (whole pages; a bigger point is written in passes, each its own call over its own pages). */
export const PASS_CHARS = 20000;
/** The most cites one unit keeps, the characters asked of a quote and the least letters a quote must have (shorter would be found anywhere). */
export const UNIT_CITES = 12;
export const QUOTE_ASK = 80;
export const QUOTE_MIN = 8;
/** The most issues one review may raise, and the repair rounds a unit gets before it is kept as short (未达标). */
export const ISSUES_MAX = 30;
export const REPAIR_ROUNDS = 2;
/** Knowledge points whose exam notes one call writes, and the characters asked of one note. */
export const EXAM_LEAVES_PER_CALL = 8;
export const EXAM_NOTE_ASK = 120;
/** The version of the writing (a change rewrites every point once). */
export const WRITE_VERSION = 1;
/** The kinds of item a level must cover (every other item is shown to the writer as optional); a stressed item (`key`) or one the papers test is always a must. */
export const MUST_KINDS = Object.freeze({
  brief: Object.freeze(['term', 'definition', 'concept', 'formula']),
  standard: Object.freeze(['term', 'definition', 'concept', 'formula', 'step', 'rule', 'warning']),
  full: Object.freeze(['term', 'definition', 'concept', 'formula', 'step', 'rule', 'warning', 'example', 'claim']),
});
