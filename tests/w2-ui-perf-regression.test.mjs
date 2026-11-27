import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { click, loadInteractiveUi, syntheticEvent, withBrowserGlobals } from './helpers/react-harness.mjs';

const require = createRequire(import.meta.url);

/**
 * Compile a module with an injectable test React hook runtime so we can exercise real hooks
 * (`usePanZoom`, `useDraftDirty`, `BookToc`) across multiple re-renders without jsdom or React private internals.
 */
async function loadWithTestHooks(contents, { resolvePlugins = [] } = {}) {
  const hookRuntime = {
    slots: [],
    effects: [],
    layoutEffects: [],
    cursor: 0,
    rerender: null,
    reset() {
      for (const eff of [...this.layoutEffects, ...this.effects]) {
        if (typeof eff?.cleanup === 'function') eff.cleanup();
      }
      this.slots = [];
      this.effects = [];
      this.layoutEffects = [];
      this.cursor = 0;
    },
    render(fn) {
      let out;
      let passes = 0;
      let dirty = true;
      while (dirty) {
        if (++passes > 10) throw new Error('Too many synchronous re-renders in test hook runtime');
        dirty = false;
        this.cursor = 0;
        const pendingLayout = [];
        const pendingEffect = [];
        this.rerender = () => { dirty = true; };
        this._pendingLayout = pendingLayout;
        this._pendingEffect = pendingEffect;
        out = fn();
        for (const run of pendingLayout) run();
        for (const run of pendingEffect) run();
        this.rerender = null;
      }
      return out;
    },
    sameDeps(a, b) {
      if (!a || !b || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
      return true;
    },
    makeReact() {
      const rt = this;
      const useState = (init) => {
        const idx = rt.cursor++;
        if (!(idx in rt.slots)) {
          rt.slots[idx] = typeof init === 'function' ? init() : init;
        }
        const setState = (next) => {
          const prev = rt.slots[idx];
          const value = typeof next === 'function' ? next(prev) : next;
          if (!Object.is(prev, value)) {
            rt.slots[idx] = value;
            if (rt.rerender) rt.rerender();
          }
        };
        return [rt.slots[idx], setState];
      };
      const useRef = (init) => {
        const idx = rt.cursor++;
        if (!(idx in rt.slots)) rt.slots[idx] = { current: init };
        return rt.slots[idx];
      };
      const useMemo = (factory, deps) => {
        const idx = rt.cursor++;
        const prev = rt.slots[idx];
        if (!prev || !rt.sameDeps(prev.deps, deps)) {
          rt.slots[idx] = { value: factory(), deps };
        }
        return rt.slots[idx].value;
      };
      const useCallback = (fn, deps) => useMemo(() => fn, deps);
      const useDeferredValue = (val) => val;
      const useId = () => {
        const idx = rt.cursor++;
        if (!(idx in rt.slots)) rt.slots[idx] = `:t${idx}:`;
        return rt.slots[idx];
      };
      const scheduleEffect = (bucket, store, effect, deps) => {
        const idx = rt.cursor++;
        const prev = store[idx];
        if (!prev || !rt.sameDeps(prev.deps, deps)) {
          bucket.push(() => {
            if (typeof prev?.cleanup === 'function') prev.cleanup();
            const cleanup = effect();
            store[idx] = { deps, cleanup };
          });
        }
      };
      const useLayoutEffect = (effect, deps) => scheduleEffect(rt._pendingLayout, rt.layoutEffects, effect, deps);
      const useEffect = (effect, deps) => scheduleEffect(rt._pendingEffect, rt.effects, effect, deps);
      const useContext = (ctx) => ctx?._defaultValue;
      const createContext = (def) => ({ _defaultValue: def, Provider: ({ children }) => children });
      const memo = (Component, compare) => Object.assign(Component, { compare });
      const forwardRef = (render) => render;
      const createElement = (type, props, ...children) => ({ type, props: { ...props, children } });
      const cloneElement = (el, props, ...children) => ({ ...el, props: { ...el?.props, ...props, ...(children.length ? { children } : {}) } });
      const isValidElement = (el) => Boolean(el && typeof el === 'object' && 'type' in el);
      const Fragment = Symbol('Fragment');
      const Children = { map: (c, fn) => [].concat(c || []).map(fn), forEach: (c, fn) => [].concat(c || []).forEach(fn), toArray: (c) => [].concat(c || []) };
      const useSyncExternalStore = (_sub, getSnap) => getSnap();
      const api = {
        ...React,
        useState,
        useRef,
        useMemo,
        useCallback,
        useDeferredValue,
        useId,
        useLayoutEffect,
        useInsertionEffect: useLayoutEffect,
        useEffect,
        useContext,
        useSyncExternalStore,
        createContext,
        memo,
        forwardRef,
        createElement,
        cloneElement,
        isValidElement,
        Fragment,
        Children,
      };
      return { default: api, ...api };
    },
  };

  const fakeReactPlugin = {
    name: 'test-hook-react',
    setup(b) {
      b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'test-hook-react' }));
      b.onLoad({ filter: /.*/, namespace: 'test-hook-react' }, () => ({
        contents: 'module.exports = globalThis.__TEST_HOOK_REACT__;',
        loader: 'js',
      }));
    },
  };

  const compiled = await build({
    stdin: { contents, resolveDir: process.cwd() },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['react-dom'],
    loader: { '.css': 'text' },
    plugins: [fakeReactPlugin, ...resolvePlugins],
  });

  const prev = globalThis.__TEST_HOOK_REACT__;
  globalThis.__TEST_HOOK_REACT__ = hookRuntime.makeReact();
  const mod = { exports: {} };
  try {
    new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
  } finally {
    globalThis.__TEST_HOOK_REACT__ = prev;
  }
  return { exports: mod.exports, runtime: hookRuntime };
}

