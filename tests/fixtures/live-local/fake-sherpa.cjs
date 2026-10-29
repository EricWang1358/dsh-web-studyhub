/* A stand-in for sherpa-onnx-node in the local live engine's worker (lib/live-local-worker.mjs): the same two classes with the calls the
   worker makes, no model and no native code. Speech is any non-zero sample; 0.5 s of silence after speech ends a segment (like silero's
   minSilenceDuration). A decode answers "句<n>（<tenths of a second>）" so a test can tell finals and partials apart by length.
   FAKE_SHERPA_FAIL=load makes the recognizer refuse its model (a broken install). */

const fs = require('node:fs');

let finals = 0;

class OfflineRecognizer {
  constructor(config) {
    if (process.env.FAKE_SHERPA_FAIL === 'load') throw new Error('Failed to load model');
    const model = config?.modelConfig?.senseVoice?.model;
    if (!model || !fs.existsSync(model)) throw new Error(`model not found: ${model}`);
    this.config = config;
  }
  createStream() {
    const stream = { samples: new Float32Array(0) };
    stream.acceptWaveform = ({ samples, sampleRate }) => {
      if (sampleRate !== 16000) throw new Error('sample rate');
      stream.samples = samples;
    };
    return stream;
  }
  decode() {}
  getResult(stream) { return { text: `句（${Math.round(stream.samples.length / 1600)}）` }; }
}

class Vad {
  constructor(config, bufferSeconds) {
    if (!config?.sileroVad?.model || !fs.existsSync(config.sileroVad.model)) throw new Error('vad model not found');
    this.bufferSeconds = bufferSeconds;
    this.speech = [];
    this.silence = 0;
    this.segments = [];
  }
  acceptWaveform(samples) {
    const loud = samples.some(value => value !== 0);
    if (loud) { this.speech.push(Float32Array.from(samples)); this.silence = 0; return; }
    if (!this.speech.length) return;
    this.silence += samples.length;
    if (this.silence >= 8000) this.cut();
  }
  cut() {
    const length = this.speech.reduce((sum, piece) => sum + piece.length, 0), samples = new Float32Array(length);
    let at = 0;
    for (const piece of this.speech) { samples.set(piece, at); at += piece.length; }
    this.segments.push({ samples, start: 0 });
    this.speech = []; this.silence = 0; finals += 1;
  }
  isDetected() { return this.speech.length > 0; }
  isEmpty() { return this.segments.length === 0; }
  front() { return this.segments[0]; }
  pop() { this.segments.shift(); }
  flush() { if (this.speech.length) this.cut(); }
}

module.exports = { OfflineRecognizer, Vad, version: 'fake', finals: () => finals };
