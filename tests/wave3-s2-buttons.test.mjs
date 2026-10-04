import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// WP-S2 (#152 #153): Button gains wrap / block / align / pill / busyLabel, and
// SegmentedControl gains fill / wrap / stack / xs, so features stop re-skinning
// .sh-btn and .sh-seg in their own CSS.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/components/index.js'; export { busyWidthStyle } from './ui/components/Button.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const html = (type, props = {}, ...children) => renderToStaticMarkup(h(type, props, ...children));
const css = readFileSync(new URL('../ui/components/button-variants.css', import.meta.url), 'utf8');

test('Button: wrap, block and align are class modifiers', () => {
  const out = html(m.Button, { wrap: true, block: true, align: 'start' }, '一个很长的按钮文案');
  assert.match(out, /class="sh-btn sh-btn--secondary sh-btn--md sh-btn--wrap sh-btn--block sh-btn--start"/);
  assert.doesNotMatch(html(m.Button, {}, 'x'), /sh-btn--(wrap|block|start|center|pill)/);
  assert.match(html(m.Button, { align: 'center' }, 'x'), /sh-btn--center/);
  assert.doesNotMatch(html(m.Button, { align: 'diagonal' }, 'x'), /sh-btn--(start|center)/);
});

test('Button: the pill shape is for toggle buttons only', () => {
  assert.match(html(m.Button, { shape: 'pill', 'aria-pressed': false }, '细'), /sh-btn--pill/);
  assert.match(html(m.Button, { shape: 'pill', 'aria-pressed': true }, '细'), /sh-btn--pill/);
  assert.doesNotMatch(html(m.Button, { shape: 'pill' }, '细'), /sh-btn--pill/, 'a pill that does not toggle is ignored');
  assert.doesNotMatch(html(m.Button, { shape: 'square', 'aria-pressed': true }, '细'), /sh-btn--pill/);
});

test('Button: busy keeps its width, announces aria-busy and can swap its label', () => {
  const busy = html(m.Button, { busy: true, busyLabel: '保存中…' }, '保存');
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /保存中…/);
  assert.doesNotMatch(busy, />保存</, 'the idle label is replaced');
  assert.match(html(m.Button, { busyLabel: '保存中…' }, '保存'), />保存</, 'busyLabel only shows while busy');
  assert.deepEqual(m.busyWidthStyle(true, 132, undefined), { minWidth: 132 });
  assert.deepEqual(m.busyWidthStyle(true, 132, { color: 'red' }), { color: 'red', minWidth: 132 });
  assert.equal(m.busyWidthStyle(false, 132, undefined), undefined);
  assert.equal(m.busyWidthStyle(true, 0, undefined), undefined);
  assert.deepEqual(m.busyWidthStyle(false, 132, { color: 'red' }), { color: 'red' });
});

test('SegmentedControl: fill, wrap, stack and xs are class modifiers', () => {
  const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
  const out = html(m.SegmentedControl, { label: 'x', value: 'a', options, fill: true, wrap: true, stack: true, size: 'xs' });
  assert.match(out, /class="sh-seg sh-seg--xs sh-seg--fill sh-seg--wrap sh-seg--stack"/);
  assert.doesNotMatch(html(m.SegmentedControl, { label: 'x', value: 'a', options }), /sh-seg--(fill|wrap|stack|xs|sm)/);
  assert.match(html(m.SegmentedControl, { label: 'x', value: 'a', options, size: 'sm' }), /sh-seg--sm/);
});

test('button-variants.css is token-only, scoped and defines every modifier', () => {
  for (const name of ['wrap', 'block', 'start', 'center', 'pill']) assert.match(css, new RegExp(`\\.sh-btn--${name}\\b`), `sh-btn--${name}`);
  for (const name of ['fill', 'wrap', 'stack', 'xs']) assert.match(css, new RegExp(`\\.sh-seg--${name}\\b`), `sh-seg--${name}`);
  assert.doesNotMatch(css, /!important/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  assert.doesNotMatch(css, /font-size:\s*\d+px/);
  assert.doesNotMatch(css, /z-index:\s*\d{2,}/);
  assert.match(css, /study-app, \.study-seat/);
  assert.match(css, /prefers-reduced-motion/);
});
