import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMathAst } from '../lib/companion-template/math-eval.js';
import {
  buildCurve1DPath,
  detectDiscontinuity1D,
  evalAst,
} from '../lib/companion-template/runtime/math-sandbox.js';
import {
  COMPANION_PROTOCOL,
  createCompanionBridge,
} from '../lib/companion-template/runtime/bridge.js';
import {
  LESSON_TEMPLATE_RUNTIME_JS,
  RUNTIME_MODULE_FILES,
  buildLessonTemplateRuntimeJs,
} from '../lib/companion-template/template-runtime.js';
import { loadUi } from './helpers/ui-module.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const { createCompanionChannel, framedDocument } = await loadUi(`
  export { createCompanionChannel, framedDocument } from './ui/diagram-frame.js';
`);

const CJK_RE = /[\u3400-\u9fff]/;

function plotSampled1D(expr, { min, max, steps = 161, yMin = -10, yMax = 10 }) {
  const ast = parseMathAst(expr);
  const evalFn = (x) => evalAst(ast, { x });
  const Lp = 50, pw = 472, Tp = 16, ph = 216;
  const px = (x) => Lp + ((Math.min(max, Math.max(min, x)) - min) / Math.max(1e-9, max - min)) * pw;
  const pyCurve = (y) => {
    const raw = Tp + ph - ((y - yMin) / Math.max(1e-9, yMax - yMin)) * ph;
    return Math.min(Tp + ph * 3.5, Math.max(Tp - ph * 2.5, raw));
  };
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const x = min + ((max - min) * i) / steps;
    const y = evalFn(x);
    pts.push({ x, y: Number.isFinite(y) ? y : null, u: x });
  }
  const built = buildCurve1DPath(evalFn, { pts, yMin, yMax, px, pyCurve });
  return { ...built, Tp, ph };
}

function hasVerticalCrossingLine(commands, Tp, ph) {
  let prev = null;
  for (const cmd of commands) {
    const type = cmd[0];
    const [xStr, yStr] = cmd.slice(1).trim().split(/\s+/);
    const pt = { x: Number(xStr), y: Number(yStr) };
    if (type === 'L' && prev) {
      const dx = Math.abs(pt.x - prev.x);
      const dy = Math.abs(pt.y - prev.y);
      const crossesFullPlot = (prev.y <= Tp + 4 && pt.y >= Tp + ph - 4) || (prev.y >= Tp + ph - 4 && pt.y <= Tp + 4);
      if (crossesFullPlot && dx < 12 && dy > ph * 0.9) return true;
    }
    prev = pt;
  }
  return false;
}

/* ---------- 1. Modular runtime assembly ---------- */

test('template-runtime assembles real modular JS files cleanly, strips ESM syntax, and boots both zh and en IIFE bundles', async () => {
  assert.ok(RUNTIME_MODULE_FILES.length >= 6, 'runtime should be split across modular files');

  const zhBundle = buildLessonTemplateRuntimeJs('zh');
  const enBundle = buildLessonTemplateRuntimeJs('en');
  assert.equal(zhBundle, LESSON_TEMPLATE_RUNTIME_JS, 'zh bundle matches exported LESSON_TEMPLATE_RUNTIME_JS');
  assert.ok(enBundle.length < LESSON_TEMPLATE_RUNTIME_JS.length, 'en bundle omits Chinese tables and is strictly shorter');

  let zhResidual = zhBundle;
  let enResidual = enBundle;
  for (const file of RUNTIME_MODULE_FILES) {
    const src = await readFile(join(repoRoot, 'lib/companion-template/runtime', file), 'utf8');
    const stripped = src
      .replace(/\r\n/g, '\n')
      .replace(/^import\s+(?:[\s\S]*?)\s+from\s+['"][^'"]+['"];?\n?/gm, '')
      .replace(/^export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm, '')
      .trim();
    assert.ok(stripped.length > 50, `module ${file} must contain real code`);
    assert.equal(zhBundle.includes(stripped), true, `zh bundle must assemble current stripped source of runtime/${file}`);
    zhResidual = zhResidual.replace(stripped, '');
    if (file === 'i18n-zh.js') {
      assert.equal(enBundle.includes(stripped), false, 'en bundle must omit runtime/i18n-zh.js');
    } else {
      assert.equal(enBundle.includes(stripped), true, `en bundle must assemble current stripped source of runtime/${file}`);
      enResidual = enResidual.replace(stripped, '');
    }
  }
  assert.ok(zhResidual.trim().length < 120, `zh bundle must only wrap ./runtime/*.js modules (residual ${zhResidual.trim().length} chars)`);
  assert.ok(enResidual.trim().length < 200, `en bundle must only wrap ./runtime/*.js modules plus en stubs (residual ${enResidual.trim().length} chars)`);

  for (const [label, bundle] of [['zh', zhBundle], ['en', enBundle]]) {
    assert.doesNotThrow(() => new vm.Script(bundle), `${label} bundle must parse as valid JS`);
    assert.ok(!/<\/script/i.test(bundle), `${label} bundle must not contain raw </script`);
    assert.doesNotMatch(bundle, /^\s*import\s+[\s\S]*?\s+from\s+['"]/m, `${label} bundle must strip top-level ESM imports`);
    assert.doesNotMatch(bundle, /^\s*export\s+(?:(?:async\s+)?function|const|let|var|class)\b/m, `${label} bundle must strip top-level ESM exports`);
  }
  assert.ok(!/https?:\/\/(?!www\.w3\.org\/)/i.test(LESSON_TEMPLATE_RUNTIME_JS), 'runtime must stay 100% offline with zero external URLs');
  assert.ok(!CJK_RE.test(enBundle), 'English runtime bundle must contain zero Han characters');

  const makeStubEl = (tag = 'div') => ({
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    hidden: false,
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    isConnected: false,
    offsetWidth: 0,
    offsetHeight: 0,
    scrollTop: 0,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    removeEventListener() {},
    append(...kids) { this.children.push(...kids); },
    prepend(...kids) { this.children.unshift(...kids); },
    replaceChildren(...kids) { this.children = [...kids]; },
    insertBefore(node) { return node; },
    remove() {},
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    scrollIntoView() {},
  });

  for (const [lang, bundle] of [['zh', zhBundle], ['en', enBundle]]) {
    const token = `tok-boot-${lang}`;
    const posted = [];
    const lessonPayload = {
      id: `lesson-${lang}`,
      title: lang === 'en' ? 'Consensus Intro' : '共识入门',
      language: lang,
      beats: [{ id: 'intro', label: lang === 'en' ? 'Intro' : '引入' }],
      slides: [{
        title: lang === 'en' ? 'Slide 1' : '第 1 页',
        beat: 'intro',
        blocks: [{ t: 'text', md: 'Hello **world**' }],
      }],
    };
    const bootPayload = {
      channelToken: token,
      theme: 'light',
      askLabel: lang === 'en' ? 'Ask' : '提问',
      selectionLabel: lang === 'en' ? 'Ask selection' : '问选中内容',
    };
    const countParent = makeStubEl('div');
    const countEl = makeStubEl('span');
    countEl.parentNode = countParent;
    const byId = new Map([
      ['lesson-data', { textContent: JSON.stringify(lessonPayload) }],
      ['sh-companion-boot', { textContent: JSON.stringify(bootPayload) }],
      ['stage', makeStubEl('main')],
      ['line', makeStubEl('p')],
      ['key', makeStubEl('p')],
      ['prev', makeStubEl('button')],
      ['next', makeStubEl('button')],
      ['count', countEl],
      ['notes', makeStubEl('button')],
      ['notes-list', makeStubEl('ul')],
      ['beats', makeStubEl('nav')],
      ['title', makeStubEl('h1')],
      ['theme', makeStubEl('button')],
    ]);
    const topTools = makeStubEl('div');
    const voice = makeStubEl('section');
    const doc = {
      body: makeStubEl('body'),
      documentElement: makeStubEl('html'),
      getElementById: (id) => byId.get(id) ?? null,
      querySelector: (sel) => (sel === '.top__tools' ? topTools : sel === '.voice' ? voice : null),
      querySelectorAll: () => [],
      createElement: (tag) => makeStubEl(tag),
      createElementNS: (_ns, tag) => makeStubEl(tag),
      createDocumentFragment: () => makeStubEl('fragment'),
      createTextNode: (text) => ({ textContent: String(text) }),
      addEventListener() {},
      removeEventListener() {},
    };
    const win = {
      innerWidth: 1024,
      innerHeight: 768,
      parent: { postMessage(msg) { posted.push(msg); } },
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: false }),
      getSelection: () => ({ toString: () => '', rangeCount: 0 }),
    };
    const sandbox = vm.createContext({
      window: win,
      document: doc,
      location: { hash: '' },
      localStorage: { getItem: () => null, setItem() {} },
      requestAnimationFrame: () => 0,
      setTimeout: () => 0,
      clearTimeout() {},
    });

    new vm.Script(bundle).runInContext(sandbox);

    assert.equal(win.__shCompanionMounted, true, `${lang} bundle mounts companion bridge`);
    assert.equal(typeof win.Lesson?.blocks, 'object', `${lang} bundle initializes window.Lesson`);
    const ready = posted.find((msg) => msg?.kind === 'ready');
    assert.ok(ready, `${lang} bundle posts a ready handshake on boot`);
    assert.equal(ready.protocol, COMPANION_PROTOCOL);
    assert.equal(ready.token, token);
    assert.equal(ready.slideTotal, 1);
    if (lang === 'en') {
      assert.doesNotMatch(byId.get('theme').textContent, CJK_RE, 'en boot renders English theme label');
    } else {
      assert.match(byId.get('theme').textContent, CJK_RE, 'zh boot renders Chinese theme label');
    }
  }
});

/* ---------- 2. function-plot-style 1D singularity / asymptote protection ---------- */

