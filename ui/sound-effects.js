/* StudyHub interaction sound effects:
   - tap / flip / correct: pre-baked studio stereo MP3 recordings (Clatterbox tactile keycap CC0,
     Kenney slow book flip CC0, Yamaha C5 Salamander D-major piano arpeggio CC BY 3.0) decoded into
     cached Web Audio buffers with synchronous stereo DSP fallbacks.
   - levelUp / miss / complete: D-major stereo Crystal Celesta synthesized offline with micro-room
     reflections so every harmonic cue shares one coherent acoustic space.
   Defaults to 'off' in appearance-prefs.js: when off, zero AudioContext instances are constructed;
   automatically mutes whenever microphone / live-class audio capture is active (ui/live-audio.js)
   or the tab is hidden (except for explicit focus timer chimes). */
import { getAppearanceSound, invalidateAppearanceCache, isMinimalMode, onAppearanceCacheChange } from './appearance-prefs.js';
import { isAudioCaptureActive } from './audio-capture-state.js';

export const SOUND_CUES = Object.freeze(['tap', 'flip', 'correct', 'levelUp', 'miss', 'complete']);
const SUBTLE_CUES = new Set(['flip', 'correct', 'levelUp', 'miss', 'complete']);
const SAMPLE_CUES = new Set(['tap', 'flip', 'correct']);

const IDLE_SUSPEND_MS = 15_000;
const CUE_COOLDOWN_MS = 45;
const GLOBAL_COOLDOWN_MS = 25;
const SUSPENDED_STALE_MS = 180;
const MAX_DSP_PEAK = 0.48;
const AIR_BUS_CUTOFF_HZ = 12_000;

// Tier multipliers tuned to match the auditioned v2 balance across all 6 cues.
const TIER_SCALE = Object.freeze({
  subtle: 0.72,
  standard: 0.88,
});

// Relative cue gains when playing synthesized stereo DSP buffers.
const DSP_CUE_GAINS = Object.freeze({
  tap: 0.85,
  flip: 0.85,
  correct: 0.85,
  levelUp: 0.85,
  miss: 0.85,
  complete: 0.85,
});

