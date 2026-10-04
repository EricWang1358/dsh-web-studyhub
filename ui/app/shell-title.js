import { ui } from '../i18n.js';
import { pageTitleOf } from '../pages.js';

/** The heading of the top bar and of the practice page: a run or its deck titles the practice page, every other page has its registry title. */
export function shellTitleOf(page, { run, decks } = {}) {
  if (page === 'review') return run?.title || decks?.find((deck) => deck.id === run?.deckId)?.title || ui('复习');
  const title = pageTitleOf(page);
  return title ? ui(title) : undefined;
}
