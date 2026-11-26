import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';

const mod = await loadUi(`
  export { setUiLanguage } from './ui/i18n.js';
  export { holdAudioCapture, isAudioCaptureActive } from './ui/audio-capture-state.js';
  export {
    CHIME_ARPEGGIO_IDS,
    CHIME_BARS,
    CHIME_KEY_MAP,
    BREEZE_MIN_MS,
    BREEZE_MAX_MS,
    synthesizeChimeBar,
    nextBreezeDelayMs,
    pickNextBreezeBar,
    strikeChimeBar,
    stopAllChimes,
    resetChimeSynthForTests,
  } from './ui/desk-atelier/chime-synth.js';
  export { default as DeskChimeDialog } from './ui/desk-atelier/DeskChimeDialog.jsx';
  export { default as DeskAtelierPanel } from './ui/desk-atelier/DeskAtelierPanel.jsx';
  export {
    default as FocusAmbientCanvas,
    FocusAmbientControls,
    FOCUS_AMBIENT_MODES,
    normalizeAmbientMode,
    loadAmbientMode,
    saveAmbientMode,
    createAmbientParticles,
    stepAmbientParticles,
  } from './ui/desk-atelier/FocusAmbientCanvas.jsx';
  export { default as TodayTimer } from './ui/board/TodayTimer.jsx';
`);

const {
  setUiLanguage,
  holdAudioCapture,
  isAudioCaptureActive,
  CHIME_ARPEGGIO_IDS,
  CHIME_BARS,
  CHIME_KEY_MAP,
  BREEZE_MIN_MS,
  BREEZE_MAX_MS,
  synthesizeChimeBar,
  nextBreezeDelayMs,
  pickNextBreezeBar,
  strikeChimeBar,
  stopAllChimes,
  resetChimeSynthForTests,
  DeskChimeDialog,
  DeskAtelierPanel,
  FocusAmbientCanvas,
  FocusAmbientControls,
  FOCUS_AMBIENT_MODES,
  normalizeAmbientMode,
  loadAmbientMode,
  saveAmbientMode,
  createAmbientParticles,
  stepAmbientParticles,
  TodayTimer,
} = mod;

const HAN = /[\u3400-\u9fff]/;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

function createFakeAudioEnv() {
  const contexts = [];
  const origAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const origDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 44100;
      this.state = 'suspended';
      this.currentTime = 0.5;
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
        started: 0,
        stopped: 0,
        disconnected: 0,
        connectedTo: null,
        onended: null,
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
        gain: { value: 0, setValueAtTime: (v) => { gain.lastValue = v; gain.gain.value = v; } },
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

  const document = { hidden: false };
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, writable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document });

  return {
    contexts,
    document,
    restore() {
      resetChimeSynthForTests();
      if (origAudioContext) Object.defineProperty(globalThis, 'AudioContext', origAudioContext);
      else delete globalThis.AudioContext;
      if (origDocument) Object.defineProperty(globalThis, 'document', origDocument);
      else delete globalThis.document;
    },
  };
}

test('9-bar D-major pentatonic chime synth produces click-free, bounded, stereo-panned PCM offline', () => {
  assert.equal(CHIME_BARS.length, 9);
  assert.deepEqual(
    CHIME_BARS.map((b) => [b.note, b.key, b.freqHz]),
    [
      ['D4', 'A', 293.66],
      ['E4', 'S', 329.63],
      ['F#4', 'D', 369.99],
      ['A4', 'F', 440.0],
      ['B4', 'G', 493.88],
      ['D5', 'H', 587.33],
      ['E5', 'J', 659.25],
      ['F#5', 'K', 739.99],
      ['A5', 'L', 880.0],
    ],
  );
  assert.equal(CHIME_KEY_MAP.A, 'D4');
  assert.equal(CHIME_KEY_MAP.L, 'A5');

  const bass = synthesizeChimeBar('D4', 22050);
  const treble = synthesizeChimeBar('A5', 22050);
  assert.ok(bass.durationSec > treble.durationSec, 'lower bars sustain longer than higher bars');

  for (const bar of CHIME_BARS) {
    const out = synthesizeChimeBar(bar.id, 22050);
    assert.ok(out && out.left instanceof Float32Array && out.right instanceof Float32Array);
    assert.equal(out.left[0], 0, `${bar.id} L starts cleanly at 0`);
    assert.equal(out.left[out.left.length - 1], 0, `${bar.id} L ends cleanly at 0`);
    assert.equal(out.right[0], 0, `${bar.id} R starts cleanly at 0`);
    assert.equal(out.right[out.right.length - 1], 0, `${bar.id} R ends cleanly at 0`);
    let peak = 0;
    let energyL = 0;
    let energyR = 0;
    for (let i = 0; i < out.left.length; i += 1) {
      assert.ok(Number.isFinite(out.left[i]) && Number.isFinite(out.right[i]));
      peak = Math.max(peak, Math.abs(out.left[i]), Math.abs(out.right[i]));
      energyL += out.left[i] * out.left[i];
      energyR += out.right[i] * out.right[i];
    }
    assert.ok(peak > 0.1 && peak <= 0.45, `${bar.id} peak (${peak.toFixed(3)}) bounded`);
    if (bar.pan < -0.2) assert.ok(energyL > energyR, `${bar.id} pans left`);
    if (bar.pan > 0.2) assert.ok(energyR > energyL, `${bar.id} pans right`);
  }
  assert.equal(synthesizeChimeBar('C9'), null);
});