test('buildCurve1DPath breaks cleanly at odd poles (1/x, 0.05/x, tan(x)) with zero false vertical crossing lines', () => {
  // Odd steps (161) guarantees x=0 is NOT a grid sample point — catches asymptotes straddling samples!
  const invX = plotSampled1D('1 / x', { min: -5, max: 5, steps: 161, yMin: -10, yMax: 10 });
  assert.ok(invX.breaks >= 1, `1/x must break at x=0, got breaks=${invX.breaks}`);
  assert.ok(invX.segments >= 2, `1/x must produce >= 2 disjoint segments, got ${invX.segments}`);
  assert.equal(hasVerticalCrossingLine(invX.commands, invX.Tp, invX.ph), false, '1/x must never draw a vertical line across x=0');

  // Tiny-residue pole 0.05/x where adjacent sample y-values are small (|dy| < 0.16 * ySpan)!
  const tinyInvX = plotSampled1D('0.05 / x', { min: -5, max: 5, steps: 161, yMin: -10, yMax: 10 });
  assert.ok(tinyInvX.breaks >= 1, `0.05/x must still break at x=0 via opposing-slope detection, got breaks=${tinyInvX.breaks}`);
  assert.ok(tinyInvX.segments >= 2);
  assert.equal(hasVerticalCrossingLine(tinyInvX.commands, tinyInvX.Tp, tinyInvX.ph), false);

  // tan(x) on [-4, 4] has two asymptotes at -pi/2 and +pi/2 -> must split into 3 segments!
  const tanX = plotSampled1D('tan(x)', { min: -4, max: 4, steps: 161, yMin: -8, yMax: 8 });
  assert.ok(tanX.breaks >= 2, `tan(x) on [-4,4] must break at both -pi/2 and +pi/2, got breaks=${tanX.breaks}`);
  assert.ok(tanX.segments >= 3, `tan(x) on [-4,4] must produce >= 3 disjoint branches, got ${tanX.segments}`);
  assert.equal(hasVerticalCrossingLine(tanX.commands, tanX.Tp, tanX.ph), false, 'tan(x) must never draw false vertical bars across asymptotes');
});

