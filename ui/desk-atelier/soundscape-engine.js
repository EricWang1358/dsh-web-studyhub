/* 100% Offline Procedural Web Audio Soundscape Engine for StudyHub Desk Atelier.
   - Zero MP3 bundles, zero CDN fetches, zero AudioWorklet blob URLs (strict web-demo CSP safe).
   - Pre-renders seamlessly equal-power crossfaded stereo AudioBuffer loops on demand (low CPU).
   - Default OFF: zero AudioContext constructed until the learner explicitly enables playback.
   - Auto-mutes immediately whenever Live Class or Voice Mic capture is active (ui/audio-capture-state.js). */
import { isAudioCaptureActive } from '../audio-capture-state.js';
import { ATELIER_CHANNEL_IDS, hasActiveChannel } from './atelier-presets.js';
import { sharedAtelierStore } from './atelier-storage.js';

const MAX_CHANNEL_PEAK = 0.44;
const MASTER_HEADROOM = 0.62;
const AIR_BUS_CUTOFF_HZ = 11_500;
const CAPTURE_POLL_MS = 250;

// Coprime-like loop durations (seconds) so layered channels never phase-lock or feel repetitive.
export const CHANNEL_LOOP_SECONDS = Object.freeze({
  rain: 7.0,
  vinyl: 5.3,
  hearth: 6.7,
  bamboo: 11.3,
  hum: 5.9,
});

