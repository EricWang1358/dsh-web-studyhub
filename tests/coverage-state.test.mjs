import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { coverageForDraft, coverageForDocument, materialCoverageIndex, materialCoverageOf, topUpRound, sourcesOfDraft } from '../lib/coverage-state.js';
import { coverageFromDigest } from '../lib/coverage.js';
import { mergeContinuedDraft } from '../lib/bank-import.js';
import { transcriptFixture, sectionedModel } from './helpers/coverage-fixture.mjs';

/* Coverage read from a library state: the draft's own, a document's (everything of the library that points into it, published or in a draft), the numbers of every document for the
   snapshot (the 资料 row), and the questions asked of a draft that is topped up. Checklists first, as in tests/coverage.test.mjs. */

const fx = transcriptFixture({ recordings: 3, parts: 4, paragraphs: 2 });
const sources = fx.sources.map(source => ({ ...source, courses: [] }));
const leaf = id => fx.leaves.find(section => section.id === id);
const cardsFor = (ids, prefix) => ids.map(id => ({ ...fx.card(leaf(id)), id: `${prefix}-${id}`, objective: `Objective ${prefix} ${id}`, prompt: `Prompt ${prefix} ${id}` }));
const draftOf = (id, covered, extra = {}) => ({ id, title: id, draftVersion: 1, cards: cardsFor(covered, id), editorial: { requested: 10, generated: covered.length, parts: 1, completedParts: 1, failures: [],
  generation: { sourceIds: sources.map(source => source.id), kind: 'quiz' }, ...extra.editorial }, ...extra.draft });
const state = (decks, drafts) => ({ revision: 1, sources, documents: [], decks, drafts });

test('the coverage of a draft is its own questions over the sources it was generated from', () => {
  const draft = draftOf('d1', ['r1.p1', 'r2.p3']);
  const coverage = coverageForDraft(state([], [draft]), draft);
  assert.equal(coverage.leaves, 12);
  assert.deepEqual(coverage.sections.filter(section => section.state === 'covered').map(section => section.id), ['r1.p1', 'r2.p3']);
  assert.deepEqual(sourcesOfDraft(state([], [draft]), draft).map(source => source.id), sources.map(source => source.id));
  // a draft of other sources does not see these
  const other = draftOf('d2', [], { editorial: { generation: { sourceIds: ['nowhere'], kind: 'quiz' } } });
  assert.equal(coverageForDraft(state([], [other]), other).leaves, 0);
});

test('the coverage of a document counts published decks and drafts together, once each, and the plans of the drafts that planned it', () => {
  const deck = { id: 'k1', title: 'Deck', cards: cardsFor(['r1.p1', 'r1.p2'], 'deck') };
  const archived = { id: 'k2', title: 'Old', archived: true, cards: cardsFor(['r3.p4'], 'old') };
  const draft = draftOf('d1', ['r1.p2', 'r2.p1']);
  const suspended = { ...draftOf('d3', []), cards: cardsFor(['r3.p3'], 'sus').map(card => ({ ...card, suspended: true })) };
  const copy = draftOf('d4', ['r3.p1'], { draft: { editingDeckId: 'k1' } });
  const failed = draftOf('d5', [], { editorial: { partPlans: [{ part: 1, sourceIds: [sources[0].id], ranges: [{ sourceId: sources[0].id, start: leaf('r2.p4').start, end: leaf('r2.p4').end }], targets: [], status: 'failed', reason: 'timeout', attempts: 1 }] } });
  const s = state([deck, archived], [draft, suspended, copy, failed]);
  const found = coverageForDocument(s, { sourceId: sources[0].id });
  assert.ok(found, 'the document is found by any of its sources');
  const covered = found.coverage.sections.filter(section => section.state === 'covered').map(section => section.id);
  assert.deepEqual(covered, ['r1.p1', 'r1.p2', 'r2.p1'], 'published + drafts; an archived deck, a suspended question and a copy of a published deck are not counted');
  assert.equal(found.coverage.cards, 4, 'a question is counted once however many places hold it');
  assert.equal(found.coverage.sections.find(section => section.id === 'r2.p4').state, 'planned-failed');
  assert.equal(found.coverage.sections.find(section => section.id === 'r2.p4').reason, 'timeout');
  assert.equal(coverageForDocument(s, { sourceId: 'unknown' }), null);
  assert.equal(coverageForDocument(s, { key: found.item.key }).item.key, found.item.key);
});

test('the numbers for the 资料 row: a document with a question has them (drafts count), a document with none has no entry, and they are kept per library revision', () => {
  const draft = draftOf('d1', ['r1.p1', 'r1.p2', 'r2.p1']);
  const s = state([], [draft]);
  const index = materialCoverageIndex(s), keys = Object.keys(index);
  assert.equal(keys.length, 1);
  assert.deepEqual(index[keys[0]], [3, 0, 9, 0, 'part'], 'covered, planned-failed, never planned, recorded, unit: a few characters per document');
  assert.deepEqual(coverageFromDigest(index[keys[0]]), { covered: 3, plannedFailed: 0, neverPlanned: 9, leaves: 12, percentLeaves: 25, units: 'part', recorded: false });
  assert.equal(coverageFromDigest(undefined), null);
  assert.equal(coverageFromDigest([0, 0, 0, 1, 'part']), null);
  assert.deepEqual(materialCoverageIndex(state([], [])), {}, 'no question anywhere: nothing');
  assert.deepEqual(materialCoverageIndex(state([], [draftOf('e', [])])), {}, 'a draft with no question is not a coverage');
  const first = materialCoverageOf(s, { root: 'cov-root' });
  assert.equal(materialCoverageOf(s, { root: 'cov-root' }), first, 'the same revision: the same answer, not computed again');
  const next = materialCoverageOf({ ...s, revision: 2, drafts: [draftOf('d1', ['r1.p1'])] }, { root: 'cov-root' });
  assert.notEqual(next, first);
  assert.equal(Object.values(next)[0][0], 1);
});

