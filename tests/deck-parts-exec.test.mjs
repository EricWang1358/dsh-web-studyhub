import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { roundList } from '../lib/coverage-run.js';
import { partsOf } from '../lib/deck-parts.js';
import { shortfallOf } from '../lib/shortfall.js';
import { settleJob } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';

/* The owner's decision of 2026-10-06: a deck published at 9% coverage is topped up as a NEW DRAFT (never in place) whose targets are exactly the document's sections without a question, in
   rounds of at most the round limit until it is covered; when the learner publishes it into the deck its questions are the deck's SECOND PART (`part: 2` on each), and practice, mastery and
   coverage read the deck total. Discarding the draft changes nothing; the learner may publish it as a new deck instead. Through the service, with a fake model only. */

const world = mergedTranscript({ recordings: 2, parts: 6, paragraphs: 4 });
const PLAIN = { kind: 'quiz', count: 6, performance: { concurrency: 1, batchSize: 4, jobTimeoutMinutes: 20, fillRounds: 0, effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' } };

async function library(t, { coverage = { roundLimit: 8 } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-deck-parts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { coverage });
  t.after(() => service.dispose());
  service.complete = clusteringModel().complete;
  for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  return { service, ids: world.sources.map(source => source.id) };
}
const exported = async service => service.call('export');

/** The first deck: a plain run of 6 questions, published as it is (a clustering planner leaves most sections without a question). */
async function published(service, ids) {
  const first = await service.call('generate', { sourceIds: ids, ...PLAIN });
  assert.equal((await settleJob(service, first.jobId)).status, 'complete');
  const draft = (await exported(service)).drafts[0];
  const receipt = await service.call('draft.publish.quick', { id: draft.id, draftVersion: draft.draftVersion });
  return service.call('deck.get', { id: receipt.deckId });
}

test('the owner\'s case: a published deck at low coverage is topped up as a NEW draft in rounds, the deck is untouched until the learner publishes it into the deck as its second part', async (t) => {
  const { service, ids } = await library(t);
  const deck = await published(service, ids);
  assert.equal(deck.cards.length, 6);
  const before = await service.call('coverage.get', { sourceId: ids[0] });
  assert.ok(before.coverage.covered < before.coverage.leaves, 'the material has sections without a question');
  const open = before.coverage.leaves - before.coverage.covered;
  // The 资料 row and the reader ask the document: the decks that hold its questions and the round the button runs now.
  assert.equal(before.topUp.canTopUp, true);
  assert.deepEqual(before.topUp.candidates.map(item => [item.id, item.nextPart]), [[deck.id, 2]]);
  assert.equal(before.topUp.round.allQuestions, open, 'one question for each section without one');
  assert.equal(before.topUp.round.rounds, Math.ceil(open / 8));
  const estimate = await service.call('usage.estimate', { feature: 'generate', documentId: before.key, coverage: { sectionIds: before.topUp.round.picks.map(pick => pick.key) } });
  assert.ok(estimate.totalTokens?.high > 0, 'the button says what the round is expected to use');

  const started = await service.call('generate', { documentId: before.key, coverage: {} });
  assert.equal(started.autoComplete, true, '自动补到完整 is on by default');
  assert.equal(started.plan.rounds, before.topUp.round.rounds);
  assert.deepEqual(started.part, { deckId: deck.id, n: 2, deckTitle: deck.title });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const snapshot = await service.call('snapshot');
  const record = snapshot.jobs.find(item => item.id === started.jobId);
  assert.deepEqual(record.contract.detail.part, { deckId: deck.id, deckTitle: deck.title, n: 2, documentKey: before.key }, 'the 任务 console knows it is the second part of the deck');

  const library1 = await exported(service), draft = library1.drafts[0];
  assert.equal(library1.drafts.length, 1, 'ONE new draft');
  assert.deepEqual(draft.editorial.part, { deckId: deck.id, n: 2 });
  assert.equal(draft.mergeTargetId, undefined, 'no retained target: the learner chooses where it goes when publishing');
  assert.deepEqual([...draft.editorial.generation.sourceIds].sort(), [...ids].sort(), 'the draft is of the whole document');
  assert.equal(draft.editorial.coverageSpec.topup, true);
  assert.ok(roundList(draft.editorial.coverageSpec).every(round => round.status === 'done' && round.questions <= 8));
  assert.equal(draft.editorial.coverageRun.stop.reason, 'complete');
  const covered = new Set(before.coverage.sections.filter(section => section.state === 'covered').map(section => section.key));
  assert.ok(draft.editorial.coverageSpec.quotas.every(item => !covered.has(item.sectionId)), 'a section the deck already covers is never planned');
  // The deck is not touched before the learner publishes.
  assert.deepEqual(await service.call('deck.get', { id: deck.id }), deck);
  // The draft and the document say the same coverage (the deck's questions count): full.
  const draftView = await service.call('coverage.get', { draftId: draft.id }), docView = await service.call('coverage.get', { sourceId: ids[0] });
  assert.equal(draftView.coverage.covered, draftView.coverage.leaves);
  assert.equal(docView.coverage.covered, docView.coverage.leaves);
  assert.equal(docView.topUp.canTopUp, false, 'nothing left to top up');
  const found = shortfallOf({ draft, coverage: draftView.coverage, round: draftView.round });
  assert.equal(found.ready, true);
  assert.deepEqual([record.contract.progress.done, record.contract.progress.total], [found.questionsKept, found.questionsGoal], 'one number on the console and the draft');

  // Publish into the deck: the second part.
  const receipt = await service.call('draft.publish.quick', { id: draft.id, draftVersion: draft.draftVersion, mergeTargetId: deck.id });
  assert.equal(receipt.deckId, deck.id);
  const after = await service.call('deck.get', { id: deck.id });
  assert.equal(after.cards.length, 6 + draft.cards.length);
  assert.deepEqual(partsOf(after), [{ n: 1, count: 6 }, { n: 2, count: draft.cards.length }]);
  assert.ok(after.cards.slice(0, 6).every(card => card.part === undefined), 'the first part keeps no marker');
  const snap = await service.call('snapshot'), summary = snap.decks.find(item => item.id === deck.id);
  assert.deepEqual(summary.parts, [6, draft.cards.length], 'the deck page and the draft read the parts from the snapshot');
  assert.equal(summary.count, after.cards.length, 'practice counts the deck total');
  assert.equal(snap.progress[deck.id].total, after.cards.length, 'mastery counts the deck total');
  assert.equal((await exported(service)).drafts.length, 0);
  assert.equal(snap.materialCoverage[docView.key][0], docView.coverage.leaves, 'the 资料 row still says full coverage (the questions moved, not doubled)');
  const run = await service.call('review.start', { deckId: deck.id, mode: 'quiz', count: 500 });
  assert.equal(run.total, after.cards.filter(card => card.kind !== 'flashcard').length, 'practice reads every part');
  await assert.rejects(service.call('generate', { documentId: before.key, coverage: {} }), /所有小节都已经有题了|nothing to add/);
});

test('discarding the part draft changes nothing; it may be published as a NEW deck instead (no part marker, the first deck untouched)', async (t) => {
  const { service, ids } = await library(t, { coverage: { roundLimit: 30 } });
  const deck = await published(service, ids);
  const view = await service.call('coverage.get', { sourceId: ids[0] });
  const one = await service.call('generate', { documentId: view.key, coverage: {} });
  await settleJob(service, one.jobId);
  let draft = (await exported(service)).drafts[0];
  await service.call('draft.delete', { id: draft.id, draftVersion: draft.draftVersion });
  assert.deepEqual(await service.call('deck.get', { id: deck.id }), deck, 'a discarded part leaves the deck as it was');
  const two = await service.call('generate', { documentId: view.key, coverage: {} });
  await settleJob(service, two.jobId);
  draft = (await exported(service)).drafts[0];
  const receipt = await service.call('draft.publish.quick', { id: draft.id, draftVersion: draft.draftVersion });
  assert.notEqual(receipt.deckId, deck.id);
  const fresh = await service.call('deck.get', { id: receipt.deckId });
  assert.ok(fresh.cards.every(card => card.part === undefined), 'a deck of its own has no part marker');
  assert.deepEqual(await service.call('deck.get', { id: deck.id }), deck);
});

test('a draft that waits for the learner (自动补到完整 off) holds its sections: the document offers nothing for them meanwhile, and a third top-up becomes part 3', async (t) => {
  const { service, ids } = await library(t, { coverage: { roundLimit: 4 } });
  const deck = await published(service, ids);
  const view = await service.call('coverage.get', { sourceId: ids[0] });
  const started = await service.call('generate', { documentId: view.key, coverage: { autoComplete: false } });
  assert.equal(started.autoComplete, false);
  await settleJob(service, started.jobId);
  const draft = (await exported(service)).drafts[0];
  assert.equal(draft.editorial.coverageRun.state, 'waiting');
  const now = await service.call('coverage.get', { sourceId: ids[0] });
  assert.ok(now.coverage.covered < now.coverage.leaves);
  assert.equal(now.topUp.canTopUp, false, 'every section left is in a round of that draft');
  assert.ok(now.topUp.inFlight > 0);
  await assert.rejects(service.call('generate', { documentId: view.key, coverage: {} }), /另一份草稿里补题|already being topped up/);
  // Published into the deck as part 2 (with what it has); then the rest is offered again, as part 3.
  await service.call('draft.publish.quick', { id: draft.id, draftVersion: draft.draftVersion, mergeTargetId: deck.id });
  const later = await service.call('coverage.get', { sourceId: ids[0] });
  assert.equal(later.topUp.canTopUp, true);
  assert.equal(later.topUp.candidates[0].nextPart, 3);
  const third = await service.call('generate', { documentId: view.key, coverage: { autoComplete: false } });
  assert.equal(third.part.n, 3);
  await settleJob(service, third.jobId);
  const next = (await exported(service)).drafts[0];
  await service.call('draft.publish.quick', { id: next.id, draftVersion: next.draftVersion, mergeTargetId: deck.id });
  assert.deepEqual(partsOf(await service.call('deck.get', { id: deck.id })).map(part => part.n), [1, 2, 3]);
});

test('several decks hold the material: the learner says which one the part is for', async (t) => {
  const { service, ids } = await library(t);
  const a = await published(service, ids), b = await published(service, ids);
  const view = await service.call('coverage.get', { sourceId: ids[0] });
  assert.deepEqual(view.topUp.candidates.map(item => item.id).sort(), [a.id, b.id].sort());
  await assert.rejects(service.call('generate', { documentId: view.key, coverage: {} }), /partOf|哪个题组/);
  await assert.rejects(service.call('generate', { documentId: view.key, coverage: {}, partOf: 'nope' }), /partOf|哪个题组/);
  const started = await service.call('generate', { documentId: view.key, coverage: { autoComplete: false }, partOf: b.id });
  assert.equal(started.part.deckId, b.id);
  await settleJob(service, started.jobId);
});

test('the draft page goes on with a part like with any draft (its own top-up): the next round, the same draft, still the part of the same deck', async (t) => {
  const { service, ids } = await library(t, { coverage: { roundLimit: 4 } });
  const deck = await published(service, ids);
  const view = await service.call('coverage.get', { sourceId: ids[0] });
  const started = await service.call('generate', { documentId: view.key, coverage: { autoComplete: false } });
  await settleJob(service, started.jobId);
  const draft = (await exported(service)).drafts[0], page = await service.call('coverage.get', { draftId: draft.id });
  assert.equal(page.coverage.covered, (await service.call('coverage.get', { sourceId: ids[0] })).coverage.covered, 'the draft page says the coverage of the document');
  assert.ok(page.round.sections > 0);
  const next = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { autoComplete: true } });
  assert.deepEqual((await service.call('snapshot')).jobs.find(job => job.id === next.jobId).part, { deckId: deck.id, deckTitle: deck.title, n: 2 }, 'the next round still says whose part it is (the console title)');
  assert.equal((await settleJob(service, next.jobId)).status, 'complete');
  const after = (await exported(service)).drafts;
  assert.equal(after.length, 1, 'the same draft');
  assert.deepEqual(after[0].editorial.part, { deckId: deck.id, n: 2 });
  assert.ok(after[0].cards.length > draft.cards.length);
  assert.deepEqual(await service.call('deck.get', { id: deck.id }), deck, 'the deck is still untouched');
});
