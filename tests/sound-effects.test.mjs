import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';
import { buildHostClient } from '../scripts/build.mjs';

const mod = await loadUi(`
  export { SOUND_CUES, synthesizeCueSamples, playSound, playTimerChime, playSoundPreview, stopSoundPreview, resetSoundEngineForTests } from './ui/sound-effects.js';
  export { BAKED_SAMPLE_DATA_URIS, BAKED_SAMPLE_GAINS } from './ui/sound-effects-assets.js';
  export { default as AppearanceSection } from './ui/settings/AppearanceSection.jsx';
  export { holdAudioCapture, isAudioCaptureActive } from './ui/live-audio.js';
  export { createVoiceRecorder } from './ui/voice/mic.js';
  export { isEarnedLevelClimb } from './ui/NextDue.jsx';
  export { APPEARANCE_DEFAULTS, saveAppearance } from './ui/appearance-prefs.js';
`);

const {
  SOUND_CUES,
  synthesizeCueSamples,
  playSound,
  playTimerChime,
  playSoundPreview,
  stopSoundPreview,
  resetSoundEngineForTests,
  BAKED_SAMPLE_DATA_URIS,
  BAKED_SAMPLE_GAINS,
  AppearanceSection,
  holdAudioCapture,
  isAudioCaptureActive,
  createVoiceRecorder,
  isEarnedLevelClimb,
  APPEARANCE_DEFAULTS,
  saveAppearance,
} = mod;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
  };
}

function createFakeAudioEnv({ defaultResumeImpl = null } = {}) {
  const contexts = [];
  const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 44100;
      this.state = 'suspended';
      this.currentTime = 0;
      this.destination = { kind: 'destination' };
      this.resumed = 0;
      this.closed = false;
      this.plays = [];
      this.gains = [];
      this.filters = [];
      this.resumeImpl = defaultResumeImpl;
      contexts.push(this);
    }
    resume() {
      this.resumed += 1;
      if (this.resumeImpl) return this.resumeImpl(this);
      this.state = 'running';
      return Promise.resolve();
    }
    suspend() {
      this.state = 'suspended';
      return Promise.resolve();
    }
    close() {
      this.closed = true;
      this.state = 'closed';
      return Promise.resolve();
    }
    createBuffer(channels, length, sampleRate) {
      const channel = new Float32Array(length);
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        copyToChannel: (src) => channel.set(src),
        getChannelData: () => channel,
      };
    }
    createBufferSource() {
      const src = {
        buffer: null,
        playbackRate: { value: 1 },
        connectedTo: null,
        disconnected: 0,
        stopped: 0,
        onended: null,
        connect: (target) => { src.connectedTo = target; return target; },
        disconnect: () => { src.disconnected += 1; src.connectedTo = null; },
        stop: () => { src.stopped += 1; },
        start: (when = 0) => {
          this.plays.push({ when, source: src, samples: src.buffer?.length || 0, playbackRate: src.playbackRate.value });
        },
      };
      return src;
    }
    createGain() {
      const gain = {
        value: null,
        gain: { setValueAtTime: (value) => { gain.value = value; } },
        connectedTo: null,
        disconnected: 0,
        connect: (target) => { gain.connectedTo = target; return target; },
        disconnect: () => { gain.disconnected += 1; gain.connectedTo = null; },
      };
      this.gains.push(gain);
      return gain;
    }
    createBiquadFilter() {
      const filter = {
        type: 'lowpass',
        frequency: { value: 2550, setValueAtTime: (v) => { filter.frequency.value = v; } },
        Q: { value: 0.7, setValueAtTime: (v) => { filter.Q.value = v; } },
        connectedTo: null,
        disconnected: 0,
        connect: (target) => { filter.connectedTo = target; return target; },
        disconnect: () => { filter.disconnected += 1; filter.connectedTo = null; },
      };
      this.filters.push(filter);
      return filter;
    }
  }

  const storage = memoryStorage();
  const document = { hidden: false };
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });

  return {
    contexts,
    storage,
    document,
    restore() {
      resetSoundEngineForTests();
      if (originalAudioContext) Object.defineProperty(globalThis, 'AudioContext', originalAudioContext);
      else delete globalThis.AudioContext;
      if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
      else delete globalThis.localStorage;
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
      else delete globalThis.document;
    },
  };
}

