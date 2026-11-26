/* Wave-1 Batch F behavioral & CSS guardrail tests (W1-09, W1-12, W1-13, W1-21, W1-22, W1-33).
   Note on static CSS guardrails below: Node has no CSS selector/pseudo-class/container-query
   engine to evaluate `:hover:not(:disabled):not([aria-disabled="true"])` (components.css / overlays.css)
   or `@container study (max-width: 640px)` `:is()` vs `:where()` specificity (wrongbook.css), so those
   two CSS invariants intentionally use static stylesheet inspection. All JS/JSX component behaviors
   (DesktopOpenAiForm, ExtensionPanel single-flight shared store, MineruInstallCard chooseHere,
   Graph mastery fullscreen demotion & single-flight practice locking, MasteryMap busy locking,
   and layoutPath bezier geometry) are exercised dynamically at runtime. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const h = React.createElement;
const noop = () => {};

const m = await loadUi(`
  export { setUiLanguage } from './ui/i18n.js';
  export { createDesktopConfigActions } from './ui/desktop/DesktopModelSetup.jsx';
  export { default as DesktopOpenAiForm } from './ui/desktop/DesktopOpenAiForm.jsx';
  export { default as ExtensionPanel, resetExtensionInstallStore } from './ui/ExtensionPanel.jsx';
  export { default as Graph } from './ui/Graph.jsx';
  export { default as MasteryMap } from './ui/mastery-map/MasteryMap.jsx';
  export { bez, layoutPath, pathPrereqPath } from './ui/graph-layout.js';
  export { sketchOrderCurve, sketchCubicPath } from './ui/graph-sketch/graph-sketch.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
`);

/** Minimal stateful React runtime for mounting UI components and firing interactive handlers in Node. */
async function createStatefulUi(entryCode) {
  const contexts = new Map();
  let currentInst = null;
  let cursor = 0;
  let idSeq = 0;

  const depsSame = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const miniReact = {
    Fragment: Symbol.for('react.fragment'),
    Suspense: Symbol.for('react.suspense'),
    Component: class Component { constructor(props) { this.props = props; this.state = {}; } },
    useInsertionEffect() {},
    lazy(load) { return { $$lazy: true, load }; },
    createContext(defaultValue) {
      const ctx = { _default: defaultValue };
      ctx.Provider = ({ value, children }) => ({ $$provider: ctx, value, children });
      return ctx;
    },
    createElement(type, props, ...children) {
      const p = props ? { ...props } : {};
      if (children.length === 1) p.children = children[0];
      else if (children.length > 1) p.children = children;
      return { type, props: p };
    },
    memo(fn) { return { $$memo: true, type: fn }; },
    forwardRef(fn) { return { $$forwardRef: true, render: fn }; },
    useContext(ctx) {
      const stack = contexts.get(ctx);
      return stack && stack.length ? stack[stack.length - 1] : ctx._default;
    },
    useId() {
      const inst = currentInst;
      const idx = cursor++;
      if (!(idx in inst.slots)) inst.slots[idx] = `:r${++idSeq}:`;
      return inst.slots[idx];
    },
    useState(init) {
      const inst = currentInst;
      const idx = cursor++;
      if (!(idx in inst.slots)) inst.slots[idx] = typeof init === 'function' ? init() : init;
      const setState = (next) => {
        const prev = inst.slots[idx];
        const value = typeof next === 'function' ? next(prev) : next;
        if (!Object.is(prev, value)) {
          inst.slots[idx] = value;
          inst.render();
        }
      };
      return [inst.slots[idx], setState];
    },
    useRef(init) {
      const inst = currentInst;
      const idx = cursor++;
      if (!(idx in inst.slots)) inst.slots[idx] = { current: init };
      return inst.slots[idx];
    },
    useCallback(fn, deps) {
      const inst = currentInst;
      const idx = cursor++;
      const prev = inst.slots[idx];
      if (!prev || !depsSame(prev.deps, deps)) inst.slots[idx] = { fn, deps };
      return inst.slots[idx].fn;
    },
    useMemo(fn, deps) {
      const inst = currentInst;
      const idx = cursor++;
      const prev = inst.slots[idx];
      if (!prev || !depsSame(prev.deps, deps)) inst.slots[idx] = { value: fn(), deps };
      return inst.slots[idx].value;
    },
    useEffect(fn, deps) {
      const inst = currentInst;
      const idx = cursor++;
      const prev = inst.effects[idx];
      if (!prev || !deps || !depsSame(prev.deps, deps)) {
        inst.pendingEffects.push({ idx, fn, deps });
      }
    },
    useLayoutEffect(fn, deps) { miniReact.useEffect(fn, deps); },
    useSyncExternalStore(subscribe, getSnapshot) {
      const inst = currentInst;
      const idx = cursor++;
      if (!(idx in inst.slots)) {
        const entry = {
          value: getSnapshot(),
          unsub: subscribe(() => {
            const next = getSnapshot();
            if (!Object.is(entry.value, next)) {
              entry.value = next;
              inst.render();
            }
          }),
        };
        inst.slots[idx] = entry;
      } else {
        inst.slots[idx].value = getSnapshot();
      }
      return inst.slots[idx].value;
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
    plugins: [nativeSelects],
    loader: { '.css': 'text' },
    logLevel: 'silent',
  });
  const modObj = { exports: {} };
  const customRequire = (id) => (id === 'react' ? miniReact : require(id));
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(customRequire, modObj, modObj.exports);

  function mount(Component, props = {}, contextValues = []) {
    const fn = Component?.$$memo ? Component.type : Component;
    const inst = {
      slots: [],
      effects: [],
      pendingEffects: [],
      tree: null,
      render() {
        for (const [ctx, val] of contextValues) {
          if (!contexts.has(ctx)) contexts.set(ctx, []);
          contexts.get(ctx).push(val);
        }
        const prevInst = currentInst;
        const prevCursor = cursor;
        currentInst = inst;
        cursor = 0;
        try {
          inst.tree = fn(props);
        } finally {
          currentInst = prevInst;
          cursor = prevCursor;
          for (const [ctx] of contextValues) contexts.get(ctx).pop();
        }
        const queue = inst.pendingEffects.splice(0);
        for (const item of queue) {
          inst.effects[item.idx]?.cleanup?.();
          const cleanup = item.fn();
          inst.effects[item.idx] = { deps: item.deps, cleanup: typeof cleanup === 'function' ? cleanup : null };
        }
        return inst.tree;
      },
      unmount() {
        for (const eff of inst.effects) eff?.cleanup?.();
        for (const slot of inst.slots) slot?.unsub?.();
      },
    };
    inst.render();
    return inst;
  }

  return { exports: modObj.exports, mount };
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  if (node.props?.children !== undefined) findAll(node.props.children, predicate, out);
  return out;
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && node.props?.children !== undefined) return textOf(node.props.children);
  return '';
}

