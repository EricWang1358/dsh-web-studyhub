import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { gate, soon, stagedModel } from './helpers/generation-baseline.mjs';

/* S3-4: a selected-passage supplement is a job of the unified runtime behind `runtime.pilot.generation`, waiting in the library's one queue with every other
   generation job; the operation record (candidates, review, receipt) and the bank's append receipt stay the domain's commit. Behind `generationRestart` an
   operation the last process left unfinished goes on from its record: candidates are reviewed, not written again (D-1), and an append that was committed is
   found by its receipt, not refused as a changed payload (D-2). */

const passage = "Architecture includes the principles guiding a system's design and evolution.";
const host = (model, paths) => { const { starts: _starts, ...options } = managedRuntimeOptions({ complete: model.complete, paths }); return { complete: model.complete, ...options }; };
const RUNTIME = ['generation'], RESTART = ['generation', 'generationRestart'];

async function library(t, model, paths = RUNTIME, hold) {
  const root = await mkdtemp(join(tmpdir(), 'study-s34-selection-'));
  t.after(async () => { hold?.open(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await new Store(root).update(state => { state.decks.push({ id: 'd', title: 'Architecture basics', cards: [{ id: 'old', kind: 'flashcard', objective: 'Original objective', prompt: 'Original question?', answer: 'Original' }] }); });
  const runtime = createStudyRuntime(root, host(model, paths));
  t.after(async () => { await runtime.dispose(); });
  await runtime.call('source.add', { id: 's', title: 'Notes', text: 'Architecture sets principles that guide how a system is designed and changed.' });
  const imported = await runtime.call('materials.document.import', { filename: 'notes.md', dataBase64: Buffer.from(`# Notes\n\n${passage}`).toString('base64') });
  const selection = (await runtime.call('materials.selection.resolve', { documentId: imported.documentId, revision: imported.revision, quote: passage })).selection;
  return { root, runtime, args: { selection, deckId: 'd', expectedVersion: 0, count: 1, kind: 'flashcard', operationId: 'op-1' } };
}
const restarted = async (t, root, model, paths) => {
  const copy = await mkdtemp(join(tmpdir(), 'study-s34-selection-restart-'));
  await cp(root, copy, { recursive: true });
  const runtime = createStudyRuntime(copy, host(model, paths));
  t.after(async () => { await runtime.dispose(); await rm(copy, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return runtime;
};
const statusOf = (runtime, operationId = 'op-1') => runtime.call('generation.selection.status', { operationId }).then(reply => reply.job);
const rowOf = async (runtime, jobId) => (await runtime.call('snapshot')).jobs.find(job => job.id === jobId);
const cardsOf = async runtime => (await runtime.call('bank.get', { deckId: 'd' })).deck.cards;

test('a selection job on the runtime waits in the library queue behind a generation job, never touches the model while it waits, and saves once', async t => {
  const hold = gate(), blocker = stagedModel({ holdAt: 'plan', hold }), model = stagedModel();
  const { runtime, args } = await library(t, { complete: (...call) => (blocker.log.length ? model : blocker).complete(...call) }, RUNTIME, hold);
  const first = await runtime.call('generate', { sourceIds: ['s'], count: 1, kind: 'flashcard' });
  await soon(() => hold.entered, 'the generation job to be at the model');
  const started = await runtime.call('generation.selection.start', args);
  assert.deepEqual([started.status, started.queuedBehind], ['queued', 1]);
  const row = await rowOf(runtime, started.jobId);
  assert.deepEqual([row.contract.contractVersion, row.contract.kind, row.origin, row.operationId], [2, 'supplement', 'selection', 'op-1'], 'a job of the runtime that the selection panel and the console already know');
  hold.open();
  assert.equal((await runtime.call('job.wait', { jobId: first.jobId, timeoutSeconds: 30 })).status, 'complete');
  const done = await runtime.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 });
  assert.equal(done.status, 'complete', done.stage);
  assert.equal((await cardsOf(runtime)).length, 2, 'one append');
  assert.ok((await rowOf(runtime, started.jobId)).contract.calls.every(call => call.feature === 'generate' && call.observation.boundary === 'host-attempt'), 'every call went through the gateway');
});

test('a queued selection job that is stopped never starts: no model call, nothing saved, the deck as it was', async t => {
  const hold = gate(), blocker = stagedModel({ holdAt: 'plan', hold }), seen = [];
  const { runtime, args } = await library(t, { complete: async (system, prompt, options) => { seen.push(system.slice(0, 20)); return blocker.complete(system, prompt, options); } }, RUNTIME, hold);
  await runtime.call('generate', { sourceIds: ['s'], count: 1, kind: 'flashcard' });
  await soon(() => hold.entered, 'the generation job to be at the model');
  const before = seen.length, started = await runtime.call('generation.selection.start', args);
  await runtime.call('job.cancel', { jobId: started.jobId });
  hold.open();
  assert.equal((await runtime.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 })).status, 'cancelled');
  assert.equal(seen.slice(before).filter(system => /^Plan a source/.test(system)).length, 0, 'the selection job never asked for a plan');
  assert.equal((await cardsOf(runtime)).length, 1);
});

test('restart, active record (D-1): with the restart switch the candidates of the record are reviewed, not written again', async t => {
  const hold = gate(), first = await library(t, stagedModel({ holdAt: 'review', hold }), RESTART, hold);
  await first.runtime.call('generation.selection.start', first.args);
  await soon(() => hold.entered, 'the review to be held');
  assert.equal((await new Store(first.root).read()).selectionJobs[0].candidates.length, 1);
  const model = stagedModel(), runtime = await restarted(t, first.root, model, RESTART);
  assert.deepEqual(model.log, [], 'no model call by itself');
  const again = await runtime.call('generation.selection.start', first.args);
  const done = await runtime.call('job.wait', { jobId: again.jobId, timeoutSeconds: 30 });
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(model.log, ['review'], 'only the review: the plan, the answers and the writing were not paid for again');
  assert.equal((await cardsOf(runtime)).length, 2, 'one append only');
});

test('restart, append committed but the record not marked (D-2): with the restart switch the receipt is replayed, the same cards, no model call', async t => {
  const first = await library(t, stagedModel(), RESTART);
  const finished = await first.runtime.call('job.wait', { jobId: (await first.runtime.call('generation.selection.start', first.args)).jobId, timeoutSeconds: 30 });
  assert.equal(finished.status, 'complete');
  const copy = await mkdtemp(join(tmpdir(), 'study-s34-d2-'));
  await cp(first.root, copy, { recursive: true });
  t.after(() => rm(copy, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await new Store(copy).update(state => { const record = state.selectionJobs[0]; record.status = 'reviewed'; delete record.receipt; });
  const model = stagedModel(), runtime = createStudyRuntime(copy, host(model, RESTART));
  t.after(async () => { await runtime.dispose(); });
  const before = await statusOf(runtime);
  assert.deepEqual([before.status, before.outcome], ['failed', 'interrupted'], 'a reviewed record that was not saved reads as unfinished, not as a review failure');
  const again = await runtime.call('generation.selection.start', first.args);
  const done = await runtime.call('job.wait', { jobId: again.jobId, timeoutSeconds: 30 });
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(done.publication.cardIds, finished.publication.cardIds, 'the cards of the first append, found by their receipt');
  assert.deepEqual(model.log, [], 'no model call');
  assert.equal((await cardsOf(runtime)).length, 2, 'no duplicate');
});

test('without the restart switch both restart defects stay as the baseline recorded them (the switch is what changes them)', async t => {
  const first = await library(t, stagedModel(), RUNTIME);
  const finished = await first.runtime.call('job.wait', { jobId: (await first.runtime.call('generation.selection.start', first.args)).jobId, timeoutSeconds: 30 });
  const copy = await mkdtemp(join(tmpdir(), 'study-s34-off-'));
  await cp(first.root, copy, { recursive: true });
  t.after(() => rm(copy, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await new Store(copy).update(state => { const record = state.selectionJobs[0]; record.status = 'reviewed'; delete record.receipt; });
  const model = stagedModel(), runtime = createStudyRuntime(copy, host(model, RUNTIME));
  t.after(async () => { await runtime.dispose(); });
  const job = await statusOf(runtime);
  assert.deepEqual([job.status, job.outcome], ['failed', 'review-failed']);
  const again = await runtime.call('job.wait', { jobId: (await runtime.call('generation.selection.start', first.args)).jobId, timeoutSeconds: 30 });
  assert.deepEqual([again.status, again.outcome], ['failed', 'conflict']);
  assert.equal(finished.status, 'complete');
});

test('a selection job stopped while its review is asked can be retried in the process: the candidates are reviewed, the deck gets one append', async t => {
  const hold = gate(), model = stagedModel({ holdAt: 'review', hold });
  const { runtime, args } = await library(t, model, RUNTIME, hold);
  const started = await runtime.call('generation.selection.start', args);
  await soon(() => hold.entered, 'the review to be held');
  await runtime.call('job.cancel', { jobId: started.jobId });
  hold.open();
  assert.equal((await runtime.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 })).status, 'cancelled');
  const row = await rowOf(runtime, started.jobId);
  assert.equal(row.contract.actions.retry.available, true);
  const authors = model.log.filter(stage => stage === 'author').length;
  const retried = await runtime.call('job.control', { jobId: started.jobId, action: 'retry' });
  const done = await runtime.call('job.wait', { jobId: retried.attemptId, timeoutSeconds: 30 });
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(model.log.filter(stage => stage === 'author').length, authors, 'the candidates were not written again');
  assert.equal((await cardsOf(runtime)).length, 2);
});
