import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

const mod = await loadUi(`
  export { SOUND_CUES, synthesizeCueSamples, playSound, playTimerChime, playSoundPreview, resetSoundEngineForTests } from './ui/sound-effects.js';
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
  resetSoundEngineForTests,
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

function createFakeAudioEnv() {
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
      contexts.push(this);
    }
    resume() {
      this.resumed += 1;
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
        connect: (target) => { src.connectedTo = target; return target; },
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
        connect: (target) => { gain.connectedTo = target; return target; },
      };
      return gain;
    }
    createBiquadFilter() {
      const filter = {
        type: 'lowpass',
        frequency: { value: 2550, setValueAtTime: (v) => { filter.frequency.value = v; } },
        Q: { value: 0.7, setValueAtTime: (v) => { filter.Q.value = v; } },
        connectedTo: null,
        connect: (target) => { filter.connectedTo = target; return target; },
      };
      return filter;
    }
  }

  const storage = memoryStorage();
  const fakeDoc = { hidden: false };
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDoc });

  return {
    contexts,
    storage,
    fakeDoc,
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
    assert.ok(peak > 0.02 && peak <= 0.22, `${cue} peak ${peak} is present and far from clipping`);
    const roughness = diffEnergy / Math.max(totalEnergy, 1e-12);
    assert.ok(roughness < 0.08, `${cue} high-frequency roughness ratio (${roughness.toFixed(4)}) stays warm and filtered`);
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
    env.fakeDoc.hidden = true;
    assert.equal(playSound('correct', { skipThrottle: true }), false);
    assert.equal(playTimerChime(), true);
    assert.equal(env.contexts[0].plays.length, 7);

    // Setting sound back to off still permits Settings › 试听 preview.
    env.fakeDoc.hidden = false;
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
