import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// P52: text tokens must be readable (WCAG AA, 4.5:1) on every surface they sit
// on, in both themes and on card stock. Decoration that used --text-faint gets
// its own --decor-faint so raising text contrast does not brighten dots/rules.
const css = (await readFile('ui/style.css', 'utf8')).replace(/\r\n/g, '\n');
function block(selectorStart) {
  const start = css.indexOf(selectorStart);
  assert.ok(start >= 0, `token block ${selectorStart}`);
  const open = css.indexOf('{', start), close = css.indexOf('\n}', open);
  const body = css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}
const dark = block('.study-app,\n.study-seat {');
const light = block('.study-app[data-theme="light"],');
const card = block('.study-app :is(.today-card');
const resolve = (value, scope) => {
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolve(scope[ref[1]], scope) : value;
};
const channel = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
function luminance(hex) {
  const match = hex.match(/^#([0-9a-f]{6})$/i);
  assert.ok(match, `opaque hex colour expected, got ${hex}`);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(match[1].slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const TEXT = ['--text', '--text-dim', '--text-muted', '--text-faint', '--accent-text', '--ok', '--warn', '--bad', '--info'];
const SURFACES = ['--bg-canvas', '--bg-sunken', '--bg-surface', '--bg-raised', '--bg-selected'];

for (const [name, scope] of [['dark', dark], ['light', { ...dark, ...light }]]) {
  test(`${name} text tokens reach 4.5:1 on every surface`, () => {
    const failures = [];
    for (const fg of TEXT) for (const bg of SURFACES) {
      const ratio = contrast(resolve(scope[fg], scope), resolve(scope[bg], scope));
      if (ratio < 4.5) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
    }
    assert.deepEqual(failures, []);
  });
}

test('text on card stock reaches 4.5:1 on paper in both themes', () => {
  const failures = [];
  for (const [name, theme] of [['dark', dark], ['light', { ...dark, ...light }]]) {
    const scope = { ...theme, ...card };
    for (const fg of ['--text', '--text-dim', '--text-muted', '--text-faint']) {
      const ratio = contrast(resolve(scope[fg], scope), resolve(scope['--bg-raised'], scope));
      if (ratio < 4.5) failures.push(`${name} ${fg} on paper: ${ratio.toFixed(2)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('decoration has its own faint token and the old faint values are kept for it', () => {
  for (const scope of [dark, light, card]) assert.ok(scope['--decor-faint'], '--decor-faint is defined');
  assert.ok(contrast(resolve(dark['--decor-faint'], dark), dark['--bg-canvas']) < contrast(dark['--text-faint'], dark['--bg-canvas']), 'decoration stays quieter than text');
  assert.ok(contrast(light['--decor-faint'], light['--bg-canvas']) < contrast(light['--text-faint'], light['--bg-canvas']));
});

test('type scale and spacing tokens exist and nothing is smaller than 12px', () => {
  const sizes = Object.entries(dark).filter(([name]) => name.startsWith('--fs-'));
  assert.ok(sizes.length >= 6, 'a type scale of at least six steps');
  for (const [name, value] of sizes) assert.ok(parseFloat(value) >= 12, `${name}: ${value}`);
  const spaces = Object.entries(dark).filter(([name]) => name.startsWith('--space-'));
  assert.ok(spaces.length >= 8, 'a spacing scale of at least eight steps');
  const values = spaces.map(([, value]) => parseFloat(value));
  assert.deepEqual([...values].sort((a, b) => a - b), values, 'spacing grows monotonically');
});

test('decorative paints use --decor-faint and text never uses it', async () => {
  const offenders = [];
  const files = (await readdir('ui', { recursive: true })).filter(name => /\.(css|jsx)$/.test(name));
  for (const name of files) {
    const source = await readFile(`ui/${name}`, 'utf8');
    for (const [line, text] of source.split(/\r?\n/).entries()) {
      // `fill` is left out: SVG labels (.gn-ghost-label, .dash-trend-label) are text.
      if (/(background|border[\w-]*|stroke|box-shadow)\s*:[^;]*var\(--text-faint\)/.test(text)) offenders.push(`${name}:${line + 1} decorative --text-faint`);
      if (/(^|[^-])color\s*:\s*var\(--decor-faint\)/.test(text)) offenders.push(`${name}:${line + 1} text uses --decor-faint`);
      if (/"text-faint"/.test(text)) offenders.push(`${name}:${line + 1} inline decorative --text-faint`);
    }
  }
  assert.deepEqual(offenders, []);
});
