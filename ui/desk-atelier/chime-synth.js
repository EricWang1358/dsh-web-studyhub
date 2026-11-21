/* Offline Web Audio Felt-Mallet Pentatonic Chime Synthesizer («五声风铃 · D4–A5»).
   - Concert-tuned to StudyHub's D-major acoustic room (matching ui/sound-effects.js & soundscape-engine.js).
   - Zero MP3 bundles, zero CDN fetches, zero AudioContext constructed until the learner strikes a bar or enables Gentle Breeze.
   - Auto-mutes immediately when isAudioCaptureActive() is true (Live Class / Voice Mic). */
import { isAudioCaptureActive } from '../audio-capture-state.js';

export const CHIME_BARS = Object.freeze([
  Object.freeze({ id: 'D4', note: 'D4', key: 'A', freqHz: 293.66, heightPct: 100, pan: -0.48 }),
  Object.freeze({ id: 'E4', note: 'E4', key: 'S', freqHz: 329.63, heightPct: 94, pan: -0.36 }),
  Object.freeze({ id: 'Fs4', note: 'F#4', key: 'D', freqHz: 369.99, heightPct: 88, pan: -0.24 }),
  Object.freeze({ id: 'A4', note: 'A4', key: 'F', freqHz: 440.0, heightPct: 82, pan: -0.12 }),
  Object.freeze({ id: 'B4', note: 'B4', key: 'G', freqHz: 493.88, heightPct: 76, pan: 0.0 }),
  Object.freeze({ id: 'D5', note: 'D5', key: 'H', freqHz: 587.33, heightPct: 70, pan: 0.12 }),
  Object.freeze({ id: 'E5', note: 'E5', key: 'J', freqHz: 659.25, heightPct: 64, pan: 0.24 }),
  Object.freeze({ id: 'Fs5', note: 'F#5', key: 'K', freqHz: 739.99, heightPct: 58, pan: 0.36 }),
  Object.freeze({ id: 'A5', note: 'A5', key: 'L', freqHz: 880.0, heightPct: 52, pan: 0.48 }),
]);

export const CHIME_KEY_MAP = Object.freeze(
  Object.fromEntries(CHIME_BARS.map((bar) => [bar.key, bar.id])),
);

export const BREEZE_MIN_MS = 2500;
export const BREEZE_MAX_MS = 6000;
const BREEZE_MEAN_MS = 3900;

const MAX_CHIME_PEAK = 0.44;
const AIR_BUS_CUTOFF_HZ = 11_500;
const BAR_COOLDOWN_MS = 45;
const IDLE_SUSPEND_MS = 12_000;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shapeEnvelope(samples, sampleRate, fadeInMs = 4.5, fadeOutMs = 45) {
  const n = samples.length;
  if (!n) return samples;
  samples[0] = 0;
  samples[n - 1] = 0;
  const fadeIn = Math.min(Math.floor(n * 0.2), Math.max(2, Math.round((fadeInMs / 1000) * sampleRate)));
  const fadeOut = Math.min(Math.floor(n * 0.35), Math.max(4, Math.round((fadeOutMs / 1000) * sampleRate)));
  for (let i = 1; i < fadeIn; i += 1) {
    samples[i] *= 0.5 * (1 - Math.cos((Math.PI * i) / fadeIn));
  }
  for (let k = 1; k < fadeOut; k += 1) {
    samples[n - 1 - k] *= 0.5 * (1 - Math.cos((Math.PI * k) / fadeOut));
  }
  return samples;
}

