// Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).
/* The recognizer thread of the local live engine (lib/live-local.js).

   SenseVoice (sherpa-onnx, onnxruntime on the CPU) plus a silero VAD, fed with 16 kHz 16-bit mono PCM the way the Gemini socket was fed: audio in,
   finished utterances ('final') and decodes of the speech in progress ('interim') out. The heavy decode runs here, so the plugin's event loop
   (panel polling, every other operation) never waits for it. The engine package is the one StudyHub installed (workerData.enginePath, an absolute
   path); nothing is looked up on the PATH or in a global node_modules. With workerData.check the thread only loads the engine and the model,
   answers 'ready' and ends: the install's last step. */

import { createRequire } from 'node:module';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { DEFAULT_LOCAL_MODEL, localModelOf } from './live-local-models.js';

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

let recognizer, vad;
try {
  localModelOf(modelId);
  recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      ...(modelId === 'whisper-turbo' ? {
        whisper: { encoder: path.join(modelDir, 'turbo-encoder.int8.onnx'), decoder: path.join(modelDir, 'turbo-decoder.int8.onnx'), language: '', task: 'transcribe', tailPaddings: 300 },
      } : { senseVoice: { model: path.join(modelDir, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 } }),
      tokens: path.join(modelDir, modelId === 'whisper-turbo' ? 'turbo-tokens.txt' : 'tokens.txt'),
      numThreads: 2, debug: 0, provider: 'cpu',
    },
  });
  vad = new sherpa.Vad({
    sileroVad: { model: path.join(modelDir, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: MIN_SILENCE_SEC, minSpeechDuration: 0.25, maxSpeechDuration: 15, windowSize: VAD_WINDOW },
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
  post({ type: 'ready', version: String(sherpa.version || '') });
  process.exit(0);
}

/* The interim buffer holds what the VAD marks as speech right now; a finished segment covers the same audio, so it empties the buffer with it. */
let interimPieces = [], interimSamples = 0, processedSamples = 0, ended = false, lastInterim = '';
const flatten = () => {
  const out = new Float32Array(interimSamples);
  let at = 0;
  for (const piece of interimPieces) { out.set(piece, at); at += piece.length; }
  return out;
};

const drain = () => {
  while (!vad.isEmpty()) {
    const segment = vad.front();
    vad.pop();
    interimPieces = []; interimSamples = 0; lastInterim = '';
    const text = decode(segment.samples);
    if (text) post({ type: 'final', text });
  }
};

const interimTimer = setInterval(() => {
  // The larger model decodes only completed segments, avoiding repeated full-segment CPU work.
  if (modelId === 'whisper-turbo' || ended || interimSamples < INTERIM_MIN_SAMPLES) return;
  const text = decode(flatten());
  if (text && text !== lastInterim) { lastInterim = text; post({ type: 'interim', text }); }
}, INTERIM_EVERY_MS);
interimTimer.unref();

parentPort.on('message', message => {
  if (ended || !message) return;
  if (message.type === 'audio' && message.buffer) {
    const source = new Int16Array(message.buffer);
    const samples = new Float32Array(source.length);
    for (let i = 0; i < source.length; i++) samples[i] = source[i] / 32768;
    for (let at = 0; at < samples.length; at += VAD_WINDOW) {
      const piece = samples.subarray(at, at + VAD_WINDOW);
      vad.acceptWaveform(piece);
      if (vad.isDetected()) { interimPieces.push(piece); interimSamples += piece.length; }
      drain();
      // Silero's maxSpeechDuration relaxes detection thresholds; continuous speech can still exceed it.
      // Flush by audio samples so final text keeps arriving even without a natural pause.
      if (interimSamples >= MAX_SPEECH_SAMPLES) { vad.flush(); drain(); }
    }
    processedSamples += samples.length;
    post({ type: 'progress', samples: processedSamples });
  } else if (message.type === 'end') {
    ended = true;
    clearInterval(interimTimer);
    vad.flush();
    drain();
    post({ type: 'done' });
  }
});

post({ type: 'ready' });
