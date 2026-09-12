import { cardLevel } from "./mastery.js";

const same = (a, b) => a.deckId === b.deckId && a.cardId === b.cardId;

/**
 * Resolve a card reference. Card ids are unique across the library, so a
 * missing or wrong deckId still finds the card by its id.
 */
export function findCard(state, ref, label = "Question") {
  const cardId = ref?.cardId;
  const inDeck = state.decks.find((d) => d.id === ref?.deckId)?.cards.find((c) => c.id === cardId);
  if (inDeck) return { deck: state.decks.find((d) => d.id === ref.deckId), card: inDeck };
  for (const deck of state.decks) {
    const card = deck.cards.find((c) => c.id === cardId);
    if (card) return { deck, card };
  }
  throw new Error(`${label} not found (cardId ${cardId || "missing"})`);
}
const refOf = ({ deck, card }) => ({ deckId: deck.id, cardId: card.id });

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
export function linkPrerequisite(state, dependentRef, prerequisite, remove = false) {
  const found = findCard(state, dependentRef),
    { card } = found,
    dependent = refOf(found);
  const ref = refOf(findCard(state, prerequisite, "Prerequisite question"));
  const current = card.requires || [];
  if (remove) {
    card.requires = current.filter((r) => !same(r, ref));
    return { linked: false, dependent, requires: ref };
  }
  if (same(dependent, ref)) throw new Error("A question cannot require itself");
  if (current.some((r) => same(r, ref))) return { linked: true, existing: true, dependent, requires: ref };
  if (reaches(state, ref, dependent))
    throw new Error("That link would make the two questions depend on each other");
  if (current.length >= 12) throw new Error("A question can have at most 12 prerequisites");
  card.requires = [...current, ref];
  return { linked: true, dependent, requires: ref };
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
