/* The backend of the reading loop: `materials.pages.cards` (the cards linked to a document's pages, with their review state),
   the snapshot's `materialMastery`, and the reading context a review run keeps (`review.start { reading }`). The real
   runtime runs here; no model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { materialsSchemas } from '../lib/contexts/materials/contracts.js';
import { domainTool } from '../lib/runtime/tools.js';
import { deckProgress, latestOutcomes } from '../lib/mastery.js';
import { makeTextPdf, LECTURE_PAGES } from './helpers/text-pdf.mjs';

const future = Date.now() + 5 * 86400000, past = Date.now() - 86400000;
const iso = ms => new Date(ms).toISOString();
const card = (id, sourceId, { start = 0, end = 20, review, extra = {} } = {}) => ({ id, kind: 'flashcard', topic: 'Indexes', objective: `Objective ${id}`, prompt: `Question ${id}?`, answer: 'Answer', hint: 'hint',
  explanation: 'Because.', misconception: 'None.', citations: [{ sourceId, quote: 'An index is an extra data' }],
  selections: [{ sourceId, documentId: 'doc', revision: 'rev', start, end, quote: 'An index is an extra data', prefix: '', suffix: '' }],
  ...(review ? { review } : {}), ...extra });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'material-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = createStudyRuntime(root);
  t.after(() => runtime.dispose());
  const imported = await runtime.call('materials.document.import', { filename: 'lecture.pdf', courses: ['Databases'], dataBase64: (await makeTextPdf(LECTURE_PAGES)).toString('base64') });
  const [p1, p2, p3] = imported.sourceIds;
  const store = new Store(root);
  await store.update(state => {
    state.decks.push({ id: 'd1', title: 'Indexes', course: 'Databases', cards: [
      card('a', p1),                                                                          // new
      card('b', p1, { review: { repetitions: 3, interval_days: 30, due_at: iso(future), ease_factor: 2.5 } }),     // mastered
      card('c', p2, { review: { repetitions: 1, interval_days: 1, due_at: iso(past), ease_factor: 2.5 } }),       // weak (graded 1 below), due
      card('d', p2, { extra: { sourceQa: true } }),                                            // a saved Q&A card, new
      { ...card('e', p3, { review: { repetitions: 1, interval_days: 10, due_at: iso(future), ease_factor: 2.5 } }), suspended: true },
    ] });
    state.decks.push({ id: 'd2', title: 'Parked', course: 'Archive', cards: [card('f', p1)] });
    state.courses.push({ id: 'archive', name: 'Archive', active: false });
    state.attempts.push({ id: 'at1', deckId: 'd1', quiz_id: 'c', grade: 1, at: iso(past), runId: 'old' });
  });
  return { root, runtime, imported, p1, p2, p3, store, documentId: imported.documentId };
}

async function refreshedTextFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'material-refreshed-pages-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = createStudyRuntime(root);
  t.after(() => runtime.dispose());
  const first = await runtime.call('materials.document.import', { filename: 'lesson.txt',
    dataBase64: Buffer.from('An original cited claim.').toString('base64') });
  await new Store(root).update(state => state.decks.push({ id: 'history', title: 'Historical questions', cards: [
    { id: 'old-card', kind: 'flashcard', prompt: 'Original question?', answer: 'Original answer.',
      citations: [{ sourceId: first.sourceIds[0], quote: 'An original cited claim.' }],
      review: { repetitions: 3, interval_days: 30, due_at: iso(future), ease_factor: 2.5 } },
  ] }));
  const current = await runtime.call('materials.document.attach', { documentId: first.documentId, filename: 'lesson.txt',
    dataBase64: Buffer.from('The revised material needs new questions.').toString('base64') });
  return { runtime, first, current };
}

test('a refreshed material does not inherit the mastery of questions citing its retained old revision', async t => {
  const { runtime } = await refreshedTextFixture(t);
  const snapshot = await runtime.call('snapshot');
  assert.deepEqual(snapshot.materialMastery, {}, 'current material has no linked questions even when its old revision was mastered');
});

test('page-card links default to current evidence while an explicitly opened old source reads only its retained revision', async t => {
  const { runtime, first, current } = await refreshedTextFixture(t);
  const currentCards = await runtime.call('materials.pages.cards', { documentId: first.documentId });
  assert.equal(currentCards.status, 'ok');
  assert.deepEqual(currentCards.sourceIds, current.sourceIds);
  assert.deepEqual(currentCards.cards, [], 'old questions never appear beside the revised claims');
  const oldCards = await runtime.call('materials.pages.cards', { documentId: first.documentId, sourceId: first.sourceIds[0] });
  assert.equal(oldCards.status, 'ok');
  assert.deepEqual(oldCards.sourceIds, first.sourceIds);
  assert.deepEqual(oldCards.cards.map(item => item.cardId), ['old-card']);
  assert.equal(oldCards.summary.state, 'mastered');
  const oldSourceOnly = await runtime.call('materials.pages.cards', { sourceId: first.sourceIds[0] });
  assert.deepEqual(oldSourceOnly.sourceIds, first.sourceIds);
  const oldRange = await runtime.call('materials.pages.cards', { sourceIds: first.sourceIds });
  assert.deepEqual(oldRange.cards.map(item => item.cardId), ['old-card']);
});

test('materials.pages.cards lists the cards that point into the document with level, due and where they point; suspended cards are left out', async t => {
  const f = await fixture(t);
  const result = await f.runtime.call('materials.pages.cards', { documentId: f.documentId });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.cards.map(item => item.cardId).sort(), ['a', 'b', 'c', 'd', 'f']);
  const by = id => result.cards.find(item => item.cardId === id);
  assert.deepEqual([by('a').level, by('b').level, by('c').level, by('d').level], ['new', 'mastered', 'weak', 'new']);
  assert.equal(by('c').due, true);
  assert.equal(by('b').due, false);
  assert.equal(by('d').sourceQa, true);
  assert.equal(by('f').inactive, true, 'a parked course is labelled, not hidden: the learner is in this document');
  assert.deepEqual(result.inactiveCourses, ['Archive']);
  assert.deepEqual(by('a').links[0], { sourceId: f.p1, start: 0, end: 20, selection: by('a').links[0].selection });
  assert.equal(by('a').links[0].selection.quote, 'An index is an extra data');
  assert.equal(result.summary.total, 5);
  assert.equal(result.summary.due, 1);
  assert.equal(result.summary.weak, 1);
});

test('a page range narrows the cards; a card on two pages is listed once', async t => {
  const f = await fixture(t);
  await f.store.update(state => { state.decks[0].cards.push({ ...card('g', f.p1), citations: [{ sourceId: f.p1, quote: 'x' }, { sourceId: f.p2, quote: 'y' }], selections: [] }); });
  const range = await f.runtime.call('materials.pages.cards', { sourceId: f.p1, sourceIds: [f.p1, f.p2] });
  assert.equal(range.cards.filter(item => item.cardId === 'g').length, 1);
  const only = await f.runtime.call('materials.pages.cards', { sourceId: f.p1, sourceIds: [f.p2] });
  assert.deepEqual(only.cards.map(item => item.cardId).sort(), ['c', 'd', 'g']);
  const none = await f.runtime.call('materials.pages.cards', { sourceIds: [f.p3] });
  assert.equal(none.summary.state, 'none', 'p3 has only a suspended card');
});

test('a document with no linked card says so (state none), an unknown document is reported, nothing throws', async t => {
  const f = await fixture(t);
  await f.store.update(state => { state.decks = []; });
  const empty = await f.runtime.call('materials.pages.cards', { documentId: f.documentId });
  assert.deepEqual([empty.status, empty.cards.length, empty.summary.state, empty.summary.percent], ['ok', 0, 'none', null]);
  const missing = await f.runtime.call('materials.pages.cards', { documentId: 'document-nope' });
  assert.equal(missing.status, 'missing');
});

test('the snapshot carries materialMastery per document, page and chapter; its numbers are the dashboard numbers', async t => {
  const f = await fixture(t);
  const snapshot = await f.runtime.call('snapshot', {});
  const [entry] = Object.values(snapshot.materialMastery);
  assert.ok(entry, 'one document');
  assert.equal(entry.document.total, 5);
  assert.equal(entry.pages[f.p1].total, 3);
  assert.equal(entry.pages[f.p3], undefined, 'a page with only a suspended card has no question');
  const state = await f.store.read(), outcome = latestOutcomes(state.attempts);
  const deck = state.decks.find(item => item.id === 'd1');
  // Every card of d1 that is not suspended cites this document: the same cards, the same number.
  const cardsOfD1 = deck.cards.filter(item => !item.suspended).length;
  assert.equal(snapshot.progress.d1.total, cardsOfD1);
  const p12 = Object.values(snapshot.materialMastery)[0].pages;
  assert.ok(p12[f.p1].percent >= 0 && p12[f.p2].percent >= 0);
  assert.equal(deckProgress({ ...deck, cards: deck.cards.filter(item => ['c', 'd'].includes(item.id)) }, outcome).mastery, entry.pages[f.p2].percent);
});

test('the contract and the structured tool expose pages.cards like the other materials operations', () => {
  assert.ok(materialsSchemas['materials.pages.cards']);
  assert.ok(materialsSchemas['materials.pages.cards'].description.length > 40);
  const tool = domainTool('materials', { resolveWorkspace: async () => null });
  assert.ok(tool.parameters.properties.operation.enum.includes('pages.cards'));
  assert.ok(tool.parameters.properties.sourceIds, 'the page list is a tool parameter');
});

/* ---------- the reading context a run keeps ---------- */