test('synthesized Acoustic Desk waveforms are warm, click-free, bounded and non-empty for every cue', () => {
  assert.deepEqual(SOUND_CUES, ['tap', 'flip', 'correct', 'levelUp', 'miss', 'complete']);
  for (const cue of SOUND_CUES) {
    const samples = synthesizeCueSamples(cue, 44100);
    assert.ok(samples instanceof Float32Array, `${cue} returns Float32Array`);
    assert.ok(samples.length > 500, `${cue} has realistic duration`);
    assert.equal(samples[0], 0, `${cue} starts cleanly at zero`);
    assert.equal(samples[samples.length - 1], 0, `${cue} ends cleanly at zero`);
    let peak = 0;
    let diffEnergy = 0;
    let totalEnergy = 0;
    for (let i = 0; i < samples.length; i += 1) {
      assert.ok(Number.isFinite(samples[i]), `${cue} sample ${i} finite`);
      const abs = Math.abs(samples[i]);
      if (abs > peak) peak = abs;
      totalEnergy += samples[i] * samples[i];
      if (i > 0) {
        const d = samples[i] - samples[i - 1];
        diffEnergy += d * d;
      }
    }
    assert.ok(peak > 0.05 && peak <= 0.50, `${cue} peak ${peak} is present and safely below clipping`);
    const roughness = diffEnergy / Math.max(totalEnergy, 1e-12);
    const maxRoughness = cue === 'flip' ? 0.50 : cue === 'tap' ? 0.25 : 0.08;
    assert.ok(roughness < maxRoughness, `${cue} high-frequency roughness ratio (${roughness.toFixed(4)}) stays clean and alias-free`);
  }
  assert.equal(synthesizeCueSamples('unknown-cue'), null);
});

test('default sound=off creates zero AudioContext instances even when triggers fire', () => {
  const env = createFakeAudioEnv();
  try {
    resetSoundEngineForTests();
    assert.equal(APPEARANCE_DEFAULTS.sound, 'off');
    for (const cue of SOUND_CUES) {
      assert.equal(playSound(cue), false, `${cue} skipped when sound=off`);
    }
    assert.equal(env.contexts.length, 0, 'AudioContext stays untouched when sound is off');
  } finally {
    env.restore();
  }
});

test('subtle vs standard gating and preview/hidden-tab timer chime rules hold', () => {
  const env = createFakeAudioEnv();
  try {
    resetSoundEngineForTests();
    saveAppearance({ sound: 'subtle' }, env.storage);
    assert.equal(playSound('tap'), false, 'subtle suppresses tap cue');
    assert.equal(env.contexts.length, 0);
    assert.equal(playSound('flip', { skipThrottle: true }), true, 'subtle plays flip');
    assert.equal(playSound('correct', { skipThrottle: true }), true, 'subtle plays correct');
    assert.equal(playSound('levelUp', { skipThrottle: true }), true, 'subtle plays levelUp');
    assert.equal(playSound('miss', { skipThrottle: true }), true, 'subtle plays miss');
    assert.equal(playSound('complete', { skipThrottle: true }), true, 'subtle plays complete');
    assert.equal(env.contexts[0].plays.length, 5);

    saveAppearance({ sound: 'standard' }, env.storage);
    assert.equal(playSound('tap', { skipThrottle: true }), true, 'standard plays tap cue');
    assert.equal(env.contexts[0].plays.length, 6);

    // Hidden tab suppresses review sounds, but still allows explicit TodayTimer completion chimes.
    env.document.hidden = true;
    assert.equal(playSound('correct', { skipThrottle: true }), false);
    assert.equal(playTimerChime(), true);
    assert.equal(env.contexts[0].plays.length, 7);

    // Setting sound back to off still permits Settings › 试听 preview.
    env.document.hidden = false;
    saveAppearance({ sound: 'off' }, env.storage);
    assert.equal(playSoundPreview('off'), true, 'Preview auditions even before user switches away from Off');
    assert.equal(env.contexts[0].plays.length, 8);
  } finally {
    env.restore();
  }
});

test('microphone recording and live-class capture immediately mute all cues and preview', async () => {
  const env = createFakeAudioEnv();
  try {
    resetSoundEngineForTests();
    saveAppearance({ sound: 'standard' }, env.storage);
    assert.equal(isAudioCaptureActive(), false);

    const releaseHold = holdAudioCapture();
    assert.equal(isAudioCaptureActive(), true);
    assert.equal(playSound('correct', { skipThrottle: true }), false);
    assert.equal(playSoundPreview('standard'), false);
    assert.equal(playTimerChime(), false);
    assert.equal(env.contexts.length, 0);

    // Release is idempotent and restores normal playback once all captures end.
    releaseHold();
    releaseHold();
    assert.equal(isAudioCaptureActive(), false);
    assert.equal(playSound('flip', { skipThrottle: true }), true);
    assert.equal(env.contexts[0].plays.length, 1);

    // Voice recorder with injected capture stub also holds & releases the capture guard.
    let stopped = 0;
    const recorder = createVoiceRecorder({
      call: async () => ({}),
      capture: async () => ({ stop: async () => { stopped += 1; } }),
      scope: () => 'deck:card1',
      every: () => () => {},
    });
    await recorder.start();
    assert.equal(isAudioCaptureActive(), true);
    assert.equal(playSound('tap', { skipThrottle: true }), false);
    await recorder.cancel();
    assert.equal(stopped, 1);
    assert.equal(isAudioCaptureActive(), false);
    assert.equal(playSound('tap', { skipThrottle: true }), true);
  } finally {
    env.restore();
  }
});

