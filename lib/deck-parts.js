/* The parts of a deck (第一部分 · 第二部分 · …). A published deck is never topped up in place: 为没覆盖的部分补题 of its material makes a NEW draft (lib/coverage-state.js documentTopUp),
   and when the learner publishes that draft into the deck its questions become the deck's next part. Practice, mastery and coverage read the deck's cards as they always did (the
   deck TOTAL); the marker only says where a question came from, so the deck page can say 「第一部分 12 题 · 第二部分 9 题」 and show one part at a time.

   Where the marker lives: on each merged CARD, `part: N` (N >= 2). A card without one is part 1: the deck's own questions, and every deck from before parts (no migration).
   A card is moved whole by deck.merge / deck.split / deck.edit, so the marker travels with it; a deck record of card ids would have to be kept in step with every one of them.
   The draft that will become a part says so in `editorial.part = { deckId, n }` (the deck it was made for and the part it would be then); the number is read again from the deck at
   publication (another part may have been published meanwhile). Pure, no Node modules: the browser reads it too. */

/** The part of a card: its marker, else 1. */
export const partOf = (card) => (Number.isInteger(card?.part) && card.part >= 2 ? card.part : 1);

/** The number the next part of a deck gets: one more than the highest part it holds (2 for a deck without parts). */
export const nextPartOf = (deck) => (deck?.cards || []).reduce((top, card) => Math.max(top, partOf(card)), 1) + 1;

/** How many questions each part of a deck holds, in order: [{ n, count }] (parts with no question left are skipped). One row for a deck without parts. */
export function partsOf(deck) {
  const counts = new Map();
  for (const card of deck?.cards || []) { const n = partOf(card); counts.set(n, (counts.get(n) || 0) + 1); }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([n, count]) => ({ n, count }));
}

/** What the snapshot keeps of a deck's parts: the counts of its parts in order ([12, 9]), only when it has more than one (a deck of one part says nothing). `nextPart` = the highest + 1. */
export function partsSummary(deck) {
  const parts = partsOf(deck);
  return parts.length > 1 ? { parts: parts.map((item) => item.count), partNumbers: parts.map((item) => item.n) } : {};
}

/** The part a summary of the snapshot (partsSummary) says comes next: 2 for a deck of one part. */
export const nextPartOfSummary = (summary) => (Array.isArray(summary?.partNumbers) && summary.partNumbers.length ? Math.max(...summary.partNumbers) + 1 : 2);

/** The record a draft that will be a part keeps: the deck it was made for and the part it would be. null for any other draft. */
export const draftPart = (draft) => {
  const part = draft?.editorial?.part;
  return part && typeof part.deckId === 'string' && part.deckId ? { deckId: part.deckId, n: Number.isInteger(part.n) && part.n >= 2 ? part.n : 2 } : null;
};

/** Whether a draft is a part of a deck in the making (a top-up of a published deck's material): its coverage is its document's (lib/coverage-state.js coverageForDraft). */
export const isPartDraft = (draft) => !!draftPart(draft);

/** The cards of a draft marked as part `n` of the deck they are merged into. */
export const stampPart = (cards, n) => cards.map((card) => ({ ...card, part: n }));
