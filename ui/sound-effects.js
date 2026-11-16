/* Acoustic Desk sound effects: physical-modeling paper, walnut and felt-mallet transients synthesized offline into memory buffers.
   Defaults to 'off' in appearance-prefs.js: when off, zero AudioContext instances are constructed; automatically mutes whenever
   microphone / live-class audio capture is active (ui/live-audio.js) or the tab is hidden (except for explicit focus timer chimes). */
import { loadAppearance } from './appearance-prefs.js';
import { isAudioCaptureActive } from './audio-capture-state.js';

export const SOUND_CUES = Object.freeze(['tap', 'flip', 'correct', 'levelUp', 'miss', 'complete']);
const SUBTLE_CUES = new Set(['flip', 'correct', 'levelUp', 'miss', 'complete']);

const IDLE_SUSPEND_MS = 15_000;
const CUE_COOLDOWN_MS = 45;
const GLOBAL_COOLDOWN_MS = 25;
const MAX_BUFFER_PEAK = 0.21;

const CUE_GAINS = Object.freeze({
  subtle: Object.freeze({ flip: 0.55, correct: 0.52, levelUp: 0.56, miss: 0.50, complete: 0.58 }),
  standard: Object.freeze({ tap: 0.50, flip: 0.68, correct: 0.66, levelUp: 0.70, miss: 0.58, complete: 0.70 }),
});

const CUE_JITTER = Object.freeze({
  tap: 0.025,
  flip: 0.028,
  miss: 0.02,
  correct: 0.003,
  levelUp: 0.003,
  complete: 0.0025,
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

/** Raised-cosine fade-in + gentle cosine release so sample[0] === 0 and sample[last] === 0 with zero DC click. */
function shapeEnvelope(samples, sampleRate, fadeInMs = 2, fadeOutMs = 10) {
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

/** Causal 2nd-order Butterworth lowpass to roll off brittle electronic highs while keeping tactile body. */
function applyLowpass2(samples, sampleRate, cutoffHz, q = Math.SQRT1_2) {
  const fc = Math.max(120, Math.min(cutoffHz, sampleRate * 0.42));
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = ((1 - cosW0) / 2) / a0;
  const b1 = (1 - cosW0) / a0;
  const b2 = b0;
  const a1 = (-2 * cosW0) / a0;
  const a2 = (1 - alpha) / a0;
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

/** 1st-order highpass to keep sub-bass thump clean and DC-free. */
function applyHighpass1(samples, sampleRate, cutoffHz) {
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * Math.max(20, cutoffHz));
  const alpha = rc / (rc + dt);
  let prevX = 0, prevY = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x = samples[i];
    const y = alpha * (prevY + x - prevX);
    prevX = x;
    prevY = y;
    samples[i] = y;
  }
  return samples;
}

function normalizePeak(samples, targetPeak) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  if (peak > 1e-6) {
    const scale = Math.min(targetPeak / peak, 1.5 * (targetPeak / peak));
    for (let i = 0; i < samples.length; i += 1) samples[i] *= scale;
  }
  return samples;
}

/** Add a struck felt-mallet acoustic bar/string voice using four gently inharmonic damped partials. */
function addFeltNote(samples, sampleRate, {
  startSec = 0,
  freqHz,
  amp = 0.16,
  tausSec = [0.062, 0.034, 0.018, 0.009],
  partialAmps = [1.0, 0.34, 0.12, 0.04],
  contactMs = 2.6,
  rand,
}) {
  const startIdx = Math.max(0, Math.round(startSec * sampleRate));
  const contactSec = contactMs / 1000;
  let brown = 0;
  for (let i = startIdx; i < samples.length; i += 1) {
    const t = (i - startIdx) / sampleRate;
    const malletEnv = t < contactSec ? 0.5 * (1 - Math.cos((Math.PI * t) / contactSec)) : 1;
    let body = 0;
    for (let k = 0; k < partialAmps.length; k += 1) {
      const harmonic = k + 1;
      const inharmonicHz = freqHz * harmonic * Math.sqrt(1 + 0.0004 * harmonic * harmonic);
      const decay = Math.exp(-t / tausSec[k]);
      body += partialAmps[k] * decay * Math.sin(2 * Math.PI * inharmonicHz * t + 0.18 * k);
    }
    // Brief felt-skin contact whisper only over the first ~6 ms of attack.
    const white = rand() * 2 - 1;
    brown = 0.91 * brown + 0.09 * white;
    const feltBrush = Math.exp(-t / 0.0032) * brown * 0.28;
    samples[i] += amp * (malletEnv * body + feltBrush);
  }
}

function buildTapCue(sampleRate) {
  const n = Math.max(64, Math.round(0.036 * sampleRate));
  const out = new Float32Array(n);
  const rand = mulberry32(0x1105a1);
  const modes = [290, 790, 1480];
  const taus = [0.009, 0.0045, 0.0022];
  const amps = [0.68, 0.34, 0.14];
  let brown = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate;
    const impulseEnv = t < 0.003 ? Math.sin((Math.PI * t) / 0.003) : 0;
    const white = rand() * 2 - 1;
    brown = 0.88 * brown + 0.12 * white;
    let wood = 0;
    for (let m = 0; m < modes.length; m += 1) {
      wood += amps[m] * Math.exp(-t / taus[m]) * Math.sin(2 * Math.PI * modes[m] * t);
    }
    const attackRise = Math.min(1, t / 0.0016);
    out[i] = 0.16 * (attackRise * wood + impulseEnv * brown * 0.65);
  }
  applyHighpass1(out, sampleRate, 95);
  applyLowpass2(out, sampleRate, 1850, 0.68);
  normalizePeak(out, 0.17);
  return shapeEnvelope(out, sampleRate, 1.5, 8);
}

