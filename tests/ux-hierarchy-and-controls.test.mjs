import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildSite } from '../scripts/site-build.mjs';
import { APPEARANCE_DEFAULTS, APPEARANCE_LABELS, APPEARANCE_OPTIONS, appearanceAttrs } from '../ui/appearance-prefs.js';
import { loadUi } from './helpers/ui-module.mjs';

const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');

function extractBlock(css, selectorStart) {
  const norm = css.replace(/\r\n/g, '\n').replace(/^[ \t]+/gm, '');
  const start = norm.indexOf(selectorStart);
  assert.ok(start >= 0, `missing block ${selectorStart}`);
  const open = norm.indexOf('{', start);
  const close = norm.indexOf('\n}', open);
  const body = norm.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
}

function hexToRgb(hex) {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  assert.ok(m, `expected opaque 6-digit hex, got ${hex}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
}

function mixHex(hexA, pctA, hexB) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB), w = pctA / 100;
  const rgb = a.map((v, i) => Math.round(v * w + b[i] * (1 - w)));
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function toLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function oklabL(hex) {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s) * 100;
}

function wcagRatio(hexA, hexB) {
  const lum = (hex) => {
    const [r, g, b] = hexToRgb(hex).map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(hexA), lum(hexB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

test('standard look is untouched by default; refined mode lives in opt-in data-craft="refined" loaded in all hosts', async () => {
  assert.equal(APPEARANCE_DEFAULTS.craft, 'standard');
  assert.deepEqual([...APPEARANCE_OPTIONS.craft], ['standard', 'refined']);
  assert.equal(appearanceAttrs({}, { light: false, reducedMotion: false, contrast: false })['data-craft'], 'standard');
  assert.equal(appearanceAttrs({ craft: 'refined' }, { light: false, reducedMotion: false, contrast: false })['data-craft'], 'refined');

  const [craftCss, tokensCss, baseCss, componentsCss, workspace, dev, demo] = await Promise.all([
    read('ui/appearance-craft.css'),
    read('ui/tokens.css'),
    read('ui/base.css'),
    read('ui/components/components.css'),
    read('ui/host/workspace.jsx'),
    read('ui/dev.jsx'),
    read('web-demo/main.jsx'),
  ]);

  assert.doesNotMatch(craftCss, /data-craft=['"]standard['"]/, 'standard default requires zero CSS rules');
  assert.match(baseCss, /& small\s*\{\s*font-size:\s*var\(--fs-md\)/, 'default base small stays untouched');
  assert.match(componentsCss, /min-height:\s*var\(--control-h,\s*40px\)/, 'default control height stays 40px');
  assert.doesNotMatch(tokensCss, /--control-h:/, 'default tokens leave control height at component default');

  assert.match(workspace, /import \w+ from ["']\.\.\/appearance-craft\.css["']/);
  assert.match(dev, /import ["']\.\/appearance-craft\.css["']/);
  assert.match(demo, /import ['"]\.\.\/ui\/appearance-craft\.css['"]/);
});

test('Settings > More appearance options renders 控件与字阶 in both languages', async () => {
  const { AppearanceSection, setUiLanguage, ui } = await loadUi(
    `export { default as AppearanceSection } from './ui/settings/AppearanceSection.jsx'; export { setUiLanguage, ui } from './ui/i18n.js';`,
  );
  const noop = () => {};
  const props = {
    appearance: {
      language: 'zh', onLanguage: noop, theme: 'dark', onTheme: noop, accent: 'cinnabar', onAccent: noop,
      scale: 100, onScale: noop, font: 'system', onFont: noop, craft: 'standard', onCraft: noop,
    },
  };
  try {
    setUiLanguage('zh');
    const zh = renderToStaticMarkup(React.createElement(AppearanceSection, props));
    assert.match(zh, /data-tour="settings-appearance-craft"/);
    assert.match(zh, />控件与字阶</);
    assert.match(zh, />精致紧凑</);
    setUiLanguage('en');
    const en = renderToStaticMarkup(React.createElement(AppearanceSection, { appearance: { ...props.appearance, language: 'en' } }));
    assert.match(en, />Controls &amp; hierarchy</);
    assert.match(en, />Refined compact</);
    for (const label of Object.values(APPEARANCE_LABELS.craft)) {
      assert.doesNotMatch(ui(label), /[㐀-鿿]/, `${label} is translated`);
    }
  } finally {
    setUiLanguage('zh');
  }
});

test('refined light-theme color-mix steps reach OKLab ΔL* >= 6.5 and WCAG AA >= 4.5:1 on all surfaces', async () => {
  const [tokensCss, craftCss] = await Promise.all([read('ui/tokens.css'), read('ui/appearance-craft.css')]);
  const light = extractBlock(tokensCss, '.study-app[data-theme="light"],');
  const dimExpr = craftCss.match(/--text-dim:\s*color-mix\(in srgb,\s*var\(--text\)\s*(\d+)%,\s*var\(--text-faint\)\)/);
  const mutedExpr = craftCss.match(/--text-muted:\s*color-mix\(in srgb,\s*var\(--text\)\s*(\d+)%,\s*var\(--text-faint\)\)/);
  assert.ok(dimExpr && mutedExpr, 'light contrast rebalancing uses color-mix of --text and --text-faint');

  const resolved = {
    '--text': light['--text'],
    '--text-dim': mixHex(light['--text'], Number(dimExpr[1]), light['--text-faint']),
    '--text-muted': mixHex(light['--text'], Number(mutedExpr[1]), light['--text-faint']),
    '--text-faint': light['--text-faint'],
  };
  const levels = Object.keys(resolved);
  const lVals = levels.map((k) => oklabL(resolved[k]));
  for (let i = 0; i < levels.length - 1; i += 1) {
    const delta = lVals[i + 1] - lVals[i];
    assert.ok(delta >= 6.5, `refined light ${levels[i]} -> ${levels[i + 1]} ΔL* = ${delta.toFixed(2)} < 6.5`);
  }
  for (const bg of ['--bg-canvas', '--bg-sunken', '--bg-surface', '--bg-raised', '--bg-selected']) {
    for (const fg of levels) {
      const ratio = wcagRatio(resolved[fg], light[bg]);
      assert.ok(ratio >= 4.5, `refined light ${fg} (${resolved[fg]}) on ${bg} (${light[bg]}): ${ratio.toFixed(2)}:1`);
    }
  }
});

test('non-aesthetic geometry bug fixes, companions tokenization, and refined overrides hold', async () => {
  const [componentsCss, inboxCss, companionsCss, craftCss] = await Promise.all([
    read('ui/components/components.css'),
    read('ui/inbox.css'),
    read('ui/companions/companions.css'),
    read('ui/appearance-craft.css'),
  ]);

  assert.match(componentsCss, /\.sh-btn--icon\s*\{[^}]*flex:\s*none/);
  assert.match(componentsCss, /@container study \(max-width:\s*640px\)[\s\S]*\.sh-btn--md:not\(\.sh-btn--link\)/);
  assert.match(inboxCss, /\.mailbox__toggle\s*\{[^}]*min-height:\s*0/);
  const spacingRem = [...companionsCss.matchAll(/(?:padding|margin|gap)(?:-[\w-]+)?:\s*[^;]*\b\d*\.?\d+rem\b/g)];
  assert.deepEqual(spacingRem.map((m) => m[0]), [], 'companions.css uses --space-* tokens for layout spacing');

  assert.match(craftCss, /--control-h:\s*36px/);
  assert.match(craftCss, /--control-h-sm:\s*30px/);
  assert.match(craftCss, /cursor:\s*not-allowed/);
  assert.match(craftCss, /:has\(>\s*:first-child:is\(\.sh-icon,\s*\.sh-spinner\)\)/);
  assert.match(craftCss, /\.setup-chip-toggle\s*\{[^}]*border-radius:\s*var\(--radius-sm\)/);
  assert.match(craftCss, /\.question-toolbar\s*\{[^}]*padding:\s*0;/);
});

test('landing page (index.html & en.html) uses Ink-desk dark/light tokens without indigo/glass drift', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studyhub-landing-ux-'));
  try {
    await buildSite({ outdir: dir });
    const [zh, en] = await Promise.all([readFile(join(dir, 'index.html'), 'utf8'), readFile(join(dir, 'en.html'), 'utf8')]);
    for (const html of [zh, en]) {
      for (const expected of ['--bg:#161412', '--accent:#c93d22', 'prefers-color-scheme: light', '--bg:#f1ede6', '--accent:#c03a1f', 'border-radius:var(--radius-sm)']) {
        assert.ok(html.includes(expected), `missing landing token/rule: ${expected}`);
      }
      assert.doesNotMatch(html, /#14171a|#1d2126|#2f353d|#6d72ff|#8b8bff|backdrop-filter|--glass/i, 'legacy slate/indigo/glass removed');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
