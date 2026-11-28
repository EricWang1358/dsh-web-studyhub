/* Offline Web Audio Soundscape Engine for StudyHub Desk Atelier.
   - Plays lazily loaded CC0 1.0 stereo field-recorded MP3 loops (ui/desk-atelier/soundscape-assets.js) via decodeAudioData.
   - 0 B workspace boot cost, zero network fetch, zero AudioWorklet blob URLs (strict web-demo CSP safe).
   - Trims 50 ms LAME head/tail padding and equal-power crossfades 1.6 s tail onto head for mathematically zero-click loops.
   - Layers sparse jittered D-major pentatonic felt-mallet chime accents on the bamboo wind channel.
   - Retains procedural stereo DSP synthesis as synchronous fallback (for mock AudioContext unit tests or decode failure).
   - Default OFF: zero AudioContext constructed until the learner explicitly enables playback.
   - Auto-mutes immediately whenever Live Class or Voice Mic capture is active (ui/audio-capture-state.js). */
import { getCachedAppearance, onAppearanceCacheChange } from '../appearance-prefs.js';
import { isAudioCaptureActive } from '../audio-capture-state.js';
import { ATELIER_CHANNEL_IDS, hasActiveChannel } from './atelier-presets.js';
import { sharedAtelierStore } from './atelier-storage.js';

const MAX_CHANNEL_PEAK = 0.44;
const MASTER_HEADROOM = 0.74;
const AIR_BUS_CUTOFF_HZ = 11_500;
const CAPTURE_POLL_MS = 250;
const SAMPLE_TRIM_SEC = 0.05;
const SAMPLE_XFADE_SEC = 1.6;
const BAMBOO_CHIME_MIN_MS = 4000;
const BAMBOO_CHIME_MAX_MS = 8000;

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

// ── Baked CC0 Asset Decoding & Zero-Click Seamless Loop Processing ──────────

