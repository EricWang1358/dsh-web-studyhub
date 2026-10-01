/* Token accounting that follows DSH's own model (WP27).

   Everything here mirrors DSH 0.2.0-rc.2 so StudyHub shows what DSH shows:
   - the four disjoint buckets of `@deepseek-ai/dsh-token-meter` (uncached
     input, cache read, cache write, output). A provider's `reasoningTokens` is
     a SUBSET of its output and is never added again; DSH folds it the same way;
   - the replay fold of its `tokenUsage` projection (`usage-projection`): one
     slot per (turn, step) that a later settlement replaces, closed by
     `llm/retry-started` so a retried attempt adds to the total;
   - the number and cache-hit formatting of its session usage panel
     (`dsh-client-ui-chat`, `token-format`): exact counts grouped by ",", compact
     counts as 12.2K / 1.2M, and a cache-hit percentage that never rounds a
     partial hit up to 100.
   No money anywhere: tokens are what a provider reports, prices are theirs. */

/** @typedef {{uncachedInputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number}} UsageBuckets */

export const emptyUsage = () => ({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

const isCount = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * One provider-reported TokenUsage as DSH buckets, or null when it is not trustworthy.
 * `reasoningTokens` and `totalTokens` are ignored on purpose: reasoning is already inside `outputTokens`.
 */
export function usageFromTokenUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0 } = raw;
  if (![inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].every(isCount)) return null;
  return { uncachedInputTokens: inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/** Sum of two usage records (`calls` is the number of model requests behind it). */
export function addUsage(a, b) {
  const sum = (field) => (Number(a?.[field]) || 0) + (Number(b?.[field]) || 0);
  return { uncachedInputTokens: sum('uncachedInputTokens'), outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheWriteTokens'), calls: sum('calls') };
}

/** Everything the provider billed on the prompt side: uncached input plus cache read and write. */
export const promptTokens = (usage) => (usage?.uncachedInputTokens || 0) + (usage?.cacheReadTokens || 0) + (usage?.cacheWriteTokens || 0);
/** DSH's "Token 用量": the prompt side plus the output. */
export const totalTokens = (usage) => promptTokens(usage) + (usage?.outputTokens || 0);

/** A usage sink for one job (and optionally one of its steps): reports accumulate onto them. */
export function jobUsageSink(job, step) {
  return (usage, meta = {}) => {
    const record = { ...usage, calls: meta.calls ?? 1 };
    job.usage = addUsage(job.usage, record);
    if (step) step.usage = addUsage(step.usage, record);
  };
}

/* ---------- DSH's replay fold ---------- */

const bucketsEqual = (a, b) => a.uncachedInputTokens === b.uncachedInputTokens && a.outputTokens === b.outputTokens
  && a.cacheReadTokens === b.cacheReadTokens && a.cacheWriteTokens === b.cacheWriteTokens;
const streamUsage = (stream) => {
  for (let index = (Array.isArray(stream) ? stream.length : 0) - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage;
  }
  return undefined;
};
const usageOf = (event) => {
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage;
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  return streamUsage(event.data?.stream);
};
const bucketsOf = (raw) => ({ uncachedInputTokens: raw.inputTokens, outputTokens: raw.outputTokens,
  cacheReadTokens: raw.cacheReadTokens ?? 0, cacheWriteTokens: raw.cacheWriteTokens ?? 0 });

/**
 * DSH's `tokenUsage` projection over a session's events. Each assistant settlement contributes the last usage
 * sample of its stream; a later settlement of the same (turn, step) replaces it, and `llm/retry-started` closes
 * the slot so the retried attempt adds. `requests` counts the slots that were opened.
 * @returns {{ totals: UsageBuckets, requests: number }}
 */
export function foldUsageEvents(events) {
  let totals = emptyUsage(), last = null, requests = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'llm/retry-started') {
      if (last && last.turn === event.data?.turn && last.step === event.data?.step) last = null;
      continue;
    }
    const sample = usageOf(event);
    if (sample === undefined || sample === null) continue;
    const { turn, step } = event.data;
    const next = bucketsOf(sample);
    const previous = last && last.turn === turn && last.step === step ? last.buckets : undefined;
    if (previous && bucketsEqual(previous, next)) continue;
    if (!previous) requests += 1;
    totals = { uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
      outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
      cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens };
    last = { turn, step, buckets: next };
  }
  return { totals, requests };
}

const wholeBuckets = (value) => !!value && ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].every((key) => isCount(value[key]));