test('Gentle Breeze Poisson delay stays in [2.5s, 6.0s] and never immediately repeats the same bar', () => {
  for (const u of [0.0001, 0.15, 0.5, 0.85, 0.9999]) {
    const delay = nextBreezeDelayMs(() => u);
    assert.ok(delay >= BREEZE_MIN_MS && delay <= BREEZE_MAX_MS, `delay ${delay}ms in [2500, 6000]`);
  }
  for (let idx = 0; idx < CHIME_BARS.length; idx += 1) {
    for (const u of [0, 0.25, 0.5, 0.75, 0.99]) {
      const picked = pickNextBreezeBar(idx, () => u);
      assert.notEqual(picked.id, CHIME_BARS[idx].id, `never repeats ${CHIME_BARS[idx].id}`);
    }
  }
});

test('DeskChime audio stays silent by default, auto-mutes on capture/hidden tab, and cleans up voices cleanly', () => {
  const env = createFakeAudioEnv();
  try {
    resetChimeSynthForTests();
    assert.equal(env.contexts.length, 0, 'zero AudioContext on boot');

    // Rendering the dialog constructs zero AudioContext.
    renderToStaticMarkup(React.createElement(DeskChimeDialog, { onClose: () => {} }));
    assert.equal(env.contexts.length, 0, 'zero AudioContext on DeskChimeDialog mount');

    // Capture active -> muted, zero AudioContext constructed.
    const release = holdAudioCapture();
    assert.equal(isAudioCaptureActive(), true);
    assert.equal(strikeChimeBar('D4'), false);
    assert.equal(env.contexts.length, 0);
    release();

    // Hidden tab -> muted, zero AudioContext constructed.
    env.document.hidden = true;
    assert.equal(strikeChimeBar('A4'), false);
    assert.equal(env.contexts.length, 0);
    env.document.hidden = false;

    // Explicit strike -> creates AudioContext, routes through airBus, disconnects cleanly on ended.
    assert.equal(strikeChimeBar('D4', { velocity: 0.9 }), true);
    assert.equal(env.contexts.length, 1);
    const ctx = env.contexts[0];
    assert.equal(ctx.state, 'running');
    assert.equal(ctx.sources.length, 1);
    assert.equal(ctx.filters.length, 1);
    assert.equal(ctx.sources[0].connectedTo, ctx.gains[0]);
    assert.equal(ctx.gains[0].connectedTo, ctx.filters[0]);
    assert.equal(ctx.filters[0].connectedTo, ctx.destination);

    // Per-bar cooldown suppresses instant double-trigger.
    assert.equal(strikeChimeBar('D4'), false);
    assert.equal(strikeChimeBar('A4'), true);
    assert.equal(ctx.sources.length, 2);

    // Source ended cleans up node graph; stopAllChimes silences remaining voices & suspends.
    ctx.sources[0].onended();
    assert.equal(ctx.sources[0].disconnected, 1);
    assert.equal(ctx.gains[0].disconnected, 1);
    assert.equal(ctx.filters[0].disconnected, 1);

    stopAllChimes();
    assert.equal(ctx.sources[1].stopped, 1);
    assert.equal(ctx.sources[1].disconnected, 1);
    assert.equal(ctx.state, 'suspended');
  } finally {
    env.restore();
  }
});