const withServices = (node, services = {}) => h(m.StudyServicesContext.Provider, {
  value: {
    call: async () => ({}),
    act: async () => undefined,
    busy: false,
    notify: noop,
    askInChat: noop,
    host: {},
    openSettings: noop,
    navigate: noop,
    openModal: noop,
    ...services,
  },
}, node);

/* ---------- W1-09: Desktop API Key single error & single primary CTA ---------- */

test('W1-09: createDesktopConfigActions avoids duplicate parent error on saveOpenAi, handles endpoint save cleanly, and DesktopOpenAiForm never renders dual primary buttons', async () => {
  m.setUiLanguage('zh');
  let parentError = 'stale error';
  const actions = m.createDesktopConfigActions({
    call: async (op) => {
      if (op === 'desktop.config.save') throw new Error('Invalid API key');
      return { ok: true };
    },
    refresh: async () => {},
    setConfig: noop,
    setError: (msg) => { parentError = msg; },
    setWorking: noop,
  });

  // saveOpenAi (SecretKeyForm path): clears parent error and rethrows without setting duplicate parent error
  await assert.rejects(() => actions.saveOpenAi({ apiKey: 'bad' }), /Invalid API key/);
  assert.equal(parentError, '', 'SecretKeyForm owns saveOpenAi error; parent error stays cleared');

  // saveOpenAiEndpoint: catches error into parentError without unhandled rejection
  const endpointRes = await actions.saveOpenAiEndpoint({ baseUrl: 'bad', model: 'm' });
  assert.equal(endpointRes, null);
  assert.match(parentError, /Invalid API key/);

  // testOpenAi clears stale parent error
  await actions.testOpenAi({});
  assert.equal(parentError, '', 'testOpenAi clears stale parent error');

  // DesktopOpenAiForm: when endpoint save action is shown (hasKey && !active), SecretKeyForm demotes to secondary -> single primary button
  const html = renderToStaticMarkup(h(m.DesktopOpenAiForm, {
    openai: { hasKey: true, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyLast4: '1234' },
    active: false,
    actions,
    working: '',
  }));
  const primaries = html.match(/sh-btn--primary/g) || [];
  assert.equal(primaries.length, 1, `expected single primary CTA when switching provider/mode, got ${primaries.length}`);
});