test('buildCurve1DPath breaks cleanly at even-order poles (1/x^2) and jump discontinuities (step(x)) without false breaks on smooth curves', () => {
  // Even pole: same sign (+inf) on both sides of x=0 (both fine grid and coarse grid where endpoints are inside viewport!)
  const evenFine = plotSampled1D('1 / (x ^ 2)', { min: -3, max: 3, steps: 161, yMin: -1, yMax: 10 });
  assert.ok(evenFine.breaks >= 1, `1/x^2 must break at x=0, got breaks=${evenFine.breaks}`);
  assert.ok(evenFine.segments >= 2);

  const evenShiftedCoarse = plotSampled1D('1 / ((x - 0.13) ^ 2)', { min: -3, max: 3, steps: 30, yMin: -1, yMax: 10 });
  assert.ok(evenShiftedCoarse.breaks >= 1, `shifted 1/(x-0.13)^2 on coarse grid must still break at x=0.13, got breaks=${evenShiftedCoarse.breaks}`);

  // Step discontinuity
  const stepCurve = plotSampled1D('step(x)', { min: -2, max: 2, steps: 161, yMin: -0.5, yMax: 1.5 });
  assert.ok(stepCurve.breaks >= 1, `step(x) must break at x=0, got breaks=${stepCurve.breaks}`);
  assert.ok(stepCurve.segments >= 2);

  // Smooth steep curves MUST remain 1 continuous unbroken segment!
  for (const [expr, opts] of [
    ['exp(-20 * x ^ 2)', { min: -2, max: 2, steps: 160, yMin: -0.2, yMax: 1.2 }],
    ['x ^ 3', { min: -2, max: 2, steps: 160, yMin: -9, yMax: 9 }],
    ['sin(4 * x)', { min: -3, max: 3, steps: 160, yMin: -1.5, yMax: 1.5 }],
  ]) {
    const smooth = plotSampled1D(expr, opts);
    assert.equal(smooth.breaks, 0, `smooth curve "${expr}" must not have false breaks (got ${smooth.breaks})`);
    assert.equal(smooth.segments, 1, `smooth curve "${expr}" must remain a single continuous segment`);
  }

  // Direct detector sanity & prototype hardening on evalAst
  assert.equal(detectDiscontinuity1D((x) => 1 / x, -0.1, -10, 0.1, 10, -20, 20), true);
  assert.equal(detectDiscontinuity1D((x) => x * x, -0.1, 0.01, 0.1, 0.01, -5, 5), false);
  assert.ok(Number.isNaN(evalAst({ t: 'call', fn: 'constructor', args: [] }, {})));
  assert.ok(Number.isNaN(evalAst({ t: 'var', name: 'toString' }, {})));
});

