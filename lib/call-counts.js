import { parseJson, salvageAuthoredCards, salvageReview } from './generation.js';
import { patchesById } from './generation-yield.js';

/* What a model call of a question run can say about the questions, read from its OWN reply when the call ends and kept on the call as `counts`
   (lib/job-calls.js unifyCall, docs/job-contract.md): the 任务 console's 日志 shows them next to the batch. A count is only given when the reply
   says it; nothing is estimated, and a reply that cannot be read gives nothing.
     author  { written }                       the questions the writing returned
     review  { reviewed, passed, flagged }     the per-card checks of this reply; flagged = a card with a dimension marked "fail" (a "suggest" never rejects)
     repair  { rewritten }                     the cards the reply re-words (a re-review of them is a review call, with its own counts)
   A review asked again for the cards still missing counts only those cards. These are the call's own verdicts, not the final result of the part (that is
   detail.partList, once the run has reported). */

function read(text) {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  try { return parseJson(text); } catch { return undefined; }
}

const countOfCards = (list) => (Array.isArray(list) ? list.filter((card) => card && typeof card === 'object' && !Array.isArray(card)).length : 0);

function authored(text) {
  const value = read(text) ?? salvageAuthoredCards(String(text ?? ''));
  const written = countOfCards(value?.deck && Array.isArray(value.deck.cards) ? value.deck.cards : value?.cards);
  return written ? { written } : undefined;
}

function reviewed(text) {
  let value = read(text);
  if (!Array.isArray(value?.checks)) value = salvageReview(String(text ?? ''));
  const checks = (Array.isArray(value?.checks) ? value.checks : []).filter((check) => check && typeof check === 'object' && typeof check.cardId === 'string');
  if (!checks.length) return undefined;
  const flagged = checks.filter((check) => Object.entries(check).some(([key, verdict]) => key !== 'cardId' && verdict === 'fail')).length;
  return { reviewed: checks.length, passed: checks.length - flagged, flagged };
}

function repaired(text) {
  const rewritten = patchesById(read(text)).size;
  return rewritten ? { rewritten } : undefined;
}

/** The counts of one reply for a call of this kind (author | review | repair), or undefined when the kind has none or the reply gives none. */
export function replyCounts(kind, text) {
  try {
    if (kind === 'author') return authored(text);
    if (kind === 'review') return reviewed(text);
    if (kind === 'repair') return repaired(text);
  } catch { /* a reply nobody can read counts nothing */ }
  return undefined;
}
