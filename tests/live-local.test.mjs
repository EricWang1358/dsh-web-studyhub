import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveSession } from '../lib/live.js';
import { LocalTiers, LoopbackWebSocket, loopbackFactory } from '../lib/live-local.js';
import { audioMessage, endMessage } from '../lib/live-protocol.js';
import { quickParts } from '../lib/live-save.js';

/* The local live engine (lib/live-local.js + lib/live-local-worker.mjs) with a fake sherpa-onnx (tests/fixtures/live-local/fake-sherpa.cjs) in a
   real worker thread: the loopback socket speaks the Gemini Live wire format, so LiveSession is driven exactly as with Google. No model, no network. */

const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/live-local/fake-sherpa.cjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function modelFolder(t) {
  const dir = await mkdtemp(join(tmpdir(), 'live-local-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx']) await writeFile(join(dir, name), 'fake');
  return dir;
}
/** 16 kHz 16-bit mono PCM: `seconds` of a loud square wave, or of silence. */
const pcm = (seconds, loud = true) => {
  const samples = Math.round(seconds * 16000), buffer = Buffer.alloc(samples * 2);
  if (loud) for (let i = 0; i < samples; i++) buffer.writeInt16LE(i % 32 < 16 ? 8000 : -8000, i * 2);
  return buffer;
};
/** Every message a socket dispatches, parsed, in order; resolves `closed` with the close event. */
function record(socket) {
  const seen = [];
  let closed;
  const done = new Promise(resolve => { closed = resolve; });
  socket.addEventListener('open', () => seen.push({ open: true }));
  socket.addEventListener('message', event => seen.push(JSON.parse(event.data)));
  socket.addEventListener('error', () => seen.push({ error: true }));
  socket.addEventListener('close', event => { seen.push({ close: event.code, reason: event.reason }); closed(event); });
  return { seen, done };
}
const waitFor = async (check, what, ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return; await sleep(20); }
  throw new Error(`timed out waiting for ${what}`);
};

test('the loopback socket opens like the Live API: CONNECTING, then open and setupComplete once the recognizer thread is warm', async t => {
  const modelDir = await modelFolder(t);
  const socket = new LoopbackWebSocket('local://live', { modelDir, enginePath: FAKE_ENGINE });
  assert.equal(socket.readyState, 0);
  const { seen, done } = record(socket);
  await waitFor(() => socket.readyState === 1, 'open');
  assert.deepEqual(seen.slice(0, 2), [{ open: true }, { setupComplete: true }]);
  socket.close();
  const event = await done;
  assert.equal(event.code, 1000);
  assert.equal(socket.readyState, 3);
});

test('audio frames in, finals with turnComplete out; audioStreamEnd flushes the last words and closes cleanly (1000)', async t => {
  const modelDir = await modelFolder(t);
  const socket = new LoopbackWebSocket('local://live', { modelDir, enginePath: FAKE_ENGINE });
  const { seen, done } = record(socket);
  await waitFor(() => socket.readyState === 1, 'open');
  // 1 s of speech, 0.6 s of silence (a segment ends), 0.5 s of speech left open until the end of the stream.
  for (const chunk of [pcm(1), pcm(0.6, false), pcm(0.5)]) socket.send(JSON.stringify(audioMessage(chunk)));
  await waitFor(() => seen.some(item => item.serverContent?.inputTranscription), 'the first final');
  socket.send(JSON.stringify(endMessage()));
  const event = await done;
  assert.equal(event.code, 1000);
  const finals = seen.filter(item => item.serverContent?.inputTranscription).map(item => item.serverContent.inputTranscription.text);
  assert.deepEqual(finals, ['句（10）', '句（5）'], 'the open segment is flushed at the end of the stream');
  const turns = seen.filter(item => item.serverContent?.turnComplete).length;
  assert.equal(turns, 2, 'every final ends a turn, so LiveSession closes the sentence');
});

test('partials arrive while someone is still speaking, as interimInputTranscription', async t => {
  const modelDir = await modelFolder(t);
  const socket = new LoopbackWebSocket('local://live', { modelDir, enginePath: FAKE_ENGINE, timing: { interimEveryMs: 50 } });
  const { seen } = record(socket);
  await waitFor(() => socket.readyState === 1, 'open');
  socket.send(JSON.stringify(audioMessage(pcm(1.2))));
  await waitFor(() => seen.some(item => item.serverContent?.interimInputTranscription), 'a partial');
  const partial = seen.find(item => item.serverContent?.interimInputTranscription).serverContent.interimInputTranscription.text;
  assert.match(partial, /^句（\d+）$/);
  socket.close();
});

