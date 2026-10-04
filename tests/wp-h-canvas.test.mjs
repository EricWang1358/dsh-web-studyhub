import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 2 · WP-H: one pan/zoom, fullscreen and zoom bar for both canvases (#129 #84).
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/canvas/index.js'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const html = (type, props = {}, ...children) => renderToStaticMarkup(h(type, props, ...children));

test('the canvas module exports the shared hooks and bars', () => {
  for (const name of ['usePanZoom', 'useCanvasFullscreen', 'ZoomBar', 'ZoomControls', 'FullscreenButton', 'fitTransform', 'zoomAround', 'clampZoom', 'requestCanvasFullscreen'])
    assert.equal(typeof m[name], 'function', name);
});

test('fitTransform centres a drawing that fits and anchors a cropped one', () => {
  const box = { width: 1000, height: 600 };
  const fits = m.fitTransform({ box, bounds: { w: 500, h: 300 }, initial: false, maxFit: 1.2 });
  assert.deepEqual(fits, { k: 1.2, x: 200, y: 120 });
  const big = { w: 4000, h: 2000 };
  const cropped = m.fitTransform({ box, bounds: big, initial: true, minInitial: 0.9, anchorX: 100, anchorY: 50 });
  assert.equal(cropped.k, 0.9, 'the first view never shrinks below the readable size');
  assert.equal(cropped.x, 160 - 100 * 0.9);
  assert.equal(cropped.y, 300 - 50 * 0.9);
  const whole = m.fitTransform({ box, bounds: big, initial: false });
  assert.ok(Math.abs(whole.k - 0.242) < 1e-9);
  assert.ok(Math.abs(whole.x - 16) < 1e-9 && Math.abs(whole.y - 58) < 1e-9);
  const graph = m.fitTransform({ box, bounds: big, initial: true, minInitial: 0, zoomMin: 0.12 });
  assert.ok(Math.abs(graph.k - 0.242) < 1e-9, 'a caller can ask for the whole drawing even on the first view');
  const inset = m.fitTransform({ box: { width: 1000, height: 600 }, bounds: { w: 100, h: 100 }, insetRight: 300, maxFit: 1 });
  assert.equal(inset.x, (700 - 100) / 2, 'an overlay panel on the right keeps the drawing clear');
  assert.equal(m.fitTransform({ box: { width: 500, height: 600 }, bounds: { w: 100, h: 100 }, insetRight: 300, maxFit: 1 }).x, 200, 'no inset on a narrow canvas');
});

test('zoomAround keeps the point under the pointer still and respects the limits', () => {
  const view = { k: 1, x: 0, y: 0 };
  assert.deepEqual(m.zoomAround(view, 2, 100, 50), { k: 2, x: -100, y: -50 });
  assert.equal(m.zoomAround({ k: 2.4, x: 0, y: 0 }, 2, 0, 0).k, 2.5);
  assert.equal(m.zoomAround({ k: 0.03, x: 0, y: 0 }, 0.1, 0, 0).k, 0.02);
  assert.equal(m.zoomAround({ k: 0.13, x: 0, y: 0 }, 0.1, 0, 0, { min: 0.12, max: 2.5 }).k, 0.12);
  assert.equal(m.clampZoom(9), 2.5);
});

test('requestCanvasFullscreen falls back to the top-layer popover when the Fullscreen API is blocked', async () => {
  assert.equal(await m.requestCanvasFullscreen({ requestFullscreen: async () => {} }), 'native');
  assert.equal(await m.requestCanvasFullscreen({ requestFullscreen: async () => { throw new Error('disallowed by the host'); } }), 'popover');
  assert.equal(await m.requestCanvasFullscreen({}), 'popover');
  assert.equal(await m.requestCanvasFullscreen(null), 'popover');
});

test('the zoom bar uses named icon buttons, not glyph text', () => {
  m.setUiLanguage('zh');
  const out = html(m.ZoomBar, { zoomAt() {}, fit() {}, percent: 120 }, h('span', { className: 'extra' }, 'x'));
  assert.match(out, /aria-label="缩小"/);
  assert.match(out, /aria-label="放大"/);
  assert.match(out, /<output[^>]*aria-label="当前缩放"[^>]*>120%<\/output>/);
  assert.match(out, />适应</);
  assert.match(out, /class="extra"/);
  assert.doesNotMatch(out, /[−＋]/);
  assert.equal((out.match(/<svg/g) || []).length, 2);
});

test('one label pair names fullscreen on every canvas', () => {
  m.setUiLanguage('zh');
  assert.match(html(m.FullscreenButton, { full: false, onToggle() {} }), />全屏查看</);
  assert.match(html(m.FullscreenButton, { full: true, onToggle() {} }), />退出全屏</);
  assert.match(html(m.FullscreenButton, { full: true, onToggle() {} }), /aria-pressed="true"/);
  m.setUiLanguage('en');
  assert.match(html(m.FullscreenButton, { full: false, onToggle() {} }), />Full screen</);
  m.setUiLanguage('zh');
});

test('both canvases share the hooks: Graph keeps no zoom, wheel or fullscreen code of its own (#129 #84)', () => {
  const graph = read('ui/Graph.jsx'), skeleton = read('ui/SkeletonCanvas.jsx');
  for (const source of [graph, skeleton]) {
    assert.match(source, /from ["']\.\/canvas\/index\.js["']/);
    assert.match(source, /usePanZoom\(/);
    assert.match(source, /useCanvasFullscreen\(/);
    assert.doesNotMatch(source, /requestFullscreen|exitFullscreen|fullscreenchange/);
    assert.doesNotMatch(source, /addEventListener\(["']wheel/);
    assert.doesNotMatch(source, /大画布/);
  }
  assert.doesNotMatch(skeleton, /function (usePanZoom|useCanvasFullscreen|ZoomBar)/);
  assert.match(graph, /FullscreenButton/);
  assert.match(skeleton, /FullscreenButton/);
  assert.doesNotMatch(graph, /ZOOM_STEP|scaleRef/);
});

test('the expanded canvas sits in the top layer, not behind a magic z-index (#84)', () => {
  assert.doesNotMatch(read('ui/skeleton.css'), /z-index:\s*10000/);
  const css = read('ui/canvas/canvas.css');
  assert.match(css, /\.canvas-expanded/);
  assert.match(css, /::backdrop/);
  assert.doesNotMatch(css, /z-index:\s*\d{3,}/);
});