/* ---------- 1. ui/Sources.jsx: DocumentRow React.memo isolation ---------- */

test('Sources DocumentRow no longer subscribes to AppContext and compares companionTarget in sourceRowPropsEqual', async () => {
  const sourceCode = await readFile(new URL('../ui/Sources.jsx', import.meta.url), 'utf8');
  const rowBody = /export const DocumentRow = memo\(function DocumentRow[\s\S]*?\n\}, sourceRowPropsEqual\);/.exec(sourceCode)?.[0] ?? '';
  assert.ok(rowBody.length > 0, 'DocumentRow memo definition found');
  assert.doesNotMatch(rowBody, /useContext\(\s*AppContext\s*\)/, 'DocumentRow must not subscribe to AppContext directly');

  const uiMod = await loadUi(`
    export { DocumentRow, sourceRowPropsEqual } from './ui/Sources.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
  `);
  const { DocumentRow, sourceRowPropsEqual, StudyServicesContext } = uiMod;

  const baseProps = {
    item: { key: 'k1', title: 'Comp Lecture', courses: ['OS'], usedBy: [], warnings: [], pages: [{ sourceId: 's1', page: 1, chars: 120 }], sourceIds: ['s1'], chars: 120, format: 'md', archived: false },
    source: { id: 's1', title: 'Comp Lecture', companionId: 'comp-1', courses: ['OS'] },
    companionTarget: { companionId: 'comp-1', course: 'OS', slide: 2, anchor: '#2', label: '', companionTitle: 'Intro', lessonMode: '' },
    isNew: false,
    organizing: false,
    selected: false,
    actions: { open() {}, generate() {}, archive() {}, remove() {}, changeCourse() {}, moveFolder() {}, segment() {}, rename: () => null, pin() {}, pinMove() {}, openSettings() {}, buildIndex() {} },
    canGenerate: false,
    canPractice: false,
    canSegment: false,
    canRename: false,
    mastery: null,
    coverage: null,
    topUp: false,
    indexInfo: null,
    canIndex: false,
    indexLink: false,
    slot: false,
    relation: null,
    advice: false,
    retrieval: null,
    courses: [],
    defaultCourse: '',
    pinned: false,
    pinFirst: false,
    pinLast: false,
    dragging: false,
    dropMark: '',
    custom: null,
    showExtraCourseBadges: false,
    folderDrag: false,
    canMoveFolder: false,
  };

  assert.equal(
    sourceRowPropsEqual(baseProps, { ...baseProps, companionTarget: { ...baseProps.companionTarget } }),
    true,
    'structurally equal companionTarget keeps React.memo hit',
  );
  assert.equal(
    sourceRowPropsEqual(baseProps, { ...baseProps, companionTarget: { ...baseProps.companionTarget, slide: 3 } }),
    false,
    'changed companionTarget triggers re-render',
  );
  assert.equal(
    sourceRowPropsEqual(baseProps, { ...baseProps, companionTarget: null }),
    false,
    'removed companionTarget triggers re-render',
  );

  // Render without AppContext.Provider: companion menu item follows the prop directly.
  const withCompanion = renderToStaticMarkup(
    React.createElement(StudyServicesContext.Provider, { value: { busy: false, openModal() {} } },
      React.createElement(DocumentRow, baseProps)),
  );
  assert.match(withCompanion, /打开交互伴学页/);

  const withoutCompanion = renderToStaticMarkup(
    React.createElement(StudyServicesContext.Provider, { value: { busy: false, openModal() {} } },
      React.createElement(DocumentRow, { ...baseProps, companionTarget: null })),
  );
  assert.doesNotMatch(withoutCompanion, /打开交互伴学页/);
});

/* ---------- 2. ui/SkeletonCanvas.jsx + usePanZoom.js + skeleton-diagrams.js ---------- */

