/* The reading context a review run keeps (the loop 读 → 做题 → 回到阅读 → 掌握度上升).

   Starting practice from the reader ("做这几页的题") stores WHERE the learner was reading with the run itself
   (`run.reading`, in the library file beside the run), so the way back survives closing the app: the run page
   offers 回到原文 / 回到阅读 from it, not from anything held in memory. The shape (`v: 1`):

     { documentId, revision, sourceId,          which document, which revision of it, which source (page) the reader was opened on
       page,                                    the page / slide number the reader was on (null for a text)
       sectionId, sectionTitle,                 the outline entry at the reading position (the reader's own id, as drawn)
       sectionOffset, scrollTop, progress,      px below the section's top, the scroll offset, 0..1: where the viewport was
       scope: { kind, count, label },           what was practised: 'here' | 'chapter' | 'recent' | 'document', how many pages / sections
       origin: { page } }                       the app page the reader was opened from, to land on it again

   The mastery of the practised pages before the first answer is the round's own `run.mastery.before`, as for every round
   (lib/run-mastery.js, measured on this run's `scope`); runs from before 3.6 kept it here as `before`, and it is still read from there.
   Pure, no I/O. Unknown fields are dropped and every number is clamped, so a stored context is always safe to hand back to the reader. */
import { masteryView, scopeSummary } from './run-mastery.js';

export { scopeSummary } from './run-mastery.js';

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

/** What a run shows: the stored context with the mastery of its pages before the first answer (when stored) and now. */
export function readingView(state, run, now = Date.now()) {
  const change = masteryView(state, run, now);
  return { ...run.reading, ...(change || { after: scopeSummary(state, run.scope, now) }) };
}