/**
 * The usage of one DSH session (a generation child, for example): DSH's own `tokenUsage` projection when the
 * host serves it, else our mirror of its fold over the session events. Null when the session cannot be read.
 * @param sessionQuery `ctx.sessionQuery`
 */
export async function readSessionUsage(sessionQuery, sessionId) {
  if (!sessionId || typeof sessionQuery?.observeSession !== 'function') return null;
  let observed;
  try {
    observed = await sessionQuery.observeSession(sessionId);
    const events = observed?.events;
    const folded = foldUsageEvents(events);
    const projected = observed?.projections?.values?.tokenUsage;
    // The host's projection is authoritative; the fold supplies how many requests stand behind it.
    if (wholeBuckets(projected)) return { usage: { ...projected }, requests: folded.requests };
    return { usage: folded.totals, requests: folded.requests };
  } catch { return null; }
  finally { try { observed?.[Symbol.dispose]?.(); } catch { /* a lease that will not release changes nothing */ } }
}

/* ---------- DSH's display helpers ---------- */

/** Exact count with "," digit grouping (DSH `formatExactTokens`). */
export function formatExactTokens(value) {
  const digits = String(value);
  const groups = [];
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
  return groups.join(',');
}

/** Compact count: 517 / 12.2K / 517K / 1.2M (DSH `formatTokens`). */
export function formatCompactTokens(value) {
  const scaled = (candidate) => candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
  if (value < 1e3) return String(value);
  if (value < 1e6) return `${scaled(value / 1e3)}K`;
  return `${scaled(value / 1e6)}M`;
}

/** Round a cache-read ratio to exact percentage units, with positive ties rounded up. */
function roundedPercentUnits(cacheReadTokens, denominator, decimalPlaces) {
  const scale = (decimalPlaces === 0 ? 1 : 10) * 100;
  const doubledScale = scale * 2;
  const denominatorQuotient = Math.floor(denominator / doubledScale);
  const denominatorRemainder = denominator % doubledScale;
  let lower = 0, upper = scale;
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2);
    const factor = candidate * 2 - 1;
    if (cacheReadTokens >= factor * denominatorQuotient + Math.ceil(factor * denominatorRemainder / doubledScale)) lower = candidate;
    else upper = candidate - 1;
  }
  return lower;
}
function displayPercentUnits(units, decimalPlaces) {
  if (decimalPlaces === 0) return String(units);
  const whole = Math.floor(units / 10), tenths = units % 10;
  return tenths === 0 ? String(whole) : `${whole}.${tenths}`;
}

/**
 * The cache-hit share without rounding a partial hit to 100 (DSH `formatCacheHitPercent`): text, or null when
 * there was no prompt input.
 */
export function formatCacheHitPercent(cacheReadTokens, promptTokenCount, decimalPlaces = 0) {
  if (promptTokenCount === 0) return null;
  const missedInputTokens = promptTokenCount - cacheReadTokens;
  if (missedInputTokens === 0) return '100';
  const roundedUnits = roundedPercentUnits(cacheReadTokens, promptTokenCount, decimalPlaces);
  if (roundedUnits < (decimalPlaces === 0 ? 100 : 1e3)) return displayPercentUnits(roundedUnits, decimalPlaces);
  let distinguishingPlaces = 1, scaledDoubleGap = missedInputTokens * 200;
  const denominatorTens = Math.floor(promptTokenCount / 10);
  while (scaledDoubleGap <= denominatorTens) { scaledDoubleGap *= 10; distinguishingPlaces += 1; }
  const denominatorOnes = promptTokenCount % 10;
  let roundedLoss = 5;
  for (let loss = 1; loss < 5; loss += 1) {
    const factor = loss * 2 + 1;
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10);
    if (scaledDoubleGap <= threshold) { roundedLoss = loss; break; }
  }
  return `99.${'9'.repeat(distinguishingPlaces - 1)}${10 - roundedLoss}`;
}

/** The session panel's 缓存命中: cache read over everything billed on the prompt side; null without input. */
export const cacheHitPercent = (usage) => formatCacheHitPercent(usage?.cacheReadTokens || 0, promptTokens(usage));
