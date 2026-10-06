import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAudioService, TEST_KEY, wav } from './fixtures/audio-single-characterization-process.mjs';
import { settleJob } from './helpers/wait.mjs';

// A single import that failed before the switch was turned on keeps its card; its retry after a
// restart with the switch on runs on the runtime and reuses what the legacy attempt saved.
test('a legacy failed single import is retried on the runtime once the switch is on', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-relink-')), root = join(directory, 'library'), prior = process.env.DSH_HOME;
  process.env.DSH_HOME = join(directory, 'home');
  t.after(async () => { if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior; await rm(directory, { recursive: true, force: true }); });
  const legacy = fakeAudioService(root, { responses: { translate: 'not json' } });
  await legacy.service.call('audio.settings.set', { paidKey: TEST_KEY, textProvider: 'host' });
  const path = join(directory, 'lecture.wav'); await writeFile(path, wav());
  const failed = await settleJob(legacy.service, (await legacy.service.call('audio.import', { path })).jobId);
  assert.equal(failed.status, 'failed');
  assert.ok(legacy.calls.includes('transcribe'));

  const managed = fakeAudioService(root, { managed: true });
  const card = (await managed.service.call('snapshot')).jobs.find(job => job.id === failed.id);
  assert.equal(card?.retryable, true, 'the legacy card survives the restart');
  const started = await managed.service.call('audio.retry', { jobId: failed.id });
  const done = await settleJob(managed.service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(managed.calls, ['translate', 'title'], 'the saved transcription and proofreading are reused; only the failed step and after run');
  const row = (await managed.service.call('snapshot')).jobs.find(job => job.id === started.jobId);
  assert.equal(row.contract.contractVersion, 2, 'the retry is a runtime job');
  const manifest = JSON.parse(await readFile(join(root, 'audio-batches', failed.singleId, 'manifest.json'), 'utf8'));
  assert.equal(manifest.runtimeJob.contract.jobId, row.contract.jobId, 'the same folder now holds the runtime record');
  assert.ok(!(await managed.service.call('snapshot')).jobs.some(job => job.id === failed.id), 'the legacy card is replaced by the retry');
});