/* ---------- W1-13: ExtensionPanel shared single-flight store & single primary button ---------- */

test('W1-13: ExtensionPanel demotes IndexBuilder when outdated update primary is shown and shares single-flight install state across mounts', async () => {
  m.setUiLanguage('zh');
  m.resetExtensionInstallStore();
  const status = {
    extension: { installed: true, outdated: true, canInstall: true, version: '0.1.0', expected: '0.2.0', desktopHost: true },
    companion: { running: true },
  };
  const html = renderToStaticMarkup(withServices(h(m.ExtensionPanel, {
    status,
    courses: [{ name: 'OS' }],
    initialPlan: { course: 'OS', pages: 10, toIndex: 10, toRemove: 0, canIndex: true },
  })));
  const primaries = html.match(/sh-btn--primary/g) || [];
  assert.equal(primaries.length, 1, `expected single primary CTA (update notice only, IndexBuilder demoted), got ${primaries.length}`);

  // Behavioral test: two simultaneous mounts share external store state and dedupe concurrent install requests.
  const ui = await createStatefulUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { default as ExtensionPanel, ExtensionUpdateNotice, resetExtensionInstallStore } from './ui/ExtensionPanel.jsx';
    export { Button } from './ui/components/index.js';
  `);
  ui.exports.setUiLanguage('zh');
  ui.exports.resetExtensionInstallStore();

  let installCalls = 0;
  let resolveInstall;
  const call = async (op) => {
    if (op === 'retrieval.extension.install') {
      installCalls += 1;
      return new Promise((res) => { resolveInstall = res; });
    }
    return {};
  };
  const ctxVal = { call, act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
  const noticeA = ui.mount(ui.exports.ExtensionUpdateNotice, { status }, [[ui.exports.StudyServicesContext, ctxVal]]);
  const noticeB = ui.mount(ui.exports.ExtensionUpdateNotice, { status }, [[ui.exports.StudyServicesContext, ctxVal]]);
  try {
    const getUpdateBtn = (inst) => findAll(inst.tree, (el) => el.type === ui.exports.Button && /更新检索扩展|正在更新/.test(textOf(el)))[0];
    assert.equal(getUpdateBtn(noticeA).props.busy, false);
    assert.equal(getUpdateBtn(noticeB).props.busy, false);

    // Click mount A -> BOTH mount A and mount B enter busy state via shared store.
    const p1 = getUpdateBtn(noticeA).props.onClick();
    assert.equal(installCalls, 1, 'starts one install flight');
    assert.equal(getUpdateBtn(noticeA).props.busy, true, 'mount A reflects busy state');
    assert.equal(getUpdateBtn(noticeB).props.busy, true, 'mount B shares busy state across mounts');

    // Concurrent trigger from mount B while in-flight is deduplicated to the same promise.
    const p2 = getUpdateBtn(noticeB).props.onClick();
    assert.equal(installCalls, 1, 'concurrent install trigger must dedupe to a single flight');

    resolveInstall({ ok: true, restartRequired: false, status: { ...status, extension: { ...status.extension, outdated: false, version: '0.2.0' } } });
    await Promise.all([p1, p2]);
    assert.match(textOf(noticeA.tree), /已更新/, 'mount A transitions to updated state');
    assert.match(textOf(noticeB.tree), /已更新/, 'mount B also transitions to updated state via shared store');
  } finally {
    noticeA.unmount();
    noticeB.unmount();
    ui.exports.resetExtensionInstallStore();
  }
});

/* ---------- W1-21: MineruInstallCard chooseHere echoes folder/blocking & aria-disabled CSS flat ---------- */

test('W1-21: MineruInstallCard chooseHere renders folder & blocking error, and components.css unifies aria-disabled without hover lift', async () => {
  const ui = await createStatefulUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { default as MineruInstallCard } from './ui/MineruInstallCard.jsx';
    export { Button, InlineMessage } from './ui/components/index.js';
  `);
  ui.exports.setUiLanguage('zh');
  const ctxVal = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
  const card = ui.mount(
    ui.exports.MineruInstallCard,
    {
      call: async () => ({}),
      initialLocal: {
        state: 'error',
        origin: 'install',
        install: {
          status: 'failed',
          folder: '/tmp/mineru-old',
          tier: 'basic',
          error: { code: 'no-space' },
        },
      },
      initialPlan: {
        folder: '/tmp/mineru-pick',
        defaultFolder: '/tmp/mineru-pick',
        tier: 'basic',
        estimate: { downloadMb: 800, minutes: [3, 5] },
        disk: { neededMb: 2000 },
        source: { id: 'mainland', reason: 'faster' },
        problems: [{ code: 'no-space', message: '目标磁盘剩余空间不足' }],
      },
    },
    [[ui.exports.StudyServicesContext, ctxVal]],
  );
  try {
    // Open the chooseHere location picker by clicking the relocate fix button ("换位置").
    const relocateBtn = findAll(card.tree, (el) => el.type === ui.exports.Button && /换位置/.test(textOf(el)))[0];
    assert.ok(relocateBtn, 'failed no-space install offers relocate fix button');
    relocateBtn.props.onClick();

    const whereEl = findAll(card.tree, (el) => el.props?.className === 'mineru-install__where')[0];
    assert.ok(whereEl, 'chooseHere renders .mineru-install__where');
    assert.match(textOf(whereEl), /\/tmp\/mineru-(?:pick|old)/, 'chooseHere echoes selected folder');

    const factsEl = findAll(card.tree, (el) => el.props?.className === 'mineru-install__facts')[0];
    assert.ok(factsEl, 'chooseHere renders .mineru-install__facts');
    assert.match(textOf(factsEl), /下载约|占用约/, 'chooseHere displays disk space / download facts');

    const errMsg = findAll(card.tree, (el) => el.type === ui.exports.InlineMessage && el.props?.tone === 'error')[0];
    assert.ok(errMsg, 'chooseHere renders blocking InlineMessage tone="error"');
    assert.match(textOf(errMsg), /目标磁盘剩余空间不足/);
  } finally {
    card.unmount();
  }

  const compCss = await readFile(new URL('../ui/components/components.css', import.meta.url), 'utf8');
  assert.match(compCss, /\.sh-btn:hover:not\(:disabled\):not\(\[aria-disabled="true"\]\)/);
  assert.match(compCss, /\.sh-btn--primary:hover:not\(:disabled\):not\(\[aria-disabled="true"\]\)/);
  assert.match(compCss, /\.sh-btn--primary\[aria-disabled="true"\]/);
  const overlaysCss = await readFile(new URL('../ui/components/overlays.css', import.meta.url), 'utf8');
  assert.doesNotMatch(overlaysCss, /\.sh-btn\[aria-disabled="true"\]/, 'duplicate aria-disabled style removed from overlays.css');
});