function buildFlipCue(sampleRate) {
  const durSec = 0.072;
  const n = Math.max(64, Math.round(durSec * sampleRate));
  const out = new Float32Array(n);
  const rand = mulberry32(0x2207b3);
  // Paul Kellet pink-noise state + resonant 1-pole paper bandpass sweep.
  let b0 = 0, b1 = 0, b2 = 0;
  let bp1 = 0, bp2 = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate;
    const u = Math.min(1, t / durSec);
    const white = rand() * 2 - 1;
    b0 = 0.997 * b0 + white * 0.029;
    b1 = 0.985 * b1 + white * 0.032;
    b2 = 0.950 * b2 + white * 0.048;
    const pink = (b0 + b1 + b2 + white * 0.055) * 0.36;
    const sweepHz = 620 + 500 * Math.sin(Math.PI * u);
    const omega = (2 * Math.PI * sweepHz) / sampleRate;
    bp1 += omega * (pink - bp1) * 0.55;
    bp2 += omega * (bp1 - bp2) * 0.55;
    const paperSwish = Math.pow(Math.sin(Math.PI * u), 1.35) * (bp1 - bp2 * 0.55);
    const settleT = Math.max(0, t - 0.014);
    const settle = t >= 0.014
      ? (0.28 * Math.exp(-settleT / 0.009) * Math.sin(2 * Math.PI * 195 * settleT)
        + 0.14 * Math.exp(-settleT / 0.005) * Math.sin(2 * Math.PI * 455 * settleT))
      : 0;
    out[i] = 0.24 * (paperSwish + settle * 0.35);
  }
  applyHighpass1(out, sampleRate, 160);
  applyLowpass2(out, sampleRate, 2400, 0.65);
  normalizePeak(out, 0.18);
  return shapeEnvelope(out, sampleRate, 3, 12);
}

function buildCorrectCue(sampleRate) {
  const n = Math.max(64, Math.round(0.185 * sampleRate));
  const out = new Float32Array(n);
  addFeltNote(out, sampleRate, {
    startSec: 0,
    freqHz: 329.63, // E4
    amp: 0.16,
    tausSec: [0.062, 0.034, 0.018, 0.009],
    partialAmps: [1.0, 0.34, 0.12, 0.04],
    contactMs: 2.8,
    rand: mulberry32(0x3309c5),
  });
  applyHighpass1(out, sampleRate, 80);
  applyLowpass2(out, sampleRate, 2300, 0.68);
  normalizePeak(out, 0.18);
  return shapeEnvelope(out, sampleRate, 2.5, 20);
}

function buildLevelUpCue(sampleRate) {
  const n = Math.max(64, Math.round(0.275 * sampleRate));
  const out = new Float32Array(n);
  const rand = mulberry32(0x440bd7);
  // Open fifth D4 -> A4: calm mastery climb without fanfare.
  addFeltNote(out, sampleRate, {
    startSec: 0,
    freqHz: 293.66, // D4
    amp: 0.13,
    tausSec: [0.068, 0.038, 0.020, 0.010],
    partialAmps: [1.0, 0.32, 0.11, 0.03],
    contactMs: 2.8,
    rand,
  });
  addFeltNote(out, sampleRate, {
    startSec: 0.058,
    freqHz: 440.00, // A4
    amp: 0.15,
    tausSec: [0.088, 0.046, 0.024, 0.011],
    partialAmps: [1.0, 0.35, 0.12, 0.04],
    contactMs: 2.8,
    rand,
  });
  applyHighpass1(out, sampleRate, 80);
  applyLowpass2(out, sampleRate, 2450, 0.68);
  normalizePeak(out, 0.19);
  return shapeEnvelope(out, sampleRate, 2.5, 24);
}