// D-major pentatonic concert-tuned notes matching ui/sound-effects.js acoustic family.
export const BAMBOO_PENTATONIC_HZ = Object.freeze([
  293.66, // D4
  329.63, // E4
  369.99, // F#4
  440.0,  // A4
  493.88, // B4
  587.33, // D5
]);

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Causal 2nd-order RBJ biquad filter (lowpass / highpass / bandpass). */
function applyBiquad(samples, sampleRate, type, cutoffHz, q = Math.SQRT1_2) {
  const fc = Math.max(30, Math.min(cutoffHz, sampleRate * 0.45));
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * q);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;
  if (type === 'bandpass') {
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else if (type === 'highpass') {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else {
    b0 = (1 - cos) / 2;
    b1 = 1 - cos;
    b2 = (1 - cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  }
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  a1 /= a0;
  a2 /= a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
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

/** Paul Kellet 7-pole pink noise generator for smooth, organic -3dB/octave spectral slope. */
function fillPinkNoise(length, seed) {
  const out = new Float32Array(length);
  const rand = mulberry32(seed);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < length; i += 1) {
    const white = rand() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  return out;
}

/** Leaky-integrated brownian noise (-6dB/octave warmth) with DC stabilization. */
function fillBrownNoise(length, seed, leak = 0.994) {
  const out = new Float32Array(length);
  const rand = mulberry32(seed);
  let acc = 0;
  for (let i = 0; i < length; i += 1) {
    const white = rand() * 2 - 1;
    acc = acc * leak + white * 0.065;
    out[i] = acc;
  }
  return out;
}

/** Equal-power sine/cosine loop crossfade: folds [loopLen .. loopLen + fadeLen) cleanly onto [0 .. fadeLen). */
function crossfadeSeamlessLoop(raw, loopLen, fadeLen) {
  const out = new Float32Array(loopLen);
  const safeFade = Math.min(fadeLen, Math.floor(loopLen * 0.35), Math.max(0, raw.length - loopLen));
  for (let i = 0; i < loopLen; i += 1) {
    if (i < safeFade) {
      const t = i / safeFade;
      const wHead = Math.sin(t * Math.PI * 0.5);
      const wTail = Math.cos(t * Math.PI * 0.5);
      out[i] = raw[i] * wHead + raw[loopLen + i] * wTail;
    } else {
      out[i] = raw[i];
    }
  }
  return out;
}

function normalizeAndClampStereo(left, right, targetRms, maxPeak = MAX_CHANNEL_PEAK) {
  let energy = 0;
  for (let i = 0; i < left.length; i += 1) {
    const l = Number.isFinite(left[i]) ? left[i] : 0;
    const r = Number.isFinite(right[i]) ? right[i] : 0;
    left[i] = l;
    right[i] = r;
    energy += l * l + r * r;
  }
  const rms = Math.sqrt(energy / Math.max(1, left.length * 2));
  const scale = rms > 1e-6 ? targetRms / rms : 1;
  for (let i = 0; i < left.length; i += 1) {
    let l = left[i] * scale;
    let r = right[i] * scale;
    // Soft tanh knee near ceiling to eliminate harsh clipping on crackles/droplets.
    if (Math.abs(l) > maxPeak * 0.85) l = maxPeak * Math.tanh(l / maxPeak);
    if (Math.abs(r) > maxPeak * 0.85) r = maxPeak * Math.tanh(r / maxPeak);
    left[i] = Math.max(-maxPeak, Math.min(maxPeak, l));
    right[i] = Math.max(-maxPeak, Math.min(maxPeak, r));
  }
  return [left, right];
}

function synthesizeRainStereo(sampleRate, durationSec) {
  const loopLen = Math.max(256, Math.round(durationSec * sampleRate));
  const fadeLen = Math.max(64, Math.round(Math.min(1.0, durationSec * 0.16) * sampleRate));
  const totalLen = loopLen + fadeLen;

  const leftRaw = fillPinkNoise(totalLen, 0x51a701);
  const rightRaw = fillPinkNoise(totalLen, 0x51a702);
  applyBiquad(leftRaw, sampleRate, 'highpass', 180, 0.7);
  applyBiquad(rightRaw, sampleRate, 'highpass', 180, 0.7);
  applyBiquad(leftRaw, sampleRate, 'lowpass', 3600, 0.65);
  applyBiquad(rightRaw, sampleRate, 'lowpass', 3900, 0.65);

  // Subtle periodic rain-gust swell wrapped over exact loopLen.
  const swellOmega = (2 * Math.PI) / loopLen;
  for (let i = 0; i < totalLen; i += 1) {
    const swellL = 0.88 + 0.12 * Math.sin(swellOmega * i) + 0.05 * Math.cos(swellOmega * 2 * i + 0.7);
    const swellR = 0.88 + 0.12 * Math.sin(swellOmega * i + 0.45) + 0.05 * Math.cos(swellOmega * 2 * i + 1.3);
    leftRaw[i] *= swellL;
    rightRaw[i] *= swellR;
  }

  // Gentle bandpass window droplets.
  const dropRand = mulberry32(0x51a703);
  const dropCount = Math.max(8, Math.round(durationSec * 7.5));
  for (let d = 0; d < dropCount; d += 1) {
    const start = Math.floor(dropRand() * (totalLen - Math.round(sampleRate * 0.045)));
    const freq = 1050 + dropRand() * 1550;
    const tau = 0.008 + dropRand() * 0.016;
    const amp = 0.045 + dropRand() * 0.06;
    const pan = dropRand();
    const gL = Math.cos(pan * Math.PI * 0.5) * amp;
    const gR = Math.sin(pan * Math.PI * 0.5) * amp;
    const durSamples = Math.min(totalLen - start, Math.round(tau * 5 * sampleRate));
    for (let k = 0; k < durSamples; k += 1) {
      const t = k / sampleRate;
      const env = (t < 0.0012 ? t / 0.0012 : 1) * Math.exp(-t / tau);
      const tone = Math.sin(2 * Math.PI * freq * t * (1 + 0.08 * Math.exp(-t / 0.004)));
      const s = env * tone;
      leftRaw[start + k] += s * gL;
      rightRaw[start + k] += s * gR;
    }
  }

  const left = crossfadeSeamlessLoop(leftRaw, loopLen, fadeLen);
  const right = crossfadeSeamlessLoop(rightRaw, loopLen, fadeLen);
  return normalizeAndClampStereo(left, right, 0.14);
}

function synthesizeVinylStereo(sampleRate, durationSec) {
  const loopLen = Math.max(256, Math.round(durationSec * sampleRate));
  const fadeLen = Math.max(64, Math.round(Math.min(0.8, durationSec * 0.16) * sampleRate));
  const totalLen = loopLen + fadeLen;

  const bedL = fillBrownNoise(totalLen, 0x62b801, 0.992);
  const bedR = fillBrownNoise(totalLen, 0x62b802, 0.992);
  applyBiquad(bedL, sampleRate, 'highpass', 55, 0.7);
  applyBiquad(bedR, sampleRate, 'highpass', 55, 0.7);
  applyBiquad(bedL, sampleRate, 'lowpass', 320, 0.7);
  applyBiquad(bedR, sampleRate, 'lowpass', 320, 0.7);

  // Warm paper-room air shimmer bed.
  const airL = fillPinkNoise(totalLen, 0x62b803);
  const airR = fillPinkNoise(totalLen, 0x62b804);
  applyBiquad(airL, sampleRate, 'bandpass', 1450, 0.9);
  applyBiquad(airR, sampleRate, 'bandpass', 1550, 0.9);

  // Subtle 33.3 RPM analog turntable warmth pulse (~0.555 Hz locked to nearest loop harmonic).
  const revCycles = Math.max(1, Math.round(durationSec * 0.555));
  const revOmega = (2 * Math.PI * revCycles) / loopLen;

  const leftRaw = new Float32Array(totalLen);
  const rightRaw = new Float32Array(totalLen);
  for (let i = 0; i < totalLen; i += 1) {
    const wobble = 0.92 + 0.08 * Math.sin(revOmega * i);
    leftRaw[i] = bedL[i] * 0.9 * wobble + airL[i] * 0.24;
    rightRaw[i] = bedR[i] * 0.9 * wobble + airR[i] * 0.24;
  }

  // Stochastic micro-dust pops & gentle crackle.
  const popRand = mulberry32(0x62b805);
  const popCount = Math.max(10, Math.round(durationSec * 8.5));
  const crackleL = new Float32Array(totalLen);
  const crackleR = new Float32Array(totalLen);
  for (let p = 0; p < popCount; p += 1) {
    const start = Math.floor(popRand() * (totalLen - Math.round(sampleRate * 0.012)));
    const amp = (0.04 + popRand() * 0.09) * (popRand() < 0.25 ? 1.4 : 0.8);
    const tau = 0.001 + popRand() * 0.0022;
    const pan = 0.2 + popRand() * 0.6;
    const gL = Math.cos(pan * Math.PI * 0.5) * amp;
    const gR = Math.sin(pan * Math.PI * 0.5) * amp;
    const len = Math.min(totalLen - start, Math.round(tau * 6 * sampleRate));
    for (let k = 0; k < len; k += 1) {
      const t = k / sampleRate;
      const burst = (popRand() * 2 - 1) * Math.exp(-t / tau);
      crackleL[start + k] += burst * gL;
      crackleR[start + k] += burst * gR;
    }
  }
  applyBiquad(crackleL, sampleRate, 'bandpass', 3800, 1.1);
  applyBiquad(crackleR, sampleRate, 'bandpass', 4100, 1.1);

  for (let i = 0; i < totalLen; i += 1) {
    leftRaw[i] += crackleL[i];
    rightRaw[i] += crackleR[i];
  }

  const left = crossfadeSeamlessLoop(leftRaw, loopLen, fadeLen);
  const right = crossfadeSeamlessLoop(rightRaw, loopLen, fadeLen);
  return normalizeAndClampStereo(left, right, 0.11);
}

function synthesizeHearthStereo(sampleRate, durationSec) {
  const loopLen = Math.max(256, Math.round(durationSec * sampleRate));
  const fadeLen = Math.max(64, Math.round(Math.min(0.9, durationSec * 0.16) * sampleRate));
  const totalLen = loopLen + fadeLen;

  const bedL = fillBrownNoise(totalLen, 0x73c901, 0.996);
  const bedR = fillBrownNoise(totalLen, 0x73c902, 0.996);
  applyBiquad(bedL, sampleRate, 'highpass', 42, 0.7);
  applyBiquad(bedR, sampleRate, 'highpass', 42, 0.7);
  applyBiquad(bedL, sampleRate, 'lowpass', 240, 0.65);
  applyBiquad(bedR, sampleRate, 'lowpass', 255, 0.65);

  // Warm flame-draft flicker (exact harmonics of loopLen).
  const w1 = (2 * Math.PI * 2) / loopLen;
  const w2 = (2 * Math.PI * 5) / loopLen;
  const leftRaw = new Float32Array(totalLen);
  const rightRaw = new Float32Array(totalLen);
  for (let i = 0; i < totalLen; i += 1) {
    const flickerL = 0.8 + 0.14 * Math.sin(w1 * i) + 0.08 * Math.sin(w2 * i + 0.9);
    const flickerR = 0.8 + 0.14 * Math.sin(w1 * i + 0.35) + 0.08 * Math.sin(w2 * i + 1.7);
    leftRaw[i] = bedL[i] * flickerL;
    rightRaw[i] = bedR[i] * flickerR;
  }

  // Sparse wood-ember pops and warm crackling hiss.
  const popRand = mulberry32(0x73c903);
  const popCount = Math.max(8, Math.round(durationSec * 4.5));
  const popL = new Float32Array(totalLen);
  const popR = new Float32Array(totalLen);
  for (let p = 0; p < popCount; p += 1) {
    const start = Math.floor(popRand() * (totalLen - Math.round(sampleRate * 0.03)));
    const amp = 0.07 + popRand() * 0.13;
    const tau = 0.002 + popRand() * 0.006;
    const pan = 0.15 + popRand() * 0.7;
    const gL = Math.cos(pan * Math.PI * 0.5) * amp;
    const gR = Math.sin(pan * Math.PI * 0.5) * amp;
    const len = Math.min(totalLen - start, Math.round(tau * 6 * sampleRate));
    for (let k = 0; k < len; k += 1) {
      const t = k / sampleRate;
      const env = (t < 0.0005 ? t / 0.0005 : 1) * Math.exp(-t / tau);
      const grain = (popRand() * 2 - 1) * env;
      popL[start + k] += grain * gL;
      popR[start + k] += grain * gR;
    }
  }
  applyBiquad(popL, sampleRate, 'bandpass', 1850, 0.9);
  applyBiquad(popR, sampleRate, 'bandpass', 1950, 0.9);

  for (let i = 0; i < totalLen; i += 1) {
    leftRaw[i] += popL[i] * 0.85;
    rightRaw[i] += popR[i] * 0.85;
  }

  const left = crossfadeSeamlessLoop(leftRaw, loopLen, fadeLen);
  const right = crossfadeSeamlessLoop(rightRaw, loopLen, fadeLen);
  return normalizeAndClampStereo(left, right, 0.145);
}

function addFeltBambooNote(left, right, sampleRate, { startSec, freqHz, amp, tau, pan }) {
  const startIdx = Math.max(0, Math.round(startSec * sampleRate));
  const gL = Math.cos(pan * Math.PI * 0.5) * amp;
  const gR = Math.sin(pan * Math.PI * 0.5) * amp;
  const ratios = [1.0, 2.004, 2.992];
  const partialAmps = [1.0, 0.28, 0.09];
  const partialTaus = [tau, tau * 0.42, tau * 0.18];
  const len = Math.min(left.length - startIdx, Math.round(tau * 5.2 * sampleRate));
  const reflectL = Math.round(sampleRate * 0.011);
  const reflectR = Math.round(sampleRate * 0.017);

  for (let k = 0; k < len; k += 1) {
    const t = k / sampleRate;
    const attack = t < 0.007 ? 0.5 * (1 - Math.cos((Math.PI * t) / 0.007)) : 1;
    let body = 0;
    for (let p = 0; p < ratios.length; p += 1) {
      body += partialAmps[p] * Math.exp(-t / partialTaus[p]) * Math.sin(2 * Math.PI * freqHz * ratios[p] * t);
    }
    const sample = attack * body;
    const idx = startIdx + k;
    left[idx] += sample * gL;
    right[idx] += sample * gR;
    if (idx + reflectL < left.length) left[idx + reflectL] += sample * gR * 0.16;
    if (idx + reflectR < right.length) right[idx + reflectR] += sample * gL * 0.14;
  }
}

function synthesizeBambooStereo(sampleRate, durationSec) {
  const loopLen = Math.max(256, Math.round(durationSec * sampleRate));
  const fadeLen = Math.max(64, Math.round(Math.min(1.2, durationSec * 0.14) * sampleRate));
  const totalLen = loopLen + fadeLen;

  // Soft bandpass wind through bamboo leaves.
  const windL = fillPinkNoise(totalLen, 0x84da01);
  const windR = fillPinkNoise(totalLen, 0x84da02);
  applyBiquad(windL, sampleRate, 'bandpass', 580, 1.25);
  applyBiquad(windR, sampleRate, 'bandpass', 640, 1.25);

  const wBreeze = (2 * Math.PI) / loopLen;
  const leftRaw = new Float32Array(totalLen);
  const rightRaw = new Float32Array(totalLen);
  for (let i = 0; i < totalLen; i += 1) {
    const gustL = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(wBreeze * i));
    const gustR = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(wBreeze * i + 0.6));
    leftRaw[i] = windL[i] * gustL * 0.65;
    rightRaw[i] = windR[i] * gustR * 0.65;
  }

  // Sparse D-major pentatonic felt-mallet strikes spaced gracefully inside safe inner window.
  const phrase = [
    { frac: 0.14, noteIdx: 0, amp: 0.14, tau: 0.72, pan: 0.34 }, // D4
    { frac: 0.29, noteIdx: 3, amp: 0.12, tau: 0.68, pan: 0.66 }, // A4
    { frac: 0.51, noteIdx: 2, amp: 0.13, tau: 0.70, pan: 0.42 }, // F#4
    { frac: 0.72, noteIdx: 4, amp: 0.11, tau: 0.64, pan: 0.60 }, // B4
    { frac: 0.84, noteIdx: 5, amp: 0.10, tau: 0.62, pan: 0.48 }, // D5
  ];
  for (const strike of phrase) {
    addFeltBambooNote(leftRaw, rightRaw, sampleRate, {
      startSec: durationSec * strike.frac,
      freqHz: BAMBOO_PENTATONIC_HZ[strike.noteIdx],
      amp: strike.amp,
      tau: strike.tau,
      pan: strike.pan,
    });
  }

  const left = crossfadeSeamlessLoop(leftRaw, loopLen, fadeLen);
  const right = crossfadeSeamlessLoop(rightRaw, loopLen, fadeLen);
  return normalizeAndClampStereo(left, right, 0.105);
}

function synthesizeHumStereo(sampleRate, durationSec) {
  const loopLen = Math.max(256, Math.round(durationSec * sampleRate));
  const fadeLen = Math.max(64, Math.round(Math.min(0.9, durationSec * 0.16) * sampleRate));
  const totalLen = loopLen + fadeLen;

  const pinkL = fillPinkNoise(totalLen, 0x95eb01);
  const pinkR = fillPinkNoise(totalLen, 0x95eb02);
  const brownL = fillBrownNoise(totalLen, 0x95eb03, 0.994);
  const brownR = fillBrownNoise(totalLen, 0x95eb04, 0.994);

  const leftRaw = new Float32Array(totalLen);
  const rightRaw = new Float32Array(totalLen);
  for (let i = 0; i < totalLen; i += 1) {
    leftRaw[i] = pinkL[i] * 0.55 + brownL[i] * 0.45;
    rightRaw[i] = pinkR[i] * 0.55 + brownR[i] * 0.45;
  }
  applyBiquad(leftRaw, sampleRate, 'highpass', 58, 0.7);
  applyBiquad(rightRaw, sampleRate, 'highpass', 58, 0.7);
  applyBiquad(leftRaw, sampleRate, 'lowpass', 920, 0.65);
  applyBiquad(rightRaw, sampleRate, 'lowpass', 920, 0.65);

  const left = crossfadeSeamlessLoop(leftRaw, loopLen, fadeLen);
  const right = crossfadeSeamlessLoop(rightRaw, loopLen, fadeLen);
  return normalizeAndClampStereo(left, right, 0.14);
}

const CHANNEL_BUILDERS = Object.freeze({
  rain: synthesizeRainStereo,
  vinyl: synthesizeVinylStereo,
  hearth: synthesizeHearthStereo,
  bamboo: synthesizeBambooStereo,
  hum: synthesizeHumStereo,
});

/** Pure offline stereo synthesis for any channel (exported for tests and DSP diagnostics). */
export function synthesizeSoundscapeChannel(channelId, sampleRate = 44100, options = {}) {
  const builder = CHANNEL_BUILDERS[channelId];
  if (!builder) return null;
  const safeRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 44100;
  const durationSec = Number.isFinite(options.durationSec) && options.durationSec >= 0.4
    ? options.durationSec
    : CHANNEL_LOOP_SECONDS[channelId];
  const [left, right] = builder(safeRate, durationSec);
  return { left, right, sampleRate: safeRate, durationSec };
}

// ── Live Web Audio Graph Singleton ───────────────────────────────────────────

let audioCtx = null;
let masterGain = null;
let airBus = null;
let cachedBuffers = new Map();
const activeChannels = new Map(); // channelId -> { source, gain }
let captureWatchTimer = null;
let suspendTimer = null;
let unloadHookInstalled = false;

function clearSuspendTimer() {
  if (suspendTimer !== null) {
    clearTimeout(suspendTimer);
    suspendTimer = null;
  }
}

function stopCaptureWatcher() {
  if (captureWatchTimer !== null) {
    clearTimeout(captureWatchTimer);
    captureWatchTimer = null;
  }
}

function rampParam(param, target, now, rampSec) {
  if (!param) return;
  const clamped = Math.max(0, Math.min(1, Number.isFinite(target) ? target : 0));
  if (typeof param.cancelScheduledValues === 'function') {
    param.cancelScheduledValues(now);
  }
  if (typeof param.setValueAtTime === 'function') {
    const current = Number.isFinite(param.value) ? param.value : clamped;
    param.setValueAtTime(current, now);
  }
  if (rampSec > 0 && typeof param.linearRampToValueAtTime === 'function') {
    param.linearRampToValueAtTime(clamped, now + rampSec);
  } else if (typeof param.setValueAtTime === 'function') {
    param.setValueAtTime(clamped, now);
  } else {
    param.value = clamped;
  }
}

function effectiveMasterGain(masterLevel) {
  const level = Math.max(0, Math.min(1, Number(masterLevel) || 0));
  return level * level * MASTER_HEADROOM;
}

function effectiveChannelGain(channelLevel) {
  const level = Math.max(0, Math.min(1, Number(channelLevel) || 0));
  // Smooth perceptual curve so low slider values remain subtle and usable.
  return Math.pow(level, 1.35);
}

function ensureUnloadHook() {
  if (unloadHookInstalled || typeof globalThis.window === 'undefined' || typeof globalThis.window.addEventListener !== 'function') return;
  unloadHookInstalled = true;
  const silenceOnUnload = () => {
    teardownGraph({ immediate: true });
  };
  globalThis.window.addEventListener('pagehide', silenceOnUnload);
  globalThis.window.addEventListener('beforeunload', silenceOnUnload);
}

function getOrCreateAudioGraph() {
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioCtx !== 'function') return null;
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioCtx();
    cachedBuffers = new Map();
    activeChannels.clear();
    masterGain = audioCtx.createGain?.() || null;
    if (!masterGain || !audioCtx.destination) {
      audioCtx = null;
      return null;
    }
    const now = audioCtx.currentTime || 0;
    masterGain.gain?.setValueAtTime?.(0, now);
    if (typeof audioCtx.createBiquadFilter === 'function') {
      airBus = audioCtx.createBiquadFilter();
      airBus.type = 'lowpass';
      airBus.frequency?.setValueAtTime?.(AIR_BUS_CUTOFF_HZ, now);
      airBus.Q?.setValueAtTime?.(Math.SQRT1_2, now);
      masterGain.connect(airBus);
      airBus.connect(audioCtx.destination);
    } else {
      airBus = null;
      masterGain.connect(audioCtx.destination);
    }
    ensureUnloadHook();
  }
  return audioCtx;
}