test('an engine that cannot load fails the connection (error, then close 1011 with the reason): nothing pretends to transcribe', async t => {
  const modelDir = await modelFolder(t);
  const missing = join(modelDir, 'no-such-engine');
  const socket = new LoopbackWebSocket('local://live', { modelDir, enginePath: missing });
  const { seen, done } = record(socket);
  const event = await done;
  assert.equal(event.code, 1011);
  assert.match(event.reason, /本地识别引擎/);
  assert.ok(seen.some(item => item.error));
  assert.equal(seen.some(item => item.open), false);
});

test('a frame sent before the thread is ready, or after close, is dropped like a socket that is not open', async t => {
  const modelDir = await modelFolder(t);
  const socket = new LoopbackWebSocket('local://live', { modelDir, enginePath: FAKE_ENGINE });
  socket.send(JSON.stringify(audioMessage(pcm(0.2))));
  socket.send('not json');
  const { done } = record(socket);
  await waitFor(() => socket.readyState === 1, 'open');
  socket.close();
  socket.send(JSON.stringify(audioMessage(pcm(0.2))));
  assert.equal((await done).code, 1000);
});

test('LiveSession over the loopback: the same session, panel and saved class; the local tier never rotates and is not billed', async t => {
  const modelDir = await modelFolder(t);
  let saves = 0;
  const session = new LiveSession({ title: 'Local', tiers: new LocalTiers(), WebSocketImpl: loopbackFactory({ modelDir, enginePath: FAKE_ENGINE }),
    translate: null, save: async () => { saves += 1; }, timing: { idleFlushMs: 50, stopWaitMs: 4000, saveDelayMs: 10 } });
  await session.start();
  assert.equal(session.status, 'live');
  assert.equal(session.snapshot().tier, 'local');
  assert.equal(session.rotateTimer, undefined, 'no 10-minute hand-over for the local engine');
  for (const chunk of [pcm(1), pcm(0.6, false), pcm(0.8)]) { session.push(chunk); await sleep(20); }
  await session.stop();
  const snap = session.snapshot(0);
  assert.equal(snap.status, 'ended');
  assert.deepEqual(snap.segments.map(segment => segment.en), ['句（10）', '句（8）']);
  assert.ok(snap.segments.every(segment => segment.zhState === 'none'), 'no translator: no 正在翻译… that never ends');
  assert.deepEqual(snap.usage, { freeSeconds: 0, paidSeconds: 0, estimatedPaidUsd: 0 });
  assert.deepEqual(snap.warnings, []);
  assert.ok(saves >= 1);
});

test('with a translator, a local class still skips sentences that are already Chinese and translates the others', async t => {
  const modelDir = await modelFolder(t);
  const asked = [];
  const translate = async ({ items }) => { asked.push(...items.map(item => item.en)); return new Map(items.map(item => [item.n, `译：${item.en}`])); };
  const session = new LiveSession({ title: 'Local', tiers: new LocalTiers(), WebSocketImpl: loopbackFactory({ modelDir, enginePath: FAKE_ENGINE }),
    translate, save: async () => {}, timing: { idleFlushMs: 50, stopWaitMs: 4000, saveDelayMs: 10 } });
  await session.start();
  session.flushBuffer();
  session.addPiece('This sentence is English and long enough.');
  session.addPiece('这一句已经是中文了，不用再翻译一遍。');
  session.flushBuffer();
  await session.stop();
  await session.settled();
  assert.deepEqual(asked, ['This sentence is English and long enough.']);
  const [english, chinese] = session.segments;
  assert.equal(english.zhState, 'done');
  assert.equal(chinese.zhState, 'none');
});

test('saving a local class: a sentence the engine wrote in Chinese fills the Chinese column itself; an untranslated English one says so', () => {
  const [part] = quickParts([{ id: 1, t: 0, en: '今天讲数据库的分区和索引。', zh: '', zhState: 'none' }, { id: 2, t: 900, en: 'Partitions skip data.', zh: '', zhState: 'none' }]);
  assert.equal(part.chinese[0], '今天讲数据库的分区和索引。（这句没有译文）');
});
