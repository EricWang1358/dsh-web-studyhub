import { omissionOf } from './deck.js';
import { askJson } from './reply.js';
import { ONE_PASS_LIMITS } from './limits.js';
import { GENERATION_STAGE_TEXT as STAGE } from '../contexts/jobs/contracts.js';

/* The merge after every portion of a one-pass run has settled (plan §3): portions are written at the same time, so two sections may each get a card on the same
   objective, or on the same quote where a sentence stands twice. The program keeps the earlier card in reading order and omits the later one, with the reason,
   taking its review receipt and its check with it. Only one-pass portions are compared; a staged part is the run's own business (lib/batch.js snapshot).
   Then ONE cheap model call over the whole run (prototype 6, owner 2026-11-21) groups the cards that test the same fact in other words, which no program key
   catches; the first card of each group in reading order stays. */

export const DUPLICATE_REASON = 'duplicate learning target: an earlier section\'s question tests the same objective';
export const SAME_FACT_REASON = 'duplicate learning target: an earlier question of this run tests the same fact';
export const SAME_FACT_SYSTEM = 'These are the objectives and questions of one set of study cards about one material. Group the cards that test the SAME fact or rule (a learner who can answer one can answer the other with no new knowledge). Return JSON only: {"groups":[[0,5],[2,7,9]]} listing only groups of two or more card indexes; cards that stand alone are left out.';

const sameText = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** A deck without the cards of `gone`, which are listed as omitted with `reason`. The deck given is not changed. */
function without(deck, gone, reason = DUPLICATE_REASON) {
  const ids = new Set(gone.map(card => card.id)), editorial = deck.editorial || {};
  const omitted = [...(editorial.omitted || []), ...gone.map(card => omissionOf(card, [reason]))];
  return { ...deck, cards: deck.cards.filter(card => !ids.has(card.id)), editorial: { ...editorial,
    reviewedCards: Object.fromEntries(Object.entries(editorial.reviewedCards || {}).filter(([id]) => !ids.has(id))),
    ...(editorial.audit ? { audit: { ...editorial.audit, checks: (editorial.audit.checks || []).filter(check => !ids.has(check.cardId)) } } : {}),
    dropped: omitted.length, omitted, omittedIssues: [...new Set([...(editorial.omittedIssues || []), reason])].slice(0, 8) } };
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

/**
 * The final same-fact merge: one call (`ask(system, prompt, context)`, the run's limited call; a broken reply is asked again once) with every kept one-pass card's
 * objective and question; in each group the reply names, the first card in reading order stays and the others are omitted with SAME_FACT_REASON. Fewer than two
 * cards, or more than ONE_PASS_LIMITS.sameFactCards, make no call. Returns the outcomes (unchanged entries are the same objects); a failed call throws.
 */
export async function mergeSameFacts(planned, outcomes, ask) {
  const all = [];
  outcomes.forEach((outcome, k) => { if (planned[k]?.onePass) for (const card of outcome?.deck?.cards || []) all.push({ k, card }); });
  if (all.length < 2 || all.length > ONE_PASS_LIMITS.sameFactCards) return outcomes;
  const cards = all.map(({ card }, index) => ({ index, objective: card.objective, prompt: card.prompt }));
  const reply = await askJson(ask, SAME_FACT_SYSTEM, JSON.stringify({ cards }), { stage: STAGE.reviewing, unit: 'merge' });
  const gone = new Set();
  for (const group of Array.isArray(reply?.groups) ? reply.groups : []) {
    const indexes = [...new Set(Array.isArray(group) ? group : [])].filter(index => Number.isInteger(index) && all[index]).sort((a, b) => a - b);
    indexes.slice(1).forEach(index => gone.add(index));
  }
  if (!gone.size) return outcomes;
  return outcomes.map((outcome, k) => {
    const lost = all.filter((item, index) => item.k === k && gone.has(index)).map(item => item.card);
    return lost.length ? { ...outcome, deck: without(outcome.deck, lost, SAME_FACT_REASON) } : outcome;
  });
}
