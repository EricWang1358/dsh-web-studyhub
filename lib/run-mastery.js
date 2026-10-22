/* The mastery of a practice round's own questions, before the first answer and now (「这组题掌握度 41% → 58%」 on the result page).

   Every round that starts (review.start in all its modes, a learning-flow practice step, a daily-plan task) stores
   `run.mastery = { v: 1, before, cards }`: the summary of its cards at the start, from the same function the dashboard uses
   (lib/material-summary.js through `scopeSummary`), and the cards it measured. `after` is never stored: the projection
   recomputes it from the live cards, on those same stored cards, so a question skipped mid-round (review.skip) or a
   daily-plan task whose scope changed after the first answer still compares the same cards.

   Which cards: a round started from the reader (`run.reading`) is measured on the cards of the pages it was started on
   (its `scope`), as it always was; that scope is already stored with the run and never changes, so `cards` is not copied
   for it. Every other round is measured on its own questions (each once, tail retries are the same question).

   Older runs: a reader round from before 3.6 kept its `before` inside `run.reading`; it is read from there. A value
   stored without `cards` is measured on `masteryCards(run)`. A run with neither has no mastery change, and its result
   page shows no line.
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

/** What a starting round stores, before its first answer: `{ v: 1, before, cards }` (a reader round's cards are its `scope`, not copied). */
export function masteryAtStart(state, run, now = Date.now()) {
  const cards = masteryCards(run), before = scopeSummary(state, cards, now);
  return run.reading ? { v: 1, before } : { v: 1, before, cards };
}

/** The cards the stored `before` was measured on: the stored ones, else (a reader round, an older value) the round's own. */
export const measuredCards = run => Array.isArray(run.mastery?.cards) ? run.mastery.cards : masteryCards(run);

/** The stored mastery before the first answer (a pre-3.6 reader round kept it in `run.reading`), or null. */
export const masteryBefore = run => run.mastery?.before ?? run.reading?.before ?? null;

/** What a round shows: `{ before, after }` on the same cards, or null for a run that stored no `before`. */
export function masteryView(state, run, now = Date.now()) {
  const before = masteryBefore(run);
  return before ? { before, after: scopeSummary(state, measuredCards(run), now) } : null;
}
