/* The sizes of one exam point list build. Named here so the plan, the readers and the stages of the job agree on them. */

/** Slides read in one window of the lecture pass, and the characters that fit it. */
export const WINDOW_SLIDES = 10;
export const WINDOW_CHARS = 6000;
/** Characters of sample paper read in one call. */
export const PAPER_CHUNK_CHARS = 8000;
export const POINTS_PER_WINDOW = 12;
export const POINTS_PER_QUESTION = 6;
/** A typical number of questions in one chunk of a paper: it sizes the estimate only, nothing is cut at it. */
export const QUESTIONS_PER_CHUNK = 24;
/** The longest quote the model is asked for. */
export const QUOTE_CHARS = 120;
/** Places kept for one point: from the slides, and from each sample paper that tested it. */
export const SLIDE_PLACES = 3;
export const PAPER_PLACES = 2;
/** The shortest quote that counts as a place (characters without spaces): a quote with CJK text, and any other. */
export const QUOTE_MIN = Object.freeze({ cjk: 6, other: 12 });
