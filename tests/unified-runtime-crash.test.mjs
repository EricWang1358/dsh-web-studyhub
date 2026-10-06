import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareSingleAudioRecord, readAudioBatch } from '../lib/audio-batch.js';
import { usageLedger } from '../lib/model-usage.js';
import { crashRuntime } from './fixtures/runtime-s15/crash-worker.mjs';

for (const [window, expectedCode] of [['before-artifact', 71], ['after-artifact', 72], ['after-checkpoint', 73]]) test(`actual process crash ${window} reconciles one source, one retained accounting entry and stable settled events`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.wav'); await writeFile(path, 'synthetic input fingerprint, not an audio-quality test');
  const record = await prepareSingleAudioRecord(root, { path });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/runtime-s15/crash-worker.mjs', import.meta.url)), root, record.id, window], { env: { ...process.env, DSH_HOME: join(root, 'private-home') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = ''; child.stderr.on('data', chunk => { diagnostics += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(code, expectedCode, diagnostics);
  const saved = await readAudioBatch(root, record.id);
  assert.equal(saved.runtimeJob.contract.status, 'running');
  const runtime = crashRuntime(root, record.id);
  try {
    const restored = await runtime.port.restore('audio-import', { singleId: record.id });
    assert.equal(restored.status, 'interrupted');
    assert.equal(restored.actions.retry.available, true, JSON.stringify(restored.actions.retry));
    const again = await runtime.port.restore('audio-import', { singleId: record.id }); assert.equal(again.events.length, 1);
    await runtime.port.recover(restored.jobId);
    const end = await runtime.port.wait(restored.jobId);
    assert.equal(end.status, 'complete', JSON.stringify(end.error));
    assert.equal(end.jobId, restored.jobId); assert.notEqual(end.attemptId, restored.attemptId);
    assert.notEqual(end.runtime.legacyId, restored.runtime.legacyId);
    assert.equal((await runtime.library.read()).sources.filter(source => source.id === 'audio-fixture-source').length, 1);
    assert.equal((await readFile(join(root, 'fake-model-calls.jsonl'), 'utf8')).trim().split('\n').length, 1);
    assert.equal((await usageLedger(root).summary()).total.calls, 1);
    assert.equal(end.events.length, 2, 'one interruption plus one new Attempt completion, no repeated restore event');
    const final = await readAudioBatch(root, record.id); assert.equal(final.runtimeJob.contract.status, 'complete');
  } finally { await runtime.dispose(); }
});
test('a process lost during a dispatched request leaves uncertainty and refuses provider resend', async t => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-unknown-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'unknown.wav'); await writeFile(path, 'synthetic input'); const record = await prepareSingleAudioRecord(root, { path });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/runtime-s15/crash-worker.mjs', import.meta.url)), root, record.id, 'during-request'], { env: { ...process.env, DSH_HOME: join(root, 'private-home') }, stdio: 'ignore' });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); assert.equal(code, 74);
  const runtime = crashRuntime(root, record.id);
  try {
    const job = await runtime.port.restore('audio-import', { singleId: record.id });
    assert.equal(job.status, 'interrupted'); assert.equal(job.actions.retry.available, false); assert.equal(job.actions.retry.reason.code, 'remote-result-unknown');
    await assert.rejects(runtime.port.recover(job.jobId), { code: 'remote-result-unknown' });
    const disk = await readAudioBatch(root, record.id);
    assert.equal(disk.runtimeJob.requestIntents[0].status, 'pending'); assert.equal(job.calls.length, 0, 'an intent alone cannot fabricate an observed Call');
    assert.equal((await readFile(join(root, 'fake-model-calls.jsonl'), 'utf8')).trim().split('\n').length, 1);
  } finally { await runtime.dispose(); }
});
