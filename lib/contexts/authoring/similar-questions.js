import { get } from "../../util.js";
import { courseOf, decksInCourse } from "../../focus.js";
import { NEAR_DUPLICATE_SIMILARITY, similarStemPairs } from "../../stem-similarity.js";
import { embeddedImagesAsAlt } from "../../study-image-markdown.js";

/* Which questions of a draft are near-duplicates of another question (#890): the same kind of question, in the draft itself or in the published
   decks of the draft's course (the course and the chapters inside it; archived and system decks do not count). A hint for the learner, read only:
   nothing is removed, merged or blocked here. */

/** How much of the other question's stem an answer carries: enough to recognise it, and an answer stays small however long the stems are. */
export const STEM_PREVIEW_CHARS = 300;

const CLOZE_MARKER = /\{\{[^{}]+\}\}/g;

/** What a learner reads as the question, as plain text: a cloze shows its text with blanks, every other kind its prompt; an embedded image is its alt
    text, never its bytes (two questions that share only a picture are not alike). */
export function stemOf(card) {
  const cloze = card?.kind === "cloze" && typeof card.cloze?.text === "string" && card.cloze.text ? card.cloze.text.replace(CLOZE_MARKER, "＿＿") : null;
  return embeddedImagesAsAlt(cloze ?? String(card?.prompt ?? ""));
}

const preview = (text) => (text.length > STEM_PREVIEW_CHARS ? `${text.slice(0, STEM_PREVIEW_CHARS - 1)}…` : text);

/**
 * -> { status: 'ok', draftId, draftVersion, threshold, similar: [{ cardId, n, similarity, other: { where: 'draft' | 'deck', deckId, deckTitle, cardId, n, prompt } }] }
 * One entry per flagged question of the draft, in the draft's order, naming the most similar other question (n counts from 1 in its draft or deck; its
 * prompt is at most STEM_PREVIEW_CHARS long). A published copy of a draft's own question (an editing draft of that deck) is the same question, not a
 * similar one. `stats`, when given, gets the search's { candidates, compared } (lib/stem-similarity.js).
 */
export function similarQuestions(state, draftId, { threshold = NEAR_DUPLICATE_SIMILARITY, stats } = {}) {
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
    for (const [i, j, similarity] of similarStemPairs(members.map((index) => stemOf(entries[index].card)), { probes, threshold, stats })) {
      const [mine, other] = [entries[members[i]], entries[members[j]]];
      const kept = best.get(mine);
      // The most similar one; between equals, the first in the draft, then in the course's decks.
      if (!kept || similarity > kept.similarity || (similarity === kept.similarity && members[j] < kept.index)) best.set(mine, { similarity, other, index: members[j] });
    }
  }
  const similar = entries.filter((entry) => best.has(entry)).map((entry) => {
    const { similarity, other } = best.get(entry);
    return { cardId: entry.card.id, n: entry.n, similarity: Math.round(similarity * 100) / 100,
      other: { where: other.deck ? "deck" : "draft", deckId: other.deck?.id ?? null, deckTitle: other.deck?.title ?? null, cardId: other.card.id, n: other.n, prompt: preview(stemOf(other.card)) } };
  });
  return { status: "ok", draftId: draft.id, draftVersion: draft.draftVersion ?? null, threshold, similar };
}

/* The last answers, for the draft page that asks again whenever the library moves (a running job commits often) while the draft and the decks did not.
   The store hands out the same frozen objects for what no commit touched (tests/store-sharing.test.mjs), so an answer is reused only while the draft
   record and the drafts, decks, sources and courses collections it was computed from are the very same objects: the same draft version and the same
   published decks. A few drafts at most; with private copies (STUDY_STORE_PRIVATE=1) nothing is ever the same object and every call computes. */
const answers = new Map(), ANSWERS_KEPT = 8;
const FIELDS = ["drafts", "decks", "sources", "courses"];

/** similarQuestions at the default threshold, answered from the last computation when nothing it reads has changed (a copy: the caller may change it).
    `stats` is filled only when it computes. */
export function similarQuestionsOf(state, draftId, { stats } = {}) {
  const draft = get(state.drafts, draftId, "Draft"), kept = answers.get(draftId);
  if (kept && kept.draft === draft && FIELDS.every((field) => kept[field] === state[field])) return structuredClone(kept.answer);
  const answer = similarQuestions(state, draftId, { stats });
  answers.delete(draftId);
  answers.set(draftId, { draft, answer, ...Object.fromEntries(FIELDS.map((field) => [field, state[field]])) });
  if (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value);
  return structuredClone(answer);
}
