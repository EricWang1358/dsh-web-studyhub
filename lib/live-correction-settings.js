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
  /** The reply a request may write: what a request without its own size gets, the least, and the most. */
  maxTokens: 4096,
  minTokens: 2048,
  maxTokensCap: 8192,
  /** The longest a request may take, whatever its size (a background request has its own floor and cap above `backgroundMs`). */
  maxRequestMs: 60_000,
  maxBackgroundMs: 120_000,
  /**
   * What a reply is expected to hold, in tokens: the JSON frame and the batch note, a little per corrected sentence (small edits, not the sentence again),
   * the Chinese translation of a changed sentence that is not itself Chinese, and the cumulative memory when it is asked for. The limit sent is this
   * with `replyHeadroom`; the time allowed is the floor plus the time to read the sentences plus the time to write that many tokens.
   */
  replyBaseTokens: 1200,
  itemTokens: 150,
  zhTokensPerChar: 1.5,
  memoryTokens: 2400,
  replyHeadroom: 1.25,
  readMsPerChar: 4,
  writeMsPerToken: 12,
  /** The cumulative memory is rewritten on its own cadence, not on every call: first batch, then every this many batches or characters, and once more when the class is over. */
  memoryEveryBatches: 3,
  memoryEveryChars: 3000,
  /** Replies kept to answer the same window again without asking. */
  cacheEntries: 8,
});

/** Chinese is not translated into Chinese: a sentence mostly made of Han characters needs no `zh`, and keeps the translation state it has. */
export function mainlyChinese(text) {
  const letters = String(text).match(/[\p{L}\p{N}]/gu);
  return !!letters && (String(text).match(/\p{Script=Han}/gu) || []).length / letters.length >= 0.5;
}

/**
 * What one request may spend, from what it asks and what it is expected to write: `inputChars` it reads, `items` it may correct, `zhChars` of those that need a
 * translation, and whether it rewrites the `memory`. Pure; never below the floor time or `minTokens`, never above the caps.
 */
export function correctionBudget({ inputChars = 0, items = 1, zhChars = 0, memory = false, background = false } = {}) {
  const L = LIVE_CORRECTION, num = value => Math.max(0, Number(value) || 0);
  const expectedTokens = Math.round(L.replyBaseTokens + num(items) * L.itemTokens + num(zhChars) * L.zhTokensPerChar + (memory ? L.memoryTokens : 0));
  const floor = background ? L.backgroundMs : L.requestMs, cap = background ? L.maxBackgroundMs : L.maxRequestMs;
  const wanted = 10_000 + num(inputChars) * L.readMsPerChar + expectedTokens * L.writeMsPerToken;
  return {
    expectedTokens,
    timeoutMs: Math.min(cap, Math.max(floor, Math.round(wanted))),
    maxOutputTokens: Math.min(L.maxTokensCap, Math.max(L.minTokens, Math.round(expectedTokens * L.replyHeadroom))),
  };
}