// Gentle organic pitch micro-variation only on mechanical/paper foley; harmonic piano & celesta stay concert-tuned.
const CUE_JITTER = Object.freeze({
  tap: 0.015,
  flip: 0.012,
  correct: 0,
  levelUp: 0,
  miss: 0,
  complete: 0,
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Raised-cosine fade-in + cosine release so sample[0] === 0 and sample[last] === 0 with zero DC click. */
function shapeEnvelope(samples, sampleRate, fadeInMs = 1, fadeOutMs = 12) {
  const n = samples.length;
  if (!n) return samples;
  samples[0] = 0;
  samples[n - 1] = 0;
  const fadeInSamples = Math.min(Math.floor(n * 0.25), Math.max(2, Math.round((fadeInMs / 1000) * sampleRate)));
  const fadeOutSamples = Math.min(Math.floor(n * 0.45), Math.max(3, Math.round((fadeOutMs / 1000) * sampleRate)));
  for (let i = 1; i < fadeInSamples; i += 1) {
    const w = 0.5 * (1 - Math.cos((Math.PI * i) / fadeInSamples));
    samples[i] *= w;
  }
  for (let k = 1; k < fadeOutSamples; k += 1) {
    const idx = n - 1 - k;
    const w = 0.5 * (1 - Math.cos((Math.PI * k) / fadeOutSamples));
    samples[idx] *= w;
  }
  return samples;
}

/** Causal 2nd-order RBJ biquad filter (lowpass / highpass / bandpass). */
function applyBiquad(samples, sampleRate, type, cutoffHz, q = Math.SQRT1_2) {
  const fc = Math.max(40, Math.min(cutoffHz, sampleRate * 0.45));
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'bandpass') {
    b0 = alpha; b1 = 0; b2 = -alpha;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x0 = samples[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    samples[i] = y0;
  }
  return samples;
}

/** Add subtle studio desk early reflections for natural stereo width without muddiness. */
function addStereoMicroRoom(mono, sampleRate, wet = 0.22, spreadMs = 11) {
  const n = mono.length;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const tapsL = [
    [Math.round(sampleRate * 0.009), 0.48],
    [Math.round(sampleRate * 0.019), 0.30],
    [Math.round(sampleRate * 0.031), 0.18],
    [Math.round(sampleRate * 0.047), 0.10],
  ];
  const tapsR = [
    [Math.round(sampleRate * (0.009 + (spreadMs / 1000) * 0.35)), 0.46],
    [Math.round(sampleRate * 0.023), 0.28],
    [Math.round(sampleRate * 0.037), 0.17],
    [Math.round(sampleRate * 0.053), 0.09],
  ];
  for (let i = 0; i < n; i += 1) {
    let rl = 0;
    let rr = 0;
    for (let t = 0; t < tapsL.length; t += 1) {
      const d = tapsL[t][0];
      if (i >= d) rl += mono[i - d] * tapsL[t][1];
    }
    for (let t = 0; t < tapsR.length; t += 1) {
      const d = tapsR[t][0];
      if (i >= d) rr += mono[i - d] * tapsR[t][1];
    }
    left[i] = mono[i] + rl * wet;
    right[i] = mono[i] + rr * wet;
  }
  applyBiquad(left, sampleRate, 'lowpass', 7800, 0.7);
  applyBiquad(right, sampleRate, 'lowpass', 7800, 0.7);
  return [left, right];
}

function normalizeStereo(left, right, targetPeak, sampleRate = 44100) {
  let peak = 0;
  for (let i = 0; i < left.length; i += 1) {
    const absL = Math.abs(left[i]);
    const absR = Math.abs(right[i]);
    if (absL > peak) peak = absL;
    if (absR > peak) peak = absR;
  }
  if (peak > 1e-6) {
    const scale = targetPeak / peak;
    for (let i = 0; i < left.length; i += 1) {
      left[i] *= scale;
      right[i] *= scale;
    }
  }
  shapeEnvelope(left, sampleRate, 0.4, 8);
  shapeEnvelope(right, sampleRate, 0.4, 8);
  return [left, right];
}

/** Add one Crystal Celesta note: fast-decaying bright partials + subtle detuned shimmer bloom. */
function addCelestaNote(samples, sampleRate, {
  startSec = 0,
  freqHz,
  amp = 0.28,
  tau = 0.26,
  shimmer = 1.0,
  rand,
}) {
  const startIdx = Math.max(0, Math.round(startSec * sampleRate));
  const ratios = [1.0, 2.001, 3.004, 4.012, 5.42];
  const partialAmps = [1.0, 0.42 * shimmer, 0.18 * shimmer, 0.09 * shimmer, 0.05 * shimmer];
  const partialTaus = [tau, tau * 0.55, tau * 0.28, tau * 0.14, tau * 0.06];
  for (let i = startIdx; i < samples.length; i += 1) {
    const t = (i - startIdx) / sampleRate;
    const attack = t < 0.0007 ? t / 0.0007 : 1;
    let body = 0;
    for (let k = 0; k < ratios.length; k += 1) {
      const detune = k === 0
        ? 0.12 * Math.sin(2 * Math.PI * (freqHz * 1.0025) * t) * Math.exp(-t / (tau * 0.9))
        : 0;
      body += partialAmps[k] * Math.exp(-t / partialTaus[k]) * Math.sin(2 * Math.PI * freqHz * ratios[k] * t) + detune;
    }
    const ping = Math.exp(-t / 0.0016) * (rand() * 2 - 1) * 0.15;
    samples[i] += amp * attack * (body + ping);
  }
}

function buildTapStereo(sampleRate) {
  const n = Math.max(64, Math.round(0.032 * sampleRate));
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate;
    const attack = t < 0.0003 ? t / 0.0003 : 1;
    mono[i] = attack * (
      Math.exp(-t / 0.0024) * Math.sin(2 * Math.PI * 2250 * t) * 0.72
      + Math.exp(-t / 0.0011) * Math.sin(2 * Math.PI * 4500 * t) * 0.30
    );
  }
  applyBiquad(mono, sampleRate, 'highpass', 800, 0.7);
  shapeEnvelope(mono, sampleRate, 0.3, 6);
  return normalizeStereo(...addStereoMicroRoom(mono, sampleRate, 0.06), 0.30, sampleRate);
}

function buildFlipStereo(sampleRate) {
  // Unhurried 3-stage natural paper arc fallback (fingertip lift -> air glide -> gentle settle) with right->left pan.
  const durSec = 0.30;
  const n = Math.max(64, Math.round(durSec * sampleRate));
  const rand = mulberry32(0x2207b3);
  const lift = new Float32Array(n);
  const glide = new Float32Array(n);
  const settle = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const u = i / n;
    const white = rand() * 2 - 1;
    lift[i] = u < 0.28 ? white * Math.pow(Math.sin((Math.PI * u) / 0.28), 1.3) : 0;
    glide[i] = u > 0.16 && u < 0.84 ? white * Math.pow(Math.sin((Math.PI * (u - 0.16)) / 0.68), 1.5) : 0;
    settle[i] = u > 0.60 ? white * Math.pow(Math.sin((Math.PI * (u - 0.60)) / 0.40), 1.8) : 0;
  }
  applyBiquad(lift, sampleRate, 'bandpass', 3400, 1.35);
  applyBiquad(glide, sampleRate, 'bandpass', 2100, 0.9);
  applyBiquad(settle, sampleRate, 'bandpass', 1200, 1.1);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const u = i / n;
    const panR = Math.cos(u * Math.PI * 0.5) * 0.45 + 0.55;
    const panL = Math.sin(u * Math.PI * 0.5) * 0.45 + 0.55;
    const sample = lift[i] * 0.55 + glide[i] * 0.95 + settle[i] * 0.50;
    left[i] = sample * panL;
    right[i] = sample * panR;
  }
  applyBiquad(left, sampleRate, 'highpass', 580, 0.7);
  applyBiquad(right, sampleRate, 'highpass', 580, 0.7);
  shapeEnvelope(left, sampleRate, 6, 36);
  shapeEnvelope(right, sampleRate, 6, 36);
  return normalizeStereo(left, right, 0.34, sampleRate);
}

