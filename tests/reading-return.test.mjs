/* The reading context a run keeps: validation, clamping, the round trip, the mastery before and after. Pure. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReading, readingForRun, readingView, scopeSummary } from '../lib/reading-return.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const valid = { documentId: 'document-abc-pdf', revision: 'rev1', sourceId: 'doc-s3', page: 3, sectionId: 'page-3-2', sectionTitle: 'Hash indexes', sectionOffset: 42.4, scrollTop: 1234.6, progress: 0.4567,
  scope: { kind: 'chapter', count: 4, label: '第 3–6 页' }, origin: { page: 'sources' } };
const card = (id, review, extra = {}) => ({ id, kind: 'flashcard', topic: 't', prompt: id, answer: 'a', citations: [], ...(review ? { review } : {}), ...extra });
const state = { attempts: [{ deckId: 'd', quiz_id: 'w', grade: 1 }], decks: [{ id: 'd', title: 'D', cards: [
  card('n'), card('m', { repetitions: 4, interval_days: 30, due_at: '2026-12-01T00:00:00.000Z' }), card('w', { repetitions: 1, interval_days: 1, due_at: '2026-09-30T00:00:00.000Z' }),
  card('s', { repetitions: 4, interval_days: 30, due_at: '2026-12-01T00:00:00.000Z' }, { suspended: true })] }, { id: 'old', archived: true, cards: [card('x')] }] };

test('a valid context round-trips with its numbers rounded and unknown fields dropped', () => {
  const kept = normalizeReading({ ...valid, junk: 1, origin: { page: 'sources', x: 1 } });
  assert.deepEqual(kept, { v: 1, documentId: 'document-abc-pdf', revision: 'rev1', sourceId: 'doc-s3', page: 3, sectionId: 'page-3-2', sectionTitle: 'Hash indexes',
    sectionOffset: 42, scrollTop: 1235, progress: 0.457, scope: { kind: 'chapter', count: 4, label: '第 3–6 页' }, origin: { page: 'sources' } });
  assert.deepEqual(normalizeReading(JSON.parse(JSON.stringify(kept))), kept, 'storing it as JSON and normalising again changes nothing');
});

test('without a document and a source there is no context; bad numbers and kinds are brought into range', () => {
  assert.equal(normalizeReading(null), null);
  assert.equal(normalizeReading({ sourceId: 's' }), null);
  assert.equal(normalizeReading({ documentId: 'd' }), null);
  const odd = normalizeReading({ documentId: 'd', sourceId: 's', page: -2, progress: 7, scrollTop: -5, sectionOffset: 'x', scope: { kind: 'everything', count: 99999 }, sectionTitle: 'x'.repeat(900) });
  assert.deepEqual([odd.page, odd.progress, odd.scrollTop, odd.sectionOffset, odd.scope.kind, odd.scope.count, odd.sectionTitle.length, odd.sectionId], [null, 1, 0, 0, 'here', 500, 200, null]);
});

test('the mastery of the practised cards: archived decks and suspended cards are not counted, a card listed twice counts once', () => {
  const summary = scopeSummary(state, [{ deckId: 'd', cardId: 'n' }, { deckId: 'd', cardId: 'n' }, { deckId: 'd', cardId: 'm' }, { deckId: 'd', cardId: 'w' }, { deckId: 'd', cardId: 's' }, { deckId: 'old', cardId: 'x' }, { deckId: 'gone', cardId: 'q' }], NOW);
  assert.deepEqual([summary.total, summary.fresh, summary.weak, summary.due], [3, 1, 1, 1]);
  assert.equal(summary.percent, Math.round((0 + 1 + 0.15) / 3 * 100));
});

test('before is fixed when the run starts and after follows the live cards', () => {
  const scope = [{ deckId: 'd', cardId: 'n' }, { deckId: 'd', cardId: 'm' }];
  const reading = readingForRun(state, valid, scope, NOW);
  assert.equal(reading.before.percent, 50);
  const run = { scope, reading };
  assert.equal(readingView(state, run, NOW).after.percent, 50);
  const answered = structuredClone(state);
  answered.decks[0].cards[0].review = { repetitions: 2, interval_days: 10, due_at: '2026-10-20T00:00:00.000Z' };
  const view = readingView(answered, run, NOW);
  assert.equal(view.before.percent, 50, 'what it was');
  assert.equal(view.after.percent, 88, 'familiar (0.75) and mastered (1) = 87.5%');
  assert.equal(readingForRun(state, { sectionId: 'x' }, scope, NOW), null);
});
