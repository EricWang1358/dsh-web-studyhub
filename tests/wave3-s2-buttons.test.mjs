import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';

// WP-S2 (#152 #153): Button gains wrap / block / align / pill / busyLabel, and
// SegmentedControl gains fill / wrap / stack / xs, so features stop re-skinning
// .sh-btn and .sh-seg in their own CSS.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export * from './ui/components/index.js'; export { holdWidth } from './ui/components/Button.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const m = module.exports;
const h = React.createElement;
const html = (type, props = {}, ...children) => renderToStaticMarkup(h(type, props, ...children));

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
  // A press records the width; the stylesheet holds it only while aria-busy is on.
  const stored = {};
  m.holdWidth({ offsetWidth: 132, style: { setProperty: (name, value) => { stored[name] = value; } } });
  assert.deepEqual(stored, { '--sh-held-width': '132px' });
  assert.doesNotThrow(() => m.holdWidth(null));
  // Behavioral busy-lock width retention is also covered in tests/busy-lock-browser.test.mjs;
  // assert the parsed CSS declaration directly so dropping min-width: var(--sh-held-width, ...) fails even for shorter busyLabel swaps.
  const { declarations } = parseCss(readFileSync(new URL('../ui/components/components.css', import.meta.url), 'utf8'));
  assert.ok(
    declarations.some(
      (d) => d.ctx.at(-1) === '.sh-btn[aria-busy="true"]'
        && d.prop === 'min-width'
        && /^var\(\s*--sh-held-width\b/.test(d.value),
    ),
    '.sh-btn[aria-busy="true"] holds width via min-width: var(--sh-held-width, ...)',
  );
});

test('Button: lock disables without a spinner (only the pressed button spins, see the browser test)', () => {
  const locked = html(m.Button, { lock: true }, 'Save');
  assert.match(locked, /<button[^>]*\bdisabled=""/);
  assert.doesNotMatch(locked, /aria-busy|sh-spinner/, 'a button locked without being pressed stays quiet');
  assert.doesNotMatch(locked, /lock=/, 'the prop is not passed on to the DOM');
  assert.doesNotMatch(html(m.Button, { lock: false }, 'Save'), /disabled=|aria-busy/);
  assert.match(html(m.Button, { lock: true, disabled: false, busy: true }, 'Save'), /aria-busy="true"[^>]*>|sh-spinner/, 'busy still spins on its own');
  assert.match(html(m.IconButton, { icon: 'refresh', label: 'Reload', lock: true }), /disabled=""/);
});

test('one disabled look for buttons and segments: faint text and no pointer, never a faded copy', () => {
  const sheet = readFileSync(new URL('../ui/components/components.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }))
    .filter(({ selector }) => /^\.sh-(?:btn|seg__item)[^,]*:disabled$/.test(selector));
  assert.ok(rules.length >= 4, 'the button and segment disabled rules are found');
  for (const { selector, body } of rules) assert.doesNotMatch(body, /opacity:\s*0?\.\d|!important/, `${selector} must not fade the control or force itself`);
  assert.match(rules.find(({ selector }) => selector === '.sh-seg__item:disabled').body, /color:\s*(?:color-mix\(in srgb,\s*)?var\(--text-faint\)/, 'a segment dims from the faint token without opacity');
});

test('SegmentedControl: fill, wrap, stack and xs are class modifiers', () => {
  const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
  const out = html(m.SegmentedControl, { label: 'x', value: 'a', options, fill: true, wrap: true, stack: true, size: 'xs' });
  assert.match(out, /class="sh-seg sh-seg--xs sh-seg--fill sh-seg--wrap sh-seg--stack"/);
  assert.doesNotMatch(html(m.SegmentedControl, { label: 'x', value: 'a', options }), /sh-seg--(fill|wrap|stack|xs|sm)/);
  assert.match(html(m.SegmentedControl, { label: 'x', value: 'a', options, size: 'sm' }), /sh-seg--sm/);
});

test('button-variants.css is token-only, scoped and defines every modifier', () => {
  // Repo-wide !important, raw hex/rgb/hsl colors, px font-size, numeric z-index (> 2), and
  // @layer / :is(.study-app, .study-seat) scoping are enforced across all ui/**/*.css by
  // tests/ui-guardrails.test.mjs, tests/css-token-guard.test.mjs, and tests/css-layers.test.mjs.
  // Here we inspect parsed AST rules for button/segment modifier declarations and reduced-motion.
  const { declarations } = parseCss(readFileSync(new URL('../ui/components/button-variants.css', import.meta.url), 'utf8'));
  const hasDecl = (selector, prop, valuePattern, ctxPattern = null) => declarations.some(
    (d) => d.ctx.at(-1) === selector
      && d.prop === prop
      && valuePattern.test(d.value)
      && (!ctxPattern || ctxPattern.test(d.ctx.join(' | '))),
  );
  assert.equal(hasDecl('.sh-btn--wrap', 'white-space', /^normal$/), true, 'sh-btn--wrap enables wrapping');
  assert.equal(hasDecl('.sh-btn--block', 'width', /^100%$/), true, 'sh-btn--block spans full width');
  assert.equal(hasDecl('.sh-btn--start', 'justify-content', /^flex-start$/), true, 'sh-btn--start aligns content to start');
  assert.equal(hasDecl('.sh-btn--center', 'justify-content', /^center$/), true, 'sh-btn--center centers content');
  assert.equal(hasDecl('.sh-btn--pill', 'border-radius', /^var\(\s*--radius-pill\s*\)$/), true, 'sh-btn--pill applies pill radius token');
  assert.equal(hasDecl('.sh-seg--fill', 'width', /^100%$/), true, 'sh-seg--fill spans full width');
  assert.equal(hasDecl('.sh-seg--wrap', 'flex-wrap', /^wrap$/), true, 'sh-seg--wrap enables wrapping');
  assert.equal(hasDecl('.sh-seg--stack', 'flex-direction', /^column$/, /@container study \(max-width:\s*480px\)/), true, 'sh-seg--stack stacks vertically in narrow study container');
  assert.equal(hasDecl('.sh-seg--xs', 'padding', /var\(\s*--space-1\s*\)/), true, 'sh-seg--xs tightens padding via spacing token');
  assert.equal(
    hasDecl('.sh-btn--pill', 'transition', /^none$/, /@media \(prefers-reduced-motion:\s*reduce\)/),
    true,
    'sh-btn--pill disables transition under prefers-reduced-motion: reduce',
  );
});
