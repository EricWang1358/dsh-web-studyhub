import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
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

test('continuous speech becomes bounded final segments before recording stops, including the short tail', async t => {
  const modelDir = await modelFolder(t);
  const socket = new LoopbackWebSocket('local://live', { modelDir, enginePath: FAKE_ENGINE });
  t.after(() => socket.close());
  const { seen, done } = record(socket);
  await waitFor(() => socket.readyState === 1, 'open');
  socket.send(JSON.stringify(audioMessage(pcm(32))));
  await waitFor(() => seen.filter(item => item.serverContent?.inputTranscription).length >= 2, 'bounded finals during continuous speech', 1000);
  socket.send(JSON.stringify(endMessage()));
  assert.equal((await done).code, 1000);
  const finals = seen.filter(item => item.serverContent?.inputTranscription).map(item => item.serverContent.inputTranscription.text);
  assert.equal(finals.length, 3);
  const tenths = finals.map(text => Number(/句（(\d+)）/.exec(text)[1]));
  assert.ok(tenths.every(length => length <= 151), 'a segment stays near the 15-second target');
  assert.equal(tenths.reduce((sum, length) => sum + length, 0), 320, 'forced segmentation keeps the entire input');
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

test('stopping a local class drains queued audio before ending and saving its final transcript', async t => {
  const modelDir = await modelFolder(t);
  const enginePath = join(modelDir, 'slow-engine.cjs');
  const engine = await readFile(FAKE_ENGINE, 'utf8');
  await writeFile(enginePath, engine.replace('decode() {}', 'decode() { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 90); }'));
  let saved;
  const session = new LiveSession({ title: 'Backlogged local class', tiers: new LocalTiers(),
    WebSocketImpl: loopbackFactory({ modelDir, enginePath }), translate: null, save: async snapshot => { saved = snapshot; },
    timing: { stopWaitMs: 20 } });
  await session.start();
  const socket = session.conn.ws;
  for (let i = 0; i < 40; i++) {
    session.push(pcm(0.6));
    session.push(pcm(0.6, false));
  }
  const firstStop = session.stop();
  await session.stop();
  assert.equal(session.status, 'ended', 'concurrent stop callers wait for the same completed transcript');
  await firstStop;
  assert.equal(session.snapshot().total, 40, 'all accepted utterances must finish before stop returns');
  assert.equal(saved.segments.length, 40, 'the final save includes the queued tail');
  assert.equal(socket.acceptedSamples, 48 * 16000, 'transferring a buffer must not erase the input counter');
  assert.equal(socket.processedSamples, socket.acceptedSamples);
  const revision = session.snapshot().revision;
  await sleep(50);
  assert.equal(session.snapshot().revision, revision, 'an ended class cannot acquire delayed transcript segments');
});

function controlledWorker() {
  const worker = new EventEmitter();
  worker.sent = [];
  worker.postMessage = message => worker.sent.push(message);
  worker.terminate = async () => { worker.terminated = true; };
  queueMicrotask(() => worker.emit('message', { type: 'ready' }));
  return worker;
}

test('local drain waits for progress and sends only one end marker', async () => {
  const worker = controlledWorker();
  const socket = new LoopbackWebSocket('local://live', { createWorker: () => worker, timing: { drainIdleMs: 100 } });
  await waitFor(() => socket.readyState === 1, 'open');
  for (let i = 0; i < 3; i++) socket.send(JSON.stringify(audioMessage(pcm(0.1))));
  const drained = socket.drain();
  socket.drain();
  socket.send(JSON.stringify(audioMessage(pcm(0.1))));
  for (let i = 1; i <= 3; i++) {
    await sleep(50);
    worker.emit('message', { type: 'progress', samples: i * 1600 });
  }
  worker.emit('message', { type: 'done' });
  await drained;
  assert.equal(worker.sent.filter(message => message.type === 'end').length, 1);
  assert.equal(worker.sent.filter(message => message.type === 'audio').length, 3, 'no new audio enters a draining worker');
  assert.equal(socket.readyState, 3);
});

test('a stalled local drain ends with an explicit incomplete-transcript warning', async () => {
  const worker = controlledWorker();
  const session = new LiveSession({ title: 'Stalled local class', tiers: new LocalTiers(),
    WebSocketImpl: loopbackFactory({ createWorker: () => worker, timing: { drainIdleMs: 40 } }), translate: null, save: async () => {} });
  await session.start();
  session.push(pcm(1));
  await Promise.all([session.stop(), sleep(100)]);
  assert.equal(session.status, 'ended');
  assert.match(session.snapshot().message, /收尾.*超时/);
  assert.match(session.snapshot().message, /1\.0/);
  assert.equal(worker.terminated, true);
});

test('a stalled final decode warns about the unfinished tail even when the input queue is empty', async () => {
  const worker = controlledWorker();
  const socket = new LoopbackWebSocket('local://live', { createWorker: () => worker, timing: { drainIdleMs: 30 } });
  await waitFor(() => socket.readyState === 1, 'open');
  socket.send(JSON.stringify(audioMessage(pcm(1))));
  worker.emit('message', { type: 'progress', samples: 16000 });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(socket.drain(), /0\.0.*尾段也可能尚未定稿/); }
  finally { clearTimeout(keepAlive); }
});