test('visibleClasses culls offscreen nodes even below 120 boxes (dead threshold removed)', async () => {
  const { visibleClasses } = await import('../ui/skeleton-diagrams.js');
  const boxes = new Map(Array.from({ length: 40 }, (_, i) => [`n${i}`, { id: `n${i}`, x: i * 300, y: 0, w: 224, h: 70 }]));
  const edges = [
    { from: 'n0', to: 'n1', x1: 224, y1: 35, x2: 300, y2: 35 },
    { from: 'n20', to: 'n21', x1: 6224, y1: 35, x2: 6300, y2: 35 },
    { from: 'n0', to: 'n30', x1: 100, y1: 35, x2: 9000, y2: 35 },
  ];
  const culled = visibleClasses(boxes, edges, { k: 1, x: 0, y: 0 }, { w: 800, h: 500 }, 'n39', 0);
  assert.deepEqual(culled.boxes.map((b) => b.id), ['n0', 'n1', 'n2', 'n39']);
  assert.equal(culled.edges.length, 2, 'keeps visible and crossing edges, culls offscreen edge');

  // Unmeasured viewport still returns all boxes and edges unculled.
  const unmeasured = visibleClasses(boxes, edges, { k: 1, x: 0, y: 0 }, { w: 0, h: 0 }, null, 0);
  assert.equal(unmeasured.boxes.length, 40);
  assert.equal(unmeasured.edges.length, 3);
});

test('usePanZoom preserves user pan/zoom and ResizeObserver when anchorX/anchorY/insetRight change on selection or detail toggle', async () => {
  const { exports: { usePanZoom }, runtime } = await loadWithTestHooks(`
    export { usePanZoom } from './ui/canvas/usePanZoom.js';
  `);

  let observerCount = 0;
  let disconnectCount = 0;
  let observerCb = null;
  const PrevRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class FakeResizeObserver {
    constructor(cb) {
      observerCount += 1;
      observerCb = cb;
    }
    observe() {}
    disconnect() { disconnectCount += 1; }
  };

  const fakeEl = {
    clientWidth: 900,
    clientHeight: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600 }),
    addEventListener() {},
    removeEventListener() {},
  };

  try {
    let opts = { insetRight: 0, anchorX: 100, anchorY: 100, vertical: false, fitKey: 'sk1::' };
    let api = runtime.render(() => {
      const res = usePanZoom(1600, 1000, opts);
      res.viewRef.current = fakeEl;
      return res;
    });
    // Second render so layout effect runs with viewRef populated.
    api = runtime.render(() => usePanZoom(1600, 1000, opts));
    const initialFitFn = api.fit;

    // Simulate user zooming/panning to a custom viewport.
    api.zoomAt(1.6, 450, 300);
    api = runtime.render(() => usePanZoom(1600, 1000, opts));
    const userView = { ...api.view };

    // Selecting a concept node and opening the detail panel changes anchorX/anchorY/insetRight.
    const observersBefore = observerCount;
    const disconnectsBefore = disconnectCount;
    opts = { insetRight: 310, anchorX: 850, anchorY: 420, vertical: false, fitKey: 'sk1::' };
    api = runtime.render(() => usePanZoom(1600, 1000, opts));

    assert.equal(api.fit, initialFitFn, 'fit callback identity stays stable when only selection/detail hints change');
    assert.equal(observerCount, observersBefore, 'ResizeObserver is not recreated on node selection or detail toggle');
    assert.equal(disconnectCount, disconnectsBefore, 'ResizeObserver is not disconnected on node selection or detail toggle');
    assert.deepEqual(api.view, userView, 'user pan/zoom viewport is preserved when selecting a concept');

    // Closing the detail panel (insetRight: 310 -> 0) also preserves user pan/zoom.
    opts = { ...opts, insetRight: 0 };
    api = runtime.render(() => usePanZoom(1600, 1000, opts));
    assert.deepEqual(api.view, userView, 'user pan/zoom viewport is preserved when closing detail panel');

    // Spurious ResizeObserver callback at identical dimensions does not reset pan/zoom.
    observerCb?.();
    api = runtime.render(() => usePanZoom(1600, 1000, opts));
    assert.deepEqual(api.view, userView, 'unchanged container size does not reset user viewport');

    // Switching structural layout (fitKey changes, e.g. focus mode) refits using latest hints.
    opts = { insetRight: 310, anchorX: 850, anchorY: 420, vertical: false, fitKey: 'sk1::node-b' };
    api = runtime.render(() => usePanZoom(1600, 1000, opts));
    assert.notDeepEqual(api.view, userView, 'structural fitKey change refits cleanly');
  } finally {
    runtime.reset();
    globalThis.ResizeObserver = PrevRO;
  }
});

