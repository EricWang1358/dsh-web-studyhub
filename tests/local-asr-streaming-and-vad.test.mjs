/* Local ASR upgrades:
   1. Pure-JS MIT LocalAgreement-2 streaming commit & overlap deduplication + backpressure
   2. Dynamic CPU numThreads selection (provider stays 'cpu')
   3. End-to-end whisper-turbo streaming in live-local-worker.mjs (incremental finals before 15 s)
   4. Offline silero_vad.onnx reuse in WAV segmentation with smooth fallback to splitWavQuiet */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalAgreement, createBackpressureController, joinTranscriptTokens, recommendedNumThreads, tokenizeTranscript } from '../lib/contexts/audio/local-streaming.js';
import { detectInstalledVad, extractMono16k, findVadSpeechGaps, pickBestVadCut, splitWavWithVad } from '../lib/contexts/audio/vad-split.js';
import { loadAudio, splitWavQuiet, wavInfo } from '../lib/audio-file.js';
import { LoopbackWebSocket } from '../lib/live-local.js';
import { audioMessage, endMessage } from '../lib/live-protocol.js';

const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/live-local/fake-sherpa.cjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (check, what, ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return; await sleep(20); }
  throw new Error(`timed out waiting for ${what}`);
};

const pcm = (seconds, loud = true) => {
  const samples = Math.round(seconds * 16000), buffer = Buffer.alloc(samples * 2);
  if (loud) for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(i % 32 < 16 ? 8000 : -8000, i * 2);
  return buffer;
};

/** Build a 16-bit PCM WAV from a sequence of `{ seconds, amplitude }` segments. */
function makeWav(segments, { sampleRate = 16000, channels = 1 } = {}) {
  const totalFrames = segments.reduce((sum, seg) => sum + Math.round(seg.seconds * sampleRate), 0);
  const blockAlign = channels * 2;
  const byteRate = sampleRate * blockAlign;
  const dataLength = totalFrames * blockAlign;
  const out = Buffer.alloc(44 + dataLength);
  out.write('RIFF', 0, 'latin1'); out.writeUInt32LE(36 + dataLength, 4); out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(byteRate, 28); out.writeUInt16LE(blockAlign, 32);
  out.writeUInt16LE(16, 34); out.write('data', 36, 'latin1'); out.writeUInt32LE(dataLength, 40);
  let frame = 0;
  for (const seg of segments) {
    const count = Math.round(seg.seconds * sampleRate);
    for (let i = 0; i < count; i += 1) {
      const sample = seg.amplitude ? (i % 16 < 8 ? seg.amplitude : -seg.amplitude) : 0;
      for (let ch = 0; ch < channels; ch += 1) {
        out.writeInt16LE(sample, 44 + (frame * channels + ch) * 2);
      }
      frame += 1;
    }
  }
  return out;
}

test('recommendedNumThreads scales with CPU cores inside [2, 6] and respects explicit overrides', () => {
  assert.equal(recommendedNumThreads({ cpus: 1 }), 2);
  assert.equal(recommendedNumThreads({ cpus: 4 }), 2);
  assert.equal(recommendedNumThreads({ cpus: 8 }), 4);
  assert.equal(recommendedNumThreads({ cpus: 12 }), 6);
  assert.equal(recommendedNumThreads({ cpus: 32 }), 6);
  assert.equal(recommendedNumThreads({ cpus: 8, override: 3 }), 3);
  assert.equal(recommendedNumThreads({ cpus: 8, override: 99 }), 16);
});