function getOrBuildAudioBuffer(ctx, channelId) {
  const rate = ctx.sampleRate || 44100;
  const key = `${channelId}@${rate}`;
  if (cachedBuffers.has(key)) return cachedBuffers.get(key);
  if (typeof ctx.createBuffer !== 'function') return null;
  const synth = synthesizeSoundscapeChannel(channelId, rate);
  if (!synth) return null;
  const buffer = ctx.createBuffer(2, synth.left.length, rate);
  if (typeof buffer.copyToChannel === 'function') {
    buffer.copyToChannel(synth.left, 0);
    buffer.copyToChannel(synth.right, 1);
  } else {
    buffer.getChannelData?.(0)?.set?.(synth.left);
    if ((buffer.numberOfChannels || 1) > 1) buffer.getChannelData?.(1)?.set?.(synth.right);
  }
  cachedBuffers.set(key, buffer);
  return buffer;
}

function stopChannelNode(channelId) {
  const node = activeChannels.get(channelId);
  if (!node) return;
  activeChannels.delete(channelId);
  try { node.source.stop?.(); } catch { /* ignore */ }
  try { node.source.disconnect?.(); } catch { /* ignore */ }
  try { node.gain.disconnect?.(); } catch { /* ignore */ }
}

function teardownGraph({ immediate = false } = {}) {
  clearSuspendTimer();
  stopCaptureWatcher();
  if (!audioCtx) return;
  const ctx = audioCtx;
  const now = ctx.currentTime || 0;
  if (masterGain && !immediate) {
    rampParam(masterGain.gain, 0, now, 0.18);
  } else if (masterGain) {
    rampParam(masterGain.gain, 0, now, 0);
  }
  const finish = () => {
    for (const id of [...activeChannels.keys()]) stopChannelNode(id);
    if (audioCtx === ctx && ctx.state === 'running') {
      try { Promise.resolve(ctx.suspend?.()).catch(() => {}); } catch { /* ignore */ }
    }
  };
  if (immediate) {
    finish();
  } else {
    suspendTimer = setTimeout(() => {
      suspendTimer = null;
      finish();
    }, 200);
    suspendTimer.unref?.();
  }
}