test('ClassCanvas preserves user pan/zoom across node selection and detail drawer toggles, and refits on focus/component/skeleton switches', async t => {
  await withBrowserGlobals(async () => {
    const ui = await loadInteractiveUi(`
      export { setUiLanguage } from './ui/i18n.js';
      export { ClassCanvas } from './ui/SkeletonCanvas.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
    `);
    const { setUiLanguage, ClassCanvas, StudyServicesContext } = ui.exports;
    const h = ui.React.createElement;
    setUiLanguage('zh');

    const skeletonA = {
      id: 'sk-alpha',
      nodes: [
        { id: 'n1', term: 'Process', meaning: 'Execution instance', attributes: ['pid'], cards: [] },
        { id: 'n2', term: 'Thread', meaning: 'Lightweight unit', attributes: ['tid'], cards: [] },
        { id: 'n3', term: 'Page Table', meaning: 'Virtual memory map', attributes: ['pte'], cards: [] },
        { id: 'n4', term: 'TLB', meaning: 'Translation cache', attributes: ['hitRate'], cards: [] },
      ],
      relations: [
        { from: 'n2', to: 'n1', type: 'part-of' },
        { from: 'n4', to: 'n3', type: 'related' },
      ],
      sequences: [],
    };
    const skeletonB = {
      id: 'sk-beta',
      nodes: [
        { id: 'b1', term: 'Socket', meaning: 'Network endpoint', attributes: ['fd'], cards: [] },
        { id: 'b2', term: 'TCP', meaning: 'Reliable stream', attributes: ['cwnd'], cards: [] },
        { id: 'b3', term: 'UDP', meaning: 'Datagram', attributes: ['port'], cards: [] },
      ],
      relations: [
        { from: 'b2', to: 'b1', type: 'related' },
        { from: 'b3', to: 'b1', type: 'related' },
      ],
      sequences: [],
    };

    const services = {
      call: async () => ({}),
      act: async () => undefined,
      busy: false,
      notify() {},
      askInChat() {},
      host: {},
      openSettings() {},
      navigate() {},
      openModal() {},
    };
    let currentSkeleton = skeletonA;
    let selected = null;
    const renderCanvas = () => h(
      StudyServicesContext.Provider,
      { value: services },
      h(ClassCanvas, {
        skeleton: currentSkeleton,
        selected,
        onSelect: (next) => { selected = next; },
      }),
    );

    const mounted = ui.mount(renderCanvas);
    t.after(() => mounted.unmount());

    const worldTransform = () => {
      const world = mounted.find((n) => n.type === 'div' && String(n.props?.className || '').includes('skc-world'));
      assert.ok(world, 'renders .skc-world container');
      return world.props.style.transform;
    };
    const panAndZoom = async () => {
      const viewEl = mounted.find((n) => n.type === 'div' && String(n.props?.className || '').includes('skc-view'));
      assert.ok(viewEl, 'renders .skc-view container');
      const target = {};
      await mounted.act(() => {
        viewEl.props.onKeyDown(syntheticEvent({ key: '+', target, currentTarget: target }));
        viewEl.props.onKeyDown(syntheticEvent({ key: 'ArrowRight', target, currentTarget: target }));
        viewEl.props.onKeyDown(syntheticEvent({ key: 'ArrowDown', target, currentTarget: target }));
      });
    };

    const initialTransform = worldTransform();
    await panAndZoom();
    const userTransform = worldTransform();
    assert.notEqual(userTransform, initialTransform, 'pan/zoom changes viewport transform');

    // Non-structural change 1: selecting a concept opens detail drawer (insetRight 0 -> 310, anchor changes) without resetting pan/zoom.
    selected = 'n1';
    mounted.rerender();
    assert.ok(mounted.find((n) => String(n.props?.className || '').includes('skc-detail')), 'detail drawer opens for selected node');
    assert.equal(worldTransform(), userTransform, 'selecting a concept preserves user pan/zoom');

    // Non-structural change 2: closing detail drawer (insetRight 310 -> 0) preserves user pan/zoom.
    const closeBtn = mounted.find((n) => n.type === 'button' && String(n.props?.className || '').includes('skc-close'));
    assert.ok(closeBtn, 'detail drawer renders close button');
    await mounted.act(() => click(closeBtn));
    assert.equal(mounted.find((n) => String(n.props?.className || '').includes('skc-detail')), null, 'detail drawer closes');
    assert.equal(worldTransform(), userTransform, 'closing detail drawer preserves user pan/zoom');

    // Non-structural change 3: selecting another concept preserves user pan/zoom.
    selected = 'n2';
    mounted.rerender();
    assert.equal(worldTransform(), userTransform, 'switching selected concept preserves user pan/zoom');

    // Structural change 1: entering focus mode (focused: "" -> "n2") refits viewport cleanly.
    const focusBtn = mounted.find((n) => n.type === 'button' && ui.textOf(n).includes('只看邻居'));
    assert.ok(focusBtn, 'renders focus toggle button when a concept is selected');
    await mounted.act(() => click(focusBtn));
    const focusedTransform = worldTransform();
    assert.notEqual(focusedTransform, userTransform, 'entering focus mode refits viewport');

    // Structural change 2: switching component group (componentId) refits viewport cleanly.
    await panAndZoom();
    const beforeComponentSwitch = worldTransform();
    const groupSelect = mounted.find((n) => typeof n.type === 'function' && n.props?.className === 'skc-search-select');
    assert.ok(groupSelect, 'renders component selector for multi-component skeleton');
    const secondGroup = groupSelect.props.options.find((opt) => opt.value);
    assert.ok(secondGroup, 'component selector offers non-empty component option');
    await mounted.act(() => groupSelect.props.onChange(secondGroup.value));
    const afterComponentSwitch = worldTransform();
    assert.notEqual(afterComponentSwitch, beforeComponentSwitch, 'switching component refits viewport');

    // Structural change 3: switching skeleton.id refits viewport cleanly.
    await panAndZoom();
    const beforeSkeletonSwitch = worldTransform();
    currentSkeleton = skeletonB;
    selected = null;
    mounted.rerender();
    const afterSkeletonSwitch = worldTransform();
    assert.notEqual(afterSkeletonSwitch, beforeSkeletonSwitch, 'switching skeleton.id refits viewport');

    // Same content in a new object keeps the pan; the same content under a different skeleton.id refits (identical content, so only the id can tell).
    await panAndZoom();
    const pannedSecond = worldTransform();
    assert.notEqual(pannedSecond, afterSkeletonSwitch, 'pan/zoom moved the viewport again');
    currentSkeleton = { ...skeletonB };
    mounted.rerender();
    assert.equal(worldTransform(), pannedSecond, 'equivalent data for the same skeleton preserves the pan');
    currentSkeleton = { ...skeletonB, id: 'sk-beta-renamed' };
    mounted.rerender();
    assert.equal(worldTransform(), afterSkeletonSwitch, 'switching only the skeleton ID resets the viewport to the fitted one');

    // Two components with identical layout bounds: the component choice alone must refit (the drawing size cannot tell).
    currentSkeleton = {
      id: 'sk-twins',
      nodes: [
        { id: 'a1', term: 'Alpha', meaning: 'one', attributes: ['x'], cards: [] },
        { id: 'a2', term: 'Bravo', meaning: 'two', attributes: ['y'], cards: [] },
        { id: 'b1', term: 'Charl', meaning: 'one', attributes: ['x'], cards: [] },
        { id: 'b2', term: 'Delta', meaning: 'two', attributes: ['y'], cards: [] },
      ],
      relations: [{ from: 'a2', to: 'a1', type: 'related' }, { from: 'b2', to: 'b1', type: 'related' }],
      sequences: [],
    };
    selected = null;
    mounted.rerender();
    const twinSelect = () => mounted.find((n) => typeof n.type === 'function' && n.props?.className === 'skc-search-select');
    const [firstTwin, secondTwin] = twinSelect().props.options.filter((opt) => opt.value);
    assert.ok(firstTwin && secondTwin, 'the twin skeleton offers two components');
    await mounted.act(() => twinSelect().props.onChange(firstTwin.value));
    const fittedFirstTwin = worldTransform();
    await panAndZoom();
    assert.notEqual(worldTransform(), fittedFirstTwin, 'pan/zoom moved the first twin');
    await mounted.act(() => twinSelect().props.onChange(secondTwin.value));
    assert.equal(worldTransform(), fittedFirstTwin, 'switching to an identically sized component refits the viewport');
  });
});

