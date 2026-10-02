import { checkScope } from './prereq.js';
import { decksInCourse } from './focus.js';

/** Explicit references (including [] = all) win over a course default. */
export function learningScope(state, args = {}) {
  const explicit = args.scope !== undefined;
  const course = explicit ? undefined : args.course;
  const all = explicit ? args.scope?.length === 0 : course === undefined || course === null || course === '*';
  const scope = explicit ? checkScope(state, args.scope) : all ? []
    : decksInCourse(state, course).map(deck => ({ deckId: deck.id }));
  const matches = (deckId, card) => all || scope.some(ref => ref.deckId === deckId &&
    (ref.cardId ? ref.cardId === card.id : !ref.topic || ref.topic === (card.topic || '未分类')));
  return { scope, all, course, matches };
}

/** Project once, so counts, lists and topic/card actions share the same cards. */
export function learningState(state, args = {}) {
  const selection = learningScope(state, args);
  if (selection.all) return state;
  const decks = state.decks.filter(deck => selection.scope.some(ref => ref.deckId === deck.id))
    .map(deck => ({ ...deck, cards: deck.cards.filter(card => selection.matches(deck.id, card)) }));
  const allowed = new Map(decks.map(deck => [deck.id, new Set(deck.cards.map(card => card.id))]));
  return { ...state, decks, attempts: state.attempts.filter(attempt => allowed.get(attempt.deckId)?.has(attempt.quiz_id)) };
}