function syncChannelsToGraph(ctx, channels, rampSec = 0.12) {
  const now = ctx.currentTime || 0;
  for (const id of ATELIER_CHANNEL_IDS) {
    const level = Number(channels?.[id]) || 0;
    const targetGain = effectiveChannelGain(level);
    const existing = activeChannels.get(id);
    if (level <= 0.005) {
      if (existing) rampParam(existing.gain.gain, 0, now, rampSec);
      continue;
    }
    if (existing) {
      rampParam(existing.gain.gain, targetGain, now, rampSec);
      continue;
    }
    const buffer = getOrBuildAudioBuffer(ctx, id);
    const source = ctx.createBufferSource?.();
    const gain = ctx.createGain?.();
    if (!buffer || !source || !gain || !masterGain) continue;
    source.buffer = buffer;
    source.loop = true;
    gain.gain?.setValueAtTime?.(0, now);
    source.connect(gain);
    gain.connect(masterGain);
    source.start(now);
    rampParam(gain.gain, targetGain, now, Math.max(rampSec, 0.15));
    activeChannels.set(id, { source, gain });
  }
}

function startCaptureWatcher() {
  if (captureWatchTimer !== null) return;
  const pollCapture = () => {
    captureWatchTimer = null;
    syncSoundscapeCaptureGuard();
    if (sharedAtelierStore.get().playing && captureWatchTimer === null) {
      captureWatchTimer = setTimeout(pollCapture, CAPTURE_POLL_MS);
      captureWatchTimer.unref?.();
    }
  };
  captureWatchTimer = setTimeout(pollCapture, CAPTURE_POLL_MS);
  captureWatchTimer.unref?.();
}

