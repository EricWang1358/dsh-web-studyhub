import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keptUploadDir } from '../lib/audio-upload.js';
import { removeAudioBatch, retireAudioBatch } from '../lib/audio-batch.js';

// A single import's manifest names the upload it keeps for a retry; that copy leaves with the job's files.
test('only a plain upload id names a kept upload folder', () => {
  const root = join(tmpdir(), 'library');
  assert.equal(keptUploadDir(root, { id: 'upload-12345678' }), join(root, 'audio-uploads', 'upload-12345678'));
  for (const ref of [undefined, null, {}, { id: 42 }, { id: '../escape-12345' }, { id: 'short' }]) assert.equal(keptUploadDir(root, ref), null, JSON.stringify(ref));
});

async function singleWithUpload(t) {
  const root = await mkdtemp(join(tmpdir(), 'kept-upload-')), id = 'single-kept-1', upload = 'upload-kept-0001';
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'audio-batches', id), { recursive: true });
  await writeFile(join(root, 'audio-batches', id, 'manifest.json'), JSON.stringify({ id, kind: 'single', upload: { id: upload, name: 'a.mp3' } }));
  await mkdir(join(root, 'audio-uploads', upload), { recursive: true });
  await writeFile(join(root, 'audio-uploads', upload, 'a.mp3'), 'audio');
  return { root, id };
}

test('retiring a single import moves its kept upload into the retired folder', async t => {
  const { root, id } = await singleWithUpload(t);
  const retired = await retireAudioBatch(root, id);
  assert.deepEqual(await readdir(join(root, 'audio-uploads')), []);
  assert.deepEqual(await readdir(join(retired, 'kept-upload')), ['a.mp3']);
});

test('removing a single import removes its kept upload; removing only its inputs keeps it', async t => {
  const { root, id } = await singleWithUpload(t);
  await removeAudioBatch(root, id, { inputsOnly: true });
  assert.deepEqual(await readdir(join(root, 'audio-uploads')), ['upload-kept-0001']);
  await removeAudioBatch(root, id);
  assert.deepEqual(await readdir(join(root, 'audio-uploads')), []);
});
