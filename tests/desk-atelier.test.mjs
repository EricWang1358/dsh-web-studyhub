/* Desk Atelier behavioral & accessibility tests.
   Note on static CSS guardrails below: Node has no CSS cascade, @layer, :has(),
   prefers-reduced-motion, forced-colors, or layout-overflow evaluator, so the
   stylesheet guardrail test intentionally inspects desk-atelier-trigger.css and
   desk-atelier.css statically for those CSS-only invariants. All JS/JSX behavior
   (audio synthesis, store persistence, capture guard, language reactivity,
   Alt+Shift+A shortcut, lazy panel/chime loading, no-setInterval, code-splitting)
   is tested dynamically at runtime. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { boardAction } from '../lib/board.js';
import { SOUNDSCAPE_DATA_URIS, SOUNDSCAPE_CHANNEL_GAINS } from '../ui/desk-atelier/soundscape-assets.js';
import { loadUi } from './helpers/ui-module.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const mod = await loadUi(`
  export { setUiLanguage } from './ui/i18n.js';
  export { holdAudioCapture, isAudioCaptureActive } from './ui/audio-capture-state.js';
  export {
    ATELIER_CHANNELS,
    ATELIER_CHANNEL_IDS,
    ATELIER_PRESETS,
    ATMOSPHERE_MODES,
    detectActivePreset,
    resolveAtmosphereLighting,
  } from './ui/desk-atelier/atelier-presets.js';
  export {
    DESK_ATELIER_KEY,
    DESK_ATELIER_DEFAULTS,
    createAtelierStore,
    loadAtelierPrefs,
    saveAtelierPrefs,
    sharedAtelierStore,
  } from './ui/desk-atelier/atelier-storage.js';
  export {
    BAMBOO_PENTATONIC_HZ,
    CHANNEL_LOOP_SECONDS,
    synthesizeSoundscapeChannel,
    buildSeamlessSampleBuffer,
    startSoundscape,
    stopSoundscape,
    toggleSoundscape,
    selectSoundscapePreset,
    setSoundscapeChannel,
    setSoundscapeMaster,
    resetSoundscapeMix,
    setDeskAtmosphere,
    syncSoundscapeCaptureGuard,
    resetSoundscapeEngineForTests,
  } from './ui/desk-atelier/soundscape-engine.js';
  export { default as DeskAtelierButton } from './ui/desk-atelier/DeskAtelierButton.jsx';
  export { default as DeskAtelierPanel } from './ui/desk-atelier/DeskAtelierPanel.jsx';
  export { default as AtmosphereLayer } from './ui/desk-atelier/AtmosphereLayer.jsx';
  export { default as FocusRitualDial, dialArcMetrics } from './ui/desk-atelier/FocusRitualDial.jsx';
  export { default as BreathingHalo, BREATH_PHASES, breathingSnapshot } from './ui/desk-atelier/BreathingHalo.jsx';
  export { default as FocusSoundscapePill } from './ui/desk-atelier/FocusSoundscapePill.jsx';
  export { default as TodayTimer } from './ui/board/TodayTimer.jsx';
`);

const {
  setUiLanguage,
  holdAudioCapture,
  isAudioCaptureActive,
  ATELIER_CHANNELS,
  ATELIER_CHANNEL_IDS,
  ATELIER_PRESETS,
  ATMOSPHERE_MODES,
  detectActivePreset,
  resolveAtmosphereLighting,
  DESK_ATELIER_KEY,
  DESK_ATELIER_DEFAULTS,
  createAtelierStore,
  loadAtelierPrefs,
  saveAtelierPrefs,
  sharedAtelierStore,
  BAMBOO_PENTATONIC_HZ,
  synthesizeSoundscapeChannel,
  buildSeamlessSampleBuffer,
  startSoundscape,
  stopSoundscape,
  toggleSoundscape,
  selectSoundscapePreset,
  setSoundscapeChannel,
  setSoundscapeMaster,
  resetSoundscapeMix,
  setDeskAtmosphere,
  syncSoundscapeCaptureGuard,
  resetSoundscapeEngineForTests,
  DeskAtelierButton,
  DeskAtelierPanel,
  AtmosphereLayer,
  FocusRitualDial,
  dialArcMetrics,
  BreathingHalo,
  BREATH_PHASES,
  breathingSnapshot,
  FocusSoundscapePill,
  TodayTimer,
} = mod;

const HAN = /[\u3400-\u9fff]/;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

function createFakeAudioEnv() {
  const contexts = [];
  const origAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const origLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 22050;
      this.state = 'suspended';
      this.currentTime = 1;
      this.destination = { kind: 'destination' };
      this.resumed = 0;
      this.suspended = 0;
      this.closed = false;
      this.sources = [];
      this.gains = [];
      this.filters = [];
      contexts.push(this);
    }
    resume() {
      this.resumed += 1;
      this.state = 'running';
      return Promise.resolve();
    }
    suspend() {
      this.suspended += 1;
      this.state = 'suspended';
      return Promise.resolve();
    }
    close() {
      this.closed = true;
      this.state = 'closed';
      return Promise.resolve();
    }
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        copyToChannel: (src, ch) => { data[ch]?.set(src); },
        getChannelData: (ch) => data[ch],
      };
    }
    createBufferSource() {
      const src = {
        buffer: null,
        loop: false,
        started: 0,
        stopped: 0,
        disconnected: 0,
        connectedTo: null,
        connect: (target) => { src.connectedTo = target; return target; },
        disconnect: () => { src.disconnected += 1; src.connectedTo = null; },
        start: () => { src.started += 1; },
        stop: () => { src.stopped += 1; },
      };
      this.sources.push(src);
      return src;
    }
    createGain() {
      const gain = {
        lastValue: 0,
        gain: {
          value: 0,
          cancelScheduledValues: () => {},
          setValueAtTime: (v) => { gain.lastValue = v; gain.gain.value = v; },
          linearRampToValueAtTime: (v) => { gain.lastValue = v; gain.gain.value = v; },
        },
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
        frequency: { value: 11500, setValueAtTime: (v) => { filter.frequency.value = v; } },
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
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

  return {
    contexts,
    storage,
    restore() {
      resetSoundscapeEngineForTests();
      if (origAudioContext) Object.defineProperty(globalThis, 'AudioContext', origAudioContext);
      else delete globalThis.AudioContext;
      if (origLocalStorage) Object.defineProperty(globalThis, 'localStorage', origLocalStorage);
      else delete globalThis.localStorage;
    },
  };
}

test('all 5 procedural soundscape channels synthesise bounded, seamless stereo PCM loops offline', () => {
  assert.deepEqual(ATELIER_CHANNEL_IDS, ['rain', 'vinyl', 'hearth', 'bamboo', 'hum']);
  assert.equal(ATELIER_CHANNELS.length, 5);
  assert.equal(ATELIER_PRESETS.length, 4);
  assert.equal(ATMOSPHERE_MODES.length, 5);
  assert.deepEqual(BAMBOO_PENTATONIC_HZ, [293.66, 329.63, 369.99, 440.0, 493.88, 587.33]);

  for (const id of ATELIER_CHANNEL_IDS) {
    const out = synthesizeSoundscapeChannel(id, 22050, { durationSec: 1.5 });
    assert.ok(out, `${id} returns stereo synthesis`);
    assert.ok(out.left instanceof Float32Array && out.right instanceof Float32Array);
    assert.equal(out.left.length, Math.round(1.5 * 22050));
    assert.equal(out.right.length, out.left.length);

    let peak = 0;
    let energy = 0;
    let diffEnergy = 0;
    for (let i = 0; i < out.left.length; i += 1) {
      const l = out.left[i];
      const r = out.right[i];
      assert.ok(Number.isFinite(l) && Number.isFinite(r), `${id} finite sample ${i}`);
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
      energy += l * l + r * r;
      diffEnergy += (l - r) * (l - r);
    }
    const rms = Math.sqrt(energy / (out.left.length * 2));
    assert.ok(peak > 0.05 && peak <= 0.45, `${id} peak (${peak.toFixed(3)}) stays bounded`);
    assert.ok(rms > 0.04, `${id} RMS (${rms.toFixed(3)}) is audibly present`);
    assert.ok(diffEnergy > 0.1, `${id} has natural stereo width (L != R)`);

    // Seam check: equal-power crossfade keeps wrap boundary continuous without clipping jump.
    const seamL = Math.abs(out.left[0] - out.left[out.left.length - 1]);
    const seamR = Math.abs(out.right[0] - out.right[out.right.length - 1]);
    assert.ok(seamL < 0.35 && seamR < 0.35, `${id} loop seam stays smooth (${seamL.toFixed(3)}, ${seamR.toFixed(3)})`);
  }
  assert.equal(synthesizeSoundscapeChannel('unknown-channel'), null);
});

test('soundscape defaults OFF with zero AudioContext, persists only under study-desk-atelier, and never touches study-interface', () => {
  const env = createFakeAudioEnv();
  try {
    resetSoundscapeEngineForTests();
    const initial = sharedAtelierStore.get();
    assert.equal(initial.playing, false);
    assert.equal(initial.atmosphere, 'none');
    assert.equal(initial.preset, DESK_ATELIER_DEFAULTS.preset);
    assert.equal(env.contexts.length, 0, 'zero AudioContext created while soundscape is OFF');

    // Persisting prefs writes only under study-desk-atelier and leaves study-interface untouched.
    const customStorage = memoryStorage({ 'study-interface': '{"sound":"off"}' });
    const store = createAtelierStore({ storage: customStorage });
    store.applyPreset('morning-bamboo');
    store.setMaster(0.72);
    store.setAtmosphere('lamp');
    assert.equal(customStorage.getItem('study-interface'), '{"sound":"off"}', 'study-interface is never mutated');
    const persisted = loadAtelierPrefs(customStorage);
    assert.equal(persisted.preset, 'morning-bamboo');
    assert.equal(persisted.master, 0.72);
    assert.equal(persisted.atmosphere, 'lamp');
    assert.equal(persisted.channels.bamboo, 0.56);

    // Reloading into a fresh store starts playing:false while remembering mix & lighting.
    const reloaded = createAtelierStore({ storage: customStorage });
    assert.equal(reloaded.get().playing, false);
    assert.equal(reloaded.get().preset, 'morning-bamboo');
    assert.equal(reloaded.get().atmosphere, 'lamp');

    // Corrupt storage falls back cleanly without throwing.
    const corrupt = memoryStorage({ [DESK_ATELIER_KEY]: '{not-valid-json' });
    const recovered = loadAtelierPrefs(corrupt);
    assert.equal(recovered.preset, DESK_ATELIER_DEFAULTS.preset);
    assert.equal(recovered.atmosphere, 'none');

    // Manual slider edit marks preset as custom when departing from curated mixes.
    saveAtelierPrefs({ preset: 'rainy-desk', channels: { rain: 0.9, vinyl: 0, hearth: 0, bamboo: 0, hum: 0 } }, customStorage);
    assert.equal(detectActivePreset({ rain: 0.9, vinyl: 0, hearth: 0, bamboo: 0, hum: 0 }), 'custom');
  } finally {
    env.restore();
  }
});

test('explicit opt-in playback routes looping stereo channels cleanly and auto-mutes during active audio capture', () => {
  const env = createFakeAudioEnv();
  try {
    resetSoundscapeEngineForTests();
    assert.equal(isAudioCaptureActive(), false);

    // 1. Capture active BEFORE starting soundscape -> stays muted and constructs ZERO AudioContext.
    const holdBefore = holdAudioCapture();
    assert.equal(startSoundscape(), false);
    assert.equal(sharedAtelierStore.get().playing, true);
    assert.equal(sharedAtelierStore.get().captureMuted, true);
    assert.equal(env.contexts.length, 0, 'no AudioContext created while capture is active');

    // Releasing capture lets syncSoundscapeCaptureGuard engage audio cleanly.
    holdBefore();
    assert.equal(syncSoundscapeCaptureGuard(), false);
    assert.equal(sharedAtelierStore.get().captureMuted, false);
    assert.equal(env.contexts.length, 1);
    const ctx = env.contexts[0];
    assert.equal(ctx.state, 'running');
    assert.equal(ctx.filters.length, 1);
    assert.ok(ctx.sources.length >= 3, 'active channels from Rainy Night Desk started');
    for (const src of ctx.sources) assert.equal(src.loop, true, 'all channel sources loop seamlessly');
    const masterNode = ctx.gains[0];
    assert.ok(masterNode.lastValue > 0.1, 'master gain ramped above zero');

    // 2. Capture starts WHILE playing -> immediately ramps master gain to 0 and suspends AudioContext.
    const holdMid = holdAudioCapture();
    assert.equal(syncSoundscapeCaptureGuard(), true);
    assert.equal(sharedAtelierStore.get().captureMuted, true);
    assert.equal(masterNode.lastValue, 0);
    assert.equal(ctx.state, 'suspended');

    // 3. Capture ends -> resumes cleanly and restores master gain.
    holdMid();
    assert.equal(syncSoundscapeCaptureGuard(), false);
    assert.equal(sharedAtelierStore.get().captureMuted, false);
    assert.equal(ctx.state, 'running');
    assert.ok(masterNode.lastValue > 0.1);

    // 4. Preset switch, channel adjustment, master volume, reset and stop work smoothly.
    selectSoundscapePreset('winter-hearth');
    assert.equal(sharedAtelierStore.get().preset, 'winter-hearth');
    setSoundscapeChannel('bamboo', 0.4);
    assert.equal(sharedAtelierStore.get().preset, 'custom');
    setSoundscapeMaster(0.8);
    assert.equal(sharedAtelierStore.get().master, 0.8);
    resetSoundscapeMix();
    assert.equal(sharedAtelierStore.get().preset, 'rainy-desk');

    stopSoundscape({ immediate: true });
    assert.equal(sharedAtelierStore.get().playing, false);
    assert.equal(ctx.state, 'suspended');
    assert.ok(ctx.sources.every((src) => src.stopped >= 1 && src.disconnected >= 1));

    // Toggle turns back on cleanly.
    assert.equal(toggleSoundscape(), true);
    assert.equal(sharedAtelierStore.get().playing, true);
    stopSoundscape({ immediate: true });
  } finally {
    env.restore();
  }
});

test('solar lighting resolution, analog ink-dial arc math and 60s 4-4-6 breathing cadence are deterministic', () => {
  // Atmosphere solar cycle across 24 hours.
  assert.equal(resolveAtmosphereLighting('none', 9), 'none');
  assert.equal(resolveAtmosphereLighting('lamp', 9), 'lamp');
  assert.equal(resolveAtmosphereLighting('solar', 8), 'morning-paper');
  assert.equal(resolveAtmosphereLighting('solar', 14), 'rain-mist');
  assert.equal(resolveAtmosphereLighting('solar', 21), 'lamp');
  assert.equal(resolveAtmosphereLighting('solar', 2), 'lamp');

  // FocusRitualDial stroke-dashoffset math.
  const d0 = dialArcMetrics(0, 80);
  const dHalf = dialArcMetrics(0.5, 80);
  const dFull = dialArcMetrics(1, 80);
  assert.ok(Math.abs(d0.dashOffset - d0.circumference) < 0.01);
  assert.ok(Math.abs(dHalf.dashOffset - dHalf.circumference * 0.5) < 0.01);
  assert.ok(Math.abs(dFull.dashOffset) < 0.01);

  // BreathingHalo 4-4-6 phase sequence over 60 seconds.
  assert.deepEqual(BREATH_PHASES.map((p) => [p.id, p.seconds]), [['inhale', 4], ['hold', 4], ['exhale', 6]]);

  const bStart = breathingSnapshot(0);
  assert.equal(bStart.phaseId, 'inhale');
  assert.equal(bStart.phaseRemainingSec, 4);
  assert.equal(bStart.remainingSec, 60);
  assert.equal(bStart.done, false);

  const bMidInhale = breathingSnapshot(2000);
  assert.equal(bMidInhale.phaseId, 'inhale');
  assert.ok(bMidInhale.scale > bStart.scale && bMidInhale.scale < 1);

  const bHold = breathingSnapshot(5000);
  assert.equal(bHold.phaseId, 'hold');
  assert.equal(bHold.scale, 1);
  assert.equal(bHold.phaseRemainingSec, 3);

  const bExhale = breathingSnapshot(11000);
  assert.equal(bExhale.phaseId, 'exhale');
  assert.ok(bExhale.scale < 1 && bExhale.scale > 0.66);
  assert.equal(bExhale.phaseRemainingSec, 3);

  const bJustBeforeDone = breathingSnapshot(59_999);
  assert.equal(bJustBeforeDone.done, false);
  assert.equal(bJustBeforeDone.remainingSec, 1);
  assert.notEqual(bJustBeforeDone.phaseId, 'done');

  const bDone = breathingSnapshot(60_000);
  assert.equal(bDone.done, true);
  assert.equal(bDone.phaseId, 'done');
  assert.equal(bDone.remainingSec, 0);
});

test('Desk Atelier, AtmosphereLayer, FocusRitualDial, BreathingHalo and upgraded TodayTimer render cleanly in zh and en', () => {
  const env = createFakeAudioEnv();
  try {
    resetSoundscapeEngineForTests();
    const today = '2026-11-20';
    const baseBoard = {
      version: 1,
      revision: 2,
      columns: [{ id: 'todo', title: '待办', cardIds: ['c1'] }],
      cards: {
        c1: { id: 'c1', title: '复习信号量与管程', note: '重点比较 Mesa 与 Hoare 语义' },
      },
      timer: {
        id: 't-break',
        mode: 'break',
        cardTitle: '休息',
        durationMinutes: 5,
        startedAt: '2026-11-20T09:00:00.000Z',
        pausedMs: 0,
      },
      timeLog: [],
    };
    const nowMs = Date.parse('2026-11-20T09:02:00.000Z');

    // Default atmosphere 'none' renders zero overlay markup.
    assert.equal(renderToStaticMarkup(React.createElement(AtmosphereLayer)), '');
    setDeskAtmosphere('lamp');
    const lampHtml = renderToStaticMarkup(React.createElement(AtmosphereLayer));
    assert.match(lampHtml, /desk-atelier-atmosphere/);
    assert.match(lampHtml, /data-atmosphere="lamp"/);
    assert.match(lampHtml, /aria-hidden="true"/);

    // Chinese SSR checks.
    setUiLanguage('zh');
    const zhPanel = renderToStaticMarkup(React.createElement(DeskAtelierPanel));
    assert.match(zhPanel, /书房声景与光影/);
    assert.match(zhPanel, /雨夜书桌/);
    assert.match(zhPanel, /古籍阅览室/);
    assert.match(zhPanel, /清晨竹窗/);
    assert.match(zhPanel, /壁炉冬夜/);
    assert.match(zhPanel, /窗外细雨/);
    assert.match(zhPanel, /风动竹铃/);
    assert.match(zhPanel, /案头光影/);
    assert.match(zhPanel, /随昼夜流转/);

    const zhBtn = renderToStaticMarkup(React.createElement(DeskAtelierButton));
    assert.match(zhBtn, /desk-atelier__toggle/);

    const zhDial = renderToStaticMarkup(React.createElement(FocusRitualDial, {
      remainingLabel: '18:00',
      progress: 0.28,
      mode: 'work',
      state: 'running',
      size: 'stage',
    }));
    assert.match(zhDial, /desk-dial--stage/);
    assert.match(zhDial, /stroke-dashoffset=/);
    assert.match(zhDial, /18:00/);

    const zhBreath = renderToStaticMarkup(React.createElement(BreathingHalo, { defaultRunning: false }));
    assert.match(zhBreath, /4-4-6 呼吸引导/);
    assert.match(zhBreath, /吸气/);
    assert.match(zhBreath, /屏息/);
    assert.match(zhBreath, /缓呼/);

    const zhTimer = renderToStaticMarkup(React.createElement(TodayTimer, {
      board: baseBoard,
      today,
      nowMs,
      fullscreen: true,
    }));
    assert.match(zhTimer, /desk-dial--compact/);
    assert.match(zhTimer, /desk-dial--stage/);
    assert.match(zhTimer, /60 秒呼吸引导/);
    assert.match(zhTimer, /desk-focus-sound/);

    // English SSR checks: zero leaked Han characters across all new components.
    setUiLanguage('en');
    const enSurfaces = [
      renderToStaticMarkup(React.createElement(DeskAtelierButton)),
      renderToStaticMarkup(React.createElement(DeskAtelierPanel)),
      renderToStaticMarkup(React.createElement(FocusRitualDial, {
        remainingLabel: '18:00',
        progress: 0.4,
        mode: 'work',
        state: 'running',
      })),
      renderToStaticMarkup(React.createElement(BreathingHalo, { defaultRunning: false })),
      renderToStaticMarkup(React.createElement(FocusSoundscapePill)),
      renderToStaticMarkup(React.createElement(TodayTimer, {
        board: {
          ...baseBoard,
          cards: { c1: { id: 'c1', title: 'Review semaphores', note: 'Compare Mesa vs Hoare' } },
          timer: { ...baseBoard.timer, cardTitle: 'Break' },
        },
        today,
        nowMs,
        fullscreen: true,
      })),
    ];
    for (const html of enSurfaces) {
      assert.doesNotMatch(html, HAN, `English render leaked Han characters: ${html.slice(0, 200)}`);
    }
    assert.match(enSurfaces[1], /Rainy Night Desk/);
    assert.match(enSurfaces[1], /Library Rain/);
    assert.match(enSurfaces[1], /Day &amp; Night Cycle/);
    assert.match(enSurfaces[3], /Inhale/);
    assert.match(enSurfaces[4], /Turn on desk soundscape/);
  } finally {
    setUiLanguage('zh');
    env.restore();
  }
});

test('desk-atelier stylesheets respect StudyHub layer, contrast, opacity ceiling, motion and zero-:has() guardrails', async () => {
  const triggerCss = await readFile(new URL('../ui/desk-atelier/desk-atelier-trigger.css', import.meta.url), 'utf8');
  const panelCss = await readFile(new URL('../ui/desk-atelier/desk-atelier.css', import.meta.url), 'utf8');
  for (const css of [triggerCss, panelCss]) {
    assert.match(css, /@layer study\.features/);
    assert.doesNotMatch(css, /:has\(/, 'must never use :has() selectors');
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /\[data-motion="reduced"\]/);
    assert.match(css, /\[data-motion="off"\]/);
  }
  assert.match(triggerCss, /@keyframes sh-desk-atelier-/);
  assert.match(triggerCss, /\[data-contrast="high"\][\s\S]*?\.desk-atelier-atmosphere[\s\S]*?display:\s*none/);
  assert.match(triggerCss, /@media \(forced-colors: active\)[\s\S]*?\.desk-atelier-atmosphere[\s\S]*?display:\s*none/);
  const opacityMatch = triggerCss.match(/\.desk-atelier-atmosphere\s*\{[^}]*opacity:\s*([0-9.]+)/);
  assert.ok(opacityMatch, 'atmosphere layer declares explicit opacity');
  assert.ok(Number(opacityMatch[1]) <= 0.06, `atmosphere opacity (${opacityMatch[1]}) must stay <= 0.06`);

  // Wave 3 popover compact fit: zero out base.css label margin and slider border so 1280x800 never overflows.
  assert.match(panelCss, /\.desk-atelier__master-label\s*\{[^}]*margin:\s*0;/);
  assert.match(panelCss, /\.desk-atelier__channel-name\s*\{[^}]*margin:\s*0;/);
  assert.match(panelCss, /\.desk-atelier__slider\s*\{[^}]*border:\s*0;/);
});

/** Minimal stateful shallow React hook runner for testing a single component's hooks, effects, and subscriptions in Node. */
async function loadStatefulComponent(entryCode) {
  const hookState = { slots: [], cursor: 0, effects: [], pendingEffects: [], listeners: new Set(), onRender: null };
  const depsSame = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const scheduleRender = () => { hookState.onRender?.(); };

  const contexts = new Map();
  let idSeq = 0;
  const miniReact = {
    Fragment: Symbol.for('react.fragment'),
    Suspense: Symbol.for('react.suspense'),
    Component: class Component { constructor(props) { this.props = props; this.state = {}; } },
    createContext(defaultValue) {
      const ctx = { _default: defaultValue };
      ctx.Provider = ({ value, children }) => ({ $$provider: ctx, value, children });
      return ctx;
    },
    useContext(ctx) {
      const stack = contexts.get(ctx);
      return stack && stack.length ? stack[stack.length - 1] : ctx._default;
    },
    useId() {
      const idx = hookState.cursor++;
      if (!(idx in hookState.slots)) hookState.slots[idx] = `:r${++idSeq}:`;
      return hookState.slots[idx];
    },
    useInsertionEffect() {},
    lazy(load) { return { $$lazy: true, load }; },
    createElement(type, props, ...children) {
      const p = props ? { ...props } : {};
      if (children.length === 1) p.children = children[0];
      else if (children.length > 1) p.children = children;
      return { type, props: p };
    },
    memo(fn) { return { $$memo: true, type: fn }; },
    forwardRef(fn) { return { $$forwardRef: true, render: fn }; },
    useState(init) {
      const idx = hookState.cursor++;
      if (!(idx in hookState.slots)) {
        hookState.slots[idx] = typeof init === 'function' ? init() : init;
      }
      const setState = (next) => {
        const prev = hookState.slots[idx];
        const value = typeof next === 'function' ? next(prev) : next;
        if (!Object.is(prev, value)) {
          hookState.slots[idx] = value;
          scheduleRender();
        }
      };
      return [hookState.slots[idx], setState];
    },
    useRef(init) {
      const idx = hookState.cursor++;
      if (!(idx in hookState.slots)) hookState.slots[idx] = { current: init };
      return hookState.slots[idx];
    },
    useCallback(fn, deps) {
      const idx = hookState.cursor++;
      const prev = hookState.slots[idx];
      if (!prev || !depsSame(prev.deps, deps)) hookState.slots[idx] = { fn, deps };
      return hookState.slots[idx].fn;
    },
    useMemo(fn, deps) {
      const idx = hookState.cursor++;
      const prev = hookState.slots[idx];
      if (!prev || !depsSame(prev.deps, deps)) hookState.slots[idx] = { value: fn(), deps };
      return hookState.slots[idx].value;
    },
    useEffect(fn, deps) {
      const idx = hookState.cursor++;
      const prev = hookState.effects[idx];
      if (!prev || !deps || !depsSame(prev.deps, deps)) {
        hookState.pendingEffects.push({ idx, fn, deps });
      }
    },
    useLayoutEffect(fn, deps) { miniReact.useEffect(fn, deps); },
    useSyncExternalStore(subscribe, getSnapshot) {
      const idx = hookState.cursor++;
      if (!(idx in hookState.slots)) {
        const entry = {
          value: getSnapshot(),
          unsub: subscribe(() => {
            const next = getSnapshot();
            if (!Object.is(entry.value, next)) {
              entry.value = next;
              scheduleRender();
            }
          }),
        };
        hookState.slots[idx] = entry;
      } else {
        hookState.slots[idx].value = getSnapshot();
      }
      return hookState.slots[idx].value;
    },
  };
  miniReact.default = miniReact;

  const built = await build({
    stdin: { contents: entryCode, resolveDir: REPO_ROOT },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['react', 'react-dom', '@codemirror/*', '@lezer/*', '@base-ui/*', 'markdown-it', 'markdown-it-texmath', 'dompurify', 'katex', 'katex/*'],
    loader: { '.css': 'text' },
    logLevel: 'silent',
  });
  const modObj = { exports: {} };
  const customRequire = (id) => (id === 'react' ? miniReact : require(id));
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(customRequire, modObj, modObj.exports);

  const flushEffects = () => {
    const queue = hookState.pendingEffects.splice(0);
    for (const item of queue) {
      hookState.effects[item.idx]?.cleanup?.();
      const cleanup = item.fn();
      hookState.effects[item.idx] = { deps: item.deps, cleanup: typeof cleanup === 'function' ? cleanup : null };
    }
  };

  function mount(Component, props = {}) {
    const fn = Component?.$$memo ? Component.type : Component;
    let tree = null;
    const render = () => {
      hookState.cursor = 0;
      tree = fn(props);
      flushEffects();
      return tree;
    };
    hookState.onRender = render;
    render();
    return {
      get tree() { return tree; },
      rerender: render,
      unmount() {
        hookState.onRender = null;
        for (const eff of hookState.effects) eff?.cleanup?.();
        for (const slot of hookState.slots) slot?.unsub?.();
      },
    };
  }

  return { exports: modObj.exports, mount };
}