function buildCorrectStereo(sampleRate) {
  // D-major arpeggio fallback (D5 -> F#5 -> A5) matching the baked Yamaha C5 piano arpeggio.
  const n = Math.max(64, Math.round(0.68 * sampleRate));
  const mono = new Float32Array(n);
  const rand = mulberry32(0x3309c5);
  addCelestaNote(mono, sampleRate, { startSec: 0, freqHz: 587.33, amp: 0.20, tau: 0.16, shimmer: 0.85, rand });
  addCelestaNote(mono, sampleRate, { startSec: 0.048, freqHz: 739.99, amp: 0.22, tau: 0.18, shimmer: 0.90, rand });
  addCelestaNote(mono, sampleRate, { startSec: 0.096, freqHz: 880.00, amp: 0.26, tau: 0.24, shimmer: 1.0, rand });
  applyBiquad(mono, sampleRate, 'highpass', 220, 0.7);
  shapeEnvelope(mono, sampleRate, 0.6, 55);
  return normalizeStereo(...addStereoMicroRoom(mono, sampleRate, 0.24), 0.40, sampleRate);
}

function buildLevelUpStereo(sampleRate) {
  // D-major Crystal Celesta mastery climb: D5 -> A5 -> D6.
  const n = Math.max(64, Math.round(0.75 * sampleRate));
  const mono = new Float32Array(n);
  const rand = mulberry32(7 * 7717 + 19);
  addCelestaNote(mono, sampleRate, { startSec: 0, freqHz: 587.33, amp: 0.20, tau: 0.16, shimmer: 0.9, rand });
  addCelestaNote(mono, sampleRate, { startSec: 0.062, freqHz: 880.00, amp: 0.24, tau: 0.19, shimmer: 1.0, rand });
  addCelestaNote(mono, sampleRate, { startSec: 0.128, freqHz: 1174.66, amp: 0.28, tau: 0.26, shimmer: 1.15, rand });
  applyBiquad(mono, sampleRate, 'highpass', 220, 0.7);
  shapeEnvelope(mono, sampleRate, 0.5, 55);
  return normalizeStereo(...addStereoMicroRoom(mono, sampleRate, 0.28), 0.44, sampleRate);
}