/** Pure offline stereo synthesis for one felt-mallet wooden-and-brass pentatonic chime bar. */
export function synthesizeChimeBar(barId, sampleRate = 44100) {
  const barIndex = CHIME_BARS.findIndex((item) => item.id === barId);
  if (barIndex < 0) return null;
  const bar = CHIME_BARS[barIndex];
  const safeRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 44100;
  // Lower bars resonate warmly longer (~2.2s); higher bars shimmer cleanly (~1.35s).
  const durationSec = Number((2.2 - barIndex * 0.1).toFixed(2));
  const n = Math.max(256, Math.round(durationSec * safeRate));
  const mono = new Float32Array(n);
  const rand = mulberry32(0x309d01 + barIndex * 4993);

  const baseTau = 0.62 - barIndex * 0.036;
  // Warm wooden-brass partials: gentle fundamental + harmonic overtones with fast upper decay.
  const ratios = [1.0, 2.002, 2.996, 4.18, 5.42];
  const amps = [1.0, 0.32, 0.14, 0.06, 0.025];
  const taus = [baseTau, baseTau * 0.46, baseTau * 0.24, baseTau * 0.12, baseTau * 0.06];

  for (let i = 0; i < n; i += 1) {
    const t = i / safeRate;
    const attack = t < 0.0045 ? 0.5 * (1 - Math.cos((Math.PI * t) / 0.0045)) : 1;
    let body = 0;
    for (let p = 0; p < ratios.length; p += 1) {
      const shimmer = p === 0
        ? 0.09 * Math.sin(2 * Math.PI * (bar.freqHz * 1.0018) * t) * Math.exp(-t / (baseTau * 0.85))
        : 0;
      body += amps[p] * Math.exp(-t / taus[p]) * Math.sin(2 * Math.PI * bar.freqHz * ratios[p] * t) + shimmer;
    }
    // Soft felt mallet contact thump (~4ms).
    const felt = Math.exp(-t / 0.0038) * (rand() * 2 - 1) * 0.11;
    mono[i] = attack * (body + felt);
  }

  // Stereo placement + subtle early studio desk micro-room reflections (matching sound-effects.js).
  const panAngle = ((bar.pan + 1) * 0.5) * Math.PI * 0.5;
  const gL = Math.cos(panAngle);
  const gR = Math.sin(panAngle);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const tapsL = [
    [Math.round(safeRate * 0.011), 0.08],
    [Math.round(safeRate * 0.024), 0.05],
    [Math.round(safeRate * 0.039), 0.03],
  ];
  const tapsR = [
    [Math.round(safeRate * 0.014), 0.08],
    [Math.round(safeRate * 0.029), 0.05],
    [Math.round(safeRate * 0.044), 0.03],
  ];
  const reflL = 0.45 + 0.55 * gL;
  const reflR = 0.45 + 0.55 * gR;

  for (let i = 0; i < n; i += 1) {
    let rl = 0;
    let rr = 0;
    for (let k = 0; k < tapsL.length; k += 1) {
      const d = tapsL[k][0];
      if (i >= d) rl += mono[i - d] * tapsL[k][1];
    }
    for (let k = 0; k < tapsR.length; k += 1) {
      const d = tapsR[k][0];
      if (i >= d) rr += mono[i - d] * tapsR[k][1];
    }
    left[i] = mono[i] * gL + rl * reflL;
    right[i] = mono[i] * gR + rr * reflR;
  }

  // Normalize stereo peak cleanly below MAX_CHIME_PEAK with zero DC click at boundaries.
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    const aL = Math.abs(left[i]);
    const aR = Math.abs(right[i]);
    if (aL > peak) peak = aL;
    if (aR > peak) peak = aR;
  }
  const targetPeak = MAX_CHIME_PEAK * 0.86;
  if (peak > 1e-6) {
    const scale = targetPeak / peak;
    for (let i = 0; i < n; i += 1) {
      left[i] = Math.max(-MAX_CHIME_PEAK, Math.min(MAX_CHIME_PEAK, left[i] * scale));
      right[i] = Math.max(-MAX_CHIME_PEAK, Math.min(MAX_CHIME_PEAK, right[i] * scale));
    }
  }
  shapeEnvelope(left, safeRate, 2.0, 55);
  shapeEnvelope(right, safeRate, 2.0, 55);

  return {
    id: bar.id,
    note: bar.note,
    freqHz: bar.freqHz,
    sampleRate: safeRate,
    durationSec,
    left,
    right,
  };
}

/** Poisson-spaced interval (2.5–6.0s) for Gentle Breeze («微风自鸣») auto-chimes. */
export function nextBreezeDelayMs(rand = Math.random) {
  const u = Math.max(1e-6, Math.min(0.999999, Number(rand()) || 0.5));
  const raw = -Math.log(1 - u) * BREEZE_MEAN_MS;
  return Math.round(Math.max(BREEZE_MIN_MS, Math.min(BREEZE_MAX_MS, raw)));
}

/** Choose the next pentatonic chime bar favoring gentle melodic intervals without repeating immediately. */
export function pickNextBreezeBar(lastIndex = -1, rand = Math.random) {
  const count = CHIME_BARS.length;
  if (lastIndex < 0 || lastIndex >= count) {
    const startIdx = Math.floor(Math.max(0, Math.min(0.9999, rand())) * count);
    return CHIME_BARS[startIdx];
  }
  const offsets = [-2, -1, 1, 2, 3, -3];
  const candidates = offsets
    .map((step) => lastIndex + step)
    .filter((idx) => idx >= 0 && idx < count && idx !== lastIndex);
  const pick = candidates[Math.floor(Math.max(0, Math.min(0.9999, rand())) * candidates.length)] ?? ((lastIndex + 1) % count);
  return CHIME_BARS[pick];
}