function engageLiveAudio(state, { fadeSec = 0.3 } = {}) {
  clearSuspendTimer();
  const ctx = getOrCreateAudioGraph();
  if (!ctx) return false;
  if (ctx.state === 'suspended') {
    try { Promise.resolve(ctx.resume?.()).catch(() => {}); } catch { /* ignore */ }
  }
  syncChannelsToGraph(ctx, state.channels, fadeSec);
  const now = ctx.currentTime || 0;
  rampParam(masterGain.gain, effectiveMasterGain(state.master), now, fadeSec);
  startCaptureWatcher();
  return true;
}

/** Synchronously align live playback with Live Class / Voice Mic capture state (also used by unit tests). */
export function syncSoundscapeCaptureGuard() {
  const state = sharedAtelierStore.get();
  if (!state.playing) {
    stopCaptureWatcher();
    if (state.captureMuted) sharedAtelierStore.setCaptureMuted(false);
    return false;
  }
  const capturing = isAudioCaptureActive();
  if (capturing) {
    if (!state.captureMuted) sharedAtelierStore.setCaptureMuted(true);
    if (audioCtx && masterGain) {
      const now = audioCtx.currentTime || 0;
      rampParam(masterGain.gain, 0, now, 0.04);
      if (audioCtx.state === 'running') {
        try { Promise.resolve(audioCtx.suspend?.()).catch(() => {}); } catch { /* ignore */ }
      }
    }
    return true;
  }
  if (state.captureMuted) {
    sharedAtelierStore.setCaptureMuted(false);
    engageLiveAudio(sharedAtelierStore.get(), { fadeSec: 0.28 });
  }
  return false;
}

