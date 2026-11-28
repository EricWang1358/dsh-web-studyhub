import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import rough from 'roughjs';
import { loadUi } from './helpers/ui-module.mjs';

const mod = await loadUi(`
  export * from './ui/appearance-prefs.js';
  export { appearanceStore, useAppearance } from './ui/use-appearance.js';
  export { setUiLanguage } from './ui/i18n.js';
  export {
    DESK_ATELIER_KEY,
    createAtelierStore,
    loadAtelierPrefs,
    saveAtelierPrefs,
    sharedAtelierStore,
  } from './ui/desk-atelier/atelier-storage.js';
  export {
    startSoundscape,
    stopSoundscape,
    setDeskAtmosphere,
    resetSoundscapeEngineForTests,
  } from './ui/desk-atelier/soundscape-engine.js';
  export { default as DeskAtelierButton } from './ui/desk-atelier/DeskAtelierButton.jsx';
  export { default as AtmosphereLayer } from './ui/desk-atelier/AtmosphereLayer.jsx';
  export { default as TodayTimer, TodayTimerBar } from './ui/board/TodayTimer.jsx';
  export { default as LazyDeskPlayStrip } from './ui/desk-play/LazyDeskPlayStrip.jsx';
  export { default as LazyFlowSealCue } from './ui/seal-press/LazyFlowSealCue.jsx';
  export { default as LazyRoundSealSection } from './ui/seal-press/LazyRoundSealSection.jsx';
  export { default as LazySealAlbumTrigger } from './ui/seal-press/LazySealAlbumTrigger.jsx';
  export { default as LazyWrongBookClearStamp } from './ui/seal-press/LazyWrongBookClearStamp.jsx';
  export { default as InkMark } from './ui/seal-press/InkMark.jsx';
  export { fireSealConfetti, resetConfettiForTests } from './ui/seal-press/confetti-burst.js';
  export { default as LetterpressNumber, isFullMotionBrowser } from './ui/letterpress/LetterpressNumber.jsx';
  export { default as ForecastInkTide } from './ui/charts/ForecastInkTide.jsx';
  export { default as Graph } from './ui/Graph.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
`);

const h = React.createElement;
const roughGen = rough.generator();
const HAN = /[\u3400-\u9fff]/;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

/** Enable or disable Minimal Mode across both integrated (author-core merged) and isolated (pre-merge) branches. */
function withMinimalMode(enabled, fn) {
  const origGet = mod.appearanceStore.get;
  const hasCoreMinimal = Object.hasOwn(mod.APPEARANCE_DEFAULTS, 'minimal');
  const prevPrefs = origGet();
  const prevDocDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');

  const fakeRoot = {
    getAttribute: (attr) => {
      if (attr === 'data-minimal') return enabled ? 'on' : 'off';
      if (attr === 'data-motion') return enabled ? 'off' : 'full';
      return null;
    },
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      hidden: false,
      querySelector: () => fakeRoot,
      documentElement: fakeRoot,
    },
  });

  if (hasCoreMinimal) {
    mod.appearanceStore.update({ minimal: enabled ? 'on' : 'off' });
  } else {
    mod.appearanceStore.get = () => ({ ...origGet(), minimal: enabled ? 'on' : 'off' });
  }

  try {
    return fn();
  } finally {
    if (hasCoreMinimal) {
      mod.appearanceStore.update(prevPrefs);
    } else {
      mod.appearanceStore.get = origGet;
    }
    if (prevDocDesc) Object.defineProperty(globalThis, 'document', prevDocDesc);
    else delete globalThis.document;
  }
}

function createFakeAudioEnv(initialStorage = {}) {
  const contexts = [];
  const origAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  const origLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 22050;
      this.state = 'suspended';
      this.currentTime = 1;
      this.destination = { kind: 'destination' };
      this.sources = [];
      this.gains = [];
      this.filters = [];
      contexts.push(this);
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
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
        connect: (t) => t,
        disconnect: () => {},
        start: () => {},
        stop: () => {},
      };
      this.sources.push(src);
      return src;
    }
    createGain() {
      const gain = {
        gain: { value: 0, cancelScheduledValues: () => {}, setValueAtTime: () => {}, linearRampToValueAtTime: () => {} },
        connect: (t) => t,
        disconnect: () => {},
      };
      this.gains.push(gain);
      return gain;
    }
    createBiquadFilter() {
      const filter = {
        type: 'lowpass',
        frequency: { value: 11500, setValueAtTime: () => {} },
        Q: { value: 0.7, setValueAtTime: () => {} },
        connect: (t) => t,
        disconnect: () => {},
      };
      this.filters.push(filter);
      return filter;
    }
  }

  const storage = memoryStorage(initialStorage);
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeAudioContext });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

  return {
    contexts,
    storage,
    restore() {
      mod.resetSoundscapeEngineForTests();
      if (origAudioContext) Object.defineProperty(globalThis, 'AudioContext', origAudioContext);
      else delete globalThis.AudioContext;
      if (origLocalStorage) Object.defineProperty(globalThis, 'localStorage', origLocalStorage);
      else delete globalThis.localStorage;
    },
  };
}