test('isEarnedLevelClimb matches NextDue mastery progression semantics', () => {
  assert.equal(isEarnedLevelClimb({ correct: false, level: 'learning', beforeLevel: 'weak' }), false);
  assert.equal(isEarnedLevelClimb({ correct: true, level: 'learning', beforeLevel: 'new' }), false);
  assert.equal(isEarnedLevelClimb({ correct: true, level: 'familiar', beforeLevel: 'familiar' }), false);
  assert.equal(isEarnedLevelClimb({ correct: true, level: 'learning', beforeLevel: 'weak' }), true);
  assert.equal(isEarnedLevelClimb({ correct: true, level: 'mastered' }, { beforeLevel: 'familiar' }), true);
});

test('suspended AudioContext never queues source.start synchronously while resume() is blocked and drops stale (>180ms) cues', async () => {
  let unlockResume = null;
  const env = createFakeAudioEnv({
    defaultResumeImpl: (ctx) => new Promise((resolve) => {
      unlockResume = () => {
        ctx.state = 'running';
        resolve();
      };
    }),
  });
  const realNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    resetSoundEngineForTests();
    saveAppearance({ sound: 'standard' }, env.storage);

    // Fire multiple cues while ctx.state === 'suspended' and resume() is blocked.
    assert.equal(playSound('tap', { skipThrottle: true }), true);
    now += 20;
    assert.equal(playSound('flip', { skipThrottle: true }), true);
    now += 20;
    assert.equal(playSound('correct', { skipThrottle: true }), true);
    const ctx = env.contexts[0];
    assert.equal(ctx.state, 'suspended');
    assert.equal(ctx.plays.length, 0, 'zero synchronous source.start calls queued while suspended');
    assert.ok(ctx.resumed >= 1, 'resume() requested while suspended');

    // User gesture arrives 250ms later (> 180ms stale threshold): queued cue must be dropped, never burst.
    now += 250;
    unlockResume();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(ctx.state, 'running');
    assert.equal(ctx.plays.length, 0, 'stale (>180ms) suspended cues are dropped instead of bursting on unlock');

    // Suspend again and unlock within <= 180ms: plays at most the single fresh cue (no stacked burst).
    await ctx.suspend();
    ctx.resumeImpl = (target) => new Promise((resolve) => {
      unlockResume = () => {
        target.state = 'running';
        resolve();
      };
    });
    assert.equal(playSound('tap', { skipThrottle: true }), true);
    now += 15;
    assert.equal(playSound('flip', { skipThrottle: true }), true);
    assert.equal(ctx.plays.length, 0);
    now += 80; // 80ms <= 180ms
    unlockResume();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(ctx.plays.length, 1, 'fresh (<180ms) unlock plays only the latest single cue, never a stacked burst');

    // Suspend again, switch sound to off before unlock -> nothing plays on unlock.
    await ctx.suspend();
    ctx.resumeImpl = (target) => new Promise((resolve) => {
      unlockResume = () => {
        target.state = 'running';
        resolve();
      };
    });
    assert.equal(playSound('correct', { skipThrottle: true }), true);
    saveAppearance({ sound: 'off' }, env.storage);
    now += 40;
    unlockResume();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(ctx.plays.length, 1, 'muting before resume resolves suppresses the pending cue');
  } finally {
    Date.now = realNow;
    env.restore();
  }
});

