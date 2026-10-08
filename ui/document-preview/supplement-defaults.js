import { normalizeGenerationSettings } from '../../lib/generation-settings.js';
import { browserStorage, readJSON, writeJSON } from '../storage.js';

/* What the reader's top-up form ("补充到现有题组") starts with, so a passage to questions takes a select and one press: the deck, the kind and the
   number. Plain data and predicates (no React), so a DOM-free test can read it.
   The deck is a guess and says why: the deck the material is used by when it is the only one, else the deck last topped up. A wrong guess is one
   choice to fix, and nothing runs until 生成 is pressed. The kind and the number are not guessed at all: they are the ones of 设置 › 出题偏好. */

export const LAST_DECK_KEY = 'study-reader-supplement-deck';
/** A top-up writes between 1 and this many questions (lib/contexts/generation/selection.js). */
export const SUPPLEMENT_MAX = 20;

const offered = (decks, id) => (decks || []).some(deck => deck.id === id && !deck.archived && !deck.systemKind);

/**
 * The deck to start with: `{ deckId, reason }`, reason 'material' (the only deck that uses this material), 'last' (the deck last topped up) or '' (no guess).
 * `usedBy` is the material's `usedBy` ([{ kind: 'deck' | 'draft', id, archived? }]), `decks` the decks that can be chosen, `last` the remembered deck id.
 */
export function suggestDeck({ usedBy = [], decks = [], last = '' } = {}) {
  const candidates = [...new Set((usedBy || []).filter(ref => ref?.kind === 'deck' && !ref.archived && offered(decks, ref.id)).map(ref => ref.id))];
  if (candidates.length === 1) return { deckId: candidates[0], reason: 'material' };
  if (last && offered(decks, last)) return { deckId: last, reason: 'last' };
  return { deckId: '', reason: '' };
}

export function recallDeck(storage = browserStorage()) {
  const value = readJSON(LAST_DECK_KEY, '', storage);
  return typeof value === 'string' ? value : '';
}
export function rememberDeck(deckId, storage = browserStorage()) {
  if (typeof deckId === 'string' && deckId) writeJSON(LAST_DECK_KEY, deckId, storage);
}

/** The kind and the number a top-up starts with, from the saved generation settings (any shape the library may hold): the first ticked kind, and at most what a top-up accepts. */
export function supplementDefaults(generation) {
  const settings = normalizeGenerationSettings(generation);
  return { kind: settings.kinds[0], count: Math.min(SUPPLEMENT_MAX, settings.count) };
}