/* ---------- 3. Sandpack-style ready handshake & pre-ready message queue ---------- */

test('createCompanionChannel buffers & coalesces pre-ready messages, flushes on ready, and supports legacy progress fallback', () => {
  const delivered = [];
  const fakeWin = { postMessage(msg) { delivered.push(msg); } };
  const channel = createCompanionChannel({ token: 'tok-123', getTargetWindow: () => fakeWin });

  assert.equal(channel.isReady(), false);
  // Queue multiple pre-ready state sync messages: theme and goto coalesce to latest value!
  assert.equal(channel.send({ kind: 'theme', theme: 'light' }), false);
  assert.equal(channel.send({ kind: 'goto', slide: 2 }), false);
  assert.equal(channel.send({ kind: 'labels', askLabel: 'Ask', selectionLabel: 'Sel' }), false);
  assert.equal(channel.send({ kind: 'theme', theme: 'dark' }), false);
  assert.equal(channel.send({ kind: 'goto', slide: 5 }), false);
  assert.equal(delivered.length, 0, 'nothing is posted before iframe signals ready');
  assert.equal(channel.pendingCount(), 3, 'coalesced to latest labels + theme + goto');

  // Foreign source or mismatched token is ignored and never unlocks the queue.
  assert.equal(channel.handleMessage({ source: {}, data: { protocol: COMPANION_PROTOCOL, token: 'tok-123', kind: 'ready' } }), null);
  assert.equal(channel.handleMessage({ source: fakeWin, data: { protocol: COMPANION_PROTOCOL, token: 'wrong', kind: 'ready' } }), null);
  assert.equal(channel.isReady(), false);
  assert.equal(delivered.length, 0);

  // ping sends immediately even before ready so late-attached host can elicit handshake
  assert.equal(channel.ping(), true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].kind, 'ping');

  // Receiving `ready` unlocks channel and atomically flushes all queued messages in order!
  const readyMsg = channel.handleMessage({ source: fakeWin, data: { protocol: COMPANION_PROTOCOL, token: 'tok-123', kind: 'ready', version: 1 } });
  assert.equal(readyMsg.kind, 'ready');
  assert.equal(channel.isReady(), true);
  assert.equal(channel.pendingCount(), 0);
  assert.deepEqual(
    delivered.slice(1).map(m => [m.kind, m.theme ?? m.slide ?? m.askLabel]),
    [['labels', 'Ask'], ['theme', 'dark'], ['goto', 5]],
  );

  // Post-ready sends go straight through immediately
  assert.equal(channel.send({ kind: 'goto', slide: 6 }), true);
  assert.equal(delivered.at(-1).slide, 6);

  // Resetting for a new document re-enables buffering; older companion sending `progress` also marks ready!
  channel.reset({ clearQueue: true });
  assert.equal(channel.isReady(), false);
  channel.send({ kind: 'theme', theme: 'light' });
  assert.equal(channel.pendingCount(), 1);
  const prog = channel.handleMessage({ source: fakeWin, data: { protocol: COMPANION_PROTOCOL, token: 'tok-123', kind: 'progress', slide: 1 } });
  assert.equal(prog.kind, 'progress');
  assert.equal(channel.isReady(), true);
  assert.equal(channel.pendingCount(), 0);
  assert.equal(delivered.at(-1).theme, 'light');
});