function buildMissStereo(sampleRate) {
  // Calm, clear non-punitive downward celesta interval: A4 -> F4.
  const n = Math.max(64, Math.round(0.32 * sampleRate));
  const mono = new Float32Array(n);
  const rand = mulberry32(4 * 7717 + 19);
  addCelestaNote(mono, sampleRate, { startSec: 0, freqHz: 440.00, amp: 0.22, tau: 0.075, shimmer: 0.45, rand });
  addCelestaNote(mono, sampleRate, { startSec: 0.068, freqHz: 349.23, amp: 0.20, tau: 0.095, shimmer: 0.35, rand });
  applyBiquad(mono, sampleRate, 'highpass', 180, 0.7);
  applyBiquad(mono, sampleRate, 'lowpass', 3000, 0.7);
  shapeEnvelope(mono, sampleRate, 0.8, 30);
  return normalizeStereo(...addStereoMicroRoom(mono, sampleRate, 0.16), 0.34, sampleRate);
}

function buildCompleteStereo(sampleRate) {
  // Luminous D-major completion arpeggio: D5 -> F#5 -> A5 -> D6.
  const n = Math.max(64, Math.round(1.05 * sampleRate));
  const mono = new Float32Array(n);
  const rand = mulberry32(8 * 7717 + 19);
  const chord = [
    [0.000, 587.33, 0.18, 0.28],
    [0.078, 739.99, 0.20, 0.30],
    [0.156, 880.00, 0.22, 0.32],
    [0.240, 1174.66, 0.25, 0.38],
  ];
  for (const [startSec, freqHz, amp, tau] of chord) {
    addCelestaNote(mono, sampleRate, { startSec, freqHz, amp, tau, shimmer: 1.0, rand });
  }
  applyBiquad(mono, sampleRate, 'highpass', 180, 0.7);
  shapeEnvelope(mono, sampleRate, 0.8, 85);
  return normalizeStereo(...addStereoMicroRoom(mono, sampleRate, 0.30), 0.45, sampleRate);
}

const STEREO_BUILDERS = Object.freeze({
  tap: buildTapStereo,
  flip: buildFlipStereo,
  correct: buildCorrectStereo,
  levelUp: buildLevelUpStereo,
  miss: buildMissStereo,
  complete: buildCompleteStereo,
});

function clampChannel(channel) {
  for (let i = 0; i < channel.length; i += 1) {
    if (!Number.isFinite(channel[i])) channel[i] = 0;
    else if (channel[i] > MAX_DSP_PEAK) channel[i] = MAX_DSP_PEAK;
    else if (channel[i] < -MAX_DSP_PEAK) channel[i] = -MAX_DSP_PEAK;
  }
  channel[0] = 0;
  channel[channel.length - 1] = 0;
  return channel;
}

function synthesizeStereoCue(cue, sampleRate = 44100) {
  const builder = STEREO_BUILDERS[cue];
  if (!builder) return null;
  const safeRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 44100;
  const [left, right] = builder(safeRate);
  return [clampChannel(left), clampChannel(right)];
}

/** Synthesize a click-free, bounded mono Float32Array PCM buffer for `cue` at `sampleRate`. */
export function synthesizeCueSamples(cue, sampleRate = 44100) {
  const pair = synthesizeStereoCue(cue, sampleRate);
  if (!pair) return null;
  const [left, right] = pair;
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i += 1) mono[i] = 0.5 * (left[i] + right[i]);
  return clampChannel(mono);
}

function decodeBase64ToArrayBuffer(dataUri) {
  const comma = dataUri.indexOf(',');
  const b64 = comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
  if (typeof globalThis.atob === 'function') {
    const bin = globalThis.atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  if (typeof globalThis.Buffer === 'function') {
    const buf = globalThis.Buffer.from(b64, 'base64');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  return null;
}

/** Trim any tiny MP3 encoder leading frame padding (<= 35 ms) so studio samples fire with zero lag. */
function trimDecodedEncoderPadding(ctx, buffer) {
  if (!buffer || typeof buffer.getChannelData !== 'function' || typeof ctx.createBuffer !== 'function') return buffer;
  const chs = buffer.numberOfChannels || 1;
  const len = buffer.length || 0;
  const sr = buffer.sampleRate || 44100;
  if (len < 128) return buffer;
  let peak = 0;
  for (let c = 0; c < chs; c += 1) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < len; i += 1) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak < 1e-5) return buffer;
  const thresh = peak * 0.015;
  const maxTrim = Math.min(len - 64, Math.round(sr * 0.035));
  let onset = 0;
  outer: for (let i = 0; i < maxTrim; i += 1) {
    for (let c = 0; c < chs; c += 1) {
      if (Math.abs(buffer.getChannelData(c)[i]) >= thresh) {
        onset = i;
        break outer;
      }
    }
  }
  const start = Math.max(0, onset - Math.round(sr * 0.002));
  if (start < 32) return buffer;
  const nextLen = len - start;
  const out = ctx.createBuffer(chs, nextLen, sr);
  const fadeIn = Math.min(nextLen, Math.round(sr * 0.0015));
  for (let c = 0; c < chs; c += 1) {
    const src = buffer.getChannelData(c).subarray(start);
    const dst = out.getChannelData(c);
    dst.set(src);
    for (let i = 0; i < fadeIn; i += 1) dst[i] *= i / fadeIn;
  }
  return out;
}