test('source.onended disconnects source, gain, and warmBus (BiquadFilterNode) cleanly without leaking graph nodes', () => {
  const env = createFakeAudioEnv();
  try {
    resetSoundEngineForTests();
    saveAppearance({ sound: 'standard' }, env.storage);
    assert.equal(playSound('correct', { skipThrottle: true }), true);
    const ctx = env.contexts[0];
    assert.equal(ctx.plays.length, 1);
    const src = ctx.plays[0].source;
    const gain = ctx.gains[0];
    const warmBus = ctx.filters[0];
    assert.ok(src && gain && warmBus, 'source, gain and airBus created');
    assert.ok(warmBus.frequency.value >= 10_000, `airBus cutoff (${warmBus.frequency.value} Hz) stays transparent instead of muddying highs`);
    assert.equal(src.connectedTo, gain);
    assert.equal(gain.connectedTo, warmBus);
    assert.equal(warmBus.connectedTo, ctx.destination);
    assert.equal(typeof src.onended, 'function', 'source.onended handler attached');

    src.onended();
    assert.equal(src.disconnected, 1, 'source disconnected on ended');
    assert.equal(gain.disconnected, 1, 'gain disconnected on ended');
    assert.equal(warmBus.disconnected, 1, 'warmBus disconnected on ended');

    // Idempotent if invoked twice.
    src.onended();
    assert.equal(src.disconnected, 1);
    assert.equal(gain.disconnected, 1);
    assert.equal(warmBus.disconnected, 1);
  } finally {
    env.restore();
  }
});

function findReactElement(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findReactElement(item, predicate);
      if (hit) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  if (node.props?.children) return findReactElement(node.props.children, predicate);
  return null;
}

test('stopSoundPreview cancels scheduled preview cues and AppearanceSection calls it when switching sound to off', async () => {
  const env = createFakeAudioEnv();
  try {
    resetSoundEngineForTests();
    saveAppearance({ sound: 'standard' }, env.storage);

    assert.equal(playSoundPreview('subtle'), true);
    const directCtx = env.contexts[0];
    assert.equal(directCtx.plays.length, 1);
    stopSoundPreview();
    assert.equal(directCtx.plays[0].source.stopped, 1, 'direct stopSoundPreview() stops active preview source');

    assert.equal(playSoundPreview('standard'), true);
    const ctx = env.contexts[0];
    assert.equal(ctx.plays.length, 2, 'step 0 of second preview played immediately');
    const firstPreviewSource = ctx.plays[1].source;

    let chosenSound = 'standard';
    const tree = AppearanceSection({
      appearance: {
        language: 'zh',
        theme: 'light',
        sound: chosenSound,
        onLanguage: () => {},
        onTheme: () => {},
        onSound: (value) => {
          chosenSound = value;
          saveAppearance({ sound: value }, env.storage);
        },
      },
    });
    const soundControl = findReactElement(
      tree,
      (el) => typeof el?.props?.onChange === 'function'
        && Array.isArray(el?.props?.options)
        && el.props.options.some((opt) => opt.value === 'subtle'),
    );
    assert.ok(soundControl, 'found sound SegmentedControl in AppearanceSection');

    // Switching sound to 'off' via AppearanceSection calls stopSoundPreview(), stopping step 0 and cancelling delayed preview steps.
    soundControl.props.onChange('off');
    assert.equal(chosenSound, 'off');
    assert.equal(firstPreviewSource.stopped, 1, 'active preview buffer source stopped immediately');
    assert.equal(firstPreviewSource.disconnected, 1, 'active preview buffer source disconnected');

    await new Promise((resolve) => setTimeout(resolve, 980));
    assert.equal(ctx.plays.length, 2, 'delayed preview cues (180ms, 920ms) were cancelled when switched to off');
  } finally {
    env.restore();
  }
});

