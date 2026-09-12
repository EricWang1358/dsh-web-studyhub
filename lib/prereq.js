import { cardLevel } from "./mastery.js";

const same = (a, b) => a.deckId === b.deckId && a.cardId === b.cardId;

export function findCard(state, ref) {
  const deck = state.decks.find((d) => d.id === ref?.deckId);
  const card = deck?.cards.find((c) => c.id === ref?.cardId);
  if (!card) throw new Error("Question not found");
  return { deck, card };
}

/** Whether `from` already depends (directly or transitively) on `to`. */
function reaches(state, from, to, seen = new Set()) {
  if (same(from, to)) return true;
  const key = from.deckId + "\0" + from.cardId;
  if (seen.has(key)) return false;
  seen.add(key);
  const card = state.decks
    .find((d) => d.id === from.deckId)
    ?.cards.find((c) => c.id === from.cardId);
  return (card?.requires || []).some((r) => reaches(state, r, to, seen));
}

/**
 * Record that `dependent` requires `prerequisite`. Links are data on the
 * dependent card, can be added or removed at any time, and never touch
 * scheduling. A link that would create a cycle is refused.
 */
export function linkPrerequisite(state, dependent, prerequisite, remove = false) {
  const { card } = findCard(state, dependent);
  findCard(state, prerequisite);
  const ref = { deckId: prerequisite.deckId, cardId: prerequisite.cardId };
  const current = card.requires || [];
  if (remove) {
    card.requires = current.filter((r) => !same(r, ref));
    return { linked: false };
  }
  if (same(dependent, ref)) throw new Error("A question cannot require itself");
  if (current.some((r) => same(r, ref))) return { linked: true, existing: true };
  if (reaches(state, ref, dependent))
    throw new Error("That link would make the two questions depend on each other");
  if (current.length >= 12) throw new Error("A question can have at most 12 prerequisites");
  card.requires = [...current, ref];
  return { linked: true };
}

/** Prerequisites of a card with their current mastery level; dangling links are skipped. */
export function prerequisiteView(state, deckId, card, outcome) {
  return (card.requires || []).flatMap((r) => {
    const deck = state.decks.find((d) => d.id === r.deckId),
      pre = deck?.cards.find((c) => c.id === r.cardId);
    if (!pre) return [];
    return [
      {
        deckId: deck.id,
        cardId: pre.id,
        deckTitle: deck.title,
        topic: pre.topic,
        prompt: pre.prompt,
        kind: pre.kind,
        level: cardLevel(pre, outcome(deck.id, pre.id)),
      },
    ];
  });
}