function buildMissCue(sampleRate) {
  const n = Math.max(64, Math.round(0.092 * sampleRate));
  const out = new Float32Array(n);
  const rand = mulberry32(0x550de9);
  // Calm muted wood/paper settle: zero harsh buzzer or punitive drop.
  let brown = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate;
    const white = rand() * 2 - 1;
    brown = 0.93 * brown + 0.07 * white;
    const brush = Math.exp(-t / 0.0055) * brown * 0.42;
    const wood = 0.72 * Math.exp(-t / 0.019) * Math.sin(2 * Math.PI * 208 * t)
      + 0.45 * Math.exp(-t / 0.015) * Math.sin(2 * Math.PI * 174 * t + 0.4);
    out[i] = 0.16 * (wood + brush);
  }
  applyHighpass1(out, sampleRate, 70);
  applyLowpass2(out, sampleRate, 920, 0.65);
  normalizePeak(out, 0.16);
  return shapeEnvelope(out, sampleRate, 3.5, 16);
}

function buildCompleteCue(sampleRate) {
  const n = Math.max(64, Math.round(0.43 * sampleRate));
  const out = new Float32Array(n);
  const rand = mulberry32(0x660ffb);
  // Serene open fifth + octave fifth: C4 -> G4 -> D5.
  const notes = [
    { startSec: 0, freqHz: 261.63, amp: 0.12, tausSec: [0.135, 0.070, 0.036, 0.016] },
    { startSec: 0.078, freqHz: 392.00, amp: 0.13, tausSec: [0.140, 0.074, 0.038, 0.018] },
    { startSec: 0.158, freqHz: 587.33, amp: 0.11, tausSec: [0.150, 0.078, 0.040, 0.018] },
  ];
  for (const note of notes) {
    addFeltNote(out, sampleRate, {
      ...note,
      partialAmps: [1.0, 0.28, 0.09, 0.03],
      contactMs: 3.2,
      rand,
    });
  }
  applyHighpass1(out, sampleRate, 70);
  applyLowpass2(out, sampleRate, 2500, 0.68);
  normalizePeak(out, 0.20);
  return shapeEnvelope(out, sampleRate, 3, 32);
}

const CUE_BUILDERS = Object.freeze({
  tap: buildTapCue,
  flip: buildFlipCue,
  correct: buildCorrectCue,
  levelUp: buildLevelUpCue,
  miss: buildMissCue,
  complete: buildCompleteCue,
});

/** Synthesize a click-free, warm mono Float32Array PCM buffer for `cue` at `sampleRate`. */
export function synthesizeCueSamples(cue, sampleRate = 44100) {
  const builder = CUE_BUILDERS[cue];
  if (!builder) return null;
  const safeRate = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 44100;
  const samples = builder(safeRate);
  for (let i = 0; i < samples.length; i += 1) {
    if (!Number.isFinite(samples[i])) samples[i] = 0;
    else if (samples[i] > MAX_BUFFER_PEAK) samples[i] = MAX_BUFFER_PEAK;
    else if (samples[i] < -MAX_BUFFER_PEAK) samples[i] = -MAX_BUFFER_PEAK;
  }
  return samples;
}

const SUSPENDED_STALE_MS = 180;

let sharedCtx = null;
let sharedCtxRate = 0;
let cachedBuffers = new Map();
let lastPlayedAt = 0;
const lastCueAt = new Map();
let idleTimer = null;
let previewTimers = [];
const activePreviewSources = new Set();
let pendingSuspendedCue = null;

function clearPreviewTimers() {
  for (const timer of previewTimers) clearTimeout(timer);
  previewTimers = [];
}

/** Cancel any queued or in-flight Settings › Appearance sound preview cues. */
export function stopSoundPreview() {
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
  }
  return sharedCtx;
}

function getBakedBuffer(ctx, cue) {
  const rate = ctx.sampleRate || sharedCtxRate || 44100;
  const key = `${cue}@${rate}`;
  if (cachedBuffers.has(key)) return cachedBuffers.get(key);
  const samples = synthesizeCueSamples(cue, rate);
  if (!samples || typeof ctx.createBuffer !== 'function') return null;
  const buffer = ctx.createBuffer(1, samples.length, rate);
  if (typeof buffer.copyToChannel === 'function') buffer.copyToChannel(samples, 0);
  else buffer.getChannelData?.(0)?.set?.(samples);
  cachedBuffers.set(key, buffer);
  return buffer;
}