/* ---------- 3. ui/WrongBook.jsx: bounded concurrency + cache ---------- */

test('fetchWrongBookPage eliminates the 10x serial waterfall using bounded concurrency and preserves order', async () => {
  const { fetchWrongBookPage } = await loadUi(`
    export { fetchWrongBookPage } from './ui/WrongBook.jsx';
  `);

  const total = 950;
  let inFlight = 0;
  let maxConcurrent = 0;
  const calls = [];
  const call = async (action, args) => {
    assert.equal(action, 'wrongbook');
    calls.push(args);
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight -= 1;
    const count = Math.min(args.limit, Math.max(0, total - args.offset));
    return {
      view: args.view,
      total,
      items: Array.from({ length: count }, (_, i) => ({ cardId: `c${args.offset + i}`, deckId: 'd1' })),
    };
  };

  const res = await fetchWrongBookPage(call, { scope: { course: 'OS' }, view: 'weak', page: 0, concurrency: 4 });
  assert.equal(res.items.length, 950);
  assert.equal(res.items[0].cardId, 'c0');
  assert.equal(res.items[949].cardId, 'c949');
  assert.equal(calls.length, 10);
  assert.ok(maxConcurrent > 1 && maxConcurrent <= 4, `expected bounded concurrency 2..4, got ${maxConcurrent}`);

  // Stale guard aborts further fetches after first chunk.
  let stale = false;
  let staleCalls = 0;
  const staleRes = await fetchWrongBookPage(
    async (_action, args) => {
      staleCalls += 1;
      stale = true;
      return { total: 500, items: Array.from({ length: args.limit }, (_, i) => ({ cardId: `c${i}` })) };
    },
    { isStale: () => stale },
  );
  assert.equal(staleCalls, 1);
  assert.equal(staleRes.items.length, 100);
});