let sharedCtx = null;
let sharedCtxRate = 0;
let cachedBuffers = new Map();
let cachedDspBuffers = new Map();
const cachedStereoSamples = new Map();
let sampleDecodePromises = new Map();
let bakedAssets = null;
let bakedAssetsPromise = null;
let lastPlayedAt = 0;
const lastCueAt = new Map();
let idleTimer = null;
let prebakeHandle = null;
let prebakeQueue = [];
let prebakeRate = 44100;
let previewTimers = [];
let previewGeneration = 0;
const activePreviewSources = new Set();
let pendingSuspendedCue = null;

function cancelPrebake() {
  if (prebakeHandle === null) return;
  if (typeof globalThis.cancelIdleCallback === 'function') {
    try { globalThis.cancelIdleCallback(prebakeHandle); } catch { /* ignore */ }
  }
  prebakeHandle = null;
  prebakeQueue = [];
}

function getOrSynthesizeStereo(cue, rate) {
  const key = `${cue}@${rate}`;
  if (cachedStereoSamples.has(key)) return cachedStereoSamples.get(key);
  const pair = synthesizeStereoCue(cue, rate);
  if (pair) cachedStereoSamples.set(key, pair);
  return pair;
}

function loadBakedAssets() {
  if (bakedAssets) return Promise.resolve(bakedAssets);
  if (!bakedAssetsPromise) {
    bakedAssetsPromise = import('./sound-effects-assets.js')
      .then((mod) => {
        bakedAssets = {
          uris: mod?.BAKED_SAMPLE_DATA_URIS || {},
          gains: mod?.BAKED_SAMPLE_GAINS || {},
        };
        return bakedAssets;
      })
      .catch(() => {
        bakedAssetsPromise = null;
        return null;
      });
  }
  return bakedAssetsPromise;
}

function decodeSampleBuffer(ctx, cue) {
  if (!SAMPLE_CUES.has(cue) || typeof ctx?.decodeAudioData !== 'function') return null;
  const rate = ctx.sampleRate || sharedCtxRate || 44100;
  const key = `${cue}@${rate}`;
  if (cachedBuffers.has(key)) return Promise.resolve(cachedBuffers.get(key));
  if (sampleDecodePromises.has(key)) return sampleDecodePromises.get(key);

  const promise = loadBakedAssets()
    .then((assets) => {
      if (ctx !== sharedCtx) return null;
      const dataUri = assets?.uris?.[cue];
      const raw = dataUri ? decodeBase64ToArrayBuffer(dataUri) : null;
      if (!raw) return null;
      return ctx.decodeAudioData(raw.slice(0));
    })
    .then((decoded) => {
      if (ctx !== sharedCtx) return null;
      sampleDecodePromises.delete(key);
      if (!decoded) return null;
      const trimmed = trimDecodedEncoderPadding(ctx, decoded);
      const entry = { buffer: trimmed, isSample: true };
      cachedBuffers.set(key, entry);
      return entry;
    }, () => {
      if (ctx === sharedCtx) sampleDecodePromises.delete(key);
      return null;
    });
  sampleDecodePromises.set(key, promise);
  return promise;
}

function preloadSampleBuffers(ctx) {
  if (!ctx || typeof ctx.decodeAudioData !== 'function') return;
  for (const cue of SAMPLE_CUES) decodeSampleBuffer(ctx, cue);
}

