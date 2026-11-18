// @ts-check
/* Zero-token helper for the opt-in written exam postmortem split & per-item source/practice bridge (settings.practice.examPostmortemBridge). */
import { firstCitation } from '../document-preview/practice/citations.js';

const refKey = (deckId, cardId) => `${deckId}:${cardId}`;

/**
 * Pure zero-token helper for the opt-in written exam postmortem option (`settings.practice.examPostmortemBridge`).
 * Computes accuracy among attempted questions separately from overall paper score, splits wrong vs skipped scopes,
 * and resolves each question's first usable material citation (from report items or loaded deck cards, excluding archived/JSON card sources).
 *
 * @param {Record<string, any> | null | undefined} report
 * @param {{ decks?: Array<Record<string, any>>, sources?: Array<Record<string, any>> }} [opts]
 * @returns {{
 *   answeredAccuracyPct: number | null,
 *   wrongScope: Array<{ deckId: string, cardId: string }>,
 *   skippedScope: Array<{ deckId: string, cardId: string }>,
 *   citationsByCard: Map<string, { sourceId: string, quote: string }>
 * }}
 */
export function buildExamPostmortem(report, { decks = [], sources = [] } = {}) {
  const wrong = Array.isArray(report?.wrong) ? report.wrong : [];
  const skipped = Array.isArray(report?.skipped) ? report.skipped : [];
  const answered = Number(report?.answered) || 0;
  const correct = Number(report?.correct) || 0;
  const answeredAccuracyPct = answered > 0 ? Math.round((correct / answered) * 100) : null;

  const toScope = (items) => {
    const seen = new Set();
    const scope = [];
    for (const item of items) {
      if (!item?.deckId || !item?.cardId) continue;
      const key = refKey(item.deckId, item.cardId);
      if (seen.has(key)) continue;
      seen.add(key);
      scope.push({ deckId: item.deckId, cardId: item.cardId });
    }
    return scope;
  };

  const wrongScope = toScope(wrong);
  const skippedScope = toScope(skipped);
  const activeSources = (Array.isArray(sources) ? sources : []).filter((src) => src?.id && !src.deleted && !src.archived);
  /** @type {Map<string, { sourceId: string, quote: string }>} */
  const citationsByCard = new Map();

  if (activeSources.length) {
    /** @type {Map<string, Record<string, any>> | null} */
    let cardsByRef = null;
    const ensureCardLookup = () => {
      if (cardsByRef !== null) return cardsByRef;
      cardsByRef = new Map();
      if (Array.isArray(decks)) {
        for (const deck of decks) {
          if (!deck?.id || !Array.isArray(deck.cards)) continue;
          for (const card of deck.cards) {
            if (card?.id) cardsByRef.set(refKey(deck.id, card.id), card);
          }
        }
      }
      return cardsByRef;
    };

    for (const item of [...wrong, ...skipped]) {
      if (!item?.deckId || !item?.cardId) continue;
      const key = refKey(item.deckId, item.cardId);
      if (citationsByCard.has(key)) continue;
      const direct = firstCitation(item, activeSources);
      const hit = direct || (() => {
        const card = ensureCardLookup().get(key);
        return card ? firstCitation(card, activeSources) : null;
      })();
      if (hit?.source?.id) {
        citationsByCard.set(key, { sourceId: hit.source.id, quote: typeof hit.quote === 'string' ? hit.quote : '' });
      }
    }
  }

  return { answeredAccuracyPct, wrongScope, skippedScope, citationsByCard };
}
