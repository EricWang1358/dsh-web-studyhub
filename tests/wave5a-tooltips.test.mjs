import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UI wave 5A, #86: information that only a title attribute carried (the board's due date, the chart tips) goes through the shared Tooltip.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as BoardCard } from './ui/board/Card.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { BoardCard, setUiLanguage } = module.exports;
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

test('the chart tip takes the shared tooltip surface and keeps only its own layout', () => {
  assert.match(read('ui/charts/DashboardCharts.jsx'), /className=\{`sh-popover sh-tooltip dash-tip/);
  const css = read('ui/charts/charts.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.dash-tip\s*\{([^}]*)\}/.exec(css)[1];
  for (const property of ['border', 'border-radius', 'background', 'box-shadow', 'z-index']) assert.doesNotMatch(rule, new RegExp(`(?:^|[;\\s])${property}\\s*:`), property);
});
