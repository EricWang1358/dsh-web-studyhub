/* The mastery of a practice round's own questions, before the first answer and now (「这组题掌握度 41% → 58%」 on the result page).

   Every round that starts (review.start in all its modes, a learning-flow practice step, a daily-plan task) stores
   `run.mastery = { v: 1, before }`: the summary of its cards at the start, from the same function the dashboard uses
   (lib/material-summary.js through `scopeSummary`). `after` is never stored: the projection recomputes it from the live
   cards, so it is always what the library would say now.

   Which cards: a round started from the reader (`run.reading`) is measured on the cards of the pages it was started on
   (its `scope`), as it always was; every other round on its own questions (each once, tail retries are the same question).

   Older runs: a reader round from before 3.6 kept its `before` inside `run.reading`; it is read from there. A run with
   neither has no mastery change, and its result page shows no line.
   Pure, no I/O. */
import { cardLevel, latestOutcomes, isDue } from './mastery.js';
import { summarizeLinked } from './material-mastery.js';

/** The small summary kept with a run: the numbers a result page needs. */
export const compactSummary = summary => ({ percent: summary.percent, total: summary.total, state: summary.state, due: summary.due, weak: summary.weak, fresh: summary.fresh });

/** The mastery of the cards `refs` ({ deckId, cardId }), from the live library. Archived decks and suspended cards are not counted. */
export function scopeSummary(state, refs, now = Date.now()) {
  const outcome = latestOutcomes(state.attempts || []), decks = new Map((state.decks || []).map(deck => [deck.id, deck]));
  const items = [], seen = new Set();
  for (const ref of Array.isArray(refs) ? refs : []) {
    const deck = decks.get(ref?.deckId), card = deck && !deck.archived ? deck.cards.find(item => item.id === ref.cardId) : null;
    const key = `${ref?.deckId}|${ref?.cardId}`;
    if (!card || card.suspended || seen.has(key)) continue;
    seen.add(key);
    const level = cardLevel(card, outcome(deck.id, card.id));
    items.push({ level, due: level !== 'new' && isDue(card, now) });
  }
  return compactSummary(summarizeLinked(items));
}

/** The cards a round's mastery is measured on: the reader's pages for a reader round, else the round's own questions. */
export function masteryCards(run) {
  if (run.reading) return run.scope;
  return (run.entries || []).filter(entry => !entry.retry).map(entry => ({ deckId: entry.deckId ?? run.deckId, cardId: entry.card?.id }));
}

/** What a starting round stores, before its first answer: `{ v: 1, before }`. */
export const masteryAtStart = (state, run, now = Date.now()) => ({ v: 1, before: scopeSummary(state, masteryCards(run), now) });

/** The stored mastery before the first answer (a pre-3.6 reader round kept it in `run.reading`), or null. */
export const masteryBefore = run => run.mastery?.before ?? run.reading?.before ?? null;

/** What a round shows: `{ before, after }` on the same cards, or null for a run that stored no `before`. */
export function masteryView(state, run, now = Date.now()) {
  const before = masteryBefore(run);
  return before ? { before, after: scopeSummary(state, masteryCards(run), now) } : null;
}
