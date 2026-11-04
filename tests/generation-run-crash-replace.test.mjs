/* Restart job replacement and double-kill crash recovery (issue #608): split from generation-run-crash.test.mjs so CI shards and local workers
   run the multi-kill replacement scenarios in parallel with the window matrix and short-world suites. Fake models only. */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CRASH_CONCURRENCY, SHORT_WORLDS, assertFinished, attemptOf, clusteringModel, die, draftOf,
  jobsOnDraft, reopen, settleJob, shortScenario, shortfallFor,
} from './helpers/generation-run-crash.mjs';

describe('restart replacement and double-kill', { concurrency: CRASH_CONCURRENCY }, () => {
  test('restart: a job that was replaced does not come back when the job that replaced it ended short of closing: its retry would make a second draft', async t => {
    const root = await die(t, 'round-2-part-saved', 'restart'), life = await reopen(t, root, 'restart');
    await life.service.call('snapshot');
    const left = await draftOf(life.service), inner = clusteringModel().complete;
    let plans = 0;
    life.use(async (system, prompt, context) => { if (system.startsWith('Plan a source') && plans++ >= 1) throw new Error('503 overloaded'); return inner(system, prompt, context); });
    const reply = await life.service.call('generate', { resumeDraftId: left.id, draftVersion: left.draftVersion, coverage: { run: true } });
    await settleJob(life.service, attemptOf(reply));
    const ended = await draftOf(life.service), [job] = await jobsOnDraft(life.service, ended);
    assert.notEqual(ended.editorial.coverageRun.state, 'running', 'it ended and did not close');
    assert.equal(ended.editorial.generation.runId, job.contract.jobId, 'every save of a run names it');
    await life.service.dispose();
    const after = await reopen(t, root, 'restart');
    assert.deepEqual((await after.service.call('snapshot')).jobs.filter(item => item.contract.status === 'interrupted').map(item => item.stage), []);
    assert.equal((await after.service.call('export')).drafts.length, 1);
    assert.deepEqual(await readdir(join(root, 'generation-runs')), []);
  });

  /* Two kills. The run is closed through generate itself (a new logical job, not a retry of the job that was interrupted) and that process dies too, right after the closing write. */
  test('restart: killed before the closing write, closed by a new job, killed after it: the run is over and no job comes back', async t => {
    const root = await die(t, 'closing-unsaved', 'restart');
    await die(t, 'closing-saved', 'restart', { direct: true }, root);
    const after = await reopen(t, root, 'restart'), draft = await draftOf(after.service);
    await assertFinished(after.service, draft);
    const { jobs } = await after.service.call('snapshot');
    assert.deepEqual(jobs.filter(job => job.contract.status === 'interrupted').map(job => [job.contract.jobId, job.stage]), [], 'neither the job that closed it nor the one it replaced');
    assert.deepEqual(after.log, []);
    assert.deepEqual(await readdir(join(root, 'generation-runs')).catch(() => []), [], 'and they leave nothing on disk');
  });

  test('restart: closed by a new job with nothing killed after it: that job replaces the interrupted one on the list and on disk, and the draft says which run it is', async t => {
    const root = await die(t, 'closing-unsaved', 'restart'), after = await reopen(t, root, 'restart');
    await after.service.call('snapshot');
    const left = await draftOf(after.service), reply = await after.service.call('generate', { resumeDraftId: left.id, draftVersion: left.draftVersion, coverage: { run: true } });
    const done = await settleJob(after.service, attemptOf(reply)), draft = await draftOf(after.service);
    assert.equal(done.status, 'complete', done.stage);
    const onDraft = await jobsOnDraft(after.service, draft);
    assert.deepEqual(onDraft.map(job => job.contract.status), ['complete'], 'one job for the run');
    assert.equal(draft.editorial.generation.runId, onDraft[0].contract.jobId, 'every save of a run names it, the closing one too');
    await after.service.dispose();
    const again = await reopen(t, root, 'restart');
    assert.deepEqual((await again.service.call('snapshot')).jobs.map(job => job.contract.status), [], 'the job it replaced does not come back');
    assert.deepEqual(await readdir(join(root, 'generation-runs')), []);
  });

  test('restart: a short run killed, closed by a new job, killed after the closing write: same, and the draft still says what is missing', async t => {
    const world = SHORT_WORLDS[1], scenario = shortScenario(world), root = await die(t, 'every-section-covered', 'restart', scenario);
    await die(t, 'closing-saved-short', 'restart', { ...scenario, direct: true }, root);
    const after = await reopen(t, root, 'restart', scenario), draft = await draftOf(after.service);
    assert.deepEqual((await after.service.call('snapshot')).jobs.filter(job => job.contract.status === 'interrupted').map(job => job.contract.jobId), []);
    assert.deepEqual((await shortfallFor(after.service, draft)).action, 'continue');
    assert.deepEqual(after.log, []);
  });

  test('restart: killed before the closing write and again before the new job closed it: one job for the run, and it closes', async t => {
    const root = await die(t, 'closing-unsaved', 'restart');
    await die(t, 'closing-unsaved', 'restart', { direct: true }, root);
    const after = await reopen(t, root, 'restart'), draft = await draftOf(after.service);
    const jobs = (await after.service.call('snapshot')).jobs.filter(job => job.contract.status === 'interrupted');
    assert.equal(jobs.length, 1, jobs.map(job => job.contract.jobId).join(' | '));
    const done = await settleJob(after.service, attemptOf(await after.service.call('job.control', { jobId: jobs[0].id, action: 'retry' })));
    assert.equal(done.status, 'complete', done.stage);
    await assertFinished(after.service, await draftOf(after.service), draft);
    assert.deepEqual(after.log, []);
  });
});
