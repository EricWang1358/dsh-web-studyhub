import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// P52: text tokens must be readable (WCAG AA, 4.5:1) on every surface they sit
// on, in both themes and on card stock. Decoration that used --text-faint gets
// its own --decor-faint so raising text contrast does not brighten dots/rules.
const css = ((await readFile('ui/tokens.css', 'utf8')) + '\n' + (await readFile('ui/paper.css', 'utf8'))).replace(/\r\n/g, '\n');
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

// #66: the extra themes and the high-contrast setting (ui/appearance-themes.css) must reach the same bar. Each scope is built the way the cascade
// does it: the dark base, then the light theme where the palette sits on it, then the palette, then high contrast, then card stock on top.
const themesCss = (await readFile('ui/appearance-themes.css', 'utf8')).replace(/\r\n/g, '\n');
function themeBlock(selectorStart) {
  const start = themesCss.indexOf(selectorStart);
  assert.ok(start >= 0, `theme block ${selectorStart}`);
  const open = themesCss.indexOf('{', start), close = themesCss.indexOf('\n}', open);
  const body = themesCss.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}
const oled = themeBlock(".study-app[data-palette='oled'],");
const paper = themeBlock(".study-app[data-palette='paper'],");
const highDark = themeBlock(".study-app[data-contrast='high'],");
const highLight = themeBlock(".study-app[data-contrast='high'][data-theme='light'],");
const highCard = themeBlock(".study-app[data-contrast='high'] :is(");
const lightScope = { ...dark, ...light };
const scopes = [
  ['oled', { ...dark, ...oled }], ['paper', { ...lightScope, ...paper }],
  ['dark + high contrast', { ...dark, ...highDark }], ['light + high contrast', { ...lightScope, ...highLight }],
  ['oled + high contrast', { ...dark, ...oled, ...highDark }], ['paper + high contrast', { ...lightScope, ...paper, ...highLight }],
];

for (const [name, scope] of scopes) {
  test(`${name}: text tokens reach 4.5:1 on every surface`, () => {
    const failures = [];
    for (const fg of TEXT) for (const bg of SURFACES) {
      const ratio = contrast(resolve(scope[fg], scope), resolve(scope[bg], scope));
      if (ratio < 4.5) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}`);
    }
    assert.deepEqual(failures, []);
  });
}

test('text on card stock reaches 4.5:1 on paper in the extra themes and under high contrast', () => {
  const failures = [];
  for (const [name, theme] of scopes) {
    const scope = { ...theme, ...card, ...(name.includes('high') ? highCard : {}) };
    for (const fg of ['--text', '--text-dim', '--text-muted', '--text-faint']) {
      const ratio = contrast(resolve(scope[fg], scope), resolve(scope['--bg-raised'], scope));
      if (ratio < 4.5) failures.push(`${name} ${fg} on paper: ${ratio.toFixed(2)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('high contrast: lines are visible (3:1) on the surfaces, faint text and decoration are clearly stronger than standard', () => {
  const failures = [];
  for (const [name, scope] of scopes.filter(([name]) => name.includes('high'))) {
    for (const line of ['--line', '--line-strong']) for (const bg of ['--bg-canvas', '--bg-surface', '--bg-raised']) {
      const ratio = contrast(resolve(scope[line], scope), resolve(scope[bg], scope));
      if (ratio < 3) failures.push(`${name} ${line} on ${bg}: ${ratio.toFixed(2)}`);
    }
    for (const bg of SURFACES) {
      const ratio = contrast(resolve(scope['--text-faint'], scope), resolve(scope[bg], scope));
      if (ratio < 7) failures.push(`${name} --text-faint on ${bg}: ${ratio.toFixed(2)} (7:1 expected)`);
    }
    const decor = contrast(resolve(scope['--decor-faint'], scope), resolve(scope['--bg-canvas'], scope));
    if (decor < 3) failures.push(`${name} --decor-faint on canvas: ${decor.toFixed(2)}`);
    const cardScope = { ...scope, ...card, ...highCard };
    for (const line of ['--line', '--line-strong']) {
      const ratio = contrast(resolve(cardScope[line], cardScope), resolve(cardScope['--bg-raised'], cardScope));
      if (ratio < 3) failures.push(`${name} card ${line} on paper: ${ratio.toFixed(2)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('the new themes keep the desk hierarchy and the cinnabar accent', () => {
  const luminances = ['--bg-sunken', '--bg-canvas', '--bg-surface', '--bg-raised'].map(name => luminance(oled[name]));
  assert.deepEqual([...luminances].sort((a, b) => a - b), luminances, 'oled layers grow lighter from the sunken desk to the raised card');
  assert.ok(luminance(oled['--bg-canvas']) <= luminance('#0b0a09'), 'oled canvas is near black');
  assert.ok(luminance(paper['--bg-canvas']) < luminance(paper['--bg-surface']), 'paper surfaces sit lighter than the desk');
  assert.equal(oled['--accent'] ?? dark['--accent'], dark['--accent'], 'oled keeps the same accent');
});
