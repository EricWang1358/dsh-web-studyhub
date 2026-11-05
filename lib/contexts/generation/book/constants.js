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
/** The characters of the sample papers read to tell the language of the 术语卡's exam pitch (book/pitch-language.js). */
export const PITCH_SAMPLE_CHARS = 4000;
/** The exam answer kit (book/kit): the version of its writing (a change asks every type again), the most question types (beyond it the questions are grouped
    by their command word alone), the most questions one type holds (a bigger group is split), the size of a type that is tiny and how many tiny types one call
    takes, the characters of a question shown, and what is asked of an answer: trigger words, characters of what is tested and of one fill. */
export const KIT_VERSION = 1;
export const KIT_TYPES_MAX = 25;
export const KIT_TYPE_QUESTIONS = 8;
export const KIT_TINY = 1;
export const KIT_TINY_PER_CALL = 4;
export const KIT_QUESTION_CHARS = 600;
export const KIT_SIGNALS_ASK = 6;
export const KIT_ASKS_ASK = 160;
export const KIT_FILL_ASK = 400;
/** The sample slice (#710): a build with at least this many points to write first writes two of them (a typical and a heavy one) and waits for the learner. */
export const SAMPLE_FROM = 12;
/** The characters of the approved sample sent at the start of every write, review and repair request of a build (the style anchor, cached with that start). */
export const EXEMPLAR_CHARS = 1200;
/** One call of the card pass (book/card-batches.js, #710 S6): at most `units` written texts (a point, or one pass of a big one), `items` cards asked for and
    `chars` characters of text. A batch closes at whichever comes first, so a free model's output limit is not reached: a 283-point book is about 30 calls. */
export const CARD_PASS = Object.freeze({ units: 10, items: 50, chars: 40000 });
/** The confusable pairs (#710 S3, book/confusables): the pairs one call compares (the comparisons are short, so a call holds many), and the version of their writing
    (a change asks every pair again). */
export const CONFUSABLE_PAIRS = 10;
export const CONFUSABLE_VERSION = 1;
/** The version of the writing (a change rewrites every point once). */
export const WRITE_VERSION = 1;
/** The kinds of item a level must cover (every other item is shown to the writer as optional); a stressed item (`key`) or one the papers test is always a must. */
export const MUST_KINDS = Object.freeze({
  brief: Object.freeze(['term', 'definition', 'concept', 'formula']),
  standard: Object.freeze(['term', 'definition', 'concept', 'formula', 'step', 'rule', 'warning']),
  full: Object.freeze(['term', 'definition', 'concept', 'formula', 'step', 'rule', 'warning', 'example', 'claim']),
});
