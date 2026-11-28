// test-audit-allowlist: static-css-guard — enforces CSS transform-only transitions and @media (prefers-reduced-motion) rules across ui/**/*.css via parseCss; stylesheet media queries and transition declarations cannot be evaluated in Node without a browser CSSOM engine (the Tour.jsx spotlight transform check below renders Tour directly).
/* #101: motion is transform and opacity only (ui/DESIGN.md). No `transition` in ui CSS may list width, height, left, top, right or bottom,
   except the content-driven cases below, each with the reason it cannot be a transform. The list only shrinks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build } from 'esbuild';
import { ROOT, walk, parseCss } from '../scripts/qa/guardrail-baseline.mjs';

const LAYOUT_PROP = /(?<![\w-])(width|height|left|top|right|bottom|max-height|max-width|min-height|min-width)(?![\w-])/;

/* file | selector -> why */
const ALLOWED = {
  'ui/review/question.css | .flip-inner': 'the card grows to the height of the face that is up while it turns; the height is content-driven (FlipCard measures it)',
  'ui/skeleton.css | .skc-class': 'focus-view boxes of the structure canvas glide to positions the layout engine writes as left/top; dragging switches the transition off',
};

const found = [];
for (const file of walk(join(ROOT, 'ui'), ['.css'])) {
  const rel = relative(ROOT, file).split('\\').join('/');
  for (const d of parseCss(readFileSync(file, 'utf8')).declarations) {
    if (!/^transition(-property)?$/.test(d.prop)) continue;
    if (LAYOUT_PROP.test(d.value)) found.push({ key: `${rel} | ${d.ctx.at(-1)}`, line: d.line, value: d.value.replace(/\s+/g, ' ') });
  }
}

test('no transition animates width, height, left, top, right or bottom outside the documented content-driven cases', () => {
  const unexpected = found.filter((f) => !(f.key in ALLOWED));
  assert.deepEqual(unexpected.map((f) => `${f.key} (line ${f.line}): ${f.value}`), [], 'animate transform / opacity instead (ui/DESIGN.md)');
});

test('every allowed exception still exists (the list only shrinks)', () => {
  for (const key of Object.keys(ALLOWED)) assert.ok(found.some((f) => f.key === key), `${key} no longer transitions a layout property: delete it from ALLOWED`);
});

const cssDecls = (relPath) => parseCss(readFileSync(join(ROOT, relPath), 'utf8')).declarations;
const inMedia = (d, query) => d.ctx.some((c) => c === `@media (${query})`);

test('the converted surfaces keep their reduced-motion switch-off', () => {
  assert.ok(
    cssDecls('ui/components/components.css').some((d) => inMedia(d, 'prefers-reduced-motion: reduce') && /\.sh-seg__thumb\b/.test(d.ctx.at(-1)) && d.prop === 'transition' && d.value === 'none'),
    'segmented thumb',
  );
  assert.ok(
    cssDecls('ui/review/session.css').some((d) => inMedia(d, 'prefers-reduced-motion: reduce') && /\.review-tick-line\b/.test(d.ctx.at(-1)) && d.prop === 'transition' && d.value === 'none'),
    'review tick',
  );
  const tourTransitions = cssDecls('ui/tour/tour.css').filter((d) => /\.tour-spot\b/.test(d.ctx.at(-1)) && d.prop === 'transition');
  assert.ok(tourTransitions.length > 0 && tourTransitions.every((d) => inMedia(d, 'prefers-reduced-motion: no-preference')), 'tour transitions are only declared for no-preference');
  assert.equal(
    cssDecls('ui/motion.css').some((d) => inMedia(d, 'prefers-reduced-motion: reduce') && d.ctx.at(-1).trim() === '*' && d.prop === 'transition-duration' && d.value === '0.01ms' && d.important),
    false,
    'prefers-reduced-motion keeps intentional opacity fades (e.g. flip-face) instead of nuking all transitions',
  );
  assert.ok(
    cssDecls('ui/review/question.css').some((d) => inMedia(d, 'prefers-reduced-motion: reduce') && /\.flip-loading\b/.test(d.ctx.at(-1)) && d.prop === 'animation' && d.value === 'none'),
    'flip loading shimmer stops under reduced motion',
  );
  assert.ok(
    cssDecls('ui/shell.css').some((d) => inMedia(d, 'prefers-reduced-motion: reduce') && /\.top-status \.dot\.busy\b/.test(d.ctx.at(-1)) && d.prop === 'animation' && d.value === 'none'),
    'status busy pulse stops under reduced motion',
  );
  assert.ok(
    cssDecls('ui/app/nav-drawer.css').some((d) => inMedia(d, 'prefers-reduced-motion: reduce') && /\.nav-drawer\[open\]/.test(d.ctx.at(-1)) && d.prop === 'animation' && d.value === 'none'),
    'nav drawer slide-in stops under reduced motion',
  );
});

