import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { transcribeClip, transcribeLocally, wavPcm } from '../lib/contexts/audio/clip.js';
import { createUploadRegistry } from '../lib/audio-upload.js';
import { wavBytes, VOICE_MAX_SECONDS } from '../ui/voice/wav.js';

/* A voice answer is transcribed once (#1031): audio.clip.transcribe reads the uploaded clip, asks one tier (a configured cloud provider, else the
   local live engine), and deletes the raw audio on every path, success or failure. No real provider: a fake fetch and the fake sherpa engine. */

const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/live-local/fake-sherpa.cjs', import.meta.url));
const KEY = 'AIzaClipTestKey_00000000000000001';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const square = (seconds) => Int16Array.from({ length: Math.round(seconds * 16000) }, (_, i) => (i % 32 < 16 ? 8000 : -8000));

async function fixture(t, { fetch, key = KEY, engine = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'audio-clip-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  let modelDir;
  if (engine) {
    modelDir = join(dir, 'model');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(modelDir, { recursive: true }));
    for (const name of ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx']) await writeFile(join(modelDir, name), 'fake');
  }
  const root = join(dir, 'library');
  const service = new StudyService(root, { fetch: fetch || (async () => { throw new Error('no provider in this test'); }),
    liveLocal: { engine: engine ? { enginePath: FAKE_ENGINE, modelDir } : null } });
  t.after(async () => {
    await service.dispose?.();
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  if (key) await service.call('audio.settings.set', { paidKey: key });
  const call = (action, args) => service.call(action, args);
  const upload = async (bytes, { finish = true } = {}) => {
    const { uploadId } = await call('audio.upload.start', { name: 'voice-answer.wav', size: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024)
      await call('audio.upload.chunk', { uploadId, offset, data: Buffer.from(bytes.subarray(offset, offset + 1024 * 1024)).toString('base64') });
    if (finish) await call('audio.upload.finish', { uploadId });
    return uploadId;
  };
  const folders = () => readdir(join(root, 'audio-uploads')).catch(() => []);
  return { call, upload, folders };
}

test('the WAV of the recorder is 16 kHz mono PCM16, and the server reads its samples back byte for byte', () => {
  const samples = Int16Array.from({ length: 16000 }, (_, i) => Math.round(Math.sin(i / 10) * 8000));
  const wav = Buffer.from(wavBytes([samples]));
  const read = wavPcm(wav);
  assert.equal(read.rate, 16000);
  assert.equal(read.seconds, 1);
  assert.ok(Buffer.from(samples.buffer).equals(read.pcm));
  assert.equal(wavPcm(Buffer.from('not a wav file at all, just text')), null);
});

test('a cloud tier transcribes the clip once, and the raw audio is gone afterwards', async (t) => {
  let asked = 0;
  const h = await fixture(t, { fetch: async (url) => {
    if (String(url).includes('transcribe:') || String(url).includes('generateContent')) { asked++; return json({ candidates: [{ content: { parts: [{ text: '幂等和指数退避' }] } }], usageMetadata: {} }); }
    return json({});
  } });
  const id = await h.upload(wavBytes([square(1.5)]));
  const result = await h.call('audio.clip.transcribe', { uploadId: id });
  assert.equal(result.text, '幂等和指数退避');
  assert.equal(asked, 1);
  assert.deepEqual(await h.folders(), [], 'the clip is deleted after it was read');
  await assert.rejects(h.call('audio.clip.transcribe', { uploadId: id }), /失效/, 'a clip is transcribed once');
});

test('a failing provider still deletes the raw audio', async (t) => {
  const h = await fixture(t, { fetch: async () => json({ error: { message: 'upstream STT failure' } }, 400) });
  const id = await h.upload(wavBytes([square(1)]));
  await assert.rejects(h.call('audio.clip.transcribe', { uploadId: id }));
  assert.deepEqual(await h.folders(), []);
});

test('no provider and no local engine: a setup error with its own code (no message matching), and the clip is deleted', async (t) => {
  const h = await fixture(t, { key: null });
  const id = await h.upload(wavBytes([square(1)]));
  await assert.rejects(h.call('audio.clip.transcribe', { uploadId: id }), (error) => error.code === 'AUDIO_SETUP');
  assert.deepEqual(await h.folders(), []);
});

test('an upload that never finished is cancelled, not left behind, when it is asked to be transcribed', async (t) => {
  const h = await fixture(t);
  const bytes = wavBytes([square(1)]);
  const { uploadId } = await h.call('audio.upload.start', { name: 'voice-answer.wav', size: bytes.length });
  await assert.rejects(h.call('audio.clip.transcribe', { uploadId }), /没有传完/);
  assert.deepEqual(await h.folders(), []);
});

test('a clip longer than the voice limit is refused and deleted', async (t) => {
  const h = await fixture(t);
  const id = await h.upload(wavBytes([new Int16Array((VOICE_MAX_SECONDS + 10) * 16000)]));
  await assert.rejects(h.call('audio.clip.transcribe', { uploadId: id }), new RegExp(`${VOICE_MAX_SECONDS} 秒`));
  assert.deepEqual(await h.folders(), []);
});

test('without a cloud key, the installed local live engine transcribes the clip on this computer', async (t) => {
  const h = await fixture(t, { key: null, engine: true });
  const id = await h.upload(wavBytes([square(1), new Int16Array(9600), square(0.5)]));
  const result = await h.call('audio.clip.transcribe', { uploadId: id });
  assert.equal(result.text, '句（10）句（5）', 'every final of the local engine, in order, the open segment flushed');
  assert.equal(result.tier, 'local');
  assert.deepEqual(await h.folders(), []);
});

test('只用付费密钥 is honoured: the default of the audio settings or the request, never a free key when it is on', async (t) => {
  const FREE = 'AIzaClipTestFreeKey_000000000000001';
  let asked = 0;
  const h = await fixture(t, { key: null, fetch: async () => { asked++; return json({ candidates: [{ content: { parts: [{ text: '免费转写' }] } }], usageMetadata: {} }); } });
  await h.call('audio.settings.set', { freeKey: FREE, paidOnlyByDefault: true });
  const first = await h.upload(wavBytes([square(1)]));
  await assert.rejects(h.call('audio.clip.transcribe', { uploadId: first }), (error) => error.code === 'AUDIO_SETUP', 'the default is paid only and there is no paid key');
  assert.equal(asked, 0, 'the free key was not used');
  assert.deepEqual(await h.folders(), []);
  await h.call('audio.settings.set', { paidOnlyByDefault: false });
  const second = await h.upload(wavBytes([square(1)]));
  await assert.rejects(h.call('audio.clip.transcribe', { uploadId: second, paidOnly: true }), (error) => error.code === 'AUDIO_SETUP', 'the request asks for paid only');
  assert.equal(asked, 0, 'the free key was not used');
  const third = await h.upload(wavBytes([square(1)]));
  assert.equal((await h.call('audio.clip.transcribe', { uploadId: third })).text, '免费转写', 'with paid-only off the free key transcribes');
  assert.equal(asked, 1);
});

test('a clip whose declared size is over the limit is refused before it is read, and a WAV with no sensible length is refused as a format', async (t) => {
  let read = false;
  const removed = [];
  const uploads = { claimUpload: () => ({ path: '/never/read.wav', size: 200 * 32000 }), cancelUpload: async () => {}, dropUnclaimedUpload: async () => {},
    discardUpload: async (upload) => { removed.push(upload.path); } };
  await assert.rejects(transcribeClip({ root: '/r', uploadId: 'u', uploads, settings: {}, local: async () => { read = true; return null; } }), /90 秒/);
  assert.equal(read, false, 'no tier was asked');
  assert.deepEqual(removed, ['/never/read.wav'], 'the clip is deleted all the same');
  const h = await fixture(t);
  const silentRate = Buffer.from(wavBytes([square(1)], 0));
  const id = await h.upload(silentRate);
  await assert.rejects(h.call('audio.clip.transcribe', { uploadId: id }), /格式/);
  assert.deepEqual(await h.folders(), []);
});

test('the local engine that never answers after the clip is sent gives up instead of hanging the answer', async () => {
  class Silent {
    constructor() { this.listeners = {}; setTimeout(() => this.emit('message', { data: JSON.stringify({ setupComplete: {} }) }), 5); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, event) { for (const fn of this.listeners[type] || []) fn(event); }
    send() {}
    close() { this.emit('close', { code: 1006, reason: '' }); }
  }
  const started = Date.now();
  await assert.rejects(transcribeLocally(Silent, Buffer.alloc(3200), { replyTimeoutMs: 50 }), /没有按时/);
  assert.ok(Date.now() - started < 5000);
});

test('a clip another import has already claimed is not cancelled under it; an unfinished one is', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audio-clip-claim-'));
  try {
    const registry = createUploadRegistry();
    const { uploadId } = await registry.startUpload(dir, { name: 'a.wav', size: 4 });
    await registry.appendUpload(dir, { uploadId, offset: 0, data: Buffer.from('abcd').toString('base64') });
    registry.finishUpload(dir, uploadId);
    registry.claimUpload(dir, uploadId);
    const settings = {}, local = async () => null;
    await assert.rejects(transcribeClip({ root: dir, uploadId, uploads: registry, settings, local }), /已经在导入/);
    assert.deepEqual(await readdir(join(dir, 'audio-uploads')), [uploadId], 'the claimed upload is still there');
    const open = await registry.startUpload(dir, { name: 'b.wav', size: 4 });
    await assert.rejects(transcribeClip({ root: dir, uploadId: open.uploadId, uploads: registry, settings, local }), /没有传完/);
    assert.deepEqual(await readdir(join(dir, 'audio-uploads')), [uploadId], 'the unfinished one is gone');
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
