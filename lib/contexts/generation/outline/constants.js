/* The sizes of one course outline build. Named here so the plan, the prompts and the stages agree on them. */

/** Characters of material descriptors in one map call: well under the per-call limit (lib/limits.js CALL_CHARS) with the rules around them. */
export const BATCH_CHARS = 36000;
/** Characters of a syllabus shown to a map call (an excerpt) and to the reduce call (the ordering authority). */
export const SYLLABUS_MAP_CHARS = 3000;
export const SYLLABUS_CHARS = 12000;
/** Characters of the knowledge points shown to the reduce call; beyond it their notes are dropped, then their material names. */
export const REDUCE_CHARS = 42000;
/** What a material (or a chapter) is described by: its most frequent question topics and the first prompts. */
export const TOPICS_PER_UNIT = 5;
export const PROMPTS_PER_UNIT = 2;
export const PROMPT_CHARS = 70;
export const CHAPTERS_PER_MATERIAL = 60;
/** Characters of sample paper read in one call, and the places a leaf keeps from one paper. */
export const PAPER_CHUNK_CHARS = 8000;
export const PAPER_PLACES = 2;
export const QUOTE_CHARS = 120;
/** The most knowledge points one map call may name, and the titles and notes asked for. */
export const POINTS_PER_BATCH = 60;
export const TITLE_ASK = 30;
export const INTRO_ASK = 90;