test('the review ticks and the tour spotlight are moved by transform', async () => {
  const tick = cssDecls('ui/review/session.css').filter((d) => /review-tick-line/.test(d.ctx.at(-1)));
  assert.ok(tick.some((d) => d.prop === 'transform' && /scaleX/.test(d.value)), 'a tick changes length with scaleX');
  assert.ok(!tick.some((d) => d.prop === 'width' && d.ctx.at(-1).includes('hover')), 'hover no longer changes the width');

  // Render Tour with a measured anchor box and verify the rendered .tour-spot element uses transform: translate(...).
  const prevWin = globalThis.window, prevDoc = globalThis.document, prevRaf = globalThis.requestAnimationFrame, prevCancelRaf = globalThis.cancelAnimationFrame;
  const hooks = [];
  let cursor = 0, pendingEffects = [];
  const hLocal = (type, p, ...children) => ({ $$type: type, props: { ...(p || {}), ...(children.length === 1 ? { children: children[0] } : children.length > 1 ? { children } : {}) } });
  const eff = (fn, deps) => {
    const i = cursor++, prev = hooks[i];
    if (!prev || !deps || deps.some((d, k) => d !== prev.deps?.[k])) {
      hooks[i] = { deps, cleanup: prev?.cleanup };
      pendingEffects.push(() => { hooks[i].cleanup?.(); hooks[i].cleanup = fn(); });
    }
  };
  const reactShim = {
    default: null, Fragment: Symbol('Fragment'), createElement: hLocal,
    useState(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init; return [hooks[i], v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; },
    useRef(init) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
    useId() { const i = cursor++; if (!(i in hooks)) hooks[i] = `:tour-${i}:`; return hooks[i]; },
    useCallback: fn => fn,
    useEffect: eff,
    useLayoutEffect: eff,
    useSyncExternalStore: (_s, snap) => snap(),
  };
  reactShim.default = reactShim;
  globalThis.__TOUR_MOTION_REACT__ = reactShim;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, scrollTo() {}, scrollY: 0 };
  globalThis.document = { body: {}, documentElement: {}, activeElement: null, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  try {
    const built = await build({
      stdin: { contents: `export { default as Tour } from './ui/tour/Tour.jsx';`, resolveDir: ROOT },
      bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.css': 'text' }, logLevel: 'silent',
      plugins: [{
        name: 'shim-tour-motion',
        setup(builder) {
          builder.onResolve({ filter: /^react$|^react\/jsx-runtime$/ }, () => ({ path: 'react', namespace: 'tmr' }));
          builder.onLoad({ filter: /.*/, namespace: 'tmr' }, () => ({
            contents: `const R = globalThis.__TOUR_MOTION_REACT__; export default R; export const { Fragment, createElement, useState, useRef, useId, useCallback, useEffect, useLayoutEffect, useSyncExternalStore } = R; export const jsx = (t, p) => R.createElement(t, p); export const jsxs = jsx; export const jsxDEV = jsx;`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /^react-dom$/ }, () => ({ path: 'react-dom', namespace: 'tmrd' }));
          builder.onLoad({ filter: /.*/, namespace: 'tmrd' }, () => ({ contents: `export const createPortal = node => node;`, loader: 'js' }));
          builder.onResolve({ filter: /components\/index\.js$/ }, () => ({ path: 'comp', namespace: 'tmc' }));
          builder.onLoad({ filter: /.*/, namespace: 'tmc' }, () => ({
            contents: `const R = globalThis.__TOUR_MOTION_REACT__; const tag = el => p => R.createElement(el, p, p.children); export const AddSourceButton = tag('button'); export const Button = tag('button'); export const IconButton = tag('button'); export const Icon = tag('span'); export const ProgressBar = tag('div');`,
            loader: 'js',
          }));
          builder.onResolve({ filter: /dialog-stack\.js$|shared\.js$|use-polling\.js$/ }, args => ({ path: args.path, namespace: 'tmh' }));
          builder.onLoad({ filter: /.*/, namespace: 'tmh' }, () => ({
            contents: `export const useTopDialog = () => null; export const useInjectCss = () => {}; export const usePolling = () => {};`,
            loader: 'js',
          }));
        },
      }],
    });
    const mod = { exports: {} };
    new Function('module', 'exports', built.outputFiles[0].text)(mod, mod.exports);
    const { Tour } = mod.exports;

    const anchorEl = {
      isConnected: true,
      getBoundingClientRect: () => ({ left: 120, top: 80, right: 260, bottom: 124, width: 140, height: 44 }),
      scrollIntoView() {},
    };
    const rootRef = {
      current: {
        style: { getPropertyValue: () => '', setProperty() {}, removeProperty() {} },
        hasAttribute: () => false,
        setAttribute() {},
        removeAttribute() {},
        contains: () => false,
        querySelector: (sel) => (sel === '[data-tour="sample"]' ? anchorEl : null),
      },
    };
    const layerBox = { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }), clientWidth: 1200, offsetWidth: 1200, closest: () => null };
    const popBox = { offsetWidth: 320, offsetHeight: 180, isConnected: true, contains: () => true, focus() {}, classList: { contains: () => false } };
    const steps = [{ id: 's1', anchor: 'sample', title: 'Step 1', body: 'Body' }];
    const props = { steps, stepId: 's1', rootRef, sampleLoaded: true, onMove() {}, onClose() {}, onFinish() {} };

    const attachRefs = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(attachRefs); return; }
      if (node.props?.ref && typeof node.props.ref === 'object') {
        if (String(node.props.className || '').includes('tour-layer')) node.props.ref.current = layerBox;
        else if (String(node.props.className || '').includes('tour-pop')) node.props.ref.current = popBox;
      }
      if (node.props?.popoverRef) node.props.popoverRef.current = popBox;
      attachRefs(node.props?.children);
    };
    const findNode = (node, pred) => {
      if (!node || typeof node !== 'object') return null;
      if (Array.isArray(node)) { for (const c of node) { const hit = findNode(c, pred); if (hit) return hit; } return null; }
      if (pred(node)) return node;
      return findNode(node.props?.children, pred);
    };
    const renderTour = () => {
      cursor = 0;
      pendingEffects = [];
      const tree = Tour(props);
      attachRefs(tree);
      pendingEffects.splice(0).forEach((fn) => fn());
      return tree;
    };

    renderTour();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    renderTour();
    renderTour();
    const tree = renderTour();
    const spot = findNode(tree, (n) => n.props?.className === 'tour-spot');
    assert.ok(spot, 'Tour renders .tour-spot around the measured anchor');
    assert.equal(spot.props.style.left, 0, 'spotlight pins left to 0 and translates instead of animating left');
    assert.equal(spot.props.style.top, 0, 'spotlight pins top to 0 and translates instead of animating top');
    assert.match(spot.props.style.transform, /^translate\(\d+(?:\.\d+)?px,\s*\d+(?:\.\d+)?px\)$/, 'the spotlight is placed with translate');
  } finally {
    // Unmount as React would, while the stand-in page is still there: the tour's waiting loops stop with it.
    for (const hook of hooks) hook?.cleanup?.();
    delete globalThis.__TOUR_MOTION_REACT__;
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
    if (prevRaf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = prevRaf;
    if (prevCancelRaf === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = prevCancelRaf;
  }
});
