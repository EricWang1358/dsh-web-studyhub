/* The cadence and request limits of the context correction of a live class, in one place. The correction goes through the class as a cursor:
   every `intervalMs` it takes the sentences it has not covered, at most `newSentences` and `newChars` characters at a time, with up to `overlap`
   sentences (within `overlapChars` characters) before them as context. A sentence longer than the budget goes alone, and what a failed request does next
   (halve, skip, wait) is bounded here too, so a sentence that cannot be corrected never costs the learner's quota every thirty seconds. */

export const LIVE_CORRECTION = Object.freeze({
  /** How often a live class is checked for sentences not yet corrected. */
  intervalMs: 30_000,
  /** The most new sentences per request, and how many earlier ones ride along as context (upper bounds: the character budgets below usually bind first). */
  newSentences: 8,
  overlap: 2,
  /** New characters per request; a fast speaker's 700-character "sentences" go one by one, never five thousand characters at once. */
  newChars: 1200,
  /** Characters of earlier context per request: whole sentences while they fit, else the last `overlapChars` of a longer one as read-only context. */
  overlapChars: 300,
  /** A request that fails for a reason of its own (too long, cut off, malformed) is retried once with fewer characters, then its sentence is skipped; this many sentences skipped in a row stop the pass. */
  skipStreak: 3,
  /** A request that fails for a reason outside the text (network, rate limit, quota) is tried again on later intervals, at most this many times in a row, then it waits for the learner. */
  transientAttempts: 3,
  /** How long one request may take before it is stopped: a batch of the class, and a background request about older sentences. */
  requestMs: 20_000,
  backgroundMs: 60_000,
  /** The least and the most a correction reply may write; a request of more characters is allowed more (see `correctionBudget`). */
  maxTokens: 4096,
  maxTokensCap: 8192,
  /** A request is allowed this much longer per character of the sentences it asks about, up to the cap (a background request has its own floor and cap). */
  msPerChar: 15,
  maxRequestMs: 60_000,
  maxBackgroundMs: 120_000,
  /** Output tokens allowed per character of those sentences (corrected text and its Chinese translation), on top of `maxTokens` for the notes and the memory. */
  tokensPerChar: 2,
  /** Replies kept to answer the same window again without asking. */
  cacheEntries: 8,
});

/** What one request may spend, from the characters of the sentences it asks about: the time and the reply it is allowed, never below today's floors (20 s, 4096 tokens) or above the caps. */
export function correctionBudget(chars, { background = false } = {}) {
  const size = Math.max(0, Number(chars) || 0);
  const floor = background ? LIVE_CORRECTION.backgroundMs : LIVE_CORRECTION.requestMs;
  const cap = background ? LIVE_CORRECTION.maxBackgroundMs : LIVE_CORRECTION.maxRequestMs;
  return {
    timeoutMs: Math.min(cap, Math.max(floor, Math.round(floor + size * LIVE_CORRECTION.msPerChar))),
    maxOutputTokens: Math.min(LIVE_CORRECTION.maxTokensCap, Math.round(LIVE_CORRECTION.maxTokens + size * LIVE_CORRECTION.tokensPerChar)),
  };
}