const reading = f => ({ documentId: f.documentId, revision: f.imported.revision, sourceId: f.p1, page: 1, sectionId: 'page-1-0', sectionTitle: 'Database indexes', sectionOffset: 40, scrollTop: 120, progress: 0.1,
  scope: { kind: 'here', count: 1, label: 'p.1' }, origin: { page: 'sources' }, unknown: 'dropped' });

test('review.start keeps the reading context with the run (survives a reload) and the mastery of those cards before the first answer', async t => {
  const f = await fixture(t);
  const scope = [{ deckId: 'd1', cardId: 'a' }, { deckId: 'd1', cardId: 'b' }];
  const run = await f.runtime.call('review.start', { mode: 'path', scope, fresh: true, reading: reading(f) });
  assert.equal(run.reading.sourceId, f.p1);
  assert.equal(run.reading.sectionId, 'page-1-0');
  assert.equal(run.reading.documentId, f.documentId);
  assert.equal(run.reading.before.percent, 50, 'one new card and one mastered card');
  assert.equal(run.reading.after.percent, 50, 'nothing answered yet');
  assert.equal(run.reading.unknown, undefined, 'only known fields are kept');
  const again = await f.runtime.call('review.get', { runId: run.id });
  assert.deepEqual(again.reading, run.reading, 'stored with the run, not in memory');
  assert.equal((await new Store(f.root).read()).runs.find(item => item.id === run.id).reading.sectionId, 'page-1-0');
});

