/* The cadence and request limits of the context correction of a live class, in one place. The correction goes through the class as a cursor:
   every `intervalMs` it takes the sentences it has not covered, `newSentences` at a time with `overlap` sentences before them as context. */

export const LIVE_CORRECTION = Object.freeze({
  /** How often a live class is checked for sentences not yet corrected. */
  intervalMs: 30_000,
  /** New sentences per request, and how many earlier ones ride along as context. */
  newSentences: 8,
  overlap: 2,
  /** How long one request may take before it is stopped: a batch of the class, and a background request about older sentences. */
  requestMs: 20_000,
  backgroundMs: 60_000,
  /** The most a correction reply may write. */
  maxTokens: 4096,
  /** Replies kept to answer the same window again without asking. */
  cacheEntries: 8,
});
