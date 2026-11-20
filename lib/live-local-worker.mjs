// Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).
/* The recognizer thread of the local live engine (lib/live-local.js).

   SenseVoice (sherpa-onnx, onnxruntime on the CPU) plus a silero VAD, fed with 16 kHz 16-bit mono PCM the way the Gemini socket was fed: audio in,
   finished utterances ('final') and decodes of the speech in progress ('interim') out. The heavy decode runs here, so the plugin's event loop
   (panel polling, every other operation) never waits for it. The engine package is the one StudyHub installed (workerData.enginePath, an absolute
   path); nothing is looked up on the PATH or in a global node_modules. With workerData.check the thread only loads the engine and the model,
   answers 'ready' and ends: the install's last step. */

import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import { DEFAULT_LOCAL_MODEL, localModelOf } from './live-local-models.js';
import { LocalAgreement, createBackpressureController, recommendedNumThreads } from './contexts/audio/local-streaming.js';

const post = message => parentPort.postMessage(message);
const fail = message => { post({ type: 'error', message: String(message).slice(0, 300) }); process.exit(1); };

const { modelDir, enginePath, modelId = DEFAULT_LOCAL_MODEL, check = false, timing = {} } = workerData || {};
if (!modelDir || !enginePath) fail('本地识别引擎没有拿到引擎或模型的位置');

let sherpa;
try { sherpa = createRequire(import.meta.url)(enginePath); }
catch (error) { fail(`本地识别引擎不可用（没能加载 sherpa-onnx）：${error.message}`); }

const SAMPLE_RATE = 16000;
const INTERIM_EVERY_MS = Number(timing.interimEveryMs) > 0 ? Number(timing.interimEveryMs) : 600;
// How long a silence ends an utterance (断句停顿, LIVE_PAUSE in lib/audio-settings.js); 0.5 s is what it was before the setting existed.
const MIN_SILENCE_SEC = Number(timing.minSilenceSec) > 0 ? Number(timing.minSilenceSec) : 0.5;
const INTERIM_MIN_SAMPLES = SAMPLE_RATE / 2;
const VAD_WINDOW = 512;
const MAX_SPEECH_SAMPLES = SAMPLE_RATE * 15;
const NUM_THREADS = recommendedNumThreads({ override: timing.numThreads });

// Streaming LocalAgreement-2 window parameters for whisper-turbo (sliding overlap eliminates 15 s silence & hard-cut word loss).
const WHISPER_STREAMING = modelId === 'whisper-turbo' && !timing.disableInterim;
const WHISPER_STEP_SAMPLES = Math.max(VAD_WINDOW, Math.round(SAMPLE_RATE * (Number(timing.whisperStepSec) > 0 ? Number(timing.whisperStepSec) : 2.0)));
const WHISPER_MIN_SAMPLES = Math.max(VAD_WINDOW, Math.round(SAMPLE_RATE * (Number(timing.whisperMinSec) > 0 ? Number(timing.whisperMinSec) : 1.0)));
const WHISPER_WINDOW_SAMPLES = Math.max(WHISPER_STEP_SAMPLES * 2, Math.round(SAMPLE_RATE * (Number(timing.whisperWindowSec) > 0 ? Number(timing.whisperWindowSec) : 12.0)));
const WHISPER_OVERLAP_SAMPLES = Math.min(Math.floor(WHISPER_WINDOW_SAMPLES / 2), Math.max(VAD_WINDOW, Math.round(SAMPLE_RATE * (Number(timing.whisperOverlapSec) > 0 ? Number(timing.whisperOverlapSec) : 3.0))));

let recognizer, vad;
try {
  localModelOf(modelId);
  recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      ...(modelId === 'whisper-turbo' ? {
        whisper: { encoder: path.join(modelDir, 'turbo-encoder.int8.onnx'), decoder: path.join(modelDir, 'turbo-decoder.int8.onnx'), language: '', task: 'transcribe', tailPaddings: 300 },
      } : { senseVoice: { model: path.join(modelDir, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 } }),
      tokens: path.join(modelDir, modelId === 'whisper-turbo' ? 'turbo-tokens.txt' : 'tokens.txt'),
      numThreads: NUM_THREADS, debug: 0, provider: 'cpu',
    },
  });
  vad = new sherpa.Vad({
    sileroVad: { model: path.join(modelDir, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: MIN_SILENCE_SEC, minSpeechDuration: 0.25, maxSpeechDuration: WHISPER_STREAMING ? 60 : 15, windowSize: VAD_WINDOW },
    sampleRate: SAMPLE_RATE,
  }, 90);
} catch (error) { fail(`本地识别模型没能加载：${error.message}`); }

/* Decode runs synchronously in this worker, away from the application's event loop. */
const decode = samples => {
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  recognizer.decode(stream);
  return String(recognizer.getResult(stream).text || '').trim();
};

if (check) {
  // The install's check: one decode of a quarter second of silence proves the model runs, not only that it loads.
  decode(new Float32Array(SAMPLE_RATE / 4));
  post({ type: 'ready', version: String(sherpa.version || ''), numThreads: NUM_THREADS });
  process.exit(0);
}

