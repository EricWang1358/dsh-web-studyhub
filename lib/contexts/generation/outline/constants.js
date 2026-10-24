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
/** How big a knowledge point is asked to be, by `granularity` (#462): the items a point of the inventory typically holds, and the most points one map call
    may name. 'medium' asks exactly what every build asked before the option existed (its prompts and cached answers are unchanged). */
export const GRANULARITY = Object.freeze({
  coarse: { items: 'ten to forty items', perBatch: 20 },
  medium: { items: 'a handful to fifteen items', perBatch: POINTS_PER_BATCH },
  fine: { items: 'two to six items', perBatch: POINTS_PER_BATCH },
});
/** The cut of a plan ({ granularity? }), as the prompts read it. */
export const cutOf = plan => GRANULARITY[plan?.granularity] ?? GRANULARITY.medium;
/** What a key of a model call adds for the cut: nothing for the default cut, so the answers kept before the option existed still count. */
export const cutSalt = granularity => (granularity && granularity !== 'medium' ? [granularity] : []);
export const TITLE_ASK = 30;
export const INTRO_ASK = 90;
/** The outline from the inventory: items one cluster call groups, the characters of a gist it shows, the intro asked of a knowledge point (two or three sentences),
    the version of the grouping (a change asks every batch again), and the characters of the clusters shown to the one order call (beyond: their intros are dropped). */
export const CLUSTER_ITEMS = 120;
export const GIST_SHOWN = 90;
export const INTRO_ASK_LONG = 240;
export const CLUSTER_VERSION = 1;
export const ORDER_CHARS = 42000;
