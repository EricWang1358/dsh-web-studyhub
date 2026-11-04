import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIO_DEFAULTS, LIVE_PAUSE, livePauseOf, publicAudioSettings, readAudioSettings, saveAudioSettings } from '../lib/audio-settings.js';
import { DEFAULT_TIMING, LiveSession, listSaved } from '../lib/live.js';
import { GeminiTiers } from '../lib/gemini.js';
import { StudyService } from '../lib/service.js';
import { localizeAppMessage } from '../lib/application-messages.js';

/* 断句停顿 (liveSentencePause): how long a pause ends a sentence in 课堂实录. One saved choice, one table (LIVE_PAUSE) that maps it to both engines:
   Gemini's idle flush (lib/live.js) and the local engine's VAD silence (lib/live-local-worker.mjs). */

const FREE = 'AIzaLiveFreeKey_00000000000000001';
const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/live-local/fake-sherpa.cjs', import.meta.url));
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('condition not met in time');
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'live-pause-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return dir;
}

test('the table: standard is exactly today\'s values, short is shorter, long is longer', () => {
  assert.deepEqual(Object.keys(LIVE_PAUSE), ['short', 'standard', 'long']);
  assert.equal(LIVE_PAUSE.standard.idleFlushMs, DEFAULT_TIMING.idleFlushMs);
  assert.equal(LIVE_PAUSE.standard.idleFlushMs, 1500);
  assert.equal(LIVE_PAUSE.standard.minSilenceSec, 0.5);
  assert.deepEqual(LIVE_PAUSE.short, { idleFlushMs: 700, minSilenceSec: 0.25 });
  assert.deepEqual(LIVE_PAUSE.long, { idleFlushMs: 2500, minSilenceSec: 0.8 });
  assert.ok(Object.isFrozen(LIVE_PAUSE));
  // A missing or unknown saved value means standard, never a crash.
  assert.equal(livePauseOf({ liveSentencePause: 'short' }), LIVE_PAUSE.short);
  assert.equal(livePauseOf({}), LIVE_PAUSE.standard);
  assert.equal(livePauseOf({ liveSentencePause: 'bogus' }), LIVE_PAUSE.standard);
});

test('liveSentencePause is a saved setting: standard by default, short or long on request, anything else refused', async t => {
  await withHome(t);
  assert.equal(AUDIO_DEFAULTS.liveSentencePause, 'standard');
  assert.equal((await readAudioSettings()).liveSentencePause, 'standard');
  assert.equal((await saveAudioSettings({ liveSentencePause: 'short' })).liveSentencePause, 'short');
  assert.equal((await readAudioSettings()).liveSentencePause, 'short', 'it survives a re-read from the file');
  assert.equal((await saveAudioSettings({ liveProvider: 'local' })).liveSentencePause, 'short', 'a patch without it leaves it alone');
  assert.equal((await saveAudioSettings({ liveSentencePause: 'long' })).liveSentencePause, 'long');
  await assert.rejects(saveAudioSettings({ liveSentencePause: 'tiny' }), /liveSentencePause/);
  const refusal = await saveAudioSettings({ liveSentencePause: 'tiny' }).catch(error => error.message);
  assert.equal(localizeAppMessage(refusal, 'en'), 'liveSentencePause must be short, standard or long', 'the refusal has an English reading');
  assert.equal((await readAudioSettings()).liveSentencePause, 'long', 'a refused patch changes nothing');
  assert.equal(publicAudioSettings(await readAudioSettings()).liveSentencePause, 'long', 'the panel sees it');
});

/* ---- the Gemini engine: LiveSession's idle flush ---- */

function socketClass() {
  return class FakeSocket {
    static instances = [];
    constructor(url) {
      this.url = url; this.readyState = 0; this.sent = []; this.listeners = {};
      FakeSocket.instances.push(this);
      setTimeout(() => {
        this.onSend = message => { if (message.setup) this.say({ setupComplete: {} }); };
        this.readyState = 1; this.emit('open');
      }, 0);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
    send(data) { const message = JSON.parse(data); this.sent.push(message); this.onSend?.(message); }
    close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.emit('close', { code, reason }), 0); }
    say(message) { this.emit('message', { data: JSON.stringify(message) }); }
  };
}