/** Start Desk Atelier soundscape (explicit user opt-in). Respects isAudioCaptureActive() guard. */
export function startSoundscape() {
  let state = sharedAtelierStore.ensureAudibleMix();
  state = sharedAtelierStore.setPlaying(true);
  if (isAudioCaptureActive()) {
    sharedAtelierStore.setCaptureMuted(true);
    startCaptureWatcher();
    return false;
  }
  sharedAtelierStore.setCaptureMuted(false);
  return engageLiveAudio(state, { fadeSec: 0.32 });
}

/** Smoothly fade out and suspend Desk Atelier soundscape. */
export function stopSoundscape({ immediate = false } = {}) {
  sharedAtelierStore.setPlaying(false);
  teardownGraph({ immediate });
}

/** Toggle Desk Atelier soundscape playback on/off. */
export function toggleSoundscape() {
  if (sharedAtelierStore.get().playing) {
    stopSoundscape();
    return false;
  }
  return startSoundscape();
}

/** Apply a curated preset mix; starts playback by default when clicked by the learner. */
export function selectSoundscapePreset(presetId, { autoPlay = true } = {}) {
  const state = sharedAtelierStore.applyPreset(presetId);
  if (autoPlay && !state.playing) {
    return startSoundscape();
  }
  if (state.playing) {
    if (isAudioCaptureActive()) {
      syncSoundscapeCaptureGuard();
      return false;
    }
    return engageLiveAudio(state, { fadeSec: 0.22 });
  }
  return false;
}

