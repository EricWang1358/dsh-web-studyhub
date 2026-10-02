import { checkScope } from './prereq.js';
import { decksInCourse } from './focus.js';
import { inactiveDeckIds } from './course-active.js';

/**
 * Explicit references (including [] = all) win over a course default.
 * "All" means every ACTIVE course (lib/course-active.js): `excluded` holds the parked decks left out, and
 * `includeInactive` is the learner's "show parked courses" for one page view. An explicit deck/topic/card list, and a
 * course picked by name, are deliberate choices and read what they name.
 */
export function learningScope(state, args = {}) {
  const explicit = args.scope !== undefined;
  const course = explicit ? undefined : args.course;
  const all = explicit ? args.scope?.length === 0 : course === undefined || course === null || course === '*';
  const includeInactive = args.includeInactive === true;
  const scope = explicit ? checkScope(state, args.scope) : all ? []
    : decksInCourse(state, course, { includeInactive }).map(deck => ({ deckId: deck.id }));
  const excluded = all && !includeInactive ? inactiveDeckIds(state) : new Set();
  const matches = (deckId, card) => all ? !excluded.has(deckId) : scope.some(ref => ref.deckId === deckId &&
    (ref.cardId ? ref.cardId === card.id : !ref.topic || ref.topic === (card.topic || '未分类')));
  return { scope, all, course, matches, excluded };
}

/** Project once, so counts, lists and topic/card actions share the same cards. */
export function learningState(state, args = {}) {
  const selection = learningScope(state, args);
  // Parked decks leave the card views; the attempts stay, so what the learner already did still shows in the history.
  if (selection.all) return selection.excluded.size ? { ...state, decks: state.decks.filter(deck => !selection.excluded.has(deck.id)) } : state;
  const decks = state.decks.filter(deck => selection.scope.some(ref => ref.deckId === deck.id))
    .map(deck => ({ ...deck, cards: deck.cards.filter(card => selection.matches(deck.id, card)) }));
  const allowed = new Map(decks.map(deck => [deck.id, new Set(deck.cards.map(card => card.id))]));
  return { ...state, decks, attempts: state.attempts.filter(attempt => allowed.get(attempt.deckId)?.has(attempt.quiz_id)) };
}