test('LiveSession closes a sentence after idleFlushMs of no new text: 700 ms for 短, and not before', async () => {
  const Socket = socketClass();
  const live = new LiveSession({ title: 'Pause', tiers: new GeminiTiers({ keys: { free: FREE } }), WebSocketImpl: Socket, translate: null,
    timing: { ...LIVE_PAUSE.short, rotateAfterMs: 60_000, saveDelayMs: 10, readyGraceMs: 200 }, save: async () => {} });
  assert.equal(live.timing.idleFlushMs, 700);
  await live.start();
  // No sentence ending and fewer than 500 characters: only the pause can close it.
  const at = Date.now();
  Socket.instances[0].say({ serverContent: { inputTranscription: { text: 'so the next thing we look at is partitioning and' } } });
  await sleep(450);
  assert.equal(live.segments.length, 0, 'still the in-progress line after 450 ms');
  await until(() => live.segments.length === 1);
  const waited = Date.now() - at;
  assert.ok(waited >= 650 && waited < 1400, `closed after about 700 ms, not ${waited}`);
  await live.stop();
});

/* ---- live.start: the saved choice reaches both engines, at the start and at 接着录 ---- */

async function service(t, { engine = null } = {}) {
  const dir = await withHome(t);
  const modelDir = join(dir, 'model');
  await mkdir(modelDir, { recursive: true });
  for (const name of ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx']) await writeFile(join(modelDir, name), 'fake');
  const Socket = socketClass();
  const svc = new StudyService(join(dir, 'library'), { WebSocket: Socket, liveLocal: { engine: engine === 'fake' ? { enginePath: FAKE_ENGINE, modelDir } : null } });
  t.after(async () => {
    for (const item of await listSaved(svc.store.root)) {
      const session = svc.runtime.liveSessions.registered(svc.store.root, item.id);
      if (session?.active) await session.stop();
      await session?.retirePersistence(); svc.runtime.liveSessions.unregister(svc.store.root, item.id);
    }
    await svc.dispose?.();
  });
  return { svc, Socket };
}

test('live.start on Gemini gives the session the idle flush of the saved choice; a running class keeps its value; 接着录 takes the new one', async t => {
  const { svc } = await service(t);
  await svc.call('audio.settings.set', { freeKey: FREE, liveProvider: 'gemini' });
  const timingOf = id => svc.runtime.liveSessions.registered(svc.store.root, id).timing.idleFlushMs;
  const stopped = [];
  for (const [choice, expected] of [[undefined, 1500], ['short', 700], ['standard', 1500], ['long', 2500]]) {
    if (choice) await svc.call('audio.settings.set', { liveSentencePause: choice });
    const started = await svc.call('live.start', { title: `Pause ${choice}` });
    assert.equal(timingOf(started.id), expected, `${choice}`);
    if (choice === 'short') {
      await svc.call('audio.settings.set', { liveSentencePause: 'long' });
      assert.equal(timingOf(started.id), 700, 'changing the setting does not change a class already running');
      stopped.push(started.id);
    }
    await svc.call('live.stop', { id: started.id });
  }
  // 接着录 reads the setting as it is then.
  await svc.call('audio.settings.set', { liveSentencePause: 'long' });
  const resumed = await svc.call('live.start', { resumeId: stopped[0] });
  assert.equal(timingOf(resumed.id), 2500);
});

const loud = seconds => {
  const buffer = Buffer.alloc(Math.round(seconds * 16000) * 2);
  for (let i = 0; i < buffer.length / 2; i++) buffer.writeInt16LE(i % 32 < 16 ? 8000 : -8000, i * 2);
  return buffer;
};
const quiet = seconds => Buffer.alloc(Math.round(seconds * 16000) * 2);

test('live.start on the local engine gives the recognizer thread the silence of the saved choice (a pause shorter than it does not split speech)', async t => {
  const { svc } = await service(t, { engine: 'fake' });
  // one second of speech, a pause, one more second of speech. The fake VAD cuts at `minSilenceDuration` like silero does.
  const rows = [['short', 0.3, 2], ['standard', 0.3, 1], ['standard', 0.6, 2], ['long', 0.6, 1]];
  for (const [choice, gap, sentences] of rows) {
    await svc.call('audio.settings.set', { liveSentencePause: choice });
    const started = await svc.call('live.start', { title: `Local ${choice} ${gap}` });
    assert.equal(started.tier, 'local');
    for (const piece of [loud(1), quiet(gap), loud(1), quiet(1)]) await svc.call('live.audio', { id: started.id, data: piece.toString('base64') });
    const ended = await svc.call('live.stop', { id: started.id });
    assert.equal(ended.segments.length, sentences, `${choice}, a ${gap} s pause`);
  }
});
