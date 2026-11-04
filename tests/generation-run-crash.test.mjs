/* A generation run killed for real (issue #608): a process of its own dies at each window of a coverage run (tests/fixtures/generation-crash-worker.mjs), under each setting of the switches, and a new process
   finds the library. Fake models only. What must hold: nothing asks a model by itself; one job per draft; looking twice restores nothing more; 接着做 ends in the draft a run that was never cut short ends in.
   Short-world and replacement scenarios live in generation-run-crash-short.test.mjs and generation-run-crash-replace.test.mjs. */
import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import {
  CORPUS_ROUND_LIMIT, CRASH_CONCURRENCY, GOAL, MODES, assertFinished, attemptOf, clusteringModel,
  corpusWorld, die, draftOf, jobsOnDraft, recoverAndFinish, reopen, settleJob, weighing,
} from './helpers/generation-run-crash.mjs';

const world = corpusWorld();
/** What a run asks of the model when nothing cuts it short: in round 1 (a pause during the last of those calls stands at the boundary between rounds) and in all. */
const uncut = { roundOne: null, calls: 0 };
before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'study-run-uncut-')), inner = clusteringModel().complete;
  const service = new StudyService(root, { coverage: { roundLimit: CORPUS_ROUND_LIMIT } });
  service.light = weighing;
  service.complete = async (system, prompt, context = {}) => {
    uncut.calls += 1;
    if (uncut.roundOne === null && (await draftOf(service))?.editorial.coverageSpec?.rounds[1]?.status === 'running') uncut.roundOne = uncut.calls - 1;
    return inner(system, prompt, context);
  };
  for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  const { jobId } = await service.call('generate', { sourceIds: world.sources.map(source => source.id), coverageLevel: 'standard', kind: 'quiz' });
  await settleJob(service, jobId);
  assert.equal((await draftOf(service)).cards.length, GOAL);
  await service.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

for (const mode of Object.keys(MODES)) describe(`crash windows (${mode})`, { concurrency: CRASH_CONCURRENCY }, () => {
  test(`${mode}: killed before its first draft`, async t => {
    const root = await die(t, 'before-first-draft', mode, {}, undefined, uncut.roundOne), after = await reopen(t, root, mode);
    assert.equal(await draftOf(after.service), undefined, 'nothing was written');
    const jobs = (await after.service.call('snapshot')).jobs;
    if (mode !== 'restart') { assert.deepEqual(jobs, [], 'kept in memory only: the run is lost, and says nothing (a limit of this mode)'); return; }
    assert.equal(jobs.length, 1, 'kept on disk: the same job');
    assert.equal(jobs[0].contract.status, 'interrupted');
    assert.deepEqual(after.log, []);
    after.use(clusteringModel().complete);
    const done = await settleJob(after.service, attemptOf(await after.service.call('job.control', { jobId: jobs[0].id, action: 'retry' })));
    assert.equal(done.status, 'complete', done.stage);
    await assertFinished(after.service, await draftOf(after.service));
  });
  for (const name of ['first-part-saved', 'round-1-done-unsaved', 'round-2-running-saved', 'round-2-part-saved', 'last-question-saved', 'closing-unsaved']) test(`${mode}: killed at ${name}`, async t => {
    const { calls } = await recoverAndFinish(t, await die(t, name, mode, {}, undefined, uncut.roundOne), mode, { exact: !name.endsWith('-part-saved') });
    assert.ok(calls <= uncut.calls, `no more model calls than the whole run takes (${calls}, the run: ${uncut.calls})`);
    if (['last-question-saved', 'closing-unsaved'].includes(name)) assert.equal(calls, 0, 'everything was written: closing it asks no model');
  });
  // A run on the runtime cannot be paused (its pause is declared unsupported, S3-2), so a draft is left paused only on the legacy path.
  if (mode === 'legacy') test(`${mode}: killed while paused between rounds`, async t => {
    await recoverAndFinish(t, await die(t, 'paused', mode, {}, undefined, uncut.roundOne), mode);
  });
  test(`${mode}: killed after the closing write: nothing comes back`, async t => {
    const root = await die(t, 'closing-saved', mode, {}, undefined, uncut.roundOne), after = await reopen(t, root, mode), draft = await draftOf(after.service);
    await assertFinished(after.service, draft);
    assert.deepEqual((await jobsOnDraft(after.service, draft)).filter(job => job.contract.status === 'interrupted').map(job => job.id), []);
    assert.deepEqual(after.log, []);
  });
});