function startCuePlayback(ctx, buffer, cue, tier, options = {}) {
  const source = ctx.createBufferSource?.();
  const gain = ctx.createGain?.();
  if (!source || !gain || !ctx.destination) return false;

  const targetGain = CUE_GAINS[tier]?.[cue] ?? 0.52;
  const startAt = ctx.currentTime || 0;
  source.buffer = buffer;
  if (source.playbackRate) {
    const jitter = CUE_JITTER[cue] || 0;
    source.playbackRate.value = 1 + (Math.random() * 2 - 1) * jitter;
  }
  gain.gain?.setValueAtTime?.(targetGain, startAt);

  let warmBus = null;
  source.connect(gain);
  if (typeof ctx.createBiquadFilter === 'function') {
    warmBus = ctx.createBiquadFilter();
    warmBus.type = 'lowpass';
    warmBus.frequency?.setValueAtTime?.(2550, startAt);
    warmBus.Q?.setValueAtTime?.(0.65, startAt);
    gain.connect(warmBus);
    warmBus.connect(ctx.destination);
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
    if (warmBus) {
      try { warmBus.disconnect?.(); } catch { /* ignore */ }
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

/** Play one Acoustic Desk cue respecting the learner's sound mode, mic mute guard, tab visibility and cooldowns. */
export function playSound(cue, options = {}) {
  try {
    if (!SOUND_CUES.includes(cue)) return false;
    if (isAudioCaptureActive()) return false;
    const mode = options.mode ?? loadAppearance().sound;
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
    if (!ctx || !ctx.destination) return false;
    const buffer = getBakedBuffer(ctx, cue);
    if (!buffer || typeof ctx.createBufferSource !== 'function' || typeof ctx.createGain !== 'function') return false;

    if (ctx.state === 'suspended') {
      lastPlayedAt = nowMs;
      lastCueAt.set(cue, nowMs);
      pendingSuspendedCue = { cue, tier, options, requestedAt: nowMs };
      const resuming = Promise.resolve(ctx.resume?.());
      if (ctx.state === 'suspended') {
        resuming.then(() => {
          const pending = pendingSuspendedCue;
          pendingSuspendedCue = null;
          if (!pending || ctx !== sharedCtx || ctx.state !== 'running') return;
          if (Date.now() - pending.requestedAt > SUSPENDED_STALE_MS) return;
          if (isAudioCaptureActive()) return;
          if (!pending.options.allowHidden && globalThis.document?.hidden === true) return;
          const latestMode = pending.options.mode ?? loadAppearance().sound;
          if (!pending.options.force && latestMode === 'off') return;
          const baked = getBakedBuffer(ctx, pending.cue);
          if (!baked) return;
          startCuePlayback(ctx, baked, pending.cue, pending.tier, pending.options);
        }, () => {
          pendingSuspendedCue = null;
        });
        return true;
      }
      pendingSuspendedCue = null;
    }

    lastPlayedAt = nowMs;
    lastCueAt.set(cue, nowMs);
    return startCuePlayback(ctx, buffer, cue, tier, options);
  } catch {
    return false;
  }
}

/** Gentle three-note chime for TodayTimer (allowed in background tabs unless mic/tab capture is active). */
export function playTimerChime() {
  return playSound('complete', { force: true, allowHidden: true, skipThrottle: true });
}

/** Audition the current sound tier from Settings › Appearance (works even when mode is still 'off'). */
export function playSoundPreview(mode = 'subtle') {
  stopSoundPreview();
  if (isAudioCaptureActive()) return false;
  const tier = mode === 'standard' ? 'standard' : 'subtle';
  const sequence = tier === 'standard'
    ? [
      { delayMs: 0, cue: 'tap' },
      { delayMs: 160, cue: 'flip' },
      { delayMs: 370, cue: 'correct' },
    ]
    : [
      { delayMs: 0, cue: 'flip' },
      { delayMs: 220, cue: 'correct' },
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
  pendingSuspendedCue = null;
  clearIdleTimer();
  lastPlayedAt = 0;
  lastCueAt.clear();
  cachedBuffers.clear();
  if (sharedCtx) {
    try { Promise.resolve(sharedCtx.close?.()).catch(() => {}); } catch { /* ignore */ }
    sharedCtx = null;
    sharedCtxRate = 0;
  }
}
