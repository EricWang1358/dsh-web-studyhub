import { sliceRangeOf } from '../sections.js';
import { ONE_PASS_LIMITS } from './limits.js';

/* What the one-pass review is given and what it says back. The review judges a card against its quote and the text around it (`windowChars` on each side),
   never the whole material, and judges at most `reviewBatch` cards at a time. */

/** The text around a target's quote: `chars` characters on each side, cut from the source (or the piece of it) that holds the quote. */
export function quoteWindow(sources, target, chars = ONE_PASS_LIMITS.windowChars) {
  const sourceId = target.citations?.[0]?.sourceId;
  for (const source of Array.isArray(sources) ? sources : []) {
    if (source?.id !== sourceId || typeof source.text !== 'string') continue;
    const base = sliceRangeOf(source).start;
    if (target.start < base || target.end > base + source.text.length) continue;
    return source.text.slice(Math.max(0, target.start - base - chars), target.end - base + chars);
  }
  return target.citations?.[0]?.quote ?? '';
}

/** `list` in batches of at most `size`, in order. */
export function reviewBatches(list, size = ONE_PASS_LIMITS.reviewBatch) {
  const batches = [];
  for (let at = 0; at < list.length; at += size) batches.push(list.slice(at, at + size));
  return batches;
}

/**
 * The verdicts of one review reply for a batch of `count` cards: an array with one entry per card, { pass, issue }, or null for a card the reply said nothing usable about.
 * A verdict is 'pass' or 'fail'; anything else is no verdict.
 */
export function readVerdicts(reply, count) {
  const verdicts = Array.from({ length: count }, () => null);
  for (const entry of Array.isArray(reply?.reviews) ? reply.reviews : []) {
    const index = entry?.index;
    if (!Number.isInteger(index) || index < 0 || index >= count || verdicts[index] || !['pass', 'fail'].includes(entry.verdict)) continue;
    verdicts[index] = { pass: entry.verdict === 'pass', issue: String(entry.issue ?? '').trim().slice(0, 300), ...(Number.isInteger(entry.blocker) && entry.blocker > 0 ? { blocker: entry.blocker } : {}) };
  }
  return verdicts;
}
