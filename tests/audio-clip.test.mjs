import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { wavPcm } from '../lib/contexts/audio/clip.js';
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
