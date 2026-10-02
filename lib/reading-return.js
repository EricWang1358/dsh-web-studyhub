/* The reading context a review run keeps (the loop 读 → 做题 → 回到阅读 → 掌握度上升).

   Starting practice from the reader ("做这几页的题") stores WHERE the learner was reading with the run itself
   (`run.reading`, in the library file beside the run), so the way back survives closing the app: the run page
   offers 回到原文 / 回到阅读 from it, not from anything held in memory. The shape (`v: 1`):

     { documentId, revision, sourceId,          which document, which revision of it, which source (page) the reader was opened on
       page,                                    the page / slide number the reader was on (null for a text)
       sectionId, sectionTitle,                 the outline entry at the reading position (the reader's own id, as drawn)
       sectionOffset, scrollTop, progress,      px below the section's top, the scroll offset, 0..1: where the viewport was
       scope: { kind, count, label },           what was practised: 'here' | 'chapter' | 'recent' | 'document', how many pages / sections
       origin: { page },                        the app page the reader was opened from, to land on it again
       before: { percent, total, state, ... } } the mastery of the practised questions before the first answer (the backend adds it)

   `after` is never stored: the projection recomputes it from the live cards, so it is always what the dashboard would say.
   Pure, no I/O. Unknown fields are dropped and every number is clamped, so a stored context is always safe to hand back to the reader. */
import { cardLevel, latestOutcomes, isDue } from './mastery.js';
import { summarizeLinked } from './material-mastery.js';

const SCOPES = new Set(['here', 'chapter', 'recent', 'document']);
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const number = (value, max) => Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 0;

/** A reading context from untrusted input, or null when it names no document and source. */
export function normalizeReading(input) {
  if (!input || typeof input !== 'object') return null;
  const documentId = text(input.documentId, 300), sourceId = text(input.sourceId, 300);
  if (!documentId || !sourceId) return null;
  const scope = input.scope && typeof input.scope === 'object' ? input.scope : {};
  return { v: 1, documentId, revision: text(input.revision, 200), sourceId,
    page: Number.isInteger(input.page) && input.page > 0 ? input.page : null,
    sectionId: text(input.sectionId, 120) || null, sectionTitle: text(input.sectionTitle, 200),
    sectionOffset: Math.round(number(input.sectionOffset, 1e6)), scrollTop: Math.round(number(input.scrollTop, 1e7)), progress: Math.round(number(input.progress, 1) * 1000) / 1000,
    scope: { kind: SCOPES.has(scope.kind) ? scope.kind : 'here', count: Number.isInteger(scope.count) ? Math.min(500, Math.max(1, scope.count)) : 1, label: text(scope.label, 120) },
    origin: { page: text(input.origin?.page, 40) } };
}

/** The small summary kept with a run: the numbers a result page needs. */
export const compactSummary = summary => ({ percent: summary.percent, total: summary.total, state: summary.state, due: summary.due, weak: summary.weak, fresh: summary.fresh });

/** The mastery of the cards a run was started on (its `scope` refs), from the live library. Archived decks and suspended cards are not counted. */
export function scopeSummary(state, scope, now = Date.now()) {
  const outcome = latestOutcomes(state.attempts || []), decks = new Map((state.decks || []).map(deck => [deck.id, deck]));
  const items = [], seen = new Set();
  for (const ref of Array.isArray(scope) ? scope : []) {
    const deck = decks.get(ref?.deckId), card = deck && !deck.archived ? deck.cards.find(item => item.id === ref.cardId) : null;
    const key = `${ref?.deckId}|${ref?.cardId}`;
    if (!card || card.suspended || seen.has(key)) continue;
    seen.add(key);
    const level = cardLevel(card, outcome(deck.id, card.id));
    items.push({ level, due: level !== 'new' && isDue(card, now) });
  }
  return compactSummary(summarizeLinked(items));
}

/** What `review.start` stores: the normalised context plus the mastery before the first answer; null when there is nothing valid to keep. */
export function readingForRun(state, input, scope, now = Date.now()) {
  const reading = normalizeReading(input);
  return reading ? { ...reading, before: scopeSummary(state, scope, now) } : null;
}

/** What a run shows: the stored context with the mastery of those same cards now. */
export function readingView(state, run, now = Date.now()) {
  return { ...run.reading, after: scopeSummary(state, run.scope, now) };
}