test('DeskAtelierButton, AtmosphereLayer, and soundscape-engine suppress UI/playback in Minimal Mode without erasing saved prefs', () => {
  const env = createFakeAudioEnv();
  try {
    mod.resetSoundscapeEngineForTests();
    mod.setDeskAtmosphere('lamp');
    mod.sharedAtelierStore.applyPreset('morning-bamboo');
    mod.sharedAtelierStore.setMaster(0.75);

    withMinimalMode(false, () => {
      assert.match(renderToStaticMarkup(h(mod.DeskAtelierButton)), /desk-atelier__toggle/);
      assert.match(renderToStaticMarkup(h(mod.AtmosphereLayer)), /desk-atelier-atmosphere/);
      assert.equal(mod.startSoundscape(), true);
      assert.equal(mod.sharedAtelierStore.get().playing, true);
    });

    // Stopping soundscape + entering Minimal Mode hides button & overlay, blocks startSoundscape, and preserves saved prefs.
    mod.stopSoundscape({ immediate: true });
    withMinimalMode(true, () => {
      assert.equal(renderToStaticMarkup(h(mod.DeskAtelierButton)), '');
      assert.equal(renderToStaticMarkup(h(mod.AtmosphereLayer)), '');
      const contextsBefore = env.contexts.length;
      assert.equal(mod.startSoundscape(), false);
      assert.equal(mod.sharedAtelierStore.get().playing, false);
      assert.equal(env.contexts.length, contextsBefore, 'does not construct AudioContext while minimal is active');
    });

    // Saved study-desk-atelier preferences remain intact and work again when Minimal Mode turns off.
    const saved = mod.loadAtelierPrefs(env.storage);
    assert.equal(saved.preset, 'morning-bamboo');
    assert.equal(saved.atmosphere, 'lamp');
    assert.equal(saved.master, 0.75);

    withMinimalMode(false, () => {
      assert.match(renderToStaticMarkup(h(mod.DeskAtelierButton)), /desk-atelier__toggle/);
      assert.match(renderToStaticMarkup(h(mod.AtmosphereLayer)), /data-atmosphere="lamp"/);
    });

    // Flipping Minimal Mode on while soundscape is actively playing stops playback automatically without erasing prefs.
    withMinimalMode(false, () => {
      assert.equal(mod.startSoundscape(), true);
      assert.equal(mod.sharedAtelierStore.get().playing, true);
      mod.appearanceStore.update({ minimal: 'on' });
      assert.equal(mod.sharedAtelierStore.get().playing, false);
    });

    // Behavioral check: DeskAtelierButton does NOT attach the global Alt+Shift+A keydown listener while minimal is active.
    const origWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const listeners = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener(type, fn) { listeners.push({ type, fn }); },
        removeEventListener() {},
      },
    });
    const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevH = internals.H;
    const runEffectsFor = (minimalOn) => {
      listeners.length = 0;
      const effects = [];
      let stateIdx = 0;
      const states = [];
      internals.H = {
        useState(init) { const i = stateIdx++; if (!(i in states)) states[i] = typeof init === 'function' ? init() : init; return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; }]; },
        useRef(init) { return { current: init }; },
        useEffect(fn) { effects.push(fn); },
        useLayoutEffect() {},
        useInsertionEffect() {},
        useCallback(fn) { return fn; },
        useMemo(fn) { return fn(); },
        useContext(ctx) { return ctx._currentValue; },
        useSyncExternalStore(_sub, getSnap) { return getSnap(); },
        useId() { return ':r0:'; },
      };
      try {
        withMinimalMode(minimalOn, () => {
          mod.DeskAtelierButton.type();
          for (const fx of effects) fx();
        });
      } finally {
        internals.H = prevH;
      }
      return listeners.filter((entry) => entry.type === 'keydown').length;
    };
    try {
      assert.equal(runEffectsFor(true), 0, 'Alt+Shift+A keydown listener is suppressed in Minimal Mode');
      assert.equal(runEffectsFor(false), 1, 'Alt+Shift+A keydown listener attaches in Standard Mode');
    } finally {
      if (origWindow) Object.defineProperty(globalThis, 'window', origWindow);
      else delete globalThis.window;
    }
  } finally {
    env.restore();
  }
});