test('FocusAmbientCanvas defaults to off, persists via study-focus-ambient, and evolves particles smoothly', () => {
  assert.deepEqual(FOCUS_AMBIENT_MODES.map((m) => m.id), ['off', 'rain-ripples', 'ink-ripples', 'lamp-dust']);
  assert.equal(normalizeAmbientMode('bogus'), 'off');
  assert.equal(normalizeAmbientMode('ink-ripples'), 'ink-ripples');

  const storage = memoryStorage();
  assert.equal(loadAmbientMode(storage), 'off');
  saveAmbientMode('rain-ripples', storage);
  assert.equal(storage.getItem('study-focus-ambient'), 'rain-ripples', 'persists ambient mode under study-focus-ambient');
  assert.equal(loadAmbientMode(storage), 'rain-ripples');
  saveAmbientMode('invalid', storage);
  assert.equal(storage.getItem('study-focus-ambient'), 'off', 'normalizes invalid mode to off under study-focus-ambient');
  assert.equal(loadAmbientMode(storage), 'off');

  // Default 'off' renders zero canvas markup.
  assert.equal(renderToStaticMarkup(React.createElement(FocusAmbientCanvas, { mode: 'off' })), '');
  const activeCanvas = renderToStaticMarkup(React.createElement(FocusAmbientCanvas, { mode: 'ink-ripples' }));
  assert.match(activeCanvas, /<canvas[^>]*desk-ambient-canvas/);
  assert.match(activeCanvas, /data-ambient-mode="ink-ripples"/);
  assert.match(activeCanvas, /aria-hidden="true"/);

  for (const mode of ['rain-ripples', 'ink-ripples', 'lamp-dust']) {
    const particles = createAmbientParticles(mode, 640, 480, () => 0.42);
    assert.ok(particles.length > 0, `${mode} initializes particles`);
    const before = particles.map((p) => ({ x: p.x, y: p.y, radius: p.radius }));
    stepAmbientParticles(particles, mode, 0.05, 640, 480, () => 0.42);
    const moved = particles.some((p, i) => p.x !== before[i].x || p.y !== before[i].y || p.radius !== before[i].radius);
    assert.equal(moved, true, `${mode} particles advance smoothly`);
  }
});

test('DeskChimeDialog, FocusAmbientControls, DeskAtelierPanel and TodayTimer render cleanly in zh and en', () => {
  const today = '2026-11-21';
  const breakBoard = {
    version: 1,
    revision: 2,
    columns: [{ id: 'todo', title: 'Todo', cardIds: ['c1'] }],
    cards: { c1: { id: 'c1', title: 'Review memory hierarchy', note: 'Compare cache associativity' } },
    timer: {
      id: 't-break',
      mode: 'break',
      cardTitle: 'Break',
      durationMinutes: 5,
      startedAt: '2026-11-21T09:00:00.000Z',
      pausedMs: 0,
    },
    timeLog: [],
  };
  const nowMs = Date.parse('2026-11-21T09:01:00.000Z');

  try {
    setUiLanguage('zh');
    const zhChime = renderToStaticMarkup(React.createElement(DeskChimeDialog, { onClose: () => {} }));
    assert.match(zhChime, /五声风铃/);
    assert.match(zhChime, /微风自鸣/);
    assert.match(zhChime, /清风一曲/);
    assert.match(zhChime, /desk-chime__cap/);
    assert.match(zhChime, /desk-chime__pin/);
    assert.match(zhChime, /--chime-warmth/);
    assert.match(zhChime, /D4/);
    assert.match(zhChime, /A5/);
    assert.match(zhChime, /desk-chime__bar/);
    assert.deepEqual(CHIME_ARPEGGIO_IDS, ['D4', 'Fs4', 'A4', 'B4', 'D5']);

    const zhPanel = renderToStaticMarkup(React.createElement(DeskAtelierPanel));
    assert.match(zhPanel, /五声风铃/);

    const zhAmbient = renderToStaticMarkup(React.createElement(FocusAmbientControls, { mode: 'off', onChange: () => {} }));
    assert.match(zhAmbient, /静谧/);
    assert.match(zhAmbient, /细雨涟漪/);
    assert.match(zhAmbient, /墨滴流纹/);
    assert.match(zhAmbient, /暖灯微尘/);

    const zhTimer = renderToStaticMarkup(React.createElement(TodayTimer, {
      board: breakBoard,
      today,
      nowMs,
      fullscreen: true,
    }));
    assert.match(zhTimer, /五声风铃/);
    assert.match(zhTimer, /desk-ambient-bar/);

    setUiLanguage('en');
    const enSurfaces = [
      renderToStaticMarkup(React.createElement(DeskChimeDialog, { onClose: () => {} })),
      renderToStaticMarkup(React.createElement(DeskAtelierPanel)),
      renderToStaticMarkup(React.createElement(FocusAmbientControls, { mode: 'lamp-dust', onChange: () => {} })),
      renderToStaticMarkup(React.createElement(TodayTimer, {
        board: breakBoard,
        today,
        nowMs,
        fullscreen: true,
      })),
    ];
    for (const html of enSurfaces) {
      assert.doesNotMatch(html, HAN, `English render leaked Han characters: ${html.slice(0, 220)}`);
    }
    assert.match(enSurfaces[0], /Pentatonic Chimes/);
    assert.match(enSurfaces[0], /Gentle Breeze/);
    assert.match(enSurfaces[0], /Gentle arpeggio/);
    assert.match(enSurfaces[2], /Rain Ripples/);
    assert.match(enSurfaces[2], /Ink Ripples/);
    assert.match(enSurfaces[2], /Lamp Dust/);
  } finally {
    setUiLanguage('zh');
  }
});

