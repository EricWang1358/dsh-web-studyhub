import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { flushAudioUsage } from '../lib/audio-dashboard.js';
import { settleJob, until } from './helpers/wait.mjs';
import { fakeAudioService, TEST_KEY, wav } from './fixtures/audio-single-characterization-process.mjs';

for (const managed of [false, true]) test(`an observer wait ends without stopping a single import; durable success, no questions; pilot=${managed}`, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'audio-single-characterization-')), root = join(dir, 'library');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  const f = fakeAudioService(root, { holdTranscription: true, managed });
  const { service } = f;
  let jobId;
  t.after(async () => {
    if (jobId) { await service.call('job.cancel', { jobId }); f.release(); await settleJob(service, jobId); }
    await flushAudioUsage();
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await service.call('audio.settings.set', { paidKey: TEST_KEY, textProvider: 'host', transcribeConcurrency: 1 });
  const path = join(dir, 'lecture.wav'); await writeFile(path, wav());
  const started = await service.call('audio.import', { path, courses: ['Database course'] });
  jobId = started.jobId;
  await until(() => f.calls.includes('transcribe'), 'the transcription to remain in flight');

  // This is the real API's observation deadline, not a fixed delay in the test.
  const waiting = await service.call('job.wait', { jobId, timeoutSeconds: 1 });
  assert.equal(waiting.waitLimitSeconds, 1);
  assert.equal(waiting.status, 'running');
  assert.equal(f.signals[0].aborted, false);
  assert.deepEqual(f.calls, ['transcribe'], 'waiting cannot start another request or retry');
  const pending = await service.call('snapshot');
  const active = pending.jobs.find(job => job.id === jobId);
  assert.equal(active.contract.status, 'running');
  if (managed) { assert.notEqual(active.contract.jobId, active.singleId); assert.notEqual(active.contract.attemptId, jobId); }
  else { assert.equal(active.contract.jobId, active.singleId); assert.equal(active.contract.attemptId, jobId); }
  assert.equal(active.contract.actions.cancel.available, true);
  assert.equal(active.contract.actions.retry.available, false);
  assert.deepEqual(active.contract.result, { refs: [], completeness: null });
  assert.equal(pending.sources.length, 0);
  assert.equal(f.notifications.length, 0);

  f.release();
  const done = await settleJob(service, jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(done.stage, '已存为 1 份资料，校对修正 0 处');
  const snapshot = await service.call('snapshot');
  const completed = snapshot.jobs.find(job => job.id === jobId), contract = completed.contract;
  assert.equal(done.phase, 'done');
  assert.equal(contract.contractVersion, managed ? 2 : 1);
  assert.equal(contract.jobId, active.contract.jobId);
  assert.equal(contract.attemptId, active.contract.attemptId);
  assert.equal(contract.status, 'complete');
  assert.deepEqual(contract.result, { refs: [{ kind: 'source', id: done.sourceIds[0] }], completeness: 'complete' });
  assert.equal(contract.actions.retry.available, false);
  assert.equal(contract.actions.cancel.available, false);
  assert.equal(contract.detail.files[0].filename, 'lecture.wav');
  assert.deepEqual(f.calls, ['transcribe', 'proofread', 'translate', 'title']);
  assert.equal(done.usage.paid.requests, 1, 'the three host calls are not Gemini requests');
  assert.equal(snapshot.sources.length, 1);
  assert.deepEqual(snapshot.sources[0].courses, ['Database course']);
  assert.equal(snapshot.decks.length, 0, 'an import does not automatically generate questions');
  assert.equal(f.notifications.length, 1, 'one terminal host notification');
  assert.equal(f.notifications[0].wakeup, false);
  assert.equal(snapshot.inbox.items.filter(item => item.jobId === jobId && item.kind === 'audio-transcribe').length, 1);
  assert.equal(snapshot.inbox.items.filter(item => item.jobId === jobId && item.kind === 'audio-result').length, 1);
  assert.equal(snapshot.inbox.items.filter(item => item.jobId === jobId && item.kind === 'audio-failed').length, 0);
  const manifestText = await readFile(join(root, 'audio-batches', completed.singleId, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.kind, 'single');
  assert.equal(manifest.id, completed.singleId);
  assert.equal(manifest.job.id, jobId);
  assert.equal(manifest.job.status, 'complete');
  assert.deepEqual(manifest.job.sourceIds, done.sourceIds);
  assert.equal(manifest.input.size, wav().length);
  assert.match(manifest.input.hash, /^[a-f0-9]{64}$/);
  assert.equal(manifestText.includes(TEST_KEY), false);
  assert.equal('root' in completed, false, 'the panel does not receive the library path');
});

test('a running single import interrupted by process exit becomes an idle recovery card until explicitly retried', { timeout: 120_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'audio-single-interruption-')), root = join(dir, 'library');
  const children = new Set();
  t.after(async () => {
    await Promise.all([...children].map(child => new Promise(resolve => { child.once('close', resolve); child.kill(); })));
    await rm(dir, { recursive: true, force: true });
  });
  const child = mode => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/audio-single-characterization-process.mjs', import.meta.url)), root, mode],
      { env: { ...process.env, DSH_HOME: join(dir, 'home') }, windowsHide: true });
    children.add(proc);
    let out = '', err = '';
    proc.stdout.on('data', data => { out += data; }); proc.stderr.on('data', data => { err += data; });
    proc.on('error', reject);
    proc.on('close', code => {
      children.delete(proc);
      if (code) return reject(new Error(err || out || `fixture exited ${code}`));
      try { resolve(JSON.parse(out.trim())); } catch (error) { reject(error); }
    });
  });
  const first = await child('interrupt');
  assert.equal(first.observed.status, 'running');
  assert.deepEqual(first.calls, ['transcribe']);
  assert.ok(['queued', 'running'].includes(first.manifest.job.status), 'an active preparation record was actually durable');

  const recovered = await child('resume');
  assert.deepEqual(recovered.callsBeforeRetry, [], 'reading a recovery card does not make model calls');
  assert.equal(recovered.before.id, first.observed.id);
  assert.equal(recovered.before.status, 'failed', 'the legacy record keeps its failed status for interruption');
  assert.equal(recovered.before.retryable, true);
  assert.match(recovered.before.stage, /上次导入已中断/);
  assert.equal(recovered.before.contract.jobId, first.observed.contract.jobId);
  assert.equal(recovered.before.contract.actions.retry.available, true);
  assert.equal(recovered.before.contract.result.completeness, null);
  assert.equal(recovered.done.status, 'complete', recovered.done.stage);
  assert.notEqual(recovered.done.id, first.observed.id);
  assert.equal(recovered.observed.contract.jobId, first.observed.contract.jobId);
  assert.equal(recovered.observed.contract.attemptId, recovered.done.id);
  assert.equal(recovered.manifest.job.id, recovered.done.id);
  assert.equal(recovered.manifest.job.status, 'complete');
  assert.deepEqual(recovered.calls, ['transcribe', 'proofread', 'translate', 'title'], 'an unfinished request has no completed transcript to reuse');
  assert.equal(recovered.sources.length, 1);
  assert.equal(recovered.jobs.filter(job => job.type === 'audio-import').length, 1, 'the retry replaces the old attempt card');
});
