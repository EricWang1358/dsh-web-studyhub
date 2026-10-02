/* 资料掌握度 (material mastery), the part both the backend and the browser bundle use: the summary of some linked cards.
   Pure, no I/O, no Node modules (lib/material-mastery.js builds the per-document index on top of it and is backend only).

   Nothing new is measured. A page's mastery is DERIVED from the review state of the cards that cite it: each card has the
   level the dashboard gives it (lib/mastery.js cardLevel: new / weak / learning / familiar / mastered, from the SM-2
   interval and the last grade), and the percentage is the dashboard's own weighting of those levels. So it rises when a
   linked card is answered well and its review interval grows, and it can never disagree with the deck mastery shown on the
   dashboard for the same cards. Reading time, clicks and page views never count.

   "No questions" is its own state (percent null), not 0%: an unlearned page (its questions all new) is 0%. The states:
     none       the pages have no question yet                     (还没出题)
     unlearned  every linked question is still new                 (未学)
     learning   some were answered, the whole is below 60%         (学习中)
     familiar   at least 60%, or 80% with a weak question left     (熟悉)
     mastered   at least 80% and no weak question (the dashboard's "done")  (已掌握)
   Suspended cards and archived decks are left out (like the dashboard); a card of a parked course (lib/course-active.js)
   counts too and is flagged `inactive`, so a view can say so. */
import { LEVELS, LEVEL_WEIGHT, DONE_MASTERY } from './mastery.js';

export const MATERIAL_STATES = Object.freeze(['none', 'unlearned', 'learning', 'familiar', 'mastered']);
export const FAMILIAR_AT = 60;

/**
 * The summary of linked cards: items `{ level, due?, inactive? }` (one per card). `percent` is null when there are none.
 * @returns {{ total, counts: {new,weak,learning,familiar,mastered}, due, weak, fresh, inactive, percent, state }}
 */
export function summarizeLinked(items = []) {
  const counts = Object.fromEntries(LEVELS.map(level => [level, 0]));
  let weight = 0, due = 0, inactive = 0;
  for (const item of items) {
    const level = LEVELS.includes(item.level) ? item.level : 'new';
    counts[level]++; weight += LEVEL_WEIGHT[level];
    if (level !== 'new' && item.due) due++;
    if (item.inactive) inactive++;
  }
  const total = items.length;
  if (!total) return { total: 0, counts, due: 0, weak: 0, fresh: 0, inactive: 0, percent: null, state: 'none' };
  const percent = Math.round(weight / total * 100);
  const state = counts.new === total ? 'unlearned'
    : percent >= DONE_MASTERY && !counts.weak ? 'mastered' : percent >= FAMILIAR_AT ? 'familiar' : 'learning';
  return { total, counts, due, weak: counts.weak, fresh: counts.new, inactive, percent, state };
}

/** "5 道题 · 2 道到期 · 1 道薄弱 · 1 道新题": only what is there; `words` supplies the language ({ questions, due, weak, fresh }: n => text). */
export function dueNewWeakLine(summary, words) {
  if (!summary?.total) return '';
  return [words.questions(summary.total), summary.due > 0 && words.due(summary.due), summary.weak > 0 && words.weak(summary.weak),
    summary.fresh > 0 && words.fresh(summary.fresh)].filter(Boolean).join(' · ');
}