test('baked studio MP3 assets decode cleanly via decodeAudioData and fall back to DSP if decoding fails', async () => {
  assert.deepEqual(Object.keys(BAKED_SAMPLE_DATA_URIS).sort(), ['correct', 'flip', 'tap']);
  for (const cue of ['tap', 'flip', 'correct']) {
    assert.ok(BAKED_SAMPLE_DATA_URIS[cue].startsWith('data:audio/mpeg;base64,'), `${cue} is an embedded MP3 data URI`);
    assert.ok(BAKED_SAMPLE_GAINS[cue] > 0 && BAKED_SAMPLE_GAINS[cue] <= 1.25, `${cue} gain calibration is bounded`);
  }

  const env = createFakeAudioEnv();
  try {
    resetSoundEngineForTests();
    saveAppearance({ sound: 'standard' }, env.storage);

    let decodeCalls = 0;
    const OrigCtx = globalThis.AudioContext;
    class DecodingFakeAudioContext extends OrigCtx {
      decodeAudioData(ab) {
        decodeCalls += 1;
        assert.ok(ab instanceof ArrayBuffer && ab.byteLength > 1000, 'decoded MP3 payload is non-empty');
        const buf = this.createBuffer(2, 1024, this.sampleRate);
        buf.getChannelData(0)[10] = 0.5;
        return Promise.resolve(buf);
      }
    }
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: DecodingFakeAudioContext });

    assert.equal(playSound('correct', { skipThrottle: true }), true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const ctx = env.contexts[0];
    assert.equal(decodeCalls, 3, 'all 3 baked samples preloaded once');
    assert.equal(ctx.plays.length, 1, 'decoded studio piano sample played cleanly');
    assert.equal(ctx.plays[0].samples, 1024);

    // Subsequent call plays synchronously from cache with zero extra decodes.
    assert.equal(playSound('flip', { skipThrottle: true }), true);
    assert.equal(decodeCalls, 3);
    assert.equal(ctx.plays.length, 2);

    // Celesta cues play synchronously as stereo DSP buffers without decodeAudioData.
    assert.equal(playSound('levelUp', { skipThrottle: true }), true);
    assert.equal(ctx.plays.length, 3);
    assert.equal(ctx.plays[2].source.buffer.numberOfChannels, 2);

    // Failed decodeAudioData falls back cleanly to synchronous DSP buffer without throwing.
    resetSoundEngineForTests();
    saveAppearance({ sound: 'standard' }, env.storage);
    class FailingDecodeAudioContext extends OrigCtx {
      decodeAudioData() {
        return Promise.reject(new Error('decode failed'));
      }
    }
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FailingDecodeAudioContext });
    assert.equal(playSound('tap', { skipThrottle: true }), true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const ctx2 = env.contexts[1];
    assert.equal(ctx2.plays.length, 1, 'fallback DSP buffer played when decodeAudioData rejects');
    assert.equal(ctx2.plays[0].source.buffer.numberOfChannels, 2);
  } finally {
    env.restore();
  }
});

test('synthesizeCueSamples scales micro-room envelope cleanly across 44.1kHz, 48kHz and 96kHz sample rates', () => {
  for (const rate of [44100, 48000, 96000]) {
    for (const cue of SOUND_CUES) {
      const samples = synthesizeCueSamples(cue, rate);
      assert.ok(samples instanceof Float32Array);
      assert.equal(samples[0], 0, `${cue}@${rate} starts at zero`);
      assert.equal(samples[samples.length - 1], 0, `${cue}@${rate} ends at zero`);
      assert.ok(samples.length >= Math.floor(0.03 * rate), `${cue}@${rate} length scales with sampleRate`);
    }
  }

  // The closing fade is set in milliseconds, not samples: the level 2 ms before the end (relative to the peak) is the same at every sample rate.
  for (const cue of ['tap', 'correct', 'miss', 'complete']) {
    const levels = [44100, 48000, 96000].map((rate) => {
      const samples = synthesizeCueSamples(cue, rate);
      let peak = 0;
      for (const value of samples) peak = Math.max(peak, Math.abs(value));
      return Math.abs(samples[samples.length - 1 - Math.round(0.002 * rate)]) / peak;
    });
    assert.ok(Math.max(...levels) / Math.min(...levels) < 1.25, `${cue}: the closing fade has the same length in ms at every sample rate (${levels.join(', ')})`);
  }
});

test('sound-effects lazy-loads sound-effects-assets via dynamic import and keeps 40KB MP3 payload out of static initial UI chunks', async () => {
  const built = await buildHostClient({ write: false });
  const outputs = Object.entries(built.metafile.outputs);
  const assetsChunks = outputs.filter(([, meta]) => Object.keys(meta.inputs || {}).some((p) => p.endsWith('ui/sound-effects-assets.js')));
  assert.equal(assetsChunks.length, 1, 'sound-effects-assets.js is emitted in a dedicated chunk');
  const [assetsOutPath, assetsMeta] = assetsChunks[0];
  assert.deepEqual(Object.keys(assetsMeta.inputs), ['ui/sound-effects-assets.js'], 'assets chunk contains only sound-effects-assets.js');
  const assetsFile = assetsOutPath.split(/[\\/]/).pop();
  const edgesToAssets = outputs.flatMap(([outPath, meta]) =>
    (meta.imports || [])
      .filter((edge) => edge.path.endsWith(assetsFile))
      .map((edge) => ({ outPath, kind: edge.kind })),
  );
  assert.ok(edgesToAssets.length >= 1, 'sound-effects chunk imports the dedicated baked MP3 assets chunk');
  assert.ok(
    edgesToAssets.every((edge) => edge.kind === 'dynamic-import'),
    `every import edge to ${assetsFile} must be dynamic-import (never static import), got ${JSON.stringify(edgesToAssets)}`,
  );
});