test('TodayTimer hides ritual dial, ambient canvas, breathing halo, chime and soundscape pill in Minimal Mode while keeping core timer controls', () => {
  const today = '2026-11-28';
  const nowMs = Date.parse('2026-11-28T09:02:00.000Z');
  const activeBoard = {
    version: 1,
    revision: 2,
    columns: [{ id: 'todo', title: 'Todo', cardIds: ['c1'] }],
    cards: { c1: { id: 'c1', title: 'Review Paxos', note: 'Compare quorum intersection' } },
    timer: {
      id: 't-break',
      mode: 'break',
      cardTitle: '休息',
      durationMinutes: 5,
      startedAt: '2026-11-28T09:00:00.000Z',
      pausedMs: 0,
    },
    timeLog: [],
  };
  const idleBoard = {
    version: 1,
    revision: 1,
    columns: [{ id: 'todo', title: 'Todo', cardIds: [] }],
    cards: {},
    timeLog: [],
  };

  mod.setUiLanguage('zh');
  try {
    const standardHtml = withMinimalMode(false, () => renderToStaticMarkup(h(mod.TodayTimer, {
      board: activeBoard,
      today,
      nowMs,
      fullscreen: true,
    })));
    assert.match(standardHtml, /desk-dial--compact/);
    assert.match(standardHtml, /desk-dial--stage/);
    assert.match(standardHtml, /60 秒呼吸引导/);
    assert.match(standardHtml, /五声风铃/);
    assert.match(standardHtml, /desk-focus-sound/);
    assert.match(standardHtml, /desk-ambient-bar/);

    const minimalActiveHtml = withMinimalMode(true, () => renderToStaticMarkup(h(mod.TodayTimer, {
      board: activeBoard,
      today,
      nowMs,
      fullscreen: true,
    })));
    assert.doesNotMatch(minimalActiveHtml, /desk-dial/);
    assert.doesNotMatch(minimalActiveHtml, /desk-ambient-canvas/);
    assert.doesNotMatch(minimalActiveHtml, /desk-ambient-bar/);
    assert.doesNotMatch(minimalActiveHtml, /desk-focus-sound/);
    assert.doesNotMatch(minimalActiveHtml, /desk-breath/);
    assert.doesNotMatch(minimalActiveHtml, /60 秒呼吸引导/);
    assert.doesNotMatch(minimalActiveHtml, /五声风铃/);
    assert.match(minimalActiveHtml, /board-timer__clock/);
    assert.match(minimalActiveHtml, /board-focus-stage__clock/);
    assert.match(minimalActiveHtml, /3:00/);
    assert.match(minimalActiveHtml, /暂停/);
    assert.match(minimalActiveHtml, /结束休息/);
    assert.match(minimalActiveHtml, /放弃这一个/);
    assert.match(minimalActiveHtml, /改时长/);
    assert.match(minimalActiveHtml, /补记一段/);

    const minimalIdleHtml = withMinimalMode(true, () => renderToStaticMarkup(h(mod.TodayTimer, {
      board: idleBoard,
      today,
      onStartFreeFocus: () => true,
    })));
    assert.doesNotMatch(minimalIdleHtml, /desk-dial/);
    assert.match(minimalIdleHtml, /board-timer__clock is-idle/);
    assert.match(minimalIdleHtml, /25:00/);
    assert.match(minimalIdleHtml, /自由专注/);
    assert.match(minimalIdleHtml, /全屏专注/);

    mod.setUiLanguage('en');
    const enMinimalHtml = withMinimalMode(true, () => renderToStaticMarkup(h(mod.TodayTimer, {
      board: activeBoard,
      today,
      nowMs,
      fullscreen: true,
    })));
    assert.doesNotMatch(enMinimalHtml, HAN, 'English Minimal Mode TodayTimer leaks zero Han');

    // TodayTimerBar: standard mode keeps 全屏专注; minimal-style props (no onOpenFullscreen, with onCancel) omit 全屏专注 and expose 放弃这一个.
    mod.setUiLanguage('zh');
    const barStandard = renderToStaticMarkup(h(mod.TodayTimerBar, {
      board: activeBoard,
      nowMs,
      onPause: () => {},
      onOpenFullscreen: () => {},
    }));
    assert.match(barStandard, /全屏专注/);
    assert.doesNotMatch(barStandard, /放弃这一个/);

    const barMinimal = renderToStaticMarkup(h(mod.TodayTimerBar, {
      board: activeBoard,
      nowMs,
      onPause: () => {},
      onCancel: () => {},
    }));
    assert.doesNotMatch(barMinimal, /全屏专注/);
    assert.match(barMinimal, /放弃这一个/);
    assert.match(barMinimal, /暂停/);

    const barFinished = renderToStaticMarkup(h(mod.TodayTimerBar, {
      board: activeBoard,
      nowMs: Date.parse('2026-11-28T09:06:00.000Z'),
      onComplete: () => {},
      onCancel: () => {},
    }));
    assert.match(barFinished, /结束休息/);
    assert.doesNotMatch(barFinished, /放弃这一个/);

    mod.setUiLanguage('en');
    const barMinimalEn = renderToStaticMarkup(h(mod.TodayTimerBar, {
      board: activeBoard,
      nowMs,
      onPause: () => {},
      onCancel: () => {},
    }));
    assert.doesNotMatch(barMinimalEn, HAN, 'English TodayTimerBar with onCancel leaks zero Han');
  } finally {
    mod.setUiLanguage('zh');
  }
});