// ── Live Web Audio Chime Player (lazy AudioContext, zero eager allocation) ───

let chimeCtx = null;
let cachedBuffers = new Map();
const activeVoices = new Set();
const lastBarAt = new Map();
let idleTimer = null;

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
    if (chimeCtx && chimeCtx.state === 'running' && activeVoices.size === 0) {
      try { Promise.resolve(chimeCtx.suspend?.()).catch(() => {}); } catch { /* ignore */ }
    }
  }, IDLE_SUSPEND_MS);
  idleTimer.unref?.();
}

function getOrCreateChimeContext() {
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioCtx !== 'function') return null;
  if (!chimeCtx || chimeCtx.state === 'closed') {
    chimeCtx = new AudioCtx();
    cachedBuffers = new Map();
  }
  return chimeCtx;
}

function getOrBuildChimeBuffer(ctx, barId) {
  const rate = ctx.sampleRate || 44100;
  const key = `${barId}@${rate}`;
  if (cachedBuffers.has(key)) return cachedBuffers.get(key);
  if (typeof ctx.createBuffer !== 'function') return null;
  const synth = synthesizeChimeBar(barId, rate);
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

/** Strike one pentatonic chime bar with optional soft velocity (0.15..1.0).
    Respects isAudioCaptureActive() and skips hidden tabs unless allowHidden is explicitly true. */
export function strikeChimeBar(barId, { velocity = 0.85, skipCooldown = false, allowHidden = false } = {}) {
  try {
    if (!CHIME_BARS.some((bar) => bar.id === barId)) return false;
    if (isAudioCaptureActive()) return false;
    if (!allowHidden && globalThis.document?.hidden === true) return false;

    const checkMs = Date.now();
    if (!skipCooldown && checkMs - (lastBarAt.get(barId) || 0) < BAR_COOLDOWN_MS) return false;

    const ctx = getOrCreateChimeContext();
    if (!ctx || !ctx.destination || typeof ctx.createBufferSource !== 'function' || typeof ctx.createGain !== 'function') {
      return false;
    }
    if (ctx.state === 'suspended') {
      try { Promise.resolve(ctx.resume?.()).catch(() => {}); } catch { /* ignore */ }
    }

    const buffer = getOrBuildChimeBuffer(ctx, barId);
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    if (!buffer || !source || !gain) return false;

    const now = ctx.currentTime || 0;
    const clampedVel = Math.max(0.15, Math.min(1, Number(velocity) || 0.85));
    source.buffer = buffer;
    gain.gain?.setValueAtTime?.(clampedVel * 0.72, now);

    let airBus = null;
    source.connect(gain);
    if (typeof ctx.createBiquadFilter === 'function') {
      airBus = ctx.createBiquadFilter();
      airBus.type = 'lowpass';
      airBus.frequency?.setValueAtTime?.(AIR_BUS_CUTOFF_HZ, now);
      airBus.Q?.setValueAtTime?.(Math.SQRT1_2, now);
      gain.connect(airBus);
      airBus.connect(ctx.destination);
    } else {
      gain.connect(ctx.destination);
    }

    let disconnected = false;
    const voice = {
      source,
      disconnect() {
        if (disconnected) return;
        disconnected = true;
        activeVoices.delete(voice);
        try { source.disconnect?.(); } catch { /* ignore */ }
        try { gain.disconnect?.(); } catch { /* ignore */ }
        if (airBus) {
          try { airBus.disconnect?.(); } catch { /* ignore */ }
        }
      },
    };
    activeVoices.add(voice);
    source.onended = () => {
      voice.disconnect();
      if (activeVoices.size === 0) scheduleIdleSuspend();
    };

    lastBarAt.set(barId, Date.now());
    clearIdleTimer();
    source.start(now);
    return true;
  } catch {
    return false;
  }
}

/** Silence active chime voices and suspend AudioContext cleanly (e.g. on dialog close). */
export function stopAllChimes() {
  clearIdleTimer();
  for (const voice of [...activeVoices]) {
    try { voice.source.stop?.(); } catch { /* ignore */ }
    voice.disconnect();
  }
  if (chimeCtx && chimeCtx.state === 'running') {
    try { Promise.resolve(chimeCtx.suspend?.()).catch(() => {}); } catch { /* ignore */ }
  }
}

/** Full clean teardown for unit tests. */
export function resetChimeSynthForTests() {
  stopAllChimes();
  lastBarAt.clear();
  if (chimeCtx) {
    try { chimeCtx.close?.(); } catch { /* ignore */ }
  }
  chimeCtx = null;
  cachedBuffers = new Map();
}
