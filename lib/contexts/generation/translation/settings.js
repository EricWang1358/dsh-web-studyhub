/** A job that has run this long stops: a chapter of a long book is a long run, but not an endless one. */
export const TRANSLATION_JOB_TIMEOUT_MS = 60 * 60 * 1000;
/** With translations parallel to generation: how long a translation waits after the model said it is busy (doubling each time), and how often it asks again. */
export const TRANSLATION_COOLING_MS = 5000;
export const TRANSLATION_COOLING_TRIES = 3;
/** The newest calls a translation job keeps on its card. */
export const TRANSLATION_STEP_LIMIT = 40;
