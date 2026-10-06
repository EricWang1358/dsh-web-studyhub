import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { gate, soon, stagedModel } from './helpers/generation-baseline.mjs';

/* S3-0 baseline, restart boundary of SELECTION fill (generation.selection.*). Unlike the other ordinary paths this one persists an operation record (state.selectionJobs: candidates, review,
   accepted, receipt) and the bank keeps an append receipt keyed by operationId, so a FINISHED operation replays after a restart (tests/selection-jobs.test.mjs). What is characterized here is
   the part that is not covered there: an operation that was still ACTIVE when the host died. It is shown as a failed/interrupted job, nothing continues by itself, and starting again with the
   same operationId re-authors instead of reusing the candidates the record already holds. Owner of the gaps: S3-4. Fake models only. */

const passage = "Architecture includes the principles guiding a system's design and evolution.";

async function opened(t, root, model) {
  const runtime = createStudyRuntime(root, { complete: model.complete });
  t.after(async () => { await runtime.dispose(); });
  return runtime;
}
async function library(t, model, hold) {
  const root = await mkdtemp(join(tmpdir(), 'study-s30-selection-'));
  t.after(async () => { hold?.open(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await new Store(root).update(state => { state.decks.push({ id: 'd', title: 'Architecture basics', cards: [{ id: 'old', kind: 'flashcard', objective: 'Original objective', prompt: 'Original question?', answer: 'Original' }] }); });
  const runtime = await opened(t, root, model);
  const imported = await runtime.call('materials.document.import', { filename: 'notes.md', dataBase64: Buffer.from(`# Notes\n\n${passage}`).toString('base64') });
  const selection = (await runtime.call('materials.selection.resolve', { documentId: imported.documentId, revision: imported.revision, quote: passage })).selection;
  const args = { selection, deckId: 'd', expectedVersion: 0, count: 1, kind: 'flashcard', operationId: 'op-1' };
  return { root, runtime, args };
}
const copyOf = async (t, root) => { const copy = await mkdtemp(join(tmpdir(), 'study-s30-selection-restart-')); await cp(root, copy, { recursive: true }); t.after(() => rm(copy, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return copy; };
const statusOf = (runtime, operationId = 'op-1') => runtime.call('generation.selection.status', { operationId }).then(reply => reply.job);

test('selection operation killed while reviewing: the record holds the candidates, the restart shows a failed/interrupted job, nothing continues by itself, and starting again authors AGAIN', async t => {
  const hold = gate(), first = await library(t, stagedModel({ holdAt: 'review', hold }), hold);
  const started = await first.runtime.call('generation.selection.start', first.args);
  await soon(() => hold.entered, 'the review to be held');
  const record = (await new Store(first.root).read()).selectionJobs[0];
  assert.deepEqual([record.status, record.candidates.length, record.reviewPassed], ['reviewing', 1, false], 'the candidates are durable before the review is asked');
  const root = await copyOf(t, first.root), model = stagedModel(), runtime = await opened(t, root, model);
  const job = await statusOf(runtime);
  assert.deepEqual([job.status, job.outcome, job.operationState], ['failed', 'interrupted', 'reviewing'], 'an active record is reported as a failed job with outcome interrupted, not as an interrupted lifecycle state');
  assert.deepEqual((await runtime.call('snapshot')).jobs.filter(item => item.origin === 'selection'), [], 'it is not on the task list');
  assert.deepEqual(model.log, [], 'no model call by itself');
  const again = await runtime.call('generation.selection.start', first.args);
  const done = await runtime.call('job.wait', { jobId: again.jobId, timeoutSeconds: 30 });
  assert.equal(done.status, 'complete', done.stage);
  assert.ok(model.log.includes('author'), 'the candidates of the record are not reused: the restart writes them again (cost, not duplication)');
  assert.equal(((await runtime.call('bank.get', { deckId: 'd' })).deck).cards.length, 2, 'one append only');
  assert.equal(started.operationId, 'op-1');
});

test('selection append committed but the record not yet marked complete (DEFECT D-2): starting again re-authors with new card ids, the bank refuses the changed payload, the job fails though the cards are in the deck', async t => {
  const first = await library(t, stagedModel());
  const done = await first.runtime.call('job.wait', { jobId: (await first.runtime.call('generation.selection.start', first.args)).jobId, timeoutSeconds: 30 });
  assert.equal(done.status, 'complete');
  const root = await copyOf(t, first.root);
  // The window between the bank's commit and the record's last save: the receipt is in the bank, the record still says reviewed.
  await new Store(root).update(state => { const record = state.selectionJobs[0]; record.status = 'reviewed'; delete record.receipt; });
  const model = stagedModel(), runtime = await opened(t, root, model);
  const job = await statusOf(runtime);
  assert.deepEqual([job.status, job.outcome], ['failed', 'review-failed'], 'a reviewed-but-uncommitted record reads as a review failure after a restart');
  const again = await runtime.call('generation.selection.start', first.args);
  const finished = await runtime.call('job.wait', { jobId: again.jobId, timeoutSeconds: 30 });
  assert.deepEqual([finished.status, finished.outcome], ['failed', 'conflict'], 'the learner is told it failed, although the first append is in the deck');
  assert.match(finished.stage, /payload changed/, 'the bank replays a receipt only for the identical payload; the re-authored cards carry new ids');
  assert.ok(model.log.includes('author'), 'the reviewed record is cleared and written again before the receipt is looked at: model spend');
  assert.equal(done.publication.cardIds.length, 1);
  assert.equal(((await runtime.call('bank.get', { deckId: 'd' })).deck).cards.length, 2, 'no duplicate: the first append is the only one');
});