test('createCompanionBridge emits ready on boot and responds to ping, and DiagramFrame shim includes ready/ping handshake', () => {
  // Verify universal shim in framedDocument carries ready + ping support
  const framed = framedDocument('<!doctype html><html><head></head><body></body></html>', {
    channelToken: 'tok-shim',
    theme: 'light',
  });
  assert.match(framed, /d\.kind==='ping'/, 'universal shim must answer ping with ready');
  assert.match(framed, /kind:'ready'/, 'universal shim must emit ready handshake');

  // Verify createCompanionBridge directly in a minimal browser stub
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  const postedToParent = [];
  const winListeners = new Map();
  const root = { dataset: { theme: 'light' } };
  let themePaints = 0;
  let gotoArgs = null;

  globalThis.window = {
    innerWidth: 1024,
    parent: { postMessage(msg) { postedToParent.push(msg); } },
    addEventListener(type, fn) { winListeners.set(type, fn); },
    getSelection: () => ({ toString: () => '', rangeCount: 0 }),
  };
  const stubEl = () => ({ style: {}, hidden: false, textContent: '', prepend() {}, append() {}, addEventListener() {}, setAttribute() {} });
  globalThis.document = {
    body: stubEl(),
    querySelector: () => stubEl(),
    addEventListener() {},
  };
  try {
    const h = () => stubEl();
    const bridge = createCompanionBridge({
      boot: { channelToken: 'tok-bridge', askLabel: 'Ask', selectionLabel: 'Sel' },
      lesson: { slides: [{}, {}, {}] },
      h,
      T: { askBtn: 'Ask', askSel: 'Sel' },
      root,
      paintTheme: () => { themePaints++; },
      getCurrentContext: () => ({ slide: 1 }),
      onGoto: (s, m) => { gotoArgs = [s, m]; },
    });
    const mounted = bridge.mount();
    assert.equal(mounted.mounted, true);
    bridge.announceReady();
    assert.equal(postedToParent.length, 1);
    assert.equal(postedToParent[0].kind, 'ready');
    assert.equal(postedToParent[0].slideTotal, 3);

    // Host pings -> bridge replies ready
    const onMsg = winListeners.get('message');
    onMsg({ data: { protocol: COMPANION_PROTOCOL, token: 'tok-bridge', kind: 'ping' } });
    assert.equal(postedToParent.length, 2);
    assert.equal(postedToParent[1].kind, 'ready');
    assert.equal(postedToParent[1].replyToPing, true);

    // Host sends theme + goto -> applied cleanly
    onMsg({ data: { protocol: COMPANION_PROTOCOL, token: 'tok-bridge', kind: 'theme', theme: 'dark' } });
    assert.equal(root.dataset.theme, 'dark');
    assert.equal(themePaints, 1);

    onMsg({ data: { protocol: COMPANION_PROTOCOL, token: 'tok-bridge', kind: 'goto', slide: 3 } });
    assert.deepEqual(gotoArgs, [2, 0]);
  } finally {
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
  }
});