test('LocalAgreement-2 commits longest common prefix across consecutive passes for English and CJK without duplicating sliding-window overlap', () => {
  const agreement = new LocalAgreement();

  // Pass 1: nothing agreed yet -> interim only.
  const r1 = agreement.insert('Today we discuss database');
  assert.equal(r1.confirmed, '');
  assert.equal(r1.interim, 'Today we discuss database');

  // Pass 2: LCP "Today we discuss database" commits immediately; new tail stays interim.
  const r2 = agreement.insert('Today we discuss database, indexing and');
  assert.equal(r2.confirmed, 'Today we discuss database,');
  assert.equal(r2.interim, 'indexing and');

  // Pass 3: window trims left audio, keeping overlap starting at "database, indexing and ...".
  const r3 = agreement.insert('database, indexing and caching in Postgres');
  assert.equal(r3.confirmed, 'indexing and');
  assert.equal(r3.interim, 'caching in Postgres');

  // Flush at silence/end emits only uncommitted tail without duplicating "indexing and".
  const tail = agreement.flush('indexing and caching in Postgres today.');
  assert.equal(tail, 'caching in Postgres today.');
  assert.equal(agreement.hasActivity(), false);

  // Mixed Chinese + English lecture streaming.
  const zh1 = agreement.insert('今天我们讲B-tree');
  assert.equal(zh1.confirmed, '');
  assert.equal(zh1.interim, '今天我们讲B-tree');
  const zh2 = agreement.insert('今天我们讲B-tree索引和分页');
  assert.equal(zh2.confirmed, '今天我们讲B-tree');
  assert.equal(zh2.interim, '索引和分页');
  assert.equal(agreement.flush('B-tree索引和分页机制。'), '索引和分页机制。');

  // Tokenizer & joiner sanity check.
  assert.equal(joinTranscriptTokens(tokenizeTranscript('Hello world, B-tree 索引')), 'Hello world, B-tree索引');
});

test('backpressure controller stretches decode cadence under CPU overload, skips stale queued audio, and recovers', () => {
  const bp = createBackpressureController({ sampleRate: 16000, baseStepSamples: 32000, maxStepSamples: 96000, backlogThresholdMs: 1000 });
  assert.equal(bp.shouldDecode(16000, 0), false);
  assert.equal(bp.shouldDecode(32000, 0), true);
  // Stale queued audio skips speculative decode.
  assert.equal(bp.shouldDecode(32000, 1500), false);
  assert.equal(bp.state().skipped, 1);

  // Slow decode (> 65% of 2000 ms step) stretches step.
  bp.recordDecode(1600);
  assert.equal(bp.state().overloaded, true);
  assert.equal(bp.state().stepSamples, 48000);

  // Fast decodes recover back toward base step.
  bp.recordDecode(200);
  bp.recordDecode(200);
  assert.equal(bp.state().stepSamples, 32000);
  assert.equal(bp.state().overloaded, false);
});

