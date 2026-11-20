import { randomUUID } from 'node:crypto';
import { reviewedCardFingerprint } from '../review-integrity.js';

/* The deck of one portion in the shape every part of a run hands lib/batch.js (what generateDeck returns): the kept cards with published ids, and an editorial
   record that says what was planned (the verified targets), what was dropped and why, and which cards the review passed. The title is left empty: the run names
   the draft (the request's title, else the material's own name). */

const NOTICE = 'Model review is not proof of factual correctness. Inspect sources before publishing.';

/** An omitted card as the draft lists it (lib/generation.js omission). */
export const omissionOf = (card, reasons) => ({ kind: card.kind, topic: card.topic, objective: card.objective, prompt: card.prompt, reasons });

/**
 * `cards`: the kept cards (provisional ids); `targets`: every verified target of the portion; `omitted`: [{ kind, topic, objective, prompt, reasons }];
 * `checks`: [{ cardId, explanation }] for the kept cards, by provisional id; `autofixed`: how many fields the program filled.
 */
export function portionDeck({ cards, targets, omitted = [], checks = [], autofixed = 0 }) {
  const ids = new Map(cards.map(card => [card.id, randomUUID()]));
  const out = cards.map(card => ({ ...card, id: ids.get(card.id) }));
  const reasons = [...new Set(omitted.flatMap(item => item.reasons))];
  return {
    id: randomUUID(), title: '', cards: out,
    editorial: {
      reviewedAt: new Date().toISOString(),
      summary: `Independently approved ${out.length} questions in one review round; ${omitted.length} candidates omitted.`,
      repaired: false, reviewRounds: 1, ...(autofixed ? { autofixed } : {}),
      evidenceWorkflow: { version: 1, targets, answers: [], omitted: [] },
      ...(omitted.length ? { dropped: omitted.length, omitted, omittedIssues: reasons.slice(0, 8) } : {}),
      candidateReviewSummary: '',
      audit: { version: 3, targets, changes: [], checks: checks.filter(check => ids.has(check.cardId)).map(check => ({ ...check, cardId: ids.get(check.cardId) })) },
      reviewedCards: Object.fromEntries(out.map(card => [card.id, reviewedCardFingerprint(card)])),
      notice: NOTICE,
    },
  };
}
