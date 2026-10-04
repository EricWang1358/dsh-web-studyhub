import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// UI wave 5A, overlays: #76 (scrim colours and z-index tokens), #77 (one popover surface), #82 (non-modal semantics).
const walk = (dir, ext) => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(`${dir}/${entry.name}`, ext) : entry.name.endsWith(ext) ? [`${dir}/${entry.name}`] : []);
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const sheets = walk('ui', '.css').map(file => ({ file, css: read(file).replace(/\/\*[\s\S]*?\*\//g, '') }));
const RAW_COLOUR = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i;

test('#76 every ::backdrop and scrim rule is painted from tokens, never a raw colour', () => {
  const bad = [];
  for (const { file, css } of sheets) for (const match of css.matchAll(/([^{}]*(?:::backdrop|scrim)[^{}]*)\{([^{}]*)\}/g)) {
    const background = /background(?:-color)?\s*:\s*([^;]+)/.exec(match[2])?.[1] || '';
    if (RAW_COLOUR.test(background)) bad.push(`${file}: ${match[1].trim()}`);
  }
  assert.deepEqual(bad, []);
});

test('#76 a numeric z-index above 2 does not exist: layers are var(--z-*) and the expanded canvas lives in the top layer', () => {
  const bad = [];
  for (const { file, css } of sheets) {
    if (file === 'ui/tokens.css') continue;
    for (const match of css.matchAll(/z-index\s*:\s*(-?\d+)\b/g)) if (Number(match[1]) > 2) bad.push(`${file}: z-index ${match[1]}`);
  }
  assert.deepEqual(bad, []);
  assert.doesNotMatch(sheets.find(sheet => sheet.file === 'ui/skeleton.css').css, /z-index\s*:\s*\d{3,}/);
});

const leafRules = css => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selector: match[1].trim(), body: match[2] }));

test('#77 the floating panels share one surface: a feature rule for them writes position and size, never border, corner, fill, shadow or blur', () => {
  const shared = ['.reader-popover__panel', '.shortcut-sheet', '.page-peek', '.course-field__panel', '.thumb-tray'];
  const overlays = sheets.find(sheet => sheet.file === 'ui/components/overlays.css').css;
  const surface = leafRules(overlays).find(rule => /\.shortcut-sheet/.test(rule.selector));
  for (const name of shared) assert.ok(surface.selector.includes(name), `${name} is in the shared surface rule`);
  assert.match(surface.body, /border-radius:\s*var\(--radius\)/);
  assert.match(surface.body, /box-shadow:\s*var\(--shadow-md\)/);
  const bad = [];
  for (const { file, css } of sheets) {
    if (file === 'ui/components/overlays.css') continue;
    for (const { selector, body } of leafRules(css)) {
      if (!selector.split(',').some(part => shared.some(name => part.trim().endsWith(name)))) continue;
      for (const property of ['border', 'border-radius', 'background', 'background-color', 'box-shadow', 'backdrop-filter']) if (new RegExp(`(?:^|[;\\s])${property}\\s*:`).test(body)) bad.push(`${file}: ${selector} sets ${property}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('#77 no panel is glass: backdrop-filter exists only on a dialog ::backdrop, and the old per-feature menu surfaces are gone', () => {
  const bad = [];
  for (const { file, css } of sheets) for (const { selector, body } of leafRules(css)) if (/backdrop-filter\s*:/.test(body) && !selector.includes('::backdrop')) bad.push(`${file}: ${selector}`);
  assert.deepEqual(bad, []);
  const all = sheets.map(sheet => sheet.css).join('\n');
  for (const old of ['.map-menu {', '.review-more-menu {', '.publication-mark-popover {', '.inbox-panel {', '.board-menu {', '.tr-menu__list {', '.skc-layout-menu > div']) assert.ok(!all.includes(old), old);
});

test('#76 both themes define --scrim and --scrim-strong', () => {
  const tokens = read('ui/tokens.css');
  const light = tokens.slice(tokens.indexOf('light-dark(') > -1 ? tokens.indexOf('--scrim: light-dark(') : 0);
  assert.match(tokens, /--scrim:\s*color-mix/);
  assert.match(tokens, /--scrim-strong:\s*color-mix/);
  assert.match(light, /--scrim:\s*light-dark\(/);
  assert.match(light, /--scrim-strong:\s*light-dark\(/);
});