function findElement(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findElement(item, predicate);
      if (hit) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  return node.props?.children ? findElement(node.props.children, predicate) : null;
}

test('Wave 3: DeskAtelierButton subscribes to language changes, toggles via guarded Alt+Shift+A, and hoists lazy DeskChimeDialog', async () => {
  const keyListeners = new Set();
  let dialogOpen = false;
  const origWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const origDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: (type, fn) => { if (type === 'keydown') keyListeners.add(fn); },
      removeEventListener: (type, fn) => { if (type === 'keydown') keyListeners.delete(fn); },
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector: (sel) => (sel === 'dialog[open]' && dialogOpen ? { open: true } : null),
    },
  });

  const { exports: loaded, mount } = await loadStatefulComponent(`
    export { setUiLanguage } from './ui/i18n.js';
    export { default as DeskAtelierButton } from './ui/desk-atelier/DeskAtelierButton.jsx';
    export { Popover } from './ui/components/index.js';
    export { default as DeskAtelierPanel } from './ui/desk-atelier/DeskAtelierPanel.jsx';
    export { default as DeskChimeDialog } from './ui/desk-atelier/DeskChimeDialog.jsx';
  `);
  loaded.setUiLanguage('zh');
  const mounted = mount(loaded.DeskAtelierButton);
  try {
    const getPopover = () => findElement(mounted.tree, (el) => el.type === loaded.Popover);
    const getTriggerLabel = () => {
      const pop = getPopover();
      const triggerEl = pop.props.trigger({ props: {}, ref: null, open: pop.props.open });
      return triggerEl.props.label;
    };

    // 1. Live language reactivity via useUiLanguage(): switching zh -> en updates label without remounting.
    assert.equal(getTriggerLabel(), '书房声景与光影');
    loaded.setUiLanguage('en');
    assert.doesNotMatch(getTriggerLabel(), HAN, 'DeskAtelierButton re-rendered in English via useUiLanguage()');
    assert.match(getTriggerLabel(), /Soundscape|Atelier/i);

    // 2. Guarded Alt+Shift+A toggles the popover open, ignoring editable inputs & open dialogs.
    assert.equal(keyListeners.size, 1, 'registers global keydown listener');
    const dispatchKey = (evt) => {
      let prevented = false;
      const event = { repeat: false, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, target: { tagName: 'DIV' }, preventDefault: () => { prevented = true; }, ...evt };
      for (const fn of [...keyListeners]) fn(event);
      return prevented;
    };

    assert.equal(getPopover().props.open, false);
    assert.equal(dispatchKey({ altKey: true, shiftKey: true, code: 'KeyA', target: { tagName: 'INPUT' } }), false, 'ignores Alt+Shift+A inside input');
    assert.equal(getPopover().props.open, false);

    dialogOpen = true;
    assert.equal(dispatchKey({ altKey: true, shiftKey: true, code: 'KeyA' }), false, 'ignores Alt+Shift+A while a dialog is open');
    assert.equal(getPopover().props.open, false);
    dialogOpen = false;

    assert.equal(dispatchKey({ altKey: true, shiftKey: true, code: 'KeyA' }), true, 'handles Alt+Shift+A');
    assert.equal(getPopover().props.open, true, 'Alt+Shift+A opens Desk Atelier popover');

    // 3. Lazy DeskAtelierPanel loads and its onToggleChime closes the popover & hoists lazy DeskChimeDialog.
    await new Promise((r) => setTimeout(r, 20));
    const panelEl = findElement(getPopover().props.children, (el) => el.type === loaded.DeskAtelierPanel);
    assert.ok(panelEl, 'lazily imported DeskAtelierPanel renders inside open Popover');
    assert.equal(typeof panelEl.props.onToggleChime, 'function', 'passes onToggleChime callback to DeskAtelierPanel');

    panelEl.props.onToggleChime();
    assert.equal(getPopover().props.open, false, 'onToggleChime closes popover before hoisting DeskChimeDialog');
    await new Promise((r) => setTimeout(r, 20));
    const chimeEl = findElement(mounted.tree, (el) => el.type === loaded.DeskChimeDialog);
    assert.ok(chimeEl, 'lazily imported DeskChimeDialog mounts hoisted outside Popover');
    assert.equal(typeof chimeEl.props.onClose, 'function');
    chimeEl.props.onClose();
    assert.equal(findElement(mounted.tree, (el) => el.type === loaded.DeskChimeDialog), null, 'onClose unmounts DeskChimeDialog');
  } finally {
    mounted.unmount();
    loaded.setUiLanguage('zh');
    if (origWindow) Object.defineProperty(globalThis, 'window', origWindow);
    else delete globalThis.window;
    if (origDocument) Object.defineProperty(globalThis, 'document', origDocument);
    else delete globalThis.document;
  }
});