test('createWrongDetailLoader limits concurrency, deduplicates in-flight calls, caches hits, and retries errors', async () => {
  const { createWrongDetailLoader } = await loadUi(`
    export { createWrongDetailLoader } from './ui/WrongBook.jsx';
  `);

  let inFlight = 0;
  let maxConcurrent = 0;
  let rpcCount = 0;
  let failOnce = true;
  const loader = createWrongDetailLoader({
    concurrency: 3,
    call: async (_action, args) => {
      rpcCount += 1;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 8));
      inFlight -= 1;
      if (args.cardId === 'flaky' && failOnce) {
        failOnce = false;
        throw new Error('transient');
      }
      return { cardId: args.cardId, explanation: `exp-${args.cardId}` };
    },
  });

  // Burst of 10 unique cards + 2 duplicates of c0.
  const refs = [
    ...Array.from({ length: 10 }, (_, i) => `c${i}`),
    'c0',
    'c0',
  ];
  const results = await Promise.all(refs.map((id) => loader.load(`sig1\0weak\0d1\0${id}`, { deckId: 'd1', cardId: id })));
  assert.equal(results.length, 12);
  assert.equal(results[0].explanation, 'exp-c0');
  assert.equal(results[10], results[0], 'duplicate in-flight call shares the same result');
  assert.equal(rpcCount, 10, 'deduplicated 12 calls into 10 unique RPCs');
  assert.ok(maxConcurrent > 1 && maxConcurrent <= 3, `expected bounded concurrency 2..3, got ${maxConcurrent}`);

  // Cache hit serves immediately with 0 additional RPCs.
  const cached = await loader.load('sig1\0weak\0d1\0c3', { deckId: 'd1', cardId: 'c3' });
  assert.equal(cached.explanation, 'exp-c3');
  assert.equal(rpcCount, 10, 'cached detail served from memory');

  // Errors are not cached so retry succeeds.
  await assert.rejects(() => loader.load('sig1\0weak\0d1\0flaky', { deckId: 'd1', cardId: 'flaky' }), /transient/);
  const retried = await loader.load('sig1\0weak\0d1\0flaky', { deckId: 'd1', cardId: 'flaky' });
  assert.equal(retried.explanation, 'exp-flaky');
});

/* ---------- 4. ui/review/use-term-marking.js: single TreeWalker scan ---------- */