/** Adjust a single channel gain (0..1); smoothly updates live graph if playing. */
export function setSoundscapeChannel(channelId, level) {
  const state = sharedAtelierStore.setChannel(channelId, level);
  if (state.playing && !isAudioCaptureActive()) {
    if (!hasActiveChannel(state.channels)) {
      if (audioCtx && masterGain) {
        syncChannelsToGraph(audioCtx, state.channels, 0.1);
      }
    } else {
      engageLiveAudio(state, { fadeSec: 0.1 });
    }
  }
  return state;
}

/** Adjust master volume (0..1); smoothly ramps master gain if playing. */
export function setSoundscapeMaster(master) {
  const state = sharedAtelierStore.setMaster(master);
  if (state.playing && !isAudioCaptureActive() && audioCtx && masterGain) {
    const now = audioCtx.currentTime || 0;
    rampParam(masterGain.gain, effectiveMasterGain(state.master), now, 0.1);
  }
  return state;
}

/** Reset channel mix & master back to default Rainy Night Desk balance. */
export function resetSoundscapeMix() {
  const state = sharedAtelierStore.resetMix();
  if (state.playing && !isAudioCaptureActive()) {
    engageLiveAudio(state, { fadeSec: 0.2 });
  }
  return state;
}

/** Update opt-in desk atmosphere lighting mode (`none` default). */
export function setDeskAtmosphere(mode) {
  return sharedAtelierStore.setAtmosphere(mode);
}

/** Cleanly tear down audio context, timers, cached buffers and store state between unit tests. */
export function resetSoundscapeEngineForTests() {
  clearSuspendTimer();
  stopCaptureWatcher();
  for (const id of [...activeChannels.keys()]) stopChannelNode(id);
  if (audioCtx) {
    try { audioCtx.close?.(); } catch { /* ignore */ }
  }
  audioCtx = null;
  masterGain = null;
  airBus = null;
  cachedBuffers = new Map();
  sharedAtelierStore.resetAllForTests();
}
