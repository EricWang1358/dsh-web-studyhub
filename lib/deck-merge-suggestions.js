import { courseOf } from "./focus.js";

// Suggestions are advisory. The deck aggregate still owns the merge and its
// reference relocation; model output never mutates the library directly.
export function mergeSuggestionContext(state, course) {
  const decks = state.decks.filter((deck) => !deck.archived && !deck.systemKind && courseOf(deck) === course);
  return decks.map((deck) => ({
    id: deck.id, title: deck.title, count: deck.cards.length,
    topics: [...new Set(deck.cards.map((card) => card.topic).filter(Boolean))].slice(0, 20),
  }));
}

export function checkedMergeSuggestions(raw, decks) {
  const proposals = Array.isArray(raw?.proposals) ? raw.proposals : [];
  const known = new Map(decks.map((deck) => [deck.id, deck]));
  const used = new Set();
  const result = [];
  for (const proposal of proposals) {
    const targetId = proposal?.targetId;
    const sourceIds = Array.isArray(proposal?.sourceIds)
      ? [...new Set(proposal.sourceIds.filter((id) => typeof id === "string"))] : [];
    const ids = [targetId, ...sourceIds];
    if (!known.has(targetId) || !sourceIds.length || ids.some((id) => !known.has(id) || used.has(id)) ||
        new Set(ids).size !== ids.length) continue;
    const reason = typeof proposal.reason === "string" ? proposal.reason.trim().slice(0, 300) : "";
    if (!reason) continue;
    result.push({ targetId, sourceIds, reason,
      targetTitle: known.get(targetId).title,
      sourceTitles: sourceIds.map((id) => known.get(id).title),
      count: ids.reduce((sum, id) => sum + known.get(id).count, 0),
    });
    ids.forEach((id) => used.add(id));
    if (result.length === 8) break;
  }
  return result;
}