test('answering the new card well raises "after" while "before" stays: the loop closes on the result page', async t => {
  const f = await fixture(t);
  let run = await f.runtime.call('review.start', { mode: 'path', scope: [{ deckId: 'd1', cardId: 'a' }, { deckId: 'd1', cardId: 'b' }], fresh: true, reading: reading(f) });
  const before = run.reading.before.percent;
  for (let guard = 0; guard < 5 && !run.complete; guard++) {
    await f.runtime.call('review.reveal', { runId: run.id, cardId: run.card.id });
    run = await f.runtime.call('review.answer', { runId: run.id, cardId: run.card.id, grade: 5 });
    if (run.feedback) run = await f.runtime.call('review.move', { runId: run.id, direction: 1 });
  }
  assert.equal(run.complete, true);
  assert.equal(run.reading.before.percent, before);
  assert.ok(run.reading.after.percent > before, `${run.reading.after.percent} > ${before}`);
  const snapshot = await f.runtime.call('snapshot', {});
  assert.ok(Object.values(snapshot.materialMastery)[0].pages[f.p1].percent > before, 'and the 资料 page shows the new number');
});

test('a run without reading, or with a reading missing its document or page, has none; the existing start paths are unchanged', async t => {
  const f = await fixture(t);
  const plain = await f.runtime.call('review.start', { mode: 'path', scope: [{ deckId: 'd1', cardId: 'a' }], fresh: true });
  assert.equal(plain.reading, undefined);
  const bad = await f.runtime.call('review.start', { mode: 'path', scope: [{ deckId: 'd1', cardId: 'a' }], fresh: true, reading: { sectionId: 'x' } });
  assert.equal(bad.reading, undefined);
});

test('practising cards of a parked course still starts (the learner chose them) and keeps the reading context', async t => {
  const f = await fixture(t);
  const run = await f.runtime.call('review.start', { mode: 'path', scope: [{ deckId: 'd2', cardId: 'f' }], fresh: true, reading: reading(f) });
  assert.equal(run.total, 1);
  assert.equal(run.reading.before.state, 'unlearned');
});