/* ---------- W1-22: Graph mastery mode demotes FullscreenButton & locks practiseOutlineKeys ---------- */

test('W1-22: Graph demotes FullscreenButton in mastery mode and guards practiseOutlineKeys with single-flight locking + MasteryMap busy prop', async () => {
  m.setUiLanguage('zh');
  const library = {
    root: '/tmp/lib',
    focus: { course: 'OS', courses: ['OS'] },
    decks: [{ id: 'd1', title: 'OS Ch1', course: 'OS', cards: [{ id: 'c1', topic: 'Paging' }] }],
    progress: {},
  };
  const outline = {
    course: 'OS',
    chapters: [{
      key: 'ch1',
      title: 'Memory',
      points: [
        { key: 'p1', title: 'Paging', total: 2, learned: 1, weak: 1, mastery: 30, state: 'weak' },
        { key: 'p2', title: 'TLB', total: 0, learned: 0, weak: 0, mastery: 0, state: 'uncovered' },
      ],
    }],
  };

  // 1) Structure mode keeps FullscreenButton primary; mastery mode demotes it to secondary.
  const structHtml = renderToStaticMarkup(withServices(h(m.Graph, {
    library,
    defaultMode: 'structure',
    initialData: { mode: 'structure', nodes: [], edges: [] },
    onClose: noop,
  })));
  assert.match(structHtml, /sh-btn--primary[^"]*canvas-fs-btn|canvas-fs-btn[^"]*sh-btn--primary|sh-btn--primary[^>]*>[\s\S]*?全屏/, 'structure mode FullscreenButton is primary');

  const masteryHtml = renderToStaticMarkup(withServices(h(m.Graph, {
    library,
    defaultMode: 'mastery',
    initialOutline: outline,
    onClose: noop,
  })));
  assert.doesNotMatch(masteryHtml, /sh-btn--primary[^>]*>[\s\S]*?全屏/, 'mastery mode FullscreenButton must not be primary');
  assert.match(masteryHtml, /sh-btn--secondary[^>]*>[\s\S]*?全屏/, 'mastery mode demotes FullscreenButton to secondary');

  // 2) MasteryMap locks practice/gapfill buttons when practising={true} even if studyBusy is false.
  const mapProgress = {
    d1: { total: 2, learned: 1, mastery: 30, weak: 1, due: 1 },
  };
  const mapDecks = [
    { id: 'd1', title: 'OS Ch1', course: 'OS', cards: [{ id: 'c1', topic: 'Paging' }, { id: 'c2', topic: 'TLB' }] },
    { id: 'd2', title: 'OS Ch2', course: 'OS', cards: [] },
  ];
  const idleMapHtml = renderToStaticMarkup(withServices(h(m.MasteryMap, {
    outline: null,
    decks: mapDecks,
    progress: mapProgress,
    course: 'OS',
    onPracticeWeakAll: noop,
    onGoGenerate: noop,
    practising: false,
  }), { busy: false }));
  assert.match(idleMapHtml, /data-mm-practice-weak/);
  assert.doesNotMatch(idleMapHtml, /disabled=""[^>]*data-mm-practice-weak|data-mm-practice-weak[^>]*disabled=""/);
  assert.doesNotMatch(idleMapHtml, /disabled=""[^>]*data-mm-gapfill-all|data-mm-gapfill-all[^>]*disabled=""/);

  const busyMapHtml = renderToStaticMarkup(withServices(h(m.MasteryMap, {
    outline: null,
    decks: mapDecks,
    progress: mapProgress,
    course: 'OS',
    onPracticeWeakAll: noop,
    onGoGenerate: noop,
    practising: true,
  }), { busy: false }));
  assert.match(busyMapHtml, /disabled=""[^>]*data-mm-practice-weak|data-mm-practice-weak[^>]*disabled=""/, 'MasteryMap locks weak-practice button when practising=true');
  assert.match(busyMapHtml, /disabled=""[^>]*data-mm-gapfill-all|data-mm-gapfill-all[^>]*disabled=""/, 'MasteryMap locks gapfill button when practising=true');

  // 3) Graph.practiseOutlineKeys enforces single-flight ref and passes practising={true} to MasteryMap while in-flight.
  const origDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      addEventListener: noop,
      removeEventListener: noop,
      fullscreenElement: null,
      head: { appendChild: noop },
      querySelector: () => null,
      createElement: () => ({ setAttribute: noop, textContent: '' }),
    },
  });
  const ui = await createStatefulUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { default as Graph } from './ui/Graph.jsx';
    export { default as MasteryMap } from './ui/mastery-map/MasteryMap.jsx';
  `);
  ui.exports.setUiLanguage('zh');
  let pickCalls = 0;
  let resolvePick;
  const practicedScopes = [];
  const ctxVal = {
    call: async (op, args) => {
      if (op === 'course.outline' && args?.pick) {
        pickCalls += 1;
        return new Promise((res) => { resolvePick = res; });
      }
      return {};
    },
    act: async () => undefined,
    busy: false,
    notify: noop,
    askInChat: noop,
    host: {},
    openSettings: noop,
    navigate: noop,
    openModal: noop,
  };
  const graphInst = ui.mount(
    ui.exports.Graph,
    {
      library,
      defaultMode: 'mastery',
      initialOutline: outline,
      onClose: noop,
      onPracticeScope: (sc) => practicedScopes.push(sc),
    },
    [[ui.exports.StudyServicesContext, ctxVal]],
  );
  try {
    const getMap = () => findAll(graphInst.tree, (el) => el.type === ui.exports.MasteryMap)[0];
    assert.equal(getMap().props.practising, false);

    // Fire two concurrent practice clicks: second must be blocked by single-flight ref.
    getMap().props.onPracticeWeakAll({ keys: ['p1'] });
    assert.equal(pickCalls, 1, 'starts one outline pick request');
    assert.equal(getMap().props.practising, true, 'passes practising=true to MasteryMap while in-flight');

    getMap().props.onPracticeWeakAll({ keys: ['p1'] });
    assert.equal(pickCalls, 1, 'concurrent practiseOutlineKeys call is ignored while in-flight');

    resolvePick({ practice: { scope: [{ deckId: 'd1', topic: 'Paging' }] } });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(practicedScopes.length, 1, 'invokes onPracticeScope once after pick resolves');
    assert.equal(getMap().props.practising, false, 'clears practising flag after completion');
  } finally {
    graphInst.unmount();
    if (origDoc) Object.defineProperty(globalThis, 'document', origDoc);
    else delete globalThis.document;
  }
});

/* ---------- W1-33: Serpentine even-row arrows point left & same-row prereqs arch cleanly ---------- */

test('W1-33: layoutPath even-row curves travel right-to-left inside the gap and pathPrereqPath avoids cutting across cards', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `c:${i + 1}`, label: `Q${i + 1}` }));
  const layout = m.layoutPath(nodes, [], 6);
  // Node index 6 (step 7, row 1 col 5) -> index 7 (step 8, row 1 col 4): right-to-left on even row (0-indexed row 1)
  const a = layout.placed[6];
  const b = layout.placed[7];
  assert.ok(a.x > b.x, 'even row steps go right to left');
  const d = layout.orderPaths[6];
  const match = /^M\s*([-\d.]+)\s+([-\d.]+)\s+C\s*([-\d.]+)\s+([-\d.]+),\s*([-\d.]+)\s+([-\d.]+),\s*([-\d.]+)\s+([-\d.]+)$/.exec(d);
  assert.ok(match, `expected cubic bezier path, got: ${d}`);
  const [, x1, , cx1, , cx2, , x2] = match.map(Number);
  assert.equal(x1, a.x, 'starts at left edge of right card');
  assert.equal(x2, b.x + b.w, 'ends at right edge of left card');
  assert.ok(cx1 < x1, `first control point (${cx1}) must head left from x1 (${x1}), not fold back into card a`);
  assert.ok(cx2 > x2, `second control point (${cx2}) must approach x2 (${x2}) from the right so arrow tangent points LEFT`);

  // Same-row prereq skipping intermediate cards (step 7 col 5 -> step 10 col 2) arches cleanly above the row
  const farLeft = layout.placed[9];
  const prereqD = m.pathPrereqPath(a, farLeft);
  const pm = /^M\s*([-\d.]+)\s+([-\d.]+)\s+C\s*([-\d.]+)\s+([-\d.]+),\s*([-\d.]+)\s+([-\d.]+),\s*([-\d.]+)\s+([-\d.]+)$/.exec(prereqD);
  assert.ok(pm, `expected cubic arch for skipping same-row prereq, got: ${prereqD}`);
  const [, px1, py1, , pcy1, , pcy2, px2, py2] = pm.map(Number);
  assert.equal(py1, a.y - a.h / 2, 'leaves top edge of card');
  assert.equal(py2, farLeft.y - farLeft.h / 2, 'arrives at top edge of target card');
  assert.ok(pcy1 < py1 && pcy2 < py2, 'arches above the row rather than cutting across intermediate cards');
  assert.ok(pcy1 >= 0 && pcy2 >= 0, 'stays inside SVG top canvas bounds');
  assert.ok(px1 > px2);

  // Structure-mode default bez(x1, y1, x2, y2) with x2 < x1 preserves dir = +1 (right-out, left-in)
  const structD = m.bez(300, 100, 100, 200);
  assert.match(structD, /^M 300 100 C 390 100, 10 200, 100 200$/, 'default bez keeps right-out left-in for structure vertical prereqs');
});

/* ---------- W1-12: wrongbook.css narrow container rules use :is() specificity ---------- */

test('W1-12: wrongbook.css narrow viewport rules use :is(.study-app, .study-seat) instead of zero-specificity :where()', async () => {
  const css = await readFile(new URL('../ui/wrongbook.css', import.meta.url), 'utf8');
  const narrowSection = css.slice(css.indexOf('@container study (max-width: 640px)'));
  assert.doesNotMatch(narrowSection, /:where\(\.study-app, \.study-seat\)/, 'must not use zero-specificity :where() in narrow container block');
  assert.match(narrowSection, /\.wb-retrain-copy small \{ white-space: normal; \}/);
  assert.match(narrowSection, /\.wb-rec-line \.wb-why \{/);
  assert.match(narrowSection, /\.wb-rec-line \.wb-why-tip \{ flex: 1 1 100%; \}/);
  assert.match(narrowSection, /\.wb-row-toggle \{ flex-wrap: wrap; align-items: center; \}/);
});