test('LazyDeskPlayStrip and lazy seal-press wrappers return null in Minimal Mode without deleting saved data or importing chunks', () => {
  const prevStorage = globalThis.localStorage;
  const mem = memoryStorage({
    'study-seal-album': JSON.stringify([{ id: 'keep-1', sealId: 'clean-sweep' }]),
    'study-desk-play': JSON.stringify({ hidden: false }),
  });
  globalThis.localStorage = mem;

  try {
    const nav5 = Array.from({ length: 5 }, (_, index) => ({ index, answered: true, passed: true }));
    const runActive = { id: 'r-flow', mode: 'path', index: 4, complete: false, navigation: nav5 };
    const runComplete = { id: 'r-done', mode: 'path', complete: true, index: 5, total: 5, questions: 5, answered: 5, correct: 5 };

    withMinimalMode(false, () => {
      assert.match(renderToStaticMarkup(h(mod.LazySealAlbumTrigger)), /seal-album-trigger/);
    });

    withMinimalMode(true, () => {
      assert.equal(renderToStaticMarkup(h(mod.LazyDeskPlayStrip, { data: { decks: [] }, onPracticeDeck: () => {} })), '');
      assert.equal(renderToStaticMarkup(h(mod.LazyFlowSealCue, { run: runActive, variant: 'header' })), '');
      assert.equal(renderToStaticMarkup(h(mod.LazyRoundSealSection, { run: runComplete, title: 'Deck', allCorrect: true })), '');
      assert.equal(renderToStaticMarkup(h(mod.LazySealAlbumTrigger)), '');
      assert.equal(renderToStaticMarkup(h(mod.LazyWrongBookClearStamp, { clearedCount: 4, course: 'CS' })), '');
    });

    // Saved localStorage records must remain untouched.
    assert.match(mem.getItem('study-seal-album'), /keep-1/);
    assert.match(mem.getItem('study-desk-play'), /"hidden":false/);

    // Verify lazy loaders gate their dynamic import() on !minimal.
    for (const rel of [
      '../ui/desk-play/LazyDeskPlayStrip.jsx',
      '../ui/seal-press/LazyFlowSealCue.jsx',
      '../ui/seal-press/LazyRoundSealSection.jsx',
      '../ui/seal-press/LazySealAlbumTrigger.jsx',
      '../ui/seal-press/LazyWrongBookClearStamp.jsx',
    ]) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
      assert.match(src, /minimal/, `${rel} checks minimal mode before dynamic import`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('InkMark, confetti-burst, and LetterpressNumber degrade cleanly in Minimal Mode', async () => {
  // InkMark: renders children directly without rough-notation wrapper when minimal is active.
  const inkStandard = withMinimalMode(false, () => renderToStaticMarkup(
    h(mod.InkMark, { type: 'underline', tone: 'success' }, h('span', { className: 'badge' }, 'All correct')),
  ));
  assert.match(inkStandard, /sh-ink-mark-host/);

  const inkMinimal = withMinimalMode(true, () => renderToStaticMarkup(
    h(mod.InkMark, { type: 'underline', tone: 'success' }, h('span', { className: 'badge' }, 'All correct')),
  ));
  assert.equal(inkMinimal, '<span class="badge">All correct</span>');
  assert.doesNotMatch(inkMinimal, /sh-ink-mark-host/);

  // confetti-burst: intercepted cleanly when data-minimal="on".
  mod.resetConfettiForTests();
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => ({ matches: false }) } });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        hidden: false,
        querySelector: () => ({
          getAttribute: (attr) => (attr === 'data-minimal' ? 'on' : attr === 'data-motion' ? 'full' : null),
        }),
      },
    });
    assert.equal(await mod.fireSealConfetti({ variant: 'clean-sweep' }), false);

    // LetterpressNumber: isFullMotionBrowser returns false when data-minimal="on", true when data-minimal="off".
    const mkDoc = (motion, minimal) => ({
      querySelector: () => ({
        getAttribute: (attr) => (attr === 'data-motion' ? motion : attr === 'data-minimal' ? minimal : null),
      }),
    });
    const mkWin = () => ({ matchMedia: () => ({ matches: false }) });
    assert.equal(mod.isFullMotionBrowser(mkDoc('full', 'on'), mkWin()), false);
    assert.equal(mod.isFullMotionBrowser(mkDoc('full', 'off'), mkWin()), true);
  } finally {
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else delete globalThis.window;
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
  }

  const lpMinimal = withMinimalMode(true, () => renderToStaticMarkup(
    h('strong', null, h(mod.LetterpressNumber, { value: 42, suffix: '%' })),
  ));
  assert.equal(lpMinimal, '<strong>42%</strong>');
});

