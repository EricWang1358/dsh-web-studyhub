import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareSingleAudioRecord } from '../lib/audio-batch.js';
import { crashRuntime } from './fixtures/runtime-s15/crash-worker.mjs';
import { durableFixture } from './fixtures/unified-runtime-durable.mjs';
import { until } from './helpers/wait.mjs';

/* Rebinding a restored Job to a fresh persistence instance (restore with bindings, as audio.retry does) while an earlier instance is still writing the same manifest
   (settlement deliveries it started, or a recovery check that is still reconciling) must wait for ALL of it, however many runs were started: the new instance starts
   from the revision the manifest really has, or the next write is a revision-conflict. */

test('two restores in a row while settlement deliveries are still being recorded, then a retry: the new Attempt starts and both settlements are recorded', async t => {
  let attempts = 0, release; const slow = new Promise(resolve => { release = resolve; });
  const f = await durableFixture(t, async () => { attempts++; if (attempts === 1) throw new Error('first attempt fails'); return { refs: [] }; },
    { notifications: [{ channel: 'inbox', idempotent: true, deliver: () => slow }], waitForDelivery: false });
  const job = await f.port.submit('persist', {});
  assert.equal((await f.port.wait(job.jobId)).status, 'failed');
  setTimeout(release, 80);
  await Promise.all([f.port.restore('persist', {}, { rebound: 1 }), f.port.restore('persist', {}, { rebound: 2 })]);
  await f.port.recover(job.jobId, 'retry');
  assert.equal((await f.port.wait(job.jobId)).status, 'complete');
  assert.equal(attempts, 2);
  await until(async () => (await f.store.load()).deliveries.every(item => item.status === 'delivered'), 'both settlements to be recorded');
});

test('a restore that finds a publication recorded but not confirmed, and a second restore while the first is still checking it, then a retry: no revision-conflict', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rebind-race-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const path = join(root, 'fixture.wav'); await writeFile(path, 'synthetic input fingerprint, not an audio-quality test');
  const record = await prepareSingleAudioRecord(root, { path });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/runtime-s15/crash-worker.mjs', import.meta.url)), root, record.id, 'after-artifact'],
    { env: { ...process.env, DSH_HOME: join(root, 'private-home') }, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = ''; child.stderr.on('data', chunk => { diagnostics += chunk; });
  assert.equal(await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }), 72, diagnostics);
  let release; const slow = new Promise(resolve => { release = resolve; });
  const runtime = crashRuntime(root, record.id, 'recover', { slowReconcile: slow });
  t.after(() => runtime.dispose());
  // The first restore is still checking the recorded publication when the second one arrives, as when a recovery and a retry overlap.
  const first = runtime.port.restore('audio-import', { singleId: record.id }, { first: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  const second = runtime.port.restore('audio-import', { singleId: record.id }, { second: true });
  setTimeout(release, 100);
  const [restored] = await Promise.all([first, second]);
  await runtime.port.recover(restored.jobId);
  const end = await runtime.port.wait(restored.jobId);
  assert.equal(end.status, 'complete', JSON.stringify(end.error));
});