/* The interim buffer holds what the VAD marks as speech right now; a finished segment covers the same audio, so it empties the buffer with it. */
let interimPieces = [], interimSamples = 0, processedSamples = 0, ended = false, lastInterim = '', samplesSinceWhisper = 0;
const agreement = new LocalAgreement();
const backpressure = createBackpressureController({
  sampleRate: SAMPLE_RATE,
  baseStepSamples: WHISPER_STEP_SAMPLES,
  maxStepSamples: Math.max(WHISPER_STEP_SAMPLES * 3, Math.floor(WHISPER_WINDOW_SAMPLES / 2)),
  backlogThresholdMs: Number(timing.backlogThresholdMs) > 0 ? Number(timing.backlogThresholdMs) : 1500,
});

const flatten = () => {
  const out = new Float32Array(interimSamples);
  let at = 0;
  for (const piece of interimPieces) { out.set(piece, at); at += piece.length; }
  return out;
};

/** Trim oldest audio from the sliding window while retaining `keepSamples` of overlap tail. */
const trimSlidingWindow = keepSamples => {
  if (interimSamples <= keepSamples) return;
  const full = flatten();
  const tail = full.slice(full.length - keepSamples);
  interimPieces = [tail];
  interimSamples = tail.length;
};

const runWhisperStep = ({ force = false, queueLagMs = 0 } = {}) => {
  if (!WHISPER_STREAMING || ended || interimSamples < WHISPER_MIN_SAMPLES) return;
  if (!force && !backpressure.shouldDecode(samplesSinceWhisper, queueLagMs)) return;
  samplesSinceWhisper = 0;
  const started = performance.now();
  const text = decode(flatten());
  backpressure.recordDecode(performance.now() - started);
  const { confirmed, interim } = agreement.insert(text);
  if (confirmed) post({ type: 'final', text: confirmed });
  if (interim && interim !== lastInterim) {
    lastInterim = interim;
    post({ type: 'interim', text: interim });
  }
  if (interimSamples >= WHISPER_WINDOW_SAMPLES) {
    trimSlidingWindow(WHISPER_OVERLAP_SAMPLES);
  }
};

const clearSpeechBuffer = () => {
  interimPieces = [];
  interimSamples = 0;
  lastInterim = '';
  samplesSinceWhisper = 0;
};

const drain = () => {
  while (!vad.isEmpty()) {
    const segment = vad.front();
    vad.pop();
    if (WHISPER_STREAMING && agreement.hasActivity()) {
      const audio = interimSamples > 0 ? flatten() : segment.samples;
      clearSpeechBuffer();
      const tail = agreement.flush(decode(audio));
      if (tail) post({ type: 'final', text: tail });
    } else {
      clearSpeechBuffer();
      agreement.reset();
      const text = decode(segment.samples);
      if (text) post({ type: 'final', text });
    }
  }
};

const interimTimer = (timing.disableInterim || WHISPER_STREAMING) ? null : setInterval(() => {
  if (ended || interimSamples < INTERIM_MIN_SAMPLES) return;
  const text = decode(flatten());
  if (text && text !== lastInterim) { lastInterim = text; post({ type: 'interim', text }); }
}, INTERIM_EVERY_MS);
interimTimer?.unref?.();

parentPort.on('message', message => {
  if (ended || !message) return;
  if (message.type === 'audio' && message.buffer) {
    const source = new Int16Array(message.buffer);
    const samples = new Float32Array(source.length);
    for (let i = 0; i < source.length; i++) samples[i] = source[i] / 32768;
    const queueLagMs = Number.isFinite(message.sentAt) ? Math.max(0, Date.now() - message.sentAt) : 0;
    for (let at = 0; at < samples.length; at += VAD_WINDOW) {
      const piece = samples.subarray(at, at + VAD_WINDOW);
      vad.acceptWaveform(piece);
      if (vad.isDetected()) {
        interimPieces.push(piece);
        interimSamples += piece.length;
        if (WHISPER_STREAMING) samplesSinceWhisper += piece.length;
      }
      drain();
      if (WHISPER_STREAMING) {
        runWhisperStep({ queueLagMs });
        if (interimSamples >= MAX_SPEECH_SAMPLES) {
          runWhisperStep({ force: true, queueLagMs: 0 });
          trimSlidingWindow(WHISPER_OVERLAP_SAMPLES);
        }
      } else if (interimSamples >= MAX_SPEECH_SAMPLES) {
        // Silero's maxSpeechDuration relaxes detection thresholds; continuous speech can still exceed it.
        // Flush by audio samples so final text keeps arriving even without a natural pause.
        vad.flush();
        drain();
      }
    }
    processedSamples += samples.length;
    post({ type: 'progress', samples: processedSamples });
  } else if (message.type === 'end') {
    vad.flush();
    drain();
    if (WHISPER_STREAMING && (interimSamples > 0 || agreement.hasActivity())) {
      const text = interimSamples > 0 ? decode(flatten()) : '';
      const tail = agreement.flush(text);
      clearSpeechBuffer();
      if (tail) post({ type: 'final', text: tail });
    }
    if (message.keepAlive) {
      if (typeof vad.reset === 'function') vad.reset();
      clearSpeechBuffer();
      agreement.reset();
      backpressure.reset();
      processedSamples = 0;
      post({ type: 'done' });
    } else {
      ended = true;
      clearInterval(interimTimer);
      post({ type: 'done' });
    }
  }
});

post({ type: 'ready', numThreads: NUM_THREADS });