test('Wave 3: board.timer.start supports cardless Free Focus and TodayTimer idle renders zh/en Free Focus entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-free-focus-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  const today = '2026-11-21';
  try {
    let board = await boardAction('board.get', {});
    await assert.rejects(
      () => boardAction('board.timer.start', { revision: board.revision, mode: 'work', now: '2026-11-21T09:00:00.000Z' }),
      /cardTitle/,
      'work mode without id or cardTitle is rejected',
    );
    await assert.rejects(
      () => boardAction('board.timer.start', { revision: board.revision, mode: 'work', cardTitle: '???', now: '2026-11-21T09:00:00.000Z' }),
      /letter or digit/,
      'non-meaningful cardTitle is rejected',
    );

    // Cardless Free Focus starts, survives reload validation, and logs cleanly on completion.
    board = await boardAction('board.timer.start', {
      revision: board.revision,
      mode: 'work',
      cardTitle: '自由专注',
      now: '2026-11-21T09:00:00.000Z',
    });
    assert.equal(board.timer.mode, 'work');
    assert.equal(board.timer.cardId, undefined);
    assert.equal(board.timer.cardTitle, '自由专注');

    const reloaded = await boardAction('board.get', {});
    assert.equal(reloaded.timer.cardTitle, '自由专注');
    assert.equal(reloaded.timer.cardId, undefined);

    const completed = await boardAction('board.timer.complete', {
      revision: reloaded.revision,
      date: today,
      now: '2026-11-21T09:15:00.000Z',
    });
    assert.equal(completed.timer, undefined);
    assert.equal(completed.timeLog.length, 1);
    assert.equal(completed.timeLog[0].cardId, undefined);
    assert.equal(completed.timeLog[0].cardTitle, '自由专注');
    assert.equal(completed.timeLog[0].minutes, 15);

    // TodayTimer idle UI renders Free Focus + Fullscreen Focus in zh & en (and hides when readOnly).
    const idleBoard = { version: 1, revision: 1, columns: [{ id: 'todo', title: 'Todo', cardIds: [] }], cards: {}, timeLog: [] };
    setUiLanguage('zh');
    const zhIdle = renderToStaticMarkup(React.createElement(TodayTimer, {
      board: idleBoard,
      today,
      onStartFreeFocus: () => true,
    }));
    assert.match(zhIdle, /点卡片上的「开始专注」才开始计时/);
    assert.match(zhIdle, /sh-btn--primary[^>]*>[\s\S]*?自由专注/);
    assert.match(zhIdle, /sh-btn--secondary[^>]*>[\s\S]*?全屏专注/);
    assert.ok(
      zhIdle.indexOf('desk-free-focus') < zhIdle.indexOf('board-timer__hint'),
      'Free Focus primary actions sit directly beneath the dial, above the secondary hint',
    );

    const roIdle = renderToStaticMarkup(React.createElement(TodayTimer, {
      board: idleBoard,
      today,
      readOnly: true,
      onStartFreeFocus: () => true,
    }));
    assert.doesNotMatch(roIdle, /desk-free-focus/);

    setUiLanguage('en');
    const enIdle = renderToStaticMarkup(React.createElement(TodayTimer, {
      board: idleBoard,
      today,
      onStartFreeFocus: () => true,
    }));
    assert.doesNotMatch(enIdle, HAN, `English idle timer leaked Han: ${enIdle.slice(0, 200)}`);
    assert.match(enIdle, /Free focus/);
    assert.match(enIdle, /Fullscreen focus/);
  } finally {
    setUiLanguage('zh');
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test('CC0 baked soundscape assets, LAME 50ms trim + 1.6s seamless fold, and decodeAudioData/fallback lifecycle work cleanly', async () => {
  // 1. All 5 channels ship valid CC0 base64 MP3 data URIs with calibration gains, loaded lazily via dynamic import().
  assert.ok(Object.isFrozen(SOUNDSCAPE_DATA_URIS));
  assert.ok(Object.isFrozen(SOUNDSCAPE_CHANNEL_GAINS));
  for (const id of ATELIER_CHANNEL_IDS) {
    const uri = SOUNDSCAPE_DATA_URIS[id];
    assert.equal(typeof uri, 'string', `${id} has a data URI`);
    assert.match(uri, /^data:audio\/mpeg;base64,[A-Za-z0-9+/=]+$/, `${id} is a valid base64 MP3 data URI`);
    const bytes = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64');
    assert.ok(bytes.length > 50_000, `${id} baked MP3 (${bytes.length} B) holds full multi-second stereo audio`);
    // MP3 frame sync (0xFF 0xE0..0xFF) or ID3 header.
    assert.equal(bytes[0], 0xff, `${id} starts directly on an MP3 frame sync (ID3/Xing stripped)`);
    assert.ok(SOUNDSCAPE_CHANNEL_GAINS[id] > 0.5 && SOUNDSCAPE_CHANNEL_GAINS[id] <= 1.2, `${id} gain bounded`);
  }

  // Verify via esbuild's module graph that soundscape-assets.js is strictly a dynamic import (never statically bundled).
  const assetImports = [];
  await build({
    entryPoints: [join(REPO_ROOT, 'ui/desk-atelier/soundscape-engine.js')],
    bundle: true,
    write: false,
    format: 'esm',
    splitting: false,
    logLevel: 'silent',
    plugins: [{
      name: 'track-soundscape-assets',
      setup(b) {
        b.onResolve({ filter: /soundscape-assets\.js$/ }, (args) => {
          assetImports.push(args.kind);
          return { path: args.path, external: true };
        });
      },
    }],
  });
  assert.deepEqual(assetImports, ['dynamic-import'], 'soundscape-assets.js must only be loaded lazily via dynamic import()');

  // 2. buildSeamlessSampleBuffer strips 50ms LAME head/tail padding & folds 1.6s tail cleanly onto head.
  const rate = 22050;
  const totalSec = 10;
  const totalLen = rate * totalSec;
  const trimLen = Math.round(rate * 0.05);
  const rawL = new Float32Array(totalLen);
  const rawR = new Float32Array(totalLen);
  for (let i = 0; i < totalLen; i += 1) {
    // Artificial LAME padding silence + spike inside first/last 50ms; steady warm tone inside middle.
    if (i < trimLen || i >= totalLen - trimLen) {
      rawL[i] = i === 0 || i === totalLen - 1 ? 0.99 : 0;
      rawR[i] = rawL[i];
    } else {
      rawL[i] = 0.28 * Math.sin((2 * Math.PI * 220 * i) / rate);
      rawR[i] = 0.26 * Math.cos((2 * Math.PI * 220 * i) / rate);
    }
  }
  const fakeDecoded = {
    sampleRate: rate,
    numberOfChannels: 2,
    length: totalLen,
    getChannelData: (ch) => (ch === 0 ? rawL : rawR),
  };
  const fakeCtx = {
    sampleRate: rate,
    createBuffer(chs, len, sr) {
      const data = Array.from({ length: chs }, () => new Float32Array(len));
      return {
        numberOfChannels: chs,
        length: len,
        sampleRate: sr,
        copyToChannel: (src, ch) => data[ch].set(src),
        getChannelData: (ch) => data[ch],
      };
    },
  };
  const seamless = buildSeamlessSampleBuffer(fakeCtx, fakeDecoded);
  assert.ok(seamless, 'seamless buffer built');
  const expectedLen = totalLen - trimLen * 2 - Math.round(rate * 1.6);
  assert.equal(seamless.length, expectedLen, 'trims 50ms head + 50ms tail and folds 1.6s tail');
  const outL = seamless.getChannelData(0);
  const outR = seamless.getChannelData(1);
  let peak = 0;
  for (let i = 0; i < outL.length; i += 1) {
    assert.ok(Number.isFinite(outL[i]) && Number.isFinite(outR[i]));
    peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
  }
  assert.ok(peak > 0.2 && peak <= 0.94, `seamless peak (${peak.toFixed(3)}) bounded and audible`);
  assert.ok(Math.abs(outL[0] - outL[outL.length - 1]) < 0.08, 'L loop seam is smooth');
  assert.ok(Math.abs(outR[0] - outR[outR.length - 1]) < 0.08, 'R loop seam is smooth');

  // 3. Successful decodeAudioData loads & loops decoded CC0 buffers without using setInterval; failure falls back cleanly to DSP.
  const env = createFakeAudioEnv();
  const origSetInterval = globalThis.setInterval;
  let setIntervalCalls = 0;
  globalThis.setInterval = (...args) => {
    setIntervalCalls += 1;
    return origSetInterval(...args);
  };
  try {
    resetSoundscapeEngineForTests();
    const OrigAudio = globalThis.AudioContext;
    let decodeSuccesses = 0;
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: class DecodingAudioContext extends OrigAudio {
        decodeAudioData(ab) {
          assert.ok(ab instanceof ArrayBuffer && ab.byteLength > 50_000, 'passed real MP3 ArrayBuffer');
          decodeSuccesses += 1;
          return Promise.resolve(fakeDecoded);
        }
      },
    });
    startSoundscape();
    selectSoundscapePreset('morning-bamboo');
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(decodeSuccesses >= 3, 'decoded active CC0 channels in parallel');
    assert.ok(env.contexts[0].sources.length >= 3, 'mounted looping CC0 sample sources');
    assert.ok(env.contexts[0].sources.every((s) => s.loop === true && s.buffer.length === expectedLen));
    stopSoundscape({ immediate: true });
    assert.equal(setIntervalCalls, 0, 'soundscape-engine must never schedule setInterval timers');

    resetSoundscapeEngineForTests();
    let decodeAttempts = 0;
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: class FailingDecodeAudioContext extends OrigAudio {
        decodeAudioData() {
          decodeAttempts += 1;
          return Promise.reject(new Error('Simulated codec failure'));
        }
      },
    });
    startSoundscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(decodeAttempts >= 1, 'attempted lazy CC0 decodeAudioData');
    assert.ok(env.contexts[1].sources.length >= 3, 'fell back cleanly to looping procedural DSP buffers');
    stopSoundscape({ immediate: true });
    assert.equal(setIntervalCalls, 0, 'fallback DSP lifecycle must never schedule setInterval timers');
  } finally {
    globalThis.setInterval = origSetInterval;
    resetSoundscapeEngineForTests();
    env.restore();
  }
});
