/* The questions behind a 复习全书 (M6, docs/plans/review-book.md): the answer cards of the book's questions and the course's question-type catalogue,
   for the 查找页 (lib/course-book-lookup.js) and the export (lib/course-book-export.js). Read from the state, never stored in the book.

   bookCardsOf(state, { course, leaves, files, questionsOf }) -> { answerCards, caseTypes, cardOf }
     answerCards: [{ deckId, cardId, prompt, hid, questionType: { id, label }, concepts: [{ name }], pitfalls, cost }] once per question, in reading
       order: the questions of each point (the outline places them, as the page lists them), then the ones the files link (a card put into 未归位, a link
       the learner wrote), with the heading id of the point that holds them ('unplaced' for 未归位).
     caseTypes: lib/case-types.js caseTypesFor of the course, a course's own type marked `own: true`.
     cardOf(deckId, cardId): the card when it is live (its deck not archived, the card there and not suspended), else null: what a link may resolve to. */
import { caseTypesFor } from './case-types.js';
import { courseProfileFromState } from './case-study.js';
import { parseBookLink } from './course-book-links.js';

const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, max) => { const value = squash(text); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const CARD_LINK = /\]\((studyhub:\/\/card\/[^)\s]+)\)/g;

/** See the top of this file. `leaves`: the manifest's leaves in reading order ({ id, hid }); `files`: the book's files by name. */
export function bookCardsOf(state, { course, leaves = [], files = {}, questionsOf = () => [], fileNames }) {
  const live = new Map();
  for (const deck of state.decks || []) if (!deck.archived) for (const card of deck.cards || []) if (card && !card.suspended) live.set(`${deck.id}|${card.id}`, card);
  const cardOf = (deckId, cardId) => live.get(`${deckId}|${cardId}`) ?? null;
  const answerCards = [], seen = new Set();
  const take = (deckId, cardId, hid) => {
    const key = `${deckId}|${cardId}`, card = live.get(key), answerCard = card?.answerCard;
    if (seen.has(key) || !answerCard || typeof answerCard !== 'object') return;
    seen.add(key);
    answerCards.push({ deckId, cardId, prompt: clip(String(card.prompt ?? '').replace(/\{\{[^{}]+\}\}/g, '＿＿'), 160), hid,
      questionType: { id: answerCard.questionType?.id || 'general', label: answerCard.questionType?.label || '' },
      concepts: (Array.isArray(answerCard.concepts) ? answerCard.concepts : []).map(item => ({ name: clip(item?.name, 80) })).filter(item => item.name),
      pitfalls: (Array.isArray(answerCard.pitfalls) ? answerCard.pitfalls : []).map(item => clip(item, 300)).filter(Boolean), cost: clip(answerCard.justification?.cost, 300) });
  };
  for (const leaf of leaves) for (const entry of questionsOf(leaf)) take(entry.deckId, entry.cardId, leaf.hid);
  for (const { hid, name } of fileNames(leaves)) for (const match of String(files[name]?.text ?? '').matchAll(CARD_LINK)) {
    const link = parseBookLink(match[1]);
    if (link) take(link.deckId, link.cardId, hid);
  }
  const profile = courseProfileFromState(state, course ?? ''), ownIds = new Set((profile.caseTypes || []).map(type => type.id));
  const caseTypes = caseTypesFor(profile.caseTypes).map(type => ({ ...type, ...(ownIds.has(type.id) ? { own: true } : {}) }));
  return { answerCards, caseTypes, cardOf };
}
