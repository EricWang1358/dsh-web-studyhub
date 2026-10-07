import { publishedFingerprint } from '../../../publication-fingerprint.js';
import { PUBLISH_TEXT } from './messages.js';

/** The step key of the one write of a publication. */
export const PUBLISH_STEP = 'publish';
/** A supplement that ran out of time publishes what it has under a step of its own (its plan and its commit are not the first publication's). */
export const PUBLISH_STEPS = Object.freeze([PUBLISH_STEP, 'publish-budget']);

// Two codes, so that what the learner reads (lib/job-contract.js `reasonText`, the retry's refusal) says which of the two it is.
const conflict = code => Object.assign(new Error(PUBLISH_TEXT[code === 'publish-draft-changed' ? 'draftChanged' : 'deckChanged']), { code });

/** Look at the library and say what became of a publication that was cut short. `expect` is what its check found the write would leave (authoring: `draft.publish.plan`):
 *   `notPublished`  the draft is as it was and none of its questions is in the deck: the write never happened, it may be done now
 *   a receipt       every question is in the deck exactly as the write makes it, and the draft is gone (or is the remainder the write leaves): it happened, never twice
 *   an error        anything else (draft edited or deleted, deck changed, only part of it there): nobody can say what happened, so nothing is done and the learner is told
 * The write is one atomic update of the library, so "part of it is there" cannot come from the write itself. */
export function reconcilePublication(expect, state) {
  const { draftId, draftVersion, deckId, written, remaining, receipt } = expect;
  const draft = state.drafts.find(item => item.id === draftId), deck = deckId ? state.decks.find(item => item.id === deckId) : null;
  const ids = Object.keys(written);
  const there = ids.filter(id => { const card = deck?.cards.find(item => item.id === id); return card && publishedFingerprint(card) === written[id]; });
  const untouched = draft?.draftVersion === draftVersion;
  if (untouched && !there.length) return { notPublished: true };
  const left = remaining ? draft?.id === remaining.id && draft.draftVersion === remaining.draftVersion : !draft;
  if (there.length === ids.length && left && !untouched) {
    return { ...receipt, total: deck ? deck.cards.length : receipt.total, remainingDraftId: remaining?.id ?? null, recovered: true };
  }
  // Someone edited or deleted the draft (nothing of the publication is in the deck), or the deck was changed after the write.
  const draftChanged = draft ? !untouched && !left : !there.length;
  throw conflict(draftChanged ? 'publish-draft-changed' : 'publish-deck-changed');
}