function getDspBuffer(ctx, cue) {
  const rate = ctx.sampleRate || sharedCtxRate || 44100;
  const key = `${cue}@${rate}`;
  if (cachedDspBuffers.has(key)) return cachedDspBuffers.get(key);
  const pair = getOrSynthesizeStereo(cue, rate);
  if (!pair || typeof ctx.createBuffer !== 'function') return null;
  const [left, right] = pair;
  const buffer = ctx.createBuffer(2, left.length, rate);
  if (typeof buffer.copyToChannel === 'function') {
    buffer.copyToChannel(left, 0);
    buffer.copyToChannel(right, 1);
  } else {
    buffer.getChannelData?.(0)?.set?.(left);
    if ((buffer.numberOfChannels || 1) > 1) buffer.getChannelData?.(1)?.set?.(right);
  }
  const entry = { buffer, isSample: false };
  cachedDspBuffers.set(key, entry);
  return entry;
}

function getReadyBufferEntry(ctx, cue) {
  const rate = ctx.sampleRate || sharedCtxRate || 44100;
  const key = `${cue}@${rate}`;
  if (SAMPLE_CUES.has(cue) && typeof ctx.decodeAudioData === 'function') {
    if (cachedBuffers.has(key)) return cachedBuffers.get(key);
    return null;
  }
  return getDspBuffer(ctx, cue);
}

function runPrebakeSlice(deadline) {
  prebakeHandle = null;
  if (getAppearanceSound() === 'off') {
    prebakeQueue = [];
    return;
  }
  const rate = sharedCtxRate || prebakeRate || 44100;
  while (prebakeQueue.length) {
    const cue = prebakeQueue.shift();
    const key = `${cue}@${rate}`;
    if (!SAMPLE_CUES.has(cue)) {
      if (!cachedStereoSamples.has(key)) getOrSynthesizeStereo(cue, rate);
      if (sharedCtx && sharedCtx.state !== 'closed' && sharedCtx.sampleRate === rate && !cachedDspBuffers.has(key)) {
        getDspBuffer(sharedCtx, cue);
      }
    } else if (sharedCtx && sharedCtx.state !== 'closed') {
      decodeSampleBuffer(sharedCtx, cue);
    }
    if (deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() <= 2) break;
  }
  if (prebakeQueue.length && typeof globalThis.requestIdleCallback === 'function') {
    prebakeHandle = globalThis.requestIdleCallback(runPrebakeSlice, { timeout: 2000 });
  }
}

/** Schedule idle pre-baking of waveforms when sound is enabled, without constructing AudioContext early. */
export function scheduleSoundPrebake(sampleRate = sharedCtxRate || 44100) {
  if (getAppearanceSound() === 'off') return false;
  if (typeof globalThis.requestIdleCallback !== 'function') return false;
  const rate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 44100;
  prebakeRate = rate;
  const missing = SOUND_CUES.filter((cue) => (
    SAMPLE_CUES.has(cue)
      ? !cachedBuffers.has(`${cue}@${rate}`)
      : !cachedStereoSamples.has(`${cue}@${rate}`)
  ));
  if (!missing.length) return false;
  prebakeQueue = missing;
  if (prebakeHandle === null) {
    prebakeHandle = globalThis.requestIdleCallback(runPrebakeSlice, { timeout: 2000 });
  }
  return true;
}

onAppearanceCacheChange((prefs) => {
  if (prefs?.minimal === 'on') {
    stopSoundPreview();
    cancelPrebake();
    return;
  }
  if (prefs?.sound && prefs.sound !== 'off') scheduleSoundPrebake();
  else cancelPrebake();
});

function clearPreviewTimers() {
  for (const timer of previewTimers) clearTimeout(timer);
  previewTimers = [];
}

/** Cancel any queued or in-flight Settings › Appearance sound preview cues. */
export function stopSoundPreview() {
  previewGeneration += 1;
  clearPreviewTimers();
  if (pendingSuspendedCue?.options?.preview) pendingSuspendedCue = null;
  for (const entry of [...activePreviewSources]) {
    activePreviewSources.delete(entry);
    try { entry.source.stop?.(); } catch { /* ignore */ }
    entry.disconnect();
  }
}

