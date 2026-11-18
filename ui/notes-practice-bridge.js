// @ts-check
/* Pure helpers for opt-in active-practice bridge inside Study Notes (ui/BlogNotes.jsx):
   deduplicates playable linked question refs, skips missing cards and archived decks,
   and supports filtering the note index to notes that carry linked questions. */

export const MAX_NOTE_PRACTICE_SCOPE = 200;

/** Linked card count carried by a note summary item in `data.notes`. */
export function noteLinkedCount(item) {
  if (!item || typeof item !== 'object') return 0;
  if (item.kind?.startsWith('daily-recap')) {
    return Number(item.daily?.answeredCount ?? item.cardCount ?? item.cards?.length ?? 0) || 0;
  }
  return Number(item.cardCount ?? item.cards?.length ?? 0) || 0;
}

/** Count notes in a list that carry at least one linked question. */
export function countNotesWithCards(notes = []) {
  return (Array.isArray(notes) ? notes : []).filter((item) => noteLinkedCount(item) > 0).length;
}

/** Filter notes to card-linked items when requested. */
export function filterNotesWithCards(notes = [], onlyWithCards = false) {
  const list = Array.isArray(notes) ? notes : [];
  return onlyWithCards ? list.filter((item) => noteLinkedCount(item) > 0) : list;
}

/**
 * Build a deduplicated, playable practice scope from `note.cards`.
 * Excludes removed questions (`ref.missing`) and questions inside archived decks.
 */
export function buildNotePracticeScope(note, decks = []) {
  const raw = Array.isArray(note?.cards) ? note.cards : [];
  if (!raw.length) return { scope: [], totalLinked: 0, skippedCount: 0 };
  const deckById = new Map(
    (Array.isArray(decks) ? decks : [])
      .filter((deck) => deck?.id)
      .map((deck) => [deck.id, deck]),
  );
  const scope = [], seen = new Set();
  for (const ref of raw) {
    if (!ref || ref.missing || !ref.deckId || !ref.cardId) continue;
    const deck = deckById.get(ref.deckId);
    if (deck?.archived) continue;
    const key = `${ref.deckId}\0${ref.cardId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scope.push({ deckId: ref.deckId, cardId: ref.cardId });
    if (scope.length >= MAX_NOTE_PRACTICE_SCOPE) break;
  }
  return {
    scope,
    totalLinked: raw.length,
    skippedCount: Math.max(0, raw.length - scope.length),
  };
}