test('whisper-turbo worker streams incremental finals via LocalAgreement-2 before 15 s, slides overlap cleanly, and uses cpu provider with dynamic threads', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'whisper-stream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['turbo-encoder.int8.onnx', 'turbo-decoder.int8.onnx', 'turbo-tokens.txt', 'silero_vad.onnx']) {
    await writeFile(join(dir, name), 'fake');
  }
  const enginePath = join(dir, 'progressive-whisper.cjs');
  await writeFile(enginePath, `
    const fs = require('node:fs');
    const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november'];
    let lastConfig = null;
    let call = 0;
    class OfflineRecognizer {
      constructor(config) {
        lastConfig = config;
        if (config.modelConfig.provider !== 'cpu') throw new Error('must stay cpu');
        if (!(config.modelConfig.numThreads >= 2 && config.modelConfig.numThreads <= 6)) throw new Error('bad threads: ' + config.modelConfig.numThreads);
        if (!fs.existsSync(config.modelConfig.whisper.encoder)) throw new Error('missing encoder');
      }
      createStream() {
        const s = { samples: new Float32Array(0) };
        s.acceptWaveform = ({ samples }) => { s.samples = samples; };
        return s;
      }
      decode() {}
      getResult() {
        call += 1;
        // Simulate progressive overlapping decodes across a sliding window:
        // pass 1: words[0..2], pass 2: words[0..4], pass 3: words[0..6], pass 4 (after slide): words[4..8], pass 5 (flush): words[6..10]
        const windows = [
          WORDS.slice(0, 3),
          WORDS.slice(0, 5),
          WORDS.slice(0, 7),
          WORDS.slice(4, 9),
          WORDS.slice(6, 11),
        ];
        const chosen = windows[Math.min(call - 1, windows.length - 1)];
        return { text: chosen.join(' ') };
      }
    }
    class Vad {
      constructor(config) {
        if (!fs.existsSync(config.sileroVad.model)) throw new Error('missing vad');
        this.speech = [];
        this.segments = [];
      }
      acceptWaveform(samples) {
        if (samples.some(v => v !== 0)) this.speech.push(Float32Array.from(samples));
      }
      isDetected() { return this.speech.length > 0; }
      isEmpty() { return this.segments.length === 0; }
      front() { return this.segments[0]; }
      pop() { this.segments.shift(); }
      flush() {
        if (!this.speech.length) return;
        const len = this.speech.reduce((s, p) => s + p.length, 0);
        const out = new Float32Array(len);
        let at = 0;
        for (const p of this.speech) { out.set(p, at); at += p.length; }
        this.segments.push({ samples: out, start: 0 });
        this.speech = [];
      }
    }
    module.exports = { OfflineRecognizer, Vad, version: 'fake-whisper', config: () => lastConfig };
  `);

  const socket = new LoopbackWebSocket('local://live', {
    modelDir: dir,
    enginePath,
    modelId: 'whisper-turbo',
    timing: { whisperStepSec: 1.0, whisperMinSec: 0.8, whisperWindowSec: 3.0, whisperOverlapSec: 1.0 },
  });
  const seen = [];
  let done;
  const closed = new Promise(resolve => { done = resolve; });
  socket.addEventListener('message', event => seen.push(JSON.parse(event.data)));
  socket.addEventListener('close', event => done(event));
  await waitFor(() => socket.readyState === 1, 'whisper socket open');

  // Stream 4.5 s of continuous speech (no silence, well under 15 s) in 0.5 s chunks.
  for (let i = 0; i < 9; i += 1) {
    socket.send(JSON.stringify(audioMessage(pcm(0.5))));
    await sleep(10);
  }
  await waitFor(() => seen.some(m => m.serverContent?.inputTranscription?.text), 'incremental whisper final before silence');
  assert.ok(seen.some(m => m.serverContent?.interimInputTranscription?.text), 'interim captions arrive during speech');

  socket.send(JSON.stringify(endMessage()));
  const event = await closed;
  assert.equal(event.code, 1000);

  const finals = seen.filter(m => m.serverContent?.inputTranscription?.text).map(m => m.serverContent.inputTranscription.text);
  assert.ok(finals.length >= 2, `expected incremental committed finals, got ${JSON.stringify(finals)}`);
  const full = finals.join(' ');
  assert.equal(full, 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo', 'overlap deduplication preserves every word exactly once');
});

