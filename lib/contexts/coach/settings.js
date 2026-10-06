/* The numbers 为你定制's background work has always used, in one place (they were literals in the worker). The day's own settings
   (batches a day, how many prepared at most, reasoning) are the ledger's: lib/coach-daily.js DAILY. */
export const COACH_PREP = Object.freeze({
  /** How long a first wrong answer waits for more before its batch starts (ms), and how many queued cards start it at once. */
  delayMs: 20000, flushAt: 3,
  /** Cards in one batch (one model call). */
  batchSize: 4,
  /** Rewrites of different cards that may run together. */
  maxParallelRewrites: 3,
});
