import { omissionOf } from './deck.js';
import { askJson } from './reply.js';
import { sameText } from './checks.js';
import { ONE_PASS_LIMITS } from './limits.js';
import { GENERATION_STAGE_TEXT as STAGE } from '../contexts/jobs/contracts.js';

/* The merge after every portion of a one-pass run has settled (plan §3): portions are written at the same time, so two sections may each get a card on the same
   objective, or on the same quote where a sentence stands twice. The program keeps the earlier card in reading order and omits the later one, with the reason,
   taking its review receipt and its check with it. Only one-pass portions are compared; a staged part is the run's own business (lib/batch.js snapshot).
   Then ONE cheap model call over the whole round (prototype 6, owner 2026-11-21) groups the cards that test the same fact in other words, which no program key
   catches; the first card of each group in reading order stays. The program bounds what that reply may remove (ONE_PASS_LIMITS.sameFact*): a group only of cards
   of the same or adjacent sections and of at most `sameFactGroup` cards, and a reply that would remove more than `sameFactShare` of the round is ignored whole.
   An omitted card names the card that stays (`coveredBy`): its target is covered by that card (lib/plan-record.js, lib/coverage.js), not asked for again. */

export const DUPLICATE_REASON = 'duplicate learning target: an earlier section\'s question tests the same objective';
export const SAME_FACT_REASON = 'duplicate learning target: an earlier question of this run tests the same fact';
export const SAME_FACT_SYSTEM = 'These are the objectives and questions of one set of study cards about one material. Group the cards that test the SAME fact or rule (a learner who can answer one can answer the other with no new knowledge). Return JSON only: {"groups":[[0,5],[2,7,9]]} listing only groups of two or more card indexes; cards that stand alone are left out.';

/** A deck without the cards of `gone` ([{ card, by }]: the card omitted and the card that stays), listed as omitted with `reason`. The deck given is not changed.
    A merged card passed its checks and its review: the omission keeps the whole card (`card`: options, explanation, citations), so a wrong merge loses nothing (gate round 2). */
function without(deck, gone, reason) {
  const ids = new Set(gone.map(item => item.card.id)), editorial = deck.editorial || {};
  const omitted = [...(editorial.omitted || []), ...gone.map(({ card, by }) => ({ ...omissionOf(card, [reason]), coveredBy: by.id, card: structuredClone(card) }))];
  return { ...deck, cards: deck.cards.filter(card => !ids.has(card.id)), editorial: { ...editorial,
    reviewedCards: Object.fromEntries(Object.entries(editorial.reviewedCards || {}).filter(([id]) => !ids.has(id))),
    ...(editorial.audit ? { audit: { ...editorial.audit, checks: (editorial.audit.checks || []).filter(check => !ids.has(check.cardId)) } } : {}),
    dropped: omitted.length, omitted, omittedIssues: [...new Set([...(editorial.omittedIssues || []), reason])].slice(0, 8) } };
}

/** The outcomes with the cards of `gone` (Map card id -> card that stays) omitted with `reason`; unchanged entries are the same objects. */
function removing(outcomes, gone, reason) {
  if (!gone.size) return outcomes;
  return outcomes.map(outcome => {
    const lost = (outcome?.deck?.cards || []).filter(card => gone.has(card.id)).map(card => ({ card, by: gone.get(card.id) }));
    return lost.length ? { ...outcome, deck: without(outcome.deck, lost, reason) } : outcome;
  });
}

/** `planned` and `outcomes` of lib/batch.js; returns the outcomes with the later duplicates of every one-pass portion omitted (unchanged entries are the same objects). Idempotent. */
export function mergeAcrossPortions(planned, outcomes) {
  const seen = new Map(), gone = new Map();
  outcomes.forEach((outcome, k) => {
    if (!planned[k]?.onePass) return;
    for (const card of outcome?.deck?.cards || []) {
      const keys = [`o:${sameText(card.objective)}`, `q:${sameText(card.citations?.[0]?.quote)}`].filter(key => key.length > 2);
      const earlier = keys.map(key => seen.get(key)).find(Boolean);
      if (earlier) gone.set(card.id, earlier);
      else keys.forEach(key => seen.set(key, card));
    }
  });
  return removing(outcomes, gone, DUPLICATE_REASON);
}

/** The reading-order index of the section of the run a card's verified place stands in (the assignments of the one-pass portions, in order), or null. */
function sectionIndexer(planned) {
  const sections = planned.filter(part => part?.onePass).flatMap(part => part.assignments || []);
  return card => {
    const cited = (card.citations || []).find(item => Number.isInteger(item?.at?.start));
    if (!cited) return null;
    const index = sections.findIndex(item => item.sourceId === cited.sourceId && cited.at.start >= item.start && cited.at.start < item.end);
    return index < 0 ? null : index;
  };
}

/** The groups of a same-fact reply the program accepts: indexes of known cards, at most `sameFactGroup` of them, all of the same or adjacent sections. */
export function acceptedGroups(reply, all, limits = ONE_PASS_LIMITS) {
  return (Array.isArray(reply?.groups) ? reply.groups : []).flatMap(group => {
    const indexes = [...new Set(Array.isArray(group) ? group : [])].filter(index => Number.isInteger(index) && all[index]).sort((a, b) => a - b);
    if (indexes.length < 2 || indexes.length > limits.sameFactGroup) return [];
    const at = indexes.map(index => all[index].section);
    if (at.some(section => section === null) || Math.max(...at) - Math.min(...at) > 1) return [];
    return [indexes];
  });
}

/**
 * The final same-fact merge: one call (`ask(system, prompt, context)`, the run's limited call; a broken reply is asked again once) with every kept one-pass card's
 * objective and question; in each group the program accepts (acceptedGroups), the first card in reading order stays and the others are omitted with SAME_FACT_REASON.
 * A reply that would remove more than `sameFactShare` of the cards (at least one card may always go) is ignored and every card is kept. Fewer than two cards, or more
 * than `sameFactCards`, make no call. Returns the outcomes (unchanged entries are the same objects); a failed call throws.
 */
export async function mergeSameFacts(planned, outcomes, ask, limits = ONE_PASS_LIMITS) {
  const sectionOf = sectionIndexer(planned), all = [];
  outcomes.forEach((outcome, k) => { if (planned[k]?.onePass) for (const card of outcome?.deck?.cards || []) all.push({ card, section: sectionOf(card) }); });
  if (all.length < 2 || all.length > limits.sameFactCards) return outcomes;
  const cards = all.map(({ card }, index) => ({ index, objective: card.objective, prompt: card.prompt }));
  const reply = await askJson(ask, SAME_FACT_SYSTEM, JSON.stringify({ cards }), { stage: STAGE.reviewing, unit: 'merge' });
  const gone = new Map();
  for (const indexes of acceptedGroups(reply, all, limits)) {
    const stays = indexes.find(index => !gone.has(all[index].card.id));
    if (stays === undefined) continue;
    for (const index of indexes) if (index !== stays && !gone.has(all[index].card.id)) gone.set(all[index].card.id, gone.get(all[stays].card.id) || all[stays].card);
  }
  if (gone.size > Math.max(1, Math.floor(all.length * limits.sameFactShare))) return outcomes;
  return removing(outcomes, gone, SAME_FACT_REASON);
}
