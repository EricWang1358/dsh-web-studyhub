import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveRegistry } from '../lib/live.js';
import { createUploadRegistry } from '../lib/audio-upload.js';
import { createPanelBridge } from '../lib/panel-bridge.js';

test('live registries isolate in-flight recordings on the same library root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-live-owners-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = createLiveRegistry(), second = createLiveRegistry();
  const recording = { id: 'recording-123', active: true, title: 'First owner', segments: [],
    startedAt: '2026-10-01T00:00:00Z', elapsedMs: 0 };
  first.register(root, recording);
  assert.equal(first.activeSession(root), recording);
  assert.equal(second.activeSession(root), undefined);
  assert.equal(second.registered(root, recording.id), undefined);
  assert.deepEqual(await second.listSaved(root), []);
  assert.equal((await first.listSaved(root))[0].title, 'First owner');
  second.unregister(root, recording.id);
  assert.equal(first.registered(root, recording.id), recording);
  first.unregister(root, recording.id);
  assert.equal(first.activeSession(root), undefined);
});

test('panel bridges isolate intents, observations, sequence counters and notifications', () => {
  const first = createPanelBridge(), second = createPanelBridge();
  const notices = [];
  first.registerPanelNotifier('session', notice => notices.push(notice));
  first.queuePanelIntent('session', { type: 'run', runId: 'first-run' }, 100);
  assert.equal(second.takePanelIntent('session', 101), null);
  assert.equal(first.takePanelIntent('session', 101).runId, 'first-run');
  first.setPanelVisible('session', 'main', { id: 'first-run', card: { id: 'first-card' } }, 100, 8);
  second.setPanelVisible('session', 'main', { id: 'second-run', card: { id: 'second-card' } }, 100, 1);
  assert.equal(first.panelObservation('session').cardId, 'first-card');
  assert.equal(second.panelObservation('session').cardId, 'second-card');
  first.setPanelVisible('session', 'main', { id: 'stale-run', card: { id: 'stale-card' } }, 101, 7);
  assert.equal(first.panelObservation('session').cardId, 'first-card');
  assert.equal(notices.length, 1);
  second.clear();
  assert.equal(second.hasPanelVisibility('session'), false);
  assert.equal(first.hasPanelVisibility('session'), true);
});

test('upload registries cannot claim or cancel another runtime’s upload at the same root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-upload-owners-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = createUploadRegistry(), second = createUploadRegistry();
  const { uploadId } = await first.startUpload(root, { name: 'lecture.wav', size: 4 });
  await assert.rejects(second.appendUpload(root, { uploadId, offset: 0, data: 'YQ==' }), /上传已经失效/);
  assert.deepEqual(await second.cancelUpload(root, uploadId), { cancelled: false });
  await first.appendUpload(root, { uploadId, offset: 0, data: Buffer.from('data').toString('base64') });
  assert.equal(first.finishUpload(root, uploadId).size, 4);
  assert.throws(() => second.claimUpload(root, uploadId), /上传已经失效/);
  const claimed = first.claimUpload(root, uploadId);
  assert.throws(() => first.claimUpload(root, uploadId), /已经在导入/);
  assert.throws(() => second.releaseUpload(claimed), /another runtime/);
  await assert.rejects(second.discardUpload(claimed), /another runtime/);
  first.releaseUpload(claimed);
  assert.equal(first.claimUpload(root, uploadId), claimed);
  await first.discardUpload(claimed);
  assert.throws(() => first.claimUpload(root, uploadId), /上传已经失效/);
});

test('persisted upload adoption reconstructs safe paths while preserving handle ownership', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-upload-adoption-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = createUploadRegistry(), resumed = createUploadRegistry();
  const { uploadId } = await first.startUpload(root, { name: 'saved.wav', size: 4 });
  await first.appendUpload(root, { uploadId, offset: 0, data: Buffer.from('data').toString('base64') });
  first.finishUpload(root, uploadId);
  const original = first.claimUpload(root, uploadId);
  await assert.rejects(resumed.adoptStoredUpload(root, { id: '../escaped', name: 'saved.wav' }), /Invalid stored upload/);
  await assert.rejects(resumed.adoptStoredUpload(root, { id: uploadId, name: '../saved.wav' }), /Invalid stored upload/);
  const adopted = await resumed.adoptStoredUpload(root, { id: uploadId, name: 'saved.wav', path: 'untrusted/path', dir: 'untrusted/dir' });
  assert.notEqual(adopted, original);
  assert.equal(adopted.path, join(root, 'audio-uploads', uploadId, 'saved.wav'));
  assert.equal(adopted.received, 4);
  assert.equal(await resumed.adoptStoredUpload(root, { id: uploadId, name: 'saved.wav' }), adopted);
  assert.throws(() => resumed.releaseUpload(original), /another runtime/);
  await assert.rejects(resumed.discardUpload(original), /another runtime/);
  await resumed.discardUpload(adopted);
});