test('DeskChimeDialog arpeggio button schedules the 5 pentatonic bars at 0, 160, 320, 480, 640 ms and clears timers on unmount', async () => {
  const ui = await loadInteractiveUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { resetChimeSynthForTests } from './ui/desk-atelier/chime-synth.js';
    export { default as DeskChimeDialog } from './ui/desk-atelier/DeskChimeDialog.jsx';
  `);
  const env = createFakeAudioEnv();
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  const scheduled = [];
  let nextTimerId = 1;
  globalThis.setTimeout = (fn, delay = 0) => {
    const handle = { id: nextTimerId++, fn, delay, cleared: false, unref() {} };
    scheduled.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (handle && typeof handle === 'object') handle.cleared = true;
  };

  try {
    await withBrowserGlobals(async () => {
      ui.exports.setUiLanguage('zh');
      ui.exports.resetChimeSynthForTests();
      const mounted = ui.mount(() => ui.React.createElement(ui.exports.DeskChimeDialog, { onClose: () => {} }));
      try {
        const arpeggioButton = mounted.find(
          (node) => node.type === 'button' && mounted.text(node).includes('清风一曲'),
        );
        assert.ok(arpeggioButton, 'found arpeggio button in mounted DeskChimeDialog');

        const clickEvent = { currentTarget: null, preventDefault() {} };
        await mounted.act(() => { arpeggioButton.props.onClick(clickEvent); });
        const arpeggioTimers = scheduled.slice();
        assert.deepEqual(
          arpeggioTimers.map((t) => t.delay),
          [0, 160, 320, 480, 640],
          'arpeggio schedules 5 stepped notes at 160ms intervals',
        );

        await mounted.act(() => {
          for (const timer of arpeggioTimers) timer.fn();
        });
        assert.equal(env.contexts.length, 1, 'arpeggio creates one AudioContext when notes fire');
        assert.equal(env.contexts[0].sources.length, 5, 'all 5 arpeggio bars strike cleanly');
        assert.match(mounted.text(), /D4 · F#4 · A4 · B4 · D5/, 'note trail records the D-major arpeggio sequence');

        // Clicking arpeggio again and unmounting clears all pending arpeggio timers.
        const beforeSecond = scheduled.length;
        await mounted.act(() => { arpeggioButton.props.onClick(clickEvent); });
        const secondBatch = scheduled.slice(beforeSecond);
        assert.deepEqual(secondBatch.map((t) => t.delay), [0, 160, 320, 480, 640]);

        mounted.unmount();
        assert.ok(secondBatch.every((t) => t.cleared), 'unmounting DeskChimeDialog clears pending arpeggio timers');
      } finally {
        mounted.unmount();
      }
    });
  } finally {
    ui.exports.resetChimeSynthForTests();
    ui.exports.setUiLanguage('zh');
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
    env.restore();
  }
});

test('desk-chime.css and Wave 2 runtime satisfy StudyHub opacity, contrast, motion, timer and storage guardrails', () => {
  // Repo-wide @layer, :has(), and undefined CSS custom-property rules are already enforced by
  // tests/css-layers.test.mjs, tests/page-switch-jank.test.mjs, and tests/ui-guardrails.test.mjs.
  // Here we parse desk-chime.css for feature-specific motion/contrast/opacity contracts.
  const { declarations, blocks } = parseCss(readFileSync(new URL('../ui/desk-atelier/desk-chime.css', import.meta.url), 'utf8'));
  const keyframeNames = blocks
    .map((b) => b.prelude.match(/^@keyframes\s+([\w-]+)/)?.[1])
    .filter(Boolean);
  assert.ok(keyframeNames.includes('sh-desk-chime-sway'), 'sh-desk-chime-sway keyframes declared');
  assert.ok(keyframeNames.includes('sh-desk-chime-ring'), 'sh-desk-chime-ring keyframes declared');
  assert.equal(declarations.some((d) => /var\(--fw-strong\)/.test(d.value)), false, 'desk-chime.css must not use var(--fw-strong)');

  const hasHiddenAmbient = (ctxPattern) => declarations.some(
    (d) => d.prop === 'display' && d.value === 'none'
      && /\.desk-ambient-canvas\b/.test(d.ctx.at(-1))
      && ctxPattern.test(d.ctx.join(' | ')),
  );
  assert.equal(hasHiddenAmbient(/\[data-contrast="high"\]/), true, 'ambient canvas hides in high contrast');
  assert.equal(hasHiddenAmbient(/@media \(forced-colors: active\)/), true, 'ambient canvas hides in forced-colors');
  assert.equal(hasHiddenAmbient(/@media \(prefers-reduced-motion: reduce\)/), true, 'ambient canvas hides under prefers-reduced-motion');
  assert.equal(hasHiddenAmbient(/\[data-motion="reduced"\]/), true, 'ambient canvas hides under data-motion="reduced"');
  assert.equal(hasHiddenAmbient(/\[data-motion="off"\]/), true, 'ambient canvas hides under data-motion="off"');

  const opacityDecl = declarations.find((d) => d.ctx.at(-1) === '.desk-ambient-canvas' && d.prop === 'opacity');
  assert.ok(opacityDecl, 'ambient canvas declares explicit opacity');
  assert.ok(Number(opacityDecl.value) <= 0.18, `ambient canvas opacity (${opacityDecl.value}) must stay <= 0.18`);

  // Runtime behavior: zero setInterval usage during render/strike/stop, synchronous SSR (no React.lazy),
  // and safe storage fallback via ui/storage.js even if host localStorage/sessionStorage throws.
  const origSetInterval = globalThis.setInterval;
  const origLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const origSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const env = createFakeAudioEnv();
  let intervalCalls = 0;
  try {
    globalThis.setInterval = (...args) => { intervalCalls += 1; return origSetInterval(...args); };
    const throwStorage = {
      configurable: true,
      get() { throw new Error('storage blocked'); },
    };
    Object.defineProperty(globalThis, 'localStorage', throwStorage);
    Object.defineProperty(globalThis, 'sessionStorage', throwStorage);

    assert.equal(loadAmbientMode(), 'off', 'loadAmbientMode tolerates blocked browser storage via ui/storage.js');
    assert.equal(saveAmbientMode('rain-ripples'), 'rain-ripples', 'saveAmbientMode tolerates blocked browser storage via ui/storage.js');

    assert.match(renderToStaticMarkup(React.createElement(DeskChimeDialog, { onClose: () => {} })), /desk-chime/, 'DeskChimeDialog renders synchronously without React.lazy');
    assert.match(renderToStaticMarkup(React.createElement(FocusAmbientCanvas, { mode: 'rain-ripples' })), /desk-ambient-canvas/, 'FocusAmbientCanvas renders synchronously without React.lazy');

    assert.equal(strikeChimeBar('D4'), true);
    stopAllChimes();
    assert.equal(intervalCalls, 0, 'chime synth and ambient components never register setInterval');
  } finally {
    globalThis.setInterval = origSetInterval;
    if (origLocalStorage) Object.defineProperty(globalThis, 'localStorage', origLocalStorage);
    else delete globalThis.localStorage;
    if (origSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', origSessionStorage);
    else delete globalThis.sessionStorage;
    env.restore();
  }
});
