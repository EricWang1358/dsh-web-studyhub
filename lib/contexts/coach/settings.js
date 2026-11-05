/* The numbers 为你定制's background work has always used, in one place (they were literals in the worker). The day's own settings
   (batches a day, how many prepared at most, reasoning) are the ledger's: lib/coach-daily.js DAILY. */
export const COACH_PREP = Object.freeze({
  /** How long a first wrong answer waits for more before its batch starts (ms), and how many queued cards start it at once. */
  delayMs: 20000, flushAt: 3,
  /** Cards in one batch (one model call). */
  batchSize: 4,
  /** The output cap of a variants call: room to think, plus what one card's JSON takes, per card asked for. A model that thinks before it answers
      spent a flat 3,600 on the thinking and wrote nothing (2026-11-05). Only what is written is paid for; the cap only stops a runaway. */
  reasoningTokens: 4096, cardTokens: 1200,
  /** Rewrites of different cards that may run together. */
  maxParallelRewrites: 3,
});