function clearIdleTimer() {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleSuspend() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (sharedCtx && sharedCtx.state === 'running') {
      try { Promise.resolve(sharedCtx.suspend?.()).catch(() => {}); } catch { /* ignore */ }
    }
  }, IDLE_SUSPEND_MS);
  idleTimer.unref?.();
}

function getOrCreateContext() {
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioCtx !== 'function') return null;
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new AudioCtx();
    sharedCtxRate = sharedCtx.sampleRate || 44100;
    cachedBuffers = new Map();
    cachedDspBuffers = new Map();
    sampleDecodePromises = new Map();
    preloadSampleBuffers(sharedCtx);
    scheduleSoundPrebake(sharedCtxRate);
  }
  return sharedCtx;
}

function resolveCueGain(cue, tier, isSample) {
  const tierScale = TIER_SCALE[tier] ?? TIER_SCALE.subtle;
  if (isSample) {
    const sampleScale = bakedAssets?.gains?.[cue] ?? 0.5;
    return Math.min(1.0, sampleScale * tierScale);
  }
  return (DSP_CUE_GAINS[cue] ?? 0.85) * tierScale;
}

function startCuePlayback(ctx, entry, cue, tier, options = {}) {
  const buffer = entry?.buffer;
  const source = ctx.createBufferSource?.();
  const gain = ctx.createGain?.();
  if (!buffer || !source || !gain || !ctx.destination) return false;

  const targetGain = resolveCueGain(cue, tier, !!entry.isSample);
  const startAt = ctx.currentTime || 0;
  source.buffer = buffer;
  if (source.playbackRate) {
    const jitter = CUE_JITTER[cue] || 0;
    source.playbackRate.value = jitter ? 1 + (Math.random() * 2 - 1) * jitter : 1;
  }
  gain.gain?.setValueAtTime?.(targetGain, startAt);

  let airBus = null;
  source.connect(gain);
  if (typeof ctx.createBiquadFilter === 'function') {
    airBus = ctx.createBiquadFilter();
    airBus.type = 'lowpass';
    airBus.frequency?.setValueAtTime?.(AIR_BUS_CUTOFF_HZ, startAt);
    airBus.Q?.setValueAtTime?.(Math.SQRT1_2, startAt);
    gain.connect(airBus);
    airBus.connect(ctx.destination);
  } else {
    gain.connect(ctx.destination);
  }

  let disconnected = false;
  let previewEntry = null;
  const disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    if (previewEntry) activePreviewSources.delete(previewEntry);
    try { source.disconnect?.(); } catch { /* ignore */ }
    try { gain.disconnect?.(); } catch { /* ignore */ }
    if (airBus) {
      try { airBus.disconnect?.(); } catch { /* ignore */ }
    }
  };
  if (options.preview) {
    previewEntry = { source, disconnect };
    activePreviewSources.add(previewEntry);
  }
  source.onended = disconnect;

  source.start(startAt);
  scheduleIdleSuspend();
  return true;
}

function canPlayDeferred(ctx, requestedAt, options, capturedPreviewGen) {
  if (ctx !== sharedCtx || ctx.state !== 'running') return false;
  if (Date.now() - requestedAt > SUSPENDED_STALE_MS) return false;
  if (options.preview && capturedPreviewGen !== previewGeneration) return false;
  if (isAudioCaptureActive()) return false;
  if (!options.allowHidden && globalThis.document?.hidden === true) return false;
  const latestMode = options.mode ?? getAppearanceSound();
  if (!options.force && latestMode === 'off') return false;
  return true;
}

function playResolvedOrDecoded(ctx, cue, tier, options, requestedAt, capturedPreviewGen) {
  const ready = getReadyBufferEntry(ctx, cue);
  if (ready) return startCuePlayback(ctx, ready, cue, tier, options);

  const decoding = decodeSampleBuffer(ctx, cue);
  if (decoding) {
    decoding.then((entry) => {
      if (!canPlayDeferred(ctx, requestedAt, options, capturedPreviewGen)) return;
      const resolved = entry || getDspBuffer(ctx, cue);
      if (resolved) startCuePlayback(ctx, resolved, cue, tier, options);
    });
    return true;
  }

  const fallback = getDspBuffer(ctx, cue);
  return fallback ? startCuePlayback(ctx, fallback, cue, tier, options) : false;
}