test('ForecastInkTide skips roughjs peak hatching and Graph forces crisp rendering without erasing saved sketch preference', () => {
  const days = [4, 0, 0, 8, 2, 0, 1].map((count, i) => ({
    date: `2026-11-${String(21 + i).padStart(2, '0')}`,
    count,
    cards: Array.from({ length: count }, (_, k) => ({ deckId: 'd1', cardId: `c${i}-${k}` })),
  }));
  const yScale = (v) => 192 - v * 16;

  const tideStandard = withMinimalMode(false, () => renderToStaticMarkup(h(mod.ForecastInkTide, {
    days,
    total: 15,
    width: 560,
    height: 220,
    yScale,
    band: 68,
    labelAt: new Set([0, 3, 6]),
    roughGenerator: roughGen,
  })));
  assert.match(tideStandard, /forecast-tide__hatch/);
  assert.match(tideStandard, /forecast-tide__echo/);

  const tideMinimal = withMinimalMode(true, () => renderToStaticMarkup(h(mod.ForecastInkTide, {
    days,
    total: 15,
    width: 560,
    height: 220,
    yScale,
    band: 68,
    labelAt: new Set([0, 3, 6]),
    roughGenerator: roughGen,
  })));
  assert.doesNotMatch(tideMinimal, /forecast-tide__hatch/);
  assert.doesNotMatch(tideMinimal, /forecast-tide__echo/);
  assert.match(tideMinimal, /forecast-tide__crest/);
  assert.match(tideMinimal, /forecast-tide__area/);

  // Graph: preserves saved 'sketch' style while forcing crisp & hiding toggle in Minimal Mode.
  const prevStorage = globalThis.localStorage;
  const mem = memoryStorage({ 'study-graph-style': JSON.stringify('sketch') });
  globalThis.localStorage = mem;
  try {
    const graphData = {
      mode: 'structure',
      nodes: [
        { id: 'deck:d1', kind: 'deck', label: 'Algorithms', mastery: 60, due: 1, total: 1 },
        { id: `card:${JSON.stringify(['d1', 'c1'])}`, kind: 'card', label: 'DP', level: 'learning' },
      ],
      edges: [
        { from: 'deck:d1', to: `card:${JSON.stringify(['d1', 'c1'])}`, type: 'tree', seq: 0 },
      ],
    };

    const sketchHtml = withMinimalMode(false, () => renderToStaticMarkup(h(mod.Graph, {
      library: { root: 'g-min', focus: { course: '*' } },
      initialData: graphData,
      roughGenerator: roughGen,
      onClose: () => {},
    })));
    assert.match(sketchHtml, /data-graph-style="sketch"/);
    assert.match(sketchHtml, /graph-sketch-node/);
    assert.match(sketchHtml, /手绘墨线/);

    const minimalGraphHtml = withMinimalMode(true, () => renderToStaticMarkup(h(mod.Graph, {
      library: { root: 'g-min', focus: { course: '*' } },
      initialData: graphData,
      roughGenerator: roughGen,
      onClose: () => {},
    })));
    assert.match(minimalGraphHtml, /data-graph-style="crisp"/);
    assert.doesNotMatch(minimalGraphHtml, /graph-sketch-node/);
    assert.doesNotMatch(minimalGraphHtml, /手绘墨线/);
    assert.match(minimalGraphHtml, /gn-node/);
    assert.equal(JSON.parse(mem.getItem('study-graph-style')), 'sketch', 'saved sketch preference is preserved');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