test('offline silero_vad.onnx WAV splitting cuts inside speech pauses and smoothly falls back when VAD is absent or broken', async t => {
  // 1. Stereo 48 kHz -> 16 kHz mono downmix & resample check.
  const stereoWav = makeWav([{ seconds: 0.5, amplitude: 10000 }, { seconds: 0.5, amplitude: 0 }], { sampleRate: 48000, channels: 2 });
  const stereoInfo = wavInfo(stereoWav);
  const mono16k = extractMono16k(stereoWav, stereoInfo, 0, stereoInfo.dataLength);
  assert.equal(mono16k.length, 16000);
  assert.ok(Math.abs(mono16k[100]) > 0.25 && mono16k[12000] === 0);

  // 2. Construct a 20 s WAV with loud speech everywhere except a clean 2 s pause at 7.0 s .. 9.0 s (target midpoint = 10 s).
  const wav = makeWav([
    { seconds: 7, amplitude: 9000 },
    { seconds: 2, amplitude: 0 },
    { seconds: 11, amplitude: 9000 },
  ]);
  const info = wavInfo(wav);

  const dir = await mkdtemp(join(tmpdir(), 'vad-split-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vadModelPath = join(dir, 'silero_vad.onnx');
  await writeFile(vadModelPath, 'fake-vad');

  // With fake sherpa.Vad present, splitWavWithVad selects 'silero-vad' and cuts inside [7s, 9s].
  const vadSplit = await splitWavWithVad(wav, info, 2, {
    reach: 5,
    vad: { enginePath: FAKE_ENGINE, vadModelPath },
    fallbackSplit: splitWavQuiet,
  });
  assert.equal(vadSplit.strategy, 'silero-vad');
  assert.equal(vadSplit.chunks.length, 2);
  assert.ok(vadSplit.chunks[0].seconds >= 7.0 && vadSplit.chunks[0].seconds <= 9.0, `VAD cut landed inside pause (${vadSplit.chunks[0].seconds}s)`);
  assert.ok(Math.abs(vadSplit.chunks[0].seconds + vadSplit.chunks[1].seconds - 20) < 0.05);

  // Without installed VAD, smoothly falls back to splitWavQuiet ('energy-quiet').
  const fallbackSplit = await splitWavWithVad(wav, info, 2, {
    reach: 5,
    resolveEngine: async () => null,
    fallbackSplit: splitWavQuiet,
  });
  assert.equal(fallbackSplit.strategy, 'energy-quiet');
  assert.equal(fallbackSplit.chunks.length, 2);

  // When engine fails to load, smoothly falls back without throwing.
  const brokenSplit = await splitWavWithVad(wav, info, 2, {
    reach: 5,
    vad: { enginePath: join(dir, 'missing.cjs'), vadModelPath },
    fallbackSplit: splitWavQuiet,
  });
  assert.equal(brokenSplit.strategy, 'energy-quiet');
  assert.equal(brokenSplit.chunks.length, 2);

  // detectInstalledVad finds enginePath + silero_vad.onnx safely and returns null when missing.
  const found = await detectInstalledVad({ resolveEngine: async () => ({ enginePath: FAKE_ENGINE, modelDir: dir }) });
  assert.deepEqual(found, { enginePath: FAKE_ENGINE, vadModelPath, modelId: 'sense-voice' });
  const absent = await detectInstalledVad({ resolveEngine: async () => null });
  assert.equal(absent, null);

  // Helper edge checks.
  assert.equal(pickBestVadCut({ gaps: [{ startSec: 1, endSec: 2, durationSec: 1 }], windowStartSec: 10, targetSec: 12 }), 11.5);
  assert.equal(pickBestVadCut({ gaps: [{ startSec: 1, endSec: 1.1, durationSec: 0.1 }], windowStartSec: 10, targetSec: 11 }), null);
  assert.deepEqual(findVadSpeechGaps({ acceptWaveform() {}, isEmpty: () => true, isDetected: () => false }, new Float32Array(16000)), [{ startSec: 0, endSec: 1, durationSec: 1 }]);

  // Integration through loadAudio (with vad: false fallback and with explicit fake VAD).
  const wavPath = join(dir, 'lecture.wav');
  const longWav = makeWav([
    { seconds: 280, amplitude: 8000 },
    { seconds: 5, amplitude: 0 },
    { seconds: 325, amplitude: 8000 },
  ], { sampleRate: 8000 });
  await writeFile(wavPath, longWav);
  const loadedFallback = await loadAudio({ path: wavPath, partSeconds: 300, vad: false });
  assert.equal(loadedFallback.chunks.length, 3);
  const loadedVad = await loadAudio({ path: wavPath, partSeconds: 300, vad: { enginePath: FAKE_ENGINE, vadModelPath } });
  assert.equal(loadedVad.chunks.length, 3);
});
