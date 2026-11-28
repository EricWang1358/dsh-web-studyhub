/* Minimal Mode (极简模式) core contract:
   - Non-destructive preference state in ui/appearance-prefs.js + ui/use-appearance.js
   - Temporary motion & sound suppression without mutating stored motion/sound choices
   - Active sound preview stopped immediately when Minimal Mode turns on
   - Flat/quiet CSS system across all 4 host entrypoints, zero rules for data-minimal='off',
     WCAG AA contrast preserved on cards in every theme and high-contrast combination. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  APPEARANCE_DEFAULTS,
  APPEARANCE_LABELS,
  APPEARANCE_OPTIONS,
  MINIMALS,
  appearanceAttrs,
  createAppearanceStore,
  exportAppearance,
  getAppearanceSound,
  importAppearance,
  invalidateAppearanceCache,
  isMinimalMode,
  loadAppearance,
  normalizeAppearance,
  saveAppearance,
  seatAttrs,
} from '../ui/appearance-prefs.js';
import { loadUi } from './helpers/ui-module.mjs';

const memory = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
};

function createFakeAudioEnv() {
  const prevAudio = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const prevWebkit = Object.getOwnPropertyDescriptor(globalThis, 'webkitAudioContext');
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const storage = memory();
  const contexts = [];
  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 44100;
      this.currentTime = 0;
      this.destination = {};
      this.plays = [];
      this.stopped = 0;
      contexts.push(this);
    }
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        getChannelData: (c) => data[c],
        copyToChannel: (src, c) => data[c].set(src),
      };
    }
    createBufferSource() {
      const ctx = this;
      return {
        buffer: null,
        playbackRate: { value: 1 },
        connect() {},
        disconnect() {},
        start(at) { ctx.plays.push({ at, source: this }); },
        stop() { ctx.stopped += 1; },
      };
    }
    createGain() {
      return { gain: { setValueAtTime() {} }, connect() {}, disconnect() {} };
    }
    createBiquadFilter() {
      return { type: 'lowpass', frequency: { setValueAtTime() {} }, Q: { setValueAtTime() {} }, connect() {}, disconnect() {} };
    }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, 'webkitAudioContext', { configurable: true, value: undefined });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false } });
  return {
    storage,
    contexts,
    restore() {
      const put = (key, desc) => {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete globalThis[key];
      };
      put('AudioContext', prevAudio);
      put('webkitAudioContext', prevWebkit);
      put('localStorage', prevStorage);
      put('document', prevDoc);
      invalidateAppearanceCache();
    },
  };
}

test('minimal preference defaults to off, whitelists off/on, persists, exports/imports and resets cleanly', () => {
  assert.deepEqual([...MINIMALS], ['off', 'on']);
  assert.equal(APPEARANCE_DEFAULTS.minimal, 'off');
  assert.equal(APPEARANCE_OPTIONS.minimal, MINIMALS);
  assert.deepEqual(APPEARANCE_LABELS.minimal, { off: '关闭', on: '开启' });

  assert.equal(normalizeAppearance({ minimal: 'on' }).minimal, 'on');
  assert.equal(normalizeAppearance({ minimal: 'ultra' }).minimal, 'off');
  assert.equal(normalizeAppearance(null).minimal, 'off');

  const storage = memory();
  const store = createAppearanceStore({ storage });
  assert.equal(store.get().minimal, 'off');
  store.update({ minimal: 'on', motion: 'full', sound: 'standard', theme: 'oled' });
  assert.equal(store.get().minimal, 'on');
  assert.equal(loadAppearance(storage).minimal, 'on');
  assert.equal(isMinimalMode(storage), true);
  assert.equal(importAppearance(exportAppearance(store.get())).minimal, 'on');

  store.reset();
  assert.equal(store.get().minimal, 'off');
  assert.equal(isMinimalMode(storage), false);
});

test('Minimal Mode overrides data-motion and getAppearanceSound non-destructively and mirrors data-minimal onto seatAttrs', () => {
  const calm = { light: false, reducedMotion: false, contrast: false };
  const attrsOn = appearanceAttrs({ minimal: 'on', motion: 'full', sound: 'standard', contrast: 'high' }, calm);
  assert.equal(attrsOn['data-minimal'], 'on');
  assert.equal(attrsOn['data-motion'], 'off', 'minimal=on forces data-motion=off');
  assert.deepEqual(seatAttrs(attrsOn), {
    'data-motion': 'off',
    'data-contrast': 'high',
    'data-craft': 'standard',
    'data-minimal': 'on',
  });

  const attrsOff = appearanceAttrs({ minimal: 'off', motion: 'full', sound: 'standard' }, calm);
  assert.equal(attrsOff['data-minimal'], 'off');
  assert.equal(attrsOff['data-motion'], 'full', 'stored motion choice is restored when minimal turns off');

  const storage = memory();
  saveAppearance({ sound: 'standard', motion: 'full', minimal: 'on' }, storage);
  assert.equal(loadAppearance(storage).sound, 'standard', 'stored sound preference is untouched');
  assert.equal(loadAppearance(storage).motion, 'full', 'stored motion preference is untouched');
  assert.equal(getAppearanceSound(storage), 'off', 'getAppearanceSound returns off while minimal is active');

  saveAppearance({ sound: 'standard', motion: 'full', minimal: 'off' }, storage);
  assert.equal(getAppearanceSound(storage), 'standard', 'turning minimal off restores saved sound tier');
});

test('useMinimalMode reads live Minimal Mode state from the shared appearance store', async () => {
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = memory({ 'study-interface': JSON.stringify({ minimal: 'on' }) });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    const mod = await loadUi(`
      export { appearanceStore, useMinimalMode } from './ui/use-appearance.js';
    `);
    function Probe() {
      return React.createElement('span', null, String(mod.useMinimalMode()));
    }
    assert.equal(renderToStaticMarkup(React.createElement(Probe)), '<span>true</span>');
    mod.appearanceStore.update({ minimal: 'off' });
    assert.equal(renderToStaticMarkup(React.createElement(Probe)), '<span>false</span>');
  } finally {
    if (prevStorage) Object.defineProperty(globalThis, 'localStorage', prevStorage);
    else delete globalThis.localStorage;
    invalidateAppearanceCache();
  }
});

test('sound-effects mutes cues/preview/chime in Minimal Mode and stops an active preview when minimal turns on', async () => {
  const env = createFakeAudioEnv();
  try {
    const mod = await loadUi(`
      export { saveAppearance } from './ui/appearance-prefs.js';
      export { playSound, playSoundPreview, playTimerChime, resetSoundEngineForTests } from './ui/sound-effects.js';
    `);
    mod.resetSoundEngineForTests();
    mod.saveAppearance({ sound: 'standard', minimal: 'on' }, env.storage);
    assert.equal(mod.playSound('correct', { skipThrottle: true }), false);
    assert.equal(mod.playSoundPreview('standard'), false);
    assert.equal(mod.playTimerChime(), false);
    assert.equal(env.contexts.length, 0, 'zero AudioContext created while minimal=on');

    // Start a preview with minimal=off, then toggle minimal=on: active preview stops immediately.
    mod.saveAppearance({ sound: 'standard', minimal: 'off' }, env.storage);
    assert.equal(mod.playSoundPreview('standard'), true);
    assert.equal(env.contexts.length, 1);
    assert.equal(env.contexts[0].plays.length, 1);
    assert.equal(env.contexts[0].stopped, 0);

    mod.saveAppearance({ sound: 'standard', minimal: 'on' }, env.storage);
    assert.equal(env.contexts[0].stopped, 1, 'onAppearanceCacheChange stops active preview when minimal turns on');
    assert.equal(mod.playSound('tap', { skipThrottle: true }), false);
  } finally {
    env.restore();
  }
});

test('appearance-minimal.css loads in all 4 host entrypoints, has zero rules for off, and preserves reader paper + flat card rules', async () => {
  const [minimalCss, paperCss, workspace, dev, desktop, demo] = await Promise.all([
    readFile('ui/appearance-minimal.css', 'utf8'),
    readFile('ui/paper.css', 'utf8'),
    readFile('ui/host/workspace.jsx', 'utf8'),
    readFile('ui/dev.jsx', 'utf8'),
    readFile('ui/desktop.jsx', 'utf8'),
    readFile('web-demo/main.jsx', 'utf8'),
  ]);
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const cleanMinimal = strip(minimalCss);
  const cleanPaper = strip(paperCss);

  assert.doesNotMatch(cleanMinimal, /data-minimal=['"]off['"]/, 'zero CSS rules for data-minimal=off');
  assert.doesNotMatch(cleanPaper, /data-minimal=['"]off['"]/, 'paper.css has zero rules for data-minimal=off');
  assert.doesNotMatch(cleanMinimal, /:has\(> \.study-app\[data-minimal/, 'never uses :has(> .study-app[data-minimal...])');
  assert.doesNotMatch(cleanMinimal, /!important/i, 'never relies on !important');

  // Key visual flattening rules present
  assert.match(cleanMinimal, /\.sh-paper-card[\s\S]*background:\s*var\(--bg-surface\)/);
  assert.match(cleanMinimal, /\.today-stack::before/);
  assert.match(cleanMinimal, /\.today-card-head[\s\S]*border-bottom:\s*1px solid var\(--line\)/);
  assert.match(cleanMinimal, /--sheen:\s*transparent/);
  assert.match(cleanMinimal, /\.top-status \.dot\.is-online/);
  assert.match(cleanMinimal, /\.nav:hover:not\(:disabled\):not\(\[aria-current="page"\]\) \.icon/);
  assert.match(cleanMinimal, /\.board-today__complete/);
  assert.match(cleanMinimal, /\[data-minimal='on'\]\[data-contrast='high'\][\s\S]*--text-faint:\s*inherit/);

  // paper.css gates card ink re-scoping on :not([data-minimal='on']) while keeping reader Aa paper tone
  assert.match(cleanPaper, /:not\(\[data-minimal='on'\]\)\s*:is\(\.sh-paper,\s*\.sh-paper-card/);
  assert.match(cleanPaper, /\.study-document-viewer\[data-tone='paper'\] \.reader-page,\s*\.study-reading\[data-tone='paper'\]/);

  // All 4 host entrypoints load appearance-minimal.css alongside appearance-craft.css
  assert.match(workspace, /import \w+ from ["']\.\.\/appearance-minimal\.css["']/);
  assert.match(workspace, /el\.textContent = [^\n]*minimalCss/);
  assert.match(dev, /import ["']\.\/appearance-minimal\.css["']/);
  assert.match(desktop, /import appearanceMinimalCss from ['"]\.\/appearance-minimal\.css['"]/);
  assert.match(desktop, /GLOBAL_CSS = \[[^\]]*appearanceMinimalCss/);
  assert.match(demo, /import ['"]\.\.\/ui\/appearance-minimal\.css['"]/);
});

test('Minimal Mode flattened cards inherit theme tokens that reach WCAG AA (4.5:1) in every theme and high-contrast mode', async () => {
  const [tokensCss, themesCss] = await Promise.all([
    readFile('ui/tokens.css', 'utf8'),
    readFile('ui/appearance-themes.css', 'utf8'),
  ]);
  const norm = (s) => s.replace(/\r\n/g, '\n').replace(/^[ \t]+/gm, '');
  const readBlock = (src, selectorStart) => {
    const start = src.indexOf(selectorStart);
    assert.ok(start >= 0, `block ${selectorStart}`);
    const open = src.indexOf('{', start);
    const close = src.indexOf('\n}', open);
    const body = src.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
    return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
  };
  const t = norm(tokensCss);
  const th = norm(themesCss);
  const dark = readBlock(t, '.study-app,\n.study-seat {');
  const light = { ...dark, ...readBlock(t, '.study-app[data-theme="light"],') };
  const oled = { ...dark, ...readBlock(th, ".study-app[data-palette='oled'],") };
  const paper = { ...light, ...readBlock(th, ".study-app[data-palette='paper'],") };
  const highDark = readBlock(th, ".study-app[data-contrast='high'],");
  const highLight = readBlock(th, ".study-app[data-contrast='high'][data-theme='light'],");

  const channel = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

  const themes = [
    ['dark', dark],
    ['light', light],
    ['oled', oled],
    ['paper', paper],
    ['dark + high', { ...dark, ...highDark }],
    ['light + high', { ...light, ...highLight }],
    ['oled + high', { ...oled, ...highDark }],
    ['paper + high', { ...paper, ...highLight }],
  ];
  const failures = [];
  for (const [name, scope] of themes) {
    // In Minimal Mode, card surface is --bg-surface and --paper-ink -> --text, --paper-dim -> --text-muted
    const bg = scope['--bg-surface'];
    for (const fg of ['--text', '--text-dim', '--text-muted', '--text-faint']) {
      const r = ratio(scope[fg], bg);
      if (r < 4.5) failures.push(`${name} ${fg} on --bg-surface: ${r.toFixed(2)}`);
    }
    // Option correct badge: --bg-raised mark on --ok fill
    const okFillContrast = ratio(scope['--bg-raised'], scope['--ok']);
    if (okFillContrast < 4.5) failures.push(`${name} --bg-raised on --ok: ${okFillContrast.toFixed(2)}`);
  }
  assert.deepEqual(failures, []);
});
