import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 5A, #86: information that only a title attribute carried (the board's due date, the chart tips) goes through the shared Tooltip.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as BoardCard } from './ui/board/Card.jsx'; export { setUiLanguage } from './ui/i18n.js'; export * as dismiss from './ui/components/use-dismiss.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { BoardCard, setUiLanguage, dismiss } = module.exports;
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const column = { id: 'todo', title: '待办', done: false, cardIds: ['a'] };
const render = due => { setUiLanguage('zh'); return renderToStaticMarkup(React.createElement(BoardCard, { card: { id: 'a', title: '期末复习', note: '', due, labels: [], createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z' },
  column, columns: [column], index: 0, count: 1, today: '2026-10-02', library: { courses: [], decks: [], sources: [], notes: [], skeletons: [] }, onToggleDone() {}, onEdit() {}, onAction() {} })); };

test('the due chip explains its date in a Tooltip: focusable, described by it, no title attribute', () => {
  const html = render('2026-10-19');
  const chip = html.match(/<span[^>]*class="board-due[^"]*"[^>]*>/)[0];
  assert.doesNotMatch(chip, /title=/);
  assert.match(chip, /tabindex="0"/);
  const described = chip.match(/aria-describedby="([^"]+)"/)[1];
  assert.match(html, new RegExp(`<span id="${described.replace(/:/g, '\\:')}" role="tooltip"[^>]*>2026-10-19 · 17 天后</span>`));
});

test('the chart tip is the shared tooltip surface: the charts stylesheet styles no tooltip of its own', () => {
  assert.match(read('ui/charts/DashboardCharts.jsx'), /sh-popover sh-tooltip sh-tooltip--point/);
  const charts = read('ui/charts/charts.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(charts, /dash-tip|\.sh-tooltip/, 'the chart tip keeps no rule of its own: the surface and its layout live in ui/components/overlays.css');
  const css = read('ui/components/overlays.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.sh-tooltip--point\s*\{([^}]*)\}/.exec(css)[1];
  for (const property of ['border', 'border-radius', 'background', 'box-shadow', 'z-index']) assert.doesNotMatch(rule, new RegExp(`(?:^|[;\\s])${property}\\s*:`), property);
  assert.match(css, /\.sh-tooltip--point\.is-below/, 'near the top of the chart the tip opens under the point');
});

function fakeDoc() {
  const listeners = new Map();
  const body = { contains: () => false }, documentElement = { contains: () => false };
  let openSelect = false;
  return {
    body,
    documentElement,
    setSelectOpen(value) { openSelect = value; },
    querySelector(selector) { return openSelect && selector.includes('.sh-pop__popup') ? {} : null; },
    addEventListener(type, fn, capture = false) {
      const list = listeners.get(type) || [];
      list.push({ fn, capture: Boolean(capture) });
      listeners.set(type, list);
    },
    removeEventListener(type, fn, capture = false) {
      const list = listeners.get(type);
      if (!list) return;
      const idx = list.findIndex(entry => entry.fn === fn && entry.capture === Boolean(capture));
      if (idx >= 0) list.splice(idx, 1);
    },
    dispatch(type, event) {
      for (const entry of [...(listeners.get(type) || [])]) {
        entry.fn(event);
        if (event.stopped) break;
      }
    },
  };
}

function escapeEvent(target) {
  const event = {
    key: 'Escape',
    target,
    defaultPrevented: false,
    stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  return event;
}

test('WCAG 1.4.13 (#1174): Tooltip dismisses on Escape regardless of focus/pointer and closes only the topmost card when stacked', () => {
  assert.equal(typeof dismiss.registerDismiss, 'function', 'use-dismiss exports registerDismiss');
  assert.match(read('ui/components/Tooltip.jsx'), /useDismiss\([\s\S]*?escapeAnywhere:\s*true\s*\}\)/, 'Tooltip opts into escapeAnywhere');
  assert.doesNotMatch(read('ui/components/Tooltip.jsx'), /event\.key === 'Escape'/, 'Tooltip delegates all Escape handling to the shared useDismiss stack');

  const doc = fakeDoc();
  const anchorA = { contains: node => node === anchorA };
  const anchorB = { contains: node => node === anchorB };
  const elsewhere = { contains: () => false };

  // 1. Default useDismiss (Popover/Menu) ignores Escape when focus is on an unrelated element elsewhere.
  const closedPopover = [];
  const offPop = dismiss.registerDismiss({ getLatest: () => ({ refs: anchorA, onClose: reason => closedPopover.push(reason) }), doc });
  doc.dispatch('keydown', escapeEvent(elsewhere));
  assert.deepEqual(closedPopover, [], 'default dismiss still ignores Escape from unrelated focused elements');
  offPop();

  // 2. Tooltip (escapeAnywhere: true) closes on Escape even while focus sits on an unrelated control (hovering with pointer).
  const closedA = [], closedB = [];
  let offA = null, offB = null;
  offA = dismiss.registerDismiss({
    getLatest: () => ({ refs: anchorA, escapeAnywhere: true, onClose: reason => { closedA.push(reason); offA(); } }),
    doc,
  });
  const evSingle = escapeEvent(elsewhere);
  doc.dispatch('keydown', evSingle);
  assert.deepEqual(closedA, ['escape'], 'hovered tooltip closes on Escape when focus is elsewhere');
  assert.equal(evSingle.defaultPrevented, true);
  assert.equal(evSingle.stopped, true);

  // 3. Stacked cards: one Escape closes ONLY the topmost card; the second Escape closes the one underneath.
  closedA.length = 0;
  offA = dismiss.registerDismiss({
    getLatest: () => ({ refs: anchorA, escapeAnywhere: true, onClose: reason => { closedA.push(reason); offA(); } }),
    doc,
  });
  offB = dismiss.registerDismiss({
    getLatest: () => ({ refs: anchorB, escapeAnywhere: true, onClose: reason => { closedB.push(reason); offB(); } }),
    doc,
  });
  // Select popup takes precedence over tooltips too.
  doc.setSelectOpen(true);
  doc.dispatch('keydown', escapeEvent(elsewhere));
  assert.deepEqual([closedA, closedB], [[], []], 'open Select popup owns Escape first');
  doc.setSelectOpen(false);

  doc.dispatch('keydown', escapeEvent(elsewhere));
  assert.deepEqual([closedA, closedB], [[], ['escape']], 'first Escape closes only the topmost stacked card');
  doc.dispatch('keydown', escapeEvent(elsewhere));
  assert.deepEqual([closedA, closedB], [['escape'], ['escape']], 'second Escape closes the card underneath');
});
