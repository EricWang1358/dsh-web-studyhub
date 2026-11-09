import { get } from "../../util.js";
import { courseOf, decksInCourse } from "../../focus.js";
import { NEAR_DUPLICATE_SIMILARITY, similarStemPairs } from "../../stem-similarity.js";

/* Which questions of a draft are near-duplicates of another question (#890): the same kind of question, in the draft itself or in the published
   decks of the draft's course (the course and the chapters inside it; archived and system decks do not count). A hint for the learner, read only:
   nothing is removed, merged or blocked here. */

/** What a learner reads as the question: a cloze shows its text with blanks, every other kind its prompt. */
const stemOf = (card) => (card?.kind === "cloze" && typeof card.cloze?.text === "string" && card.cloze.text ? card.cloze.text : String(card?.prompt ?? ""));

/**
 * -> { status: 'ok', draftId, draftVersion, threshold, similar: [{ cardId, n, similarity, other: { where: 'draft' | 'deck', deckId, deckTitle, cardId, n, prompt } }] }
 * One entry per flagged question of the draft, in the draft's order, naming the most similar other question (n counts from 1 in its draft or deck).
 * A published copy of a draft's own question (an editing draft of that deck) is the same question, not a similar one.
 */
export function similarQuestions(state, draftId, { threshold = NEAR_DUPLICATE_SIMILARITY } = {}) {
  const draft = get(state.drafts, draftId, "Draft");
  const own = new Set(draft.cards.map((card) => card.id));
  const entries = draft.cards.map((card, index) => ({ card, n: index + 1, deck: null }));
  for (const deck of decksInCourse(state, courseOf(draft, state))) {
    deck.cards.forEach((card, index) => { if (!own.has(card.id)) entries.push({ card, n: index + 1, deck }); });
  }
  const byKind = new Map();
  entries.forEach((entry, index) => {
    if (!byKind.has(entry.card.kind)) byKind.set(entry.card.kind, []);
    byKind.get(entry.card.kind).push(index);
  });
  const best = new Map();
  for (const members of byKind.values()) {
    const probes = members.map((_, local) => local).filter((local) => !entries[members[local]].deck);
    if (!probes.length) continue;
    for (const [i, j, similarity] of similarStemPairs(members.map((index) => stemOf(entries[index].card)), { probes, threshold })) {
      const [mine, other] = [entries[members[i]], entries[members[j]]];
      const kept = best.get(mine);
      // The most similar one; between equals, the first in the draft, then in the course's decks.
      if (!kept || similarity > kept.similarity || (similarity === kept.similarity && members[j] < kept.index)) best.set(mine, { similarity, other, index: members[j] });
    }
  }
  const similar = entries.filter((entry) => best.has(entry)).map((entry) => {
    const { similarity, other } = best.get(entry);
    return { cardId: entry.card.id, n: entry.n, similarity: Math.round(similarity * 100) / 100,
      other: { where: other.deck ? "deck" : "draft", deckId: other.deck?.id ?? null, deckTitle: other.deck?.title ?? null, cardId: other.card.id, n: other.n, prompt: stemOf(other.card) } };
  });
  return { status: "ok", draftId: draft.id, draftVersion: draft.draftVersion ?? null, threshold, similar };
}