test('collectAllHighlightEntries scans the DOM with a single TreeWalker pass for active, seen, and candidate terms', async () => {
  const { collectAllHighlightEntries } = await loadUi(`
    export { collectAllHighlightEntries } from './ui/review/use-term-marking.js';
  `);

  const mkText = (data) => ({ nodeType: 3, data, parentElement: null });
  const mkEl = (tagName, { classes = [], attrs = {}, open = false, children = [] } = {}) => {
    const el = {
      nodeType: 1,
      tagName: tagName.toUpperCase(),
      open,
      childNodes: children,
      matches(selector) {
        return selector.split(',').map((s) => s.trim()).some((part) => {
          if (part.startsWith('.')) return classes.includes(part.slice(1));
          if (part === '[aria-hidden="true"]') return attrs['aria-hidden'] === 'true';
          if (part === 'button:not(.option)') return el.tagName === 'BUTTON' && !classes.includes('option');
          if (part === 'button.option') return el.tagName === 'BUTTON' && classes.includes('option');
          return el.tagName === part.toUpperCase();
        });
      },
      contains(target) {
        if (target === el) return true;
        for (const child of el.childNodes) {
          if (child === target) return true;
          if (child.nodeType === 1 && child.contains(target)) return true;
        }
        return false;
      },
    };
    for (const child of children) child.parentElement = el;
    return el;
  };

  // Tree with inline spans, inline <code>, fenced <pre><code>, excluded .katex / .md-code-head / closed <details>, and block breaks.
  const body = mkEl('div', {
    children: [
      mkEl('p', {
        children: [
          mkText('Check '),
          mkEl('span', { children: [mkText('Linear')] }),
          mkEl('span', { children: [mkText('izability')] }),
          mkText(' and Consensus'),
        ],
      }),
      mkEl('p', {
        children: [
          mkText('Split'),
          mkEl('span', { classes: ['katex'], children: [mkText('Linearizability')] }),
          mkText('Word and '),
          mkEl('code', { children: [mkText('idempotency')] }),
          mkText(' plus Idempotency'),
        ],
      }),
      mkEl('div', {
        classes: ['md-code-block'],
        children: [
          mkEl('div', {
            classes: ['md-code-head'],
            children: [mkEl('span', { classes: ['md-code-lang'], children: [mkText('Consensus')] })],
          }),
          mkEl('pre', {
            classes: ['md-code'],
            children: [mkEl('code', { children: [mkText('s3.intern();')] })],
          }),
        ],
      }),
      mkEl('details', { open: false, children: [mkText('Consensus hidden')] }),
      mkEl('p', { children: [mkText('LineA'), mkEl('br'), mkText('LineB')] }),
    ],
  });

  let walkerCalls = 0;
  const doc = {
    createRange() {
      const r = { startContainer: null, startOffset: 0, endContainer: null, endOffset: 0 };
      r.setStart = (n, o) => { r.startContainer = n; r.startOffset = o; };
      r.setEnd = (n, o) => { r.endContainer = n; r.endOffset = o; };
      return r;
    },
    createTreeWalker(root, _whatToShow, filter) {
      walkerCalls += 1;
      // Emulate TreeWalker streaming order by calling acceptNode lazily in nextNode.
      const stack = [...(root.childNodes || [])].reverse();
      return {
        nextNode() {
          while (stack.length) {
            const node = stack.pop();
            const verdict = filter.acceptNode(node);
            if (verdict === 2) continue;
            if (node.nodeType === 1 && node.childNodes?.length) {
              for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
            }
            if (verdict === 1) return node;
          }
          return null;
        },
      };
    },
  };

  const result = collectAllHighlightEntries(doc, body, {
    activeTerms: ['Linearizability', 'intern', 'SplitWord', 'LineALineB'],
    seenTerms: ['consensus'],
    candidateTerms: ['idempotency'],
  });

  assert.equal(walkerCalls, 1, 'all 3 highlight passes share exactly 1 TreeWalker DOM scan');
  assert.equal(result.active.ranges.length, 2, 'matches Linearizability across inline spans and intern inside <pre><code>, without gluing across .katex or <br>');
  assert.equal(result.seen.ranges.length, 1, 'matches Consensus case-insensitively and skips .md-code-head and closed <details>');
  assert.equal(result.cand.ranges.length, 2, 'matches Idempotency case-insensitively in both prose and inline <code>');
});

/* ---------- 5. ui/book/BookToc.jsx: retain search index on query clear ---------- */

test('BookToc builds searchIndex lazily once per book and retains it when clearing the search query', async () => {
  let indexBuilds = 0;
  const spySearchPlugin = {
    name: 'spy-book-search',
    setup(b) {
      b.onResolve({ filter: /^\.\/book-search\.js$/ }, (args) => {
        if (args.importer.endsWith('BookToc.jsx')) {
          return { path: 'spy-book-search', namespace: 'spy-book-search' };
        }
        return null;
      });
      b.onLoad({ filter: /.*/, namespace: 'spy-book-search' }, () => ({
        contents: `
          import * as real from './ui/book/book-search.js';
          export const SEARCH_ROWS = real.SEARCH_ROWS;
          export const searchBook = real.searchBook;
          export function searchIndex(book) {
            globalThis.__BOOK_INDEX_SPY__?.();
            return real.searchIndex(book);
          }
        `,
        resolveDir: process.cwd(),
        loader: 'js',
      }));
    },
  };

  const { exports: { default: BookToc }, runtime } = await loadWithTestHooks(
    `export { default } from './ui/book/BookToc.jsx';`,
    { resolvePlugins: [spySearchPlugin] },
  );

  const bookA = {
    status: 'ok',
    nodes: [{ hid: 'h1', number: '1', title: 'Transport Layer', gen: 'TCP uses three-way handshake and UDP is connectionless.', children: [] }],
  };
  const bookB = {
    status: 'ok',
    nodes: [{ hid: 'h2', number: '1', title: 'Application Layer', gen: 'DNS resolves domain names.', children: [] }],
  };
  const entries = [{ id: 'h1', level: 2, title: 'Transport Layer', chapter: 'h1' }];
  const baseProps = { entries, here: 'h1', onGo() {}, narrow: false, onClose() {}, onQuery() {}, onFound() {} };

  const prevSpy = globalThis.__BOOK_INDEX_SPY__;
  globalThis.__BOOK_INDEX_SPY__ = () => { indexBuilds += 1; };
  try {
    // 1. Initial empty query: lazy, no index built yet.
    runtime.render(() => BookToc({ ...baseProps, book: bookA, query: '' }));
    assert.equal(indexBuilds, 0, 'does not build index before first search');

    // 2. First search builds index once.
    runtime.render(() => BookToc({ ...baseProps, book: bookA, query: 'TCP' }));
    assert.equal(indexBuilds, 1, 'builds index on first search');

    // 3. Clearing search retains index (no rebuild).
    runtime.render(() => BookToc({ ...baseProps, book: bookA, query: '' }));
    assert.equal(indexBuilds, 1, 'clearing query keeps index');

    // 4. Searching again reuses retained index (still 1 build total!).
    runtime.render(() => BookToc({ ...baseProps, book: bookA, query: 'UDP' }));
    assert.equal(indexBuilds, 1, 'subsequent search after clear reuses retained index without rebuilding');

    // 5. Switching to a new book stays lazy when query is empty, then builds once on search.
    runtime.render(() => BookToc({ ...baseProps, book: bookB, query: '' }));
    assert.equal(indexBuilds, 1, 'new book stays lazy while query is empty');
    runtime.render(() => BookToc({ ...baseProps, book: bookB, query: 'DNS' }));
    assert.equal(indexBuilds, 2, 'new book builds its own index once on first search');
  } finally {
    runtime.reset();
    globalThis.__BOOK_INDEX_SPY__ = prevSpy;
  }
});

