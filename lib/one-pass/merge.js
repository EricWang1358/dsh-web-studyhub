import { omissionOf } from './deck.js';

/* The merge after every portion of a one-pass run has settled (plan §3): portions are written at the same time, so two sections may each get a card on the same
   objective, or on the same quote where a sentence stands twice. The program keeps the earlier card in reading order and omits the later one, with the reason,
   taking its review receipt and its check with it. Only one-pass portions are compared; a staged part is the run's own business (lib/batch.js snapshot). */

export const DUPLICATE_REASON = 'duplicate learning target: an earlier section\'s question tests the same objective';

const sameText = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** A deck without the cards of `gone`, which are listed as omitted. The deck given is not changed. */
function without(deck, gone) {
  const ids = new Set(gone.map(card => card.id)), editorial = deck.editorial || {};
  const omitted = [...(editorial.omitted || []), ...gone.map(card => omissionOf(card, [DUPLICATE_REASON]))];
  return { ...deck, cards: deck.cards.filter(card => !ids.has(card.id)), editorial: { ...editorial,
    reviewedCards: Object.fromEntries(Object.entries(editorial.reviewedCards || {}).filter(([id]) => !ids.has(id))),
    ...(editorial.audit ? { audit: { ...editorial.audit, checks: (editorial.audit.checks || []).filter(check => !ids.has(check.cardId)) } } : {}),
    dropped: omitted.length, omitted, omittedIssues: [...new Set([...(editorial.omittedIssues || []), DUPLICATE_REASON])].slice(0, 8) } };
}

/** `planned` and `outcomes` of lib/batch.js; returns the outcomes with the later duplicates of every one-pass portion omitted (unchanged entries are the same objects). */
export function mergeAcrossPortions(planned, outcomes) {
  const seen = new Set();
  return outcomes.map((outcome, k) => {
    if (!planned[k]?.onePass || !outcome?.deck?.cards?.length) return outcome;
    const gone = [];
    for (const card of outcome.deck.cards) {
      const keys = [`o:${sameText(card.objective)}`, `q:${sameText(card.citations?.[0]?.quote)}`].filter(key => key.length > 2);
      if (keys.some(key => seen.has(key))) gone.push(card);
      else keys.forEach(key => seen.add(key));
    }
    return gone.length ? { ...outcome, deck: without(outcome.deck, gone) } : outcome;
  });
}
