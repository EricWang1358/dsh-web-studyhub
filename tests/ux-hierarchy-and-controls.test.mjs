import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../scripts/site-build.mjs';

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
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
}

function toLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
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
    const [r, g, b] = hexToRgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(hexA), lum(hexB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

test('light-theme text hierarchy maintains OKLab perceptual separation and WCAG AA contrast', async () => {
  const tokensCss = await read('ui/tokens.css');
  const light = extractBlock(tokensCss, '.study-app[data-theme="light"],');
  const levels = ['--text', '--text-dim', '--text-muted', '--text-faint'];
  const lValues = levels.map((name) => oklabL(light[name]));
  for (let i = 0; i < levels.length - 1; i += 1) {
    const delta = lValues[i + 1] - lValues[i];
    assert.ok(delta >= 6.5, `light ${levels[i]} -> ${levels[i + 1]} OKLab ΔL* must be >= 6.5, got ${delta.toFixed(2)}`);
  }
  for (const bg of ['--bg-canvas', '--bg-sunken', '--bg-surface', '--bg-raised', '--bg-selected']) {
    for (const fg of levels) {
      const ratio = wcagRatio(light[fg], light[bg]);
      assert.ok(ratio >= 4.5, `light ${fg} on ${bg} contrast ${ratio.toFixed(2)}:1 < 4.5:1`);
    }
  }
});

test('apparatus typography separates chrome/meta (--fs-sm) from reading copy (--fs-md)', async () => {
  const [baseCss, shellCss, catalogCss, deskCss] = await Promise.all([
    read('ui/base.css'),
    read('ui/shell.css'),
    read('ui/study-map/catalog.css'),
    read('ui/study-map/desk.css'),
  ]);
  assert.match(baseCss, /& small\s*\{[^}]*font-size:\s*var\(--fs-sm\)/);
  assert.match(baseCss, /\.eyebrow\s*\{[^}]*font-size:\s*var\(--fs-sm\)/);
  assert.match(baseCss, /& legend\s*\{[^}]*font-size:\s*var\(--fs-sm\)/);
  assert.match(baseCss, /\.small\s*\{[^}]*font-size:\s*var\(--fs-sm\)/);

  assert.match(shellCss, /\.brand small\s*\{[^}]*font-size:\s*var\(--fs-sm\)/);
  assert.match(shellCss, /\.nav-count\s*\{[^}]*font-size:\s*var\(--fs-sm\)/);
  assert.match(shellCss, /\.topbar\s*\{[^}]*font-size:\s*var\(--fs-sm\)/);
  assert.match(shellCss, /\.crumb\[aria-current="page"\]\s*\{[^}]*font-size:\s*var\(--fs-md\)/);
  assert.match(shellCss, /\.top-status\s*\{[^}]*font-size:\s*var\(--fs-sm\)/);

  assert.match(catalogCss, /\.map-legend\s*\{[^}]*font-size:\s*var\(--fs-sm\)/);
  assert.match(catalogCss, /\.map-name small\s*\{[^}]*font-size:\s*var\(--fs-sm\)/);
  assert.match(catalogCss, /\.mastery-value\s*\{[^}]*font-size:\s*var\(--fs-sm\)/);
  assert.match(deskCss, /\.desk-mastery-label\s*\{[^}]*font-size:\s*var\(--fs-sm\)/);
  assert.match(deskCss, /\.desk-next-label\s*\{[^}]*font-size:\s*var\(--fs-sm\)/);
  assert.match(deskCss, /\.today-card-head\s*\{[^}]*font-size:\s*var\(--fs-sm\)/);
});

test('button proportions, curvature, optical icon padding, and 5 geometry bug fixes hold', async () => {
  const [tokensCss, componentsCss, buttonJsx, inboxJsx, inboxCss, setupCss, deskCss, catalogCss, questionCss] = await Promise.all([
    read('ui/tokens.css'),
    read('ui/components/components.css'),
    read('ui/components/Button.jsx'),
    read('ui/Inbox.jsx'),
    read('ui/inbox.css'),
    read('ui/setup-checklist.css'),
    read('ui/study-map/desk.css'),
    read('ui/study-map/catalog.css'),
    read('ui/review/question.css'),
  ]);

  assert.match(tokensCss, /--control-h:\s*36px;/);
  assert.match(tokensCss, /--control-h-sm:\s*30px;/);
  assert.match(buttonJsx, /const iconSize = scale === 'sm' \? 15 : 16;/);

  // Curvature ratio & compact control height + optical icon padding
  assert.match(componentsCss, /\.sh-btn\s*\{[^}]*border-radius:\s*calc\(var\(--radius-sm\)\s*\*\s*0\.75\)/);
  assert.match(componentsCss, /\.sh-btn\s*\{[^}]*min-height:\s*var\(--control-h,\s*36px\)/);
  assert.match(componentsCss, /\.sh-btn--sm\s*\{[^}]*min-height:\s*var\(--control-h-sm,\s*30px\)/);
  assert.match(componentsCss, /:has\(>\s*:first-child:is\(\.sh-icon,\s*\.sh-spinner\)\)/);
  assert.match(componentsCss, /:has\(>\s*:last-child:is\(\.sh-icon,\s*\.sh-spinner\)\)/);

  // 1. IconButton never squishes in flex headers
  assert.match(componentsCss, /\.sh-btn--icon\s*\{[^}]*flex:\s*none/);
  // 2. Narrow-container rule does not inflate inline link buttons
  assert.match(componentsCss, /@container study \(max-width:\s*640px\)[\s\S]*\.sh-btn--md:not\(\.sh-btn--link\)/);
  // 3. Topbar mailbox toggle stays square
  assert.match(inboxJsx, /<IconButton[\s\S]*?size="sm"[\s\S]*?mailbox__toggle/);
  assert.match(inboxCss, /\.mailbox__toggle\s*\{[^}]*min-height:\s*0/);
  // 4. Today CTA & RoundSetup trigger align in height and radius
  assert.match(deskCss, /\.round-setup__trigger\s*\{[^}]*width:\s*42px;\s*min-height:\s*42px;[^}]*border-radius:\s*var\(--radius-sm\)/);
  assert.match(deskCss, /\.today-card \.today-go\s*\{[^}]*min-height:\s*42px;[^}]*border-radius:\s*var\(--radius-sm\)/);
  // 5. Notebook search aligns vertically without stretching its button
  assert.match(catalogCss, /\.nb-search\s*\{[^}]*align-items:\s*center/);
  // Semiotic fix: disclosure toggle is not a pill
  assert.doesNotMatch(setupCss.slice(setupCss.indexOf('.setup-chip-toggle')), /^\.setup-chip-toggle\s*\{[^}]*radius-pill/m);
  assert.match(setupCss, /\.setup-chip-toggle\s*\{[^}]*border-radius:\s*var\(--radius-sm\)/);
  // Question toolbar aligns flush with card width
  assert.match(questionCss, /\.question-toolbar\s*\{[^}]*padding:\s*0;/);
});

test('companions.css uses density-responsive --space-* tokens for layout spacing', async () => {
  const css = await read('ui/companions/companions.css');
  const spacingRem = [...css.matchAll(/(?:padding|margin|gap)(?:-[\w-]+)?:\s*[^;]*\b\d*\.?\d+rem\b/g)];
  assert.deepEqual(spacingRem.map((m) => m[0]), [], 'all padding/margin/gap spacing in companions.css uses --space-* tokens');
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