function decodeBase64ToArrayBuffer(dataUri) {
  if (typeof dataUri !== 'string' || !dataUri) return null;
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

/** Trim fixed LAME encoder head/tail padding (default 50 ms each) and fold the remaining tail
    (default 1.6 s) onto the head using equal-power sine/cosine crossfade for click-free looping. */
export function buildSeamlessSampleBuffer(ctx, decoded, {
  trimSec = SAMPLE_TRIM_SEC,
  fadeSec = SAMPLE_XFADE_SEC,
  maxPeak = 0.94,
} = {}) {
  if (!ctx || typeof ctx.createBuffer !== 'function' || !decoded || typeof decoded.getChannelData !== 'function') {
    return null;
  }
  const rate = decoded.sampleRate || ctx.sampleRate || 44100;
  const srcLen = decoded.length || 0;
  if (srcLen < 256) return decoded;

  const trim = srcLen > Math.round(rate * trimSec * 2) + 256 ? Math.round(rate * trimSec) : 0;
  const trimmedLen = srcLen - trim * 2;
  const srcL = decoded.getChannelData(0).subarray(trim, trim + trimmedLen);
  const srcR = (decoded.numberOfChannels || 1) > 1
    ? decoded.getChannelData(1).subarray(trim, trim + trimmedLen)
    : srcL;

  const fadeLen = Math.min(Math.round(rate * fadeSec), Math.floor(trimmedLen * 0.28));
  const loopLen = Math.max(128, trimmedLen - fadeLen);

  const left = crossfadeSeamlessLoop(srcL, loopLen, fadeLen);
  const right = crossfadeSeamlessLoop(srcR, loopLen, fadeLen);
  for (let i = 0; i < loopLen; i += 1) {
    const l = Number.isFinite(left[i]) ? left[i] : 0;
    const r = Number.isFinite(right[i]) ? right[i] : 0;
    left[i] = Math.max(-maxPeak, Math.min(maxPeak, l));
    right[i] = Math.max(-maxPeak, Math.min(maxPeak, r));
  }

  const out = ctx.createBuffer(2, loopLen, rate);
  if (typeof out.copyToChannel === 'function') {
    out.copyToChannel(left, 0);
    out.copyToChannel(right, 1);
  } else {
    out.getChannelData?.(0)?.set?.(left);
    if ((out.numberOfChannels || 1) > 1) out.getChannelData?.(1)?.set?.(right);
  }
  return out;
}

// ── Live Web Audio Graph Singleton ───────────────────────────────────────────

let audioCtx = null;
let masterGain = null;
let airBus = null;
let cachedDspBuffers = new Map();
let decodedSampleBuffers = new Map(); // channelId@rate -> { buffer, gain }
let sampleDecodePromises = new Map(); // channelId@rate -> Promise
let cachedBambooNoteBuffers = new Map(); // noteIdx@rate -> AudioBuffer
let bakedAssets = null;
let bakedAssetsPromise = null;
const activeChannels = new Map(); // channelId -> { source, gain, isSample, calGain }
const activeAccentVoices = new Set();
let captureWatchTimer = null;
let suspendTimer = null;
let bambooChimeTimer = null;
let lastBambooNoteIdx = -1;
let unloadHookInstalled = false;
let visibilityHookInstalled = false;

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

function stopBambooChimes() {
  if (bambooChimeTimer !== null) {
    clearTimeout(bambooChimeTimer);
    bambooChimeTimer = null;
  }
  for (const voice of [...activeAccentVoices]) {
    try { voice.source.stop?.(); } catch { /* ignore */ }
    voice.disconnect();
  }
}

function loadBakedSoundscapeAssets() {
  if (bakedAssets) return Promise.resolve(bakedAssets);
  if (!bakedAssetsPromise) {
    bakedAssetsPromise = import('./soundscape-assets.js')
      .then((mod) => {
        bakedAssets = {
          uris: mod?.SOUNDSCAPE_DATA_URIS || {},
          gains: mod?.SOUNDSCAPE_CHANNEL_GAINS || {},
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

function rampParam(param, target, now, rampSec) {
  if (!param) return;
  const clamped = Math.max(0, Math.min(1.5, Number.isFinite(target) ? target : 0));
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

function effectiveChannelGain(channelLevel, calGain = 1) {
  const level = Math.max(0, Math.min(1, Number(channelLevel) || 0));
  // Smooth perceptual curve so low slider values remain subtle and usable.
  return Math.pow(level, 1.35) * calGain;
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

function ensureVisibilityHook() {
  if (visibilityHookInstalled || typeof globalThis.document === 'undefined' || typeof globalThis.document.addEventListener !== 'function') return;
  visibilityHookInstalled = true;
  globalThis.document.addEventListener('visibilitychange', () => {
    const state = sharedAtelierStore.get();
    if (!state.playing || state.captureMuted) return;
    if (globalThis.document.hidden) {
      stopBambooChimes();
    } else if ((state.channels?.bamboo || 0) > 0.005 && audioCtx) {
      syncBambooChimeScheduler(audioCtx, state.channels);
    }
  });
}

function getOrCreateAudioGraph() {
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioCtx !== 'function') return null;
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioCtx();
    cachedDspBuffers = new Map();
    decodedSampleBuffers = new Map();
    sampleDecodePromises = new Map();
    cachedBambooNoteBuffers = new Map();
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
    ensureVisibilityHook();
  }
  return audioCtx;
}

function getOrBuildDspBuffer(ctx, channelId) {
  const rate = ctx.sampleRate || 44100;
  const key = `${channelId}@${rate}`;
  if (cachedDspBuffers.has(key)) return cachedDspBuffers.get(key);
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
  cachedDspBuffers.set(key, buffer);
  return buffer;
}

function getOrBuildBambooNoteBuffer(ctx, noteIdx) {
  const rate = ctx.sampleRate || 44100;
  const key = `${noteIdx}@${rate}`;
  if (cachedBambooNoteBuffers.has(key)) return cachedBambooNoteBuffers.get(key);
  if (typeof ctx.createBuffer !== 'function') return null;
  const freqHz = BAMBOO_PENTATONIC_HZ[noteIdx];
  if (!freqHz) return null;
  const len = Math.max(256, Math.round(rate * 2.1));
  const left = new Float32Array(len);
  const right = new Float32Array(len);
  const pan = 0.25 + (noteIdx / Math.max(1, BAMBOO_PENTATONIC_HZ.length - 1)) * 0.5;
  addFeltBambooNote(left, right, rate, { startSec: 0.004, freqHz, amp: 0.36, tau: 0.68, pan });
  const buffer = ctx.createBuffer(2, len, rate);
  if (typeof buffer.copyToChannel === 'function') {
    buffer.copyToChannel(left, 0);
    buffer.copyToChannel(right, 1);
  } else {
    buffer.getChannelData?.(0)?.set?.(left);
    if ((buffer.numberOfChannels || 1) > 1) buffer.getChannelData?.(1)?.set?.(right);
  }
  cachedBambooNoteBuffers.set(key, buffer);
  return buffer;
}

function triggerBambooChimeAccent(ctx) {
  const state = sharedAtelierStore.get();
  const level = Number(state.channels?.bamboo) || 0;
  if (!state.playing || state.captureMuted || level <= 0.005) return;
  if (isAudioCaptureActive() || globalThis.document?.hidden === true) return;
  if (ctx !== audioCtx || !masterGain || ctx.state !== 'running') return;

  const count = BAMBOO_PENTATONIC_HZ.length;
  let nextIdx = Math.floor(Math.random() * count);
  if (nextIdx === lastBambooNoteIdx) nextIdx = (nextIdx + 1 + Math.floor(Math.random() * (count - 1))) % count;
  lastBambooNoteIdx = nextIdx;

  const buffer = getOrBuildBambooNoteBuffer(ctx, nextIdx);
  const source = ctx.createBufferSource?.();
  const gain = ctx.createGain?.();
  if (!buffer || !source || !gain) return;
  const now = ctx.currentTime || 0;
  source.buffer = buffer;
  gain.gain?.setValueAtTime?.(effectiveChannelGain(level, 0.34), now);
  source.connect(gain);
  gain.connect(masterGain);

  let disconnected = false;
  const voice = {
    source,
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      activeAccentVoices.delete(voice);
      try { source.disconnect?.(); } catch { /* ignore */ }
      try { gain.disconnect?.(); } catch { /* ignore */ }
    },
  };
  activeAccentVoices.add(voice);
  source.onended = () => voice.disconnect();
  source.start(now);
}

function syncBambooChimeScheduler(ctx, channels) {
  const level = Number(channels?.bamboo) || 0;
  const state = sharedAtelierStore.get();
  if (!state.playing || state.captureMuted || level <= 0.005 || globalThis.document?.hidden === true) {
    stopBambooChimes();
    return;
  }
  if (bambooChimeTimer !== null) return;
  const schedule = (delayMs) => {
    bambooChimeTimer = setTimeout(() => {
      bambooChimeTimer = null;
      const live = sharedAtelierStore.get();
      if (!live.playing || live.captureMuted || (live.channels?.bamboo || 0) <= 0.005 || ctx !== audioCtx) {
        return;
      }
      if (globalThis.document?.hidden === true) return;
      // Only layer separate chime accents when playing the real CC0 wind sample (procedural fallback already has chimes baked in).
      const activeBamboo = activeChannels.get('bamboo');
      if (activeBamboo?.isSample) {
        triggerBambooChimeAccent(ctx);
      }
      const nextDelay = Math.round(BAMBOO_CHIME_MIN_MS + Math.random() * (BAMBOO_CHIME_MAX_MS - BAMBOO_CHIME_MIN_MS));
      schedule(nextDelay);
    }, delayMs);
    bambooChimeTimer.unref?.();
  };
  schedule(Math.round(1800 + Math.random() * 1600));
}

function ensureDecodedChannelSample(ctx, channelId) {
  if (typeof ctx?.decodeAudioData !== 'function') return null;
  const rate = ctx.sampleRate || 44100;
  const key = `${channelId}@${rate}`;
  if (decodedSampleBuffers.has(key)) return Promise.resolve(decodedSampleBuffers.get(key));
  if (sampleDecodePromises.has(key)) return sampleDecodePromises.get(key);

  const promise = loadBakedSoundscapeAssets()
    .then((assets) => {
      if (ctx !== audioCtx) return null;
      const dataUri = assets?.uris?.[channelId];
      const raw = dataUri ? decodeBase64ToArrayBuffer(dataUri) : null;
      if (!raw) return null;
      return Promise.resolve(ctx.decodeAudioData(raw.slice(0))).then((decoded) => ({
        decoded,
        calGain: Number.isFinite(assets?.gains?.[channelId]) ? assets.gains[channelId] : 1,
      }));
    })
    .then((payload) => {
      if (ctx !== audioCtx) return null;
      sampleDecodePromises.delete(key);
      if (!payload?.decoded) return null;
      const seamless = buildSeamlessSampleBuffer(ctx, payload.decoded);
      if (!seamless) return null;
      const entry = { buffer: seamless, calGain: payload.calGain, isSample: true };
      decodedSampleBuffers.set(key, entry);
      return entry;
    }, () => {
      if (ctx === audioCtx) sampleDecodePromises.delete(key);
      return null;
    });

  sampleDecodePromises.set(key, promise);
  return promise;
}

function stopChannelNode(channelId, { fadeSec = 0 } = {}) {
  const node = activeChannels.get(channelId);
  if (!node) return;
  activeChannels.delete(channelId);
  const cleanup = () => {
    try { node.source.stop?.(); } catch { /* ignore */ }
    try { node.source.disconnect?.(); } catch { /* ignore */ }
    try { node.gain.disconnect?.(); } catch { /* ignore */ }
  };
  if (fadeSec > 0 && audioCtx && node.gain?.gain) {
    const now = audioCtx.currentTime || 0;
    rampParam(node.gain.gain, 0, now, fadeSec);
    const timer = setTimeout(cleanup, Math.round(fadeSec * 1000) + 40);
    timer.unref?.();
    return;
  }
  cleanup();
}

function mountChannelSource(ctx, channelId, buffer, { targetLevel, calGain = 1, isSample = false, rampSec = 0.25 } = {}) {
  if (!buffer || !masterGain || ctx !== audioCtx) return false;
  const source = ctx.createBufferSource?.();
  const gain = ctx.createGain?.();
  if (!source || !gain) return false;
  const now = ctx.currentTime || 0;
  source.buffer = buffer;
  source.loop = true;
  gain.gain?.setValueAtTime?.(0, now);
  source.connect(gain);
  gain.connect(masterGain);
  source.start(now);
  rampParam(gain.gain, effectiveChannelGain(targetLevel, calGain), now, Math.max(rampSec, 0.18));
  activeChannels.set(channelId, { source, gain, isSample, calGain });
  return true;
}

function teardownGraph({ immediate = false } = {}) {
  clearSuspendTimer();
  stopCaptureWatcher();
  stopBambooChimes();
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
  const rate = ctx.sampleRate || 44100;
  const supportsSampleDecode = typeof ctx.decodeAudioData === 'function';

  for (const id of ATELIER_CHANNEL_IDS) {
    const level = Number(channels?.[id]) || 0;
    const existing = activeChannels.get(id);
    if (level <= 0.005) {
      if (existing) rampParam(existing.gain.gain, 0, now, rampSec);
      continue;
    }
    if (existing) {
      rampParam(existing.gain.gain, effectiveChannelGain(level, existing.calGain || 1), now, rampSec);
      continue;
    }

    const sampleKey = `${id}@${rate}`;
    const cachedSample = decodedSampleBuffers.get(sampleKey);
    if (cachedSample) {
      mountChannelSource(ctx, id, cachedSample.buffer, {
        targetLevel: level,
        calGain: cachedSample.calGain,
        isSample: true,
        rampSec,
      });
      continue;
    }

    if (supportsSampleDecode) {
      const decodePromise = ensureDecodedChannelSample(ctx, id);
      if (decodePromise) {
        decodePromise.then((entry) => {
          if (ctx !== audioCtx) return;
          const live = sharedAtelierStore.get();
          const liveLevel = Number(live.channels?.[id]) || 0;
          if (!live.playing || live.captureMuted || liveLevel <= 0.005) return;
          const current = activeChannels.get(id);
          if (entry?.buffer) {
            if (current && !current.isSample) stopChannelNode(id, { fadeSec: 0.2 });
            if (!activeChannels.has(id)) {
              mountChannelSource(ctx, id, entry.buffer, {
                targetLevel: liveLevel,
                calGain: entry.calGain,
                isSample: true,
                rampSec: 0.35,
              });
            }
            if (id === 'bamboo') syncBambooChimeScheduler(ctx, live.channels);
            return;
          }
          // Asset/decode failure -> gracefully fall back to offline procedural DSP synthesis.
          if (!activeChannels.has(id)) {
            const fallback = getOrBuildDspBuffer(ctx, id);
            mountChannelSource(ctx, id, fallback, { targetLevel: liveLevel, calGain: 1, isSample: false, rampSec: 0.25 });
          }
        });
        continue;
      }
    }

    const fallback = getOrBuildDspBuffer(ctx, id);
    mountChannelSource(ctx, id, fallback, { targetLevel: level, calGain: 1, isSample: false, rampSec });
  }

  syncBambooChimeScheduler(ctx, channels);
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
    stopBambooChimes();
    if (state.captureMuted) sharedAtelierStore.setCaptureMuted(false);
    return false;
  }
  const capturing = isAudioCaptureActive();
  if (capturing) {
    stopBambooChimes();
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

let minimalHookInstalled = false;

function isMinimalModeSuppressed() {
  try {
    if (getCachedAppearance().minimal === 'on') return true;
  } catch { /* ignore */ }
  const root = globalThis.document?.querySelector?.('.study-app, .study-seat');
  return root?.getAttribute?.('data-minimal') === 'on';
}

function ensureMinimalHook() {
  if (minimalHookInstalled) return;
  minimalHookInstalled = true;
  onAppearanceCacheChange((next) => {
    if (next?.minimal === 'on' && sharedAtelierStore.get().playing) {
      stopSoundscape();
    }
  });
}

/** Start Desk Atelier soundscape (explicit user opt-in). Respects isAudioCaptureActive() and Minimal Mode guards. */
export function startSoundscape() {
  ensureMinimalHook();
  if (isMinimalModeSuppressed()) return false;
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
  stopBambooChimes();
  for (const id of [...activeChannels.keys()]) stopChannelNode(id);
  if (audioCtx) {
    try { audioCtx.close?.(); } catch { /* ignore */ }
  }
  audioCtx = null;
  masterGain = null;
  airBus = null;
  cachedDspBuffers = new Map();
  decodedSampleBuffers = new Map();
  sampleDecodePromises = new Map();
  cachedBambooNoteBuffers = new Map();
  bakedAssets = null;
  bakedAssetsPromise = null;
  lastBambooNoteIdx = -1;
  sharedAtelierStore.resetAllForTests();
}