test('the top-up round of a draft: the default round, the keys the screen showed, and the refusal when the draft has nothing to be planned from', () => {
  const draft = draftOf('d1', ['r1.p1']);
  const s = state([], [draft]);
  const { round, request } = topUpRound(s, draft);
  assert.deepEqual([round.sections, round.questions, round.left, round.complete], [11, 11, 0, true]);
  assert.equal(request.count, 11);
  assert.equal(request.reuse.length, 0);
  const keys = round.picks.slice(0, 2).map(pick => pick.key);
  assert.equal(topUpRound(s, draft, { sectionIds: keys }).request.count, 2);
  assert.equal(topUpRound(s, draft, { sectionIds: ['nowhere#x'] }).round.error, 'unknown');
  assert.equal(topUpRound(s, draft, { sectionIds: ['x'], limit: 1 }).request, undefined);
});

/* ---------- through the service: the snapshot and coverage.get ---------- */

const EFFORTS = { effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' };
test('the snapshot carries the coverage of a document that only has a draft, and coverage.get answers for the draft and for the document', async (t) => {
  const model = sectionedModel();
  const root = await mkdtemp(join(tmpdir(), 'study-cov-snap-')), previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'home');
  const service = new StudyService(root, { complete: model.complete, coach: false, language: 'zh' });
  t.after(async () => { await service.dispose(); if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const ids = [];
  for (const source of fx.sources) ids.push((await service.call('source.add', { title: source.title, text: source.text })).id);
  const performance = { concurrency: 1, batchSize: 5, jobTimeoutMinutes: 5, fillRounds: 0, ...EFFORTS };
  const started = await service.call('generate', { sourceIds: ids, count: 6, kind: 'quiz', title: 'Snap', ...performance, performance });
  const job = await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 60 });
  assert.equal(job.status, 'complete', job.stage);
  const snapshot = await service.call('snapshot', {});
  const entries = Object.entries(snapshot.materialCoverage || {});
  assert.equal(entries.length, 1, 'one material, and it has only a draft');
  const [key, digest] = entries[0], numbers = coverageFromDigest(digest);
  assert.deepEqual([numbers.covered, numbers.leaves], [6, 12]);
  assert.equal(numbers.recorded, true);
  assert.equal((await service.call('snapshot', { compact: true })).materialCoverage, undefined, 'a compact snapshot is lean');
  const byDocument = await service.call('coverage.get', { sourceId: snapshot.sources[0].id });
  assert.equal(byDocument.status, 'ok');
  assert.equal(byDocument.scope, 'document');
  assert.equal(byDocument.key, key);
  assert.equal(byDocument.coverage.covered, 6);
  assert.ok(byDocument.coverage.sections.every(section => section.targets === undefined), 'the planned targets stay on the backend');
  const byDraft = await service.call('coverage.get', { draftId: job.draftId });
  assert.equal(byDraft.scope, 'draft');
  assert.equal(byDraft.canTopUp, true);
  assert.equal(byDraft.coverage.covered, byDocument.coverage.covered, 'the draft and its material tell the same story');
  assert.equal(byDraft.round.sections, 6, 'the six sections that are left');
  assert.equal((await service.call('coverage.get', { draftId: 'gone' })).status, 'missing');
  assert.equal((await service.call('coverage.get', { documentId: 'gone' })).status, 'missing');
  await assert.rejects(() => service.call('coverage.get', {}), /needs draftId/);
});

/* ---------- what a top-up does to the number a draft was asked for ---------- */

test('a top-up for the uncovered sections never changes what the draft was asked for', () => {
  const base = draftOf('d1', ['r1.p1', 'r1.p2'], { editorial: { requested: 10 } });
  const fresh = { cards: cardsFor(['r2.p1', 'r2.p2'], 'new'), editorial: { failures: [], parts: 1, completedParts: 1, generation: { sourceIds: base.editorial.generation.sourceIds, course: '' }, coverage: { sources: [] }, audits: [], partPlans: [] } };
  const merged = mergeContinuedDraft(base, fresh, sources);
  assert.equal(merged.cards.length, 4);
  assert.equal(merged.editorial.requested, 10, '4 of 10 asked: still 10, never 12');
  const big = mergeContinuedDraft(draftOf('d2', ['r1.p1', 'r1.p2', 'r1.p3'], { editorial: { requested: 3 } }), fresh, sources);
  assert.equal(big.cards.length, 5);
  assert.equal(big.editorial.requested, 3, 'a draft that holds more than it was asked for stays "asked for 3"');
  // the older continuation still takes the number it is given
  assert.equal(mergeContinuedDraft(base, fresh, sources, { addSourceIds: [], requested: 17 }).editorial.requested, 17);
});