/** Play one study cue respecting the learner's sound mode, mic mute guard, tab visibility and cooldowns. */
export function playSound(cue, options = {}) {
  try {
    if (!SOUND_CUES.includes(cue)) return false;
    if (isAudioCaptureActive()) return false;
    const mode = options.mode ?? getAppearanceSound();
    if (!options.force && mode === 'off') return false;
    const tier = mode === 'standard' ? 'standard' : 'subtle';
    if (!options.force && tier === 'subtle' && !SUBTLE_CUES.has(cue)) return false;
    if (!options.allowHidden && globalThis.document?.hidden === true) return false;

    const nowMs = Date.now();
    if (!options.skipThrottle) {
      if (nowMs - lastPlayedAt < GLOBAL_COOLDOWN_MS) return false;
      if (nowMs - (lastCueAt.get(cue) || 0) < CUE_COOLDOWN_MS) return false;
    }

    const ctx = getOrCreateContext();
    if (!ctx || !ctx.destination || typeof ctx.createBufferSource !== 'function' || typeof ctx.createGain !== 'function') {
      return false;
    }

    const capturedPreviewGen = previewGeneration;
    if (ctx.state === 'suspended') {
      lastPlayedAt = nowMs;
      lastCueAt.set(cue, nowMs);
      pendingSuspendedCue = { cue, tier, options, requestedAt: nowMs, previewGen: capturedPreviewGen };
      const resuming = Promise.resolve(ctx.resume?.());
      if (ctx.state === 'suspended') {
        resuming.then(() => {
          const pending = pendingSuspendedCue;
          pendingSuspendedCue = null;
          if (!pending || !canPlayDeferred(ctx, pending.requestedAt, pending.options, pending.previewGen)) return;
          playResolvedOrDecoded(ctx, pending.cue, pending.tier, pending.options, pending.requestedAt, pending.previewGen);
        }, () => {
          pendingSuspendedCue = null;
        });
        return true;
      }
      pendingSuspendedCue = null;
    }

    lastPlayedAt = nowMs;
    lastCueAt.set(cue, nowMs);
    return playResolvedOrDecoded(ctx, cue, tier, options, nowMs, capturedPreviewGen);
  } catch {
    return false;
  }
}

/** Luminous D-major chime for TodayTimer (allowed in background tabs unless mic/tab capture or Minimal Mode is active). */
export function playTimerChime() {
  if (isMinimalMode()) return false;
  return playSound('complete', { force: true, allowHidden: true, skipThrottle: true });
}

/** Audition the current sound tier from Settings › Appearance (works even when mode is still 'off', muted in Minimal Mode). */
export function playSoundPreview(mode = 'subtle') {
  stopSoundPreview();
  if (isAudioCaptureActive() || isMinimalMode()) return false;
  const tier = mode === 'standard' ? 'standard' : 'subtle';
  const sequence = tier === 'standard'
    ? [
      { delayMs: 0, cue: 'tap' },
      { delayMs: 180, cue: 'flip' },
      { delayMs: 920, cue: 'correct' },
    ]
    : [
      { delayMs: 0, cue: 'flip' },
      { delayMs: 740, cue: 'correct' },
    ];
  let started = false;
  for (const step of sequence) {
    if (step.delayMs === 0) {
      started = playSound(step.cue, { mode: tier, force: true, skipThrottle: true, preview: true });
    } else {
      const timer = setTimeout(() => {
        playSound(step.cue, { mode: tier, force: true, skipThrottle: true, preview: true });
      }, step.delayMs);
      timer.unref?.();
      previewTimers.push(timer);
    }
  }
  return started;
}

/** Release timers, cooldowns and the shared Web Audio context cleanly between unit tests. */
export function resetSoundEngineForTests() {
  stopSoundPreview();
  cancelPrebake();
  pendingSuspendedCue = null;
  clearIdleTimer();
  lastPlayedAt = 0;
  lastCueAt.clear();
  cachedBuffers.clear();
  cachedDspBuffers.clear();
  cachedStereoSamples.clear();
  sampleDecodePromises.clear();
  bakedAssets = null;
  bakedAssetsPromise = null;
  invalidateAppearanceCache();
  if (sharedCtx) {
    try { Promise.resolve(sharedCtx.close?.()).catch(() => {}); } catch { /* ignore */ }
    sharedCtx = null;
    sharedCtxRate = 0;
  }
}
