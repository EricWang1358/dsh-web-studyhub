// @ts-check
import { resolveCompanionTarget } from './companion-ref.js';

const LEVEL_PRIORITY = Object.freeze({ weak: 0, new: 1, learning: 2, familiar: 3, mastered: 4 });

/**
 * Pure 0-token selector for Interactive Companion's opt-in slide/lesson self-check (`settings.practice.companionSlideCheck`).
 * Ranks weak/new/learning cards ahead of already-mastered cards for the active slide or lesson.
 *
 * @param {Array<Record<string, any>>} relatedCards
 * @param {{ companionId?: string, slide?: number }} [opts]
 * @returns {{ slideCards: Array<Record<string, any>>, lessonCards: Array<Record<string, any>> }}
 */
export function selectCompanionPracticeCards(relatedCards = [], { companionId = '', slide = 0 } = {}) {
  if (!Array.isArray(relatedCards) || !relatedCards.length) return { slideCards: [], lessonCards: [] };
  const byPriority = (a, b) => {
    const pa = LEVEL_PRIORITY[a?.level] ?? 1;
    const pb = LEVEL_PRIORITY[b?.level] ?? 1;
    if (pa !== pb) return pa - pb;
    const sa = Number(a?.slide ?? a?.companionRef?.slide) || 999999;
    const sb = Number(b?.slide ?? b?.companionRef?.slide) || 999999;
    return sa - sb;
  };
  const lessonCards = relatedCards
    .filter((card) => Boolean(card?.linkedToCompanion || (companionId && card?.companionRef?.companionId === companionId)))
    .slice()
    .sort(byPriority);
  const wantedSlide = Math.floor(Number(slide) || 0);
  const slideCards = wantedSlide >= 1
    ? lessonCards.filter((card) => Number(card?.slide ?? card?.companionRef?.slide) === wantedSlide)
    : [];
  return { slideCards, lessonCards };
}

/**
 * Scans loaded decks (`data.decks`) to index linked practice card refs (`{ deckId, cardId }`) per companion lesson.
 *
 * @param {Array<Record<string, any>>} [decks]
 * @param {Array<Record<string, any>>} [sources]
 * @param {Array<Record<string, any>>} [courses]
 * @returns {Map<string, Array<{ deckId: string, cardId: string }>>}
 */
export function companionDeckRefsMap(decks = [], sources = [], courses = []) {
  /** @type {Map<string, Array<{ deckId: string, cardId: string }>>} */
  const map = new Map();
  if (!Array.isArray(decks) || !decks.length) return map;
  for (const deck of decks) {
    if (!deck || deck.archived || deck.systemKind || !Array.isArray(deck.cards)) continue;
    for (const card of deck.cards) {
      if (!card?.id || card.suspended) continue;
      const target = resolveCompanionTarget({ card, courses, sources, fallbackCourse: deck.course || '' });
      if (!target?.companionId) continue;
      let list = map.get(target.companionId);
      if (!list) {
        list = [];
        map.set(target.companionId, list);
      }
      list.push({ deckId: deck.id, cardId: card.id });
    }
  }
  return map;
}