/* ---------- 6. ui/Draft.jsx: useDraftDirty avoids per-keystroke JSON.stringify + i18n ---------- */

test('useDraftDirty avoids synchronous JSON.stringify on every keystroke and reconciles after debounce', async () => {
  const { exports: { useDraftDirty }, runtime } = await loadWithTestHooks(`
    export { useDraftDirty } from './ui/Draft.jsx';
  `);

  const original = { id: 'd1', title: 'Algorithms', cards: [{ id: 'c1', prompt: 'What is Dijkstra?' }] };
  const draftLoaded = JSON.stringify(original);
  let draft = structuredClone(original);
  let draftText = JSON.stringify(original, null, 2);
  let jsonMode = false;

  const origStringify = JSON.stringify;
  let stringifyCount = 0;
  JSON.stringify = (...args) => {
    stringifyCount += 1;
    return origStringify(...args);
  };

  try {
    // 1. Initial mount checks baseline once.
    let unsaved = runtime.render(() => useDraftDirty({ draft, draftLoaded, draftText, jsonMode, debounceMs: 25 }));
    assert.equal(unsaved, false);
    assert.equal(stringifyCount, 1);

    // 2. Unrelated re-render with same draft object performs 0 JSON.stringify calls.
    unsaved = runtime.render(() => useDraftDirty({ draft, draftLoaded, draftText, jsonMode, debounceMs: 25 }));
    assert.equal(unsaved, false);
    assert.equal(stringifyCount, 1);

    // 3. Five rapid keystrokes in form mode mark dirty immediately with 0 synchronous JSON.stringify calls.
    for (let i = 1; i <= 5; i++) {
      draft = { ...original, title: `Algorithms ${i}` };
      unsaved = runtime.render(() => useDraftDirty({ draft, draftLoaded, draftText, jsonMode, debounceMs: 25 }));
      assert.equal(unsaved, true);
    }
    assert.equal(stringifyCount, 1, 'zero synchronous JSON.stringify calls during form keystrokes');

    // 4. Reverting back to original content reconciles to false after debounce.
    draft = structuredClone(original);
    unsaved = runtime.render(() => useDraftDirty({ draft, draftLoaded, draftText, jsonMode, debounceMs: 25 }));
    assert.equal(unsaved, true, 'optimistically dirty before debounce fires');
    assert.equal(stringifyCount, 1);

    await new Promise((r) => setTimeout(r, 45));
    unsaved = runtime.render(() => useDraftDirty({ draft, draftLoaded, draftText, jsonMode, debounceMs: 25 }));
    assert.equal(unsaved, false, 'debounced reconciliation clears dirty flag when reverted to saved content');
    assert.equal(stringifyCount, 2, 'only 1 debounced JSON.stringify ran after typing paused');

    // 5. Entering JSON mode memoizes pretty JSON once; typing 5 times in textarea does 0 JSON.stringify calls.
    jsonMode = true;
    unsaved = runtime.render(() => useDraftDirty({ draft, draftLoaded, draftText, jsonMode, debounceMs: 25 }));
    assert.equal(unsaved, false);
    const afterEnterJson = stringifyCount;
    for (let i = 1; i <= 5; i++) {
      draftText = `${draftText} `;
      unsaved = runtime.render(() => useDraftDirty({ draft, draftLoaded, draftText, jsonMode, debounceMs: 25 }));
      assert.equal(unsaved, true);
    }
    assert.equal(stringifyCount, afterEnterJson, 'zero JSON.stringify calls during JSON textarea keystrokes');
  } finally {
    runtime.reset();
    JSON.stringify = origStringify;
  }

  // Verify missing i18n toast strings in ui/Draft.jsx are now localized via uiFormat.
  const draftSrc = await readFile(new URL('../ui/Draft.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(draftSrc, /toast\.error\(\s*["']JSON 格式不正确：["']\s*\+/);
});
