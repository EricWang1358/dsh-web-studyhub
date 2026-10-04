/* 强调色 (设置 › 界面, #63): five presets, cinnabar by default, switched by one data-accent attribute that overrides a handful of tokens per theme.
   The state lives in the unified appearance store; the colours live in ui/accent.css (injected right after style.css) and in style.css, whose
   card stock now derives its accent tints from var(--accent). Every preset x dark/light x card stock must keep the contrast the cinnabar
   desk has (tests/wp1-tokens): accent text on every surface, the ink on the accent fill, the accent as a visible rule on the canvas and on paper. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as appearance from '../ui/appearance-prefs.js';

const { APPEARANCE_DEFAULTS, APPEARANCE_OPTIONS, APPEARANCE_LABELS, normalizeAppearance, appearanceAttrs, exportAppearance, importAppearance } = appearance;
const read = async file => (await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const PRESETS = ['cinnabar', 'jade', 'ochre', 'graphite', 'plum'];
const dark = { light: false, reducedMotion: false };

/* ---------- the state ---------- */

test('accent is one more appearance setting: five presets, cinnabar by default, the whitelist of an import', () => {
  assert.deepEqual(APPEARANCE_OPTIONS.accent, PRESETS);
  assert.equal(APPEARANCE_DEFAULTS.accent, 'cinnabar');
  assert.equal(normalizeAppearance({ accent: 'jade' }).accent, 'jade');
  for (const bad of ['neon', '#ff00ff', 'JADE', '', null, 7, undefined]) assert.equal(normalizeAppearance({ accent: bad }).accent, 'cinnabar', String(bad));
  assert.deepEqual(importAppearance(exportAppearance({ accent: 'plum', theme: 'light' })), { ...APPEARANCE_DEFAULTS, accent: 'plum', theme: 'light' });
  assert.equal(importAppearance(JSON.stringify({ studyhubAppearance: 1, accent: 'url(javascript:x)' })).accent, 'cinnabar', 'an import cannot set a colour outside the list');
  assert.equal(appearanceAttrs({ accent: 'ochre' }, dark)['data-accent'], 'ochre');
  assert.equal(appearanceAttrs({}, dark)['data-accent'], 'cinnabar');
  assert.equal(appearanceAttrs({ accent: 'bogus' }, dark)['data-accent'], 'cinnabar', 'an invalid value never reaches the DOM');
});

test('every preset has a zh label and an English one', async () => {
  const en = JSON.parse(await read('ui/locales/en.json'));
  assert.deepEqual(Object.keys(APPEARANCE_LABELS.accent), PRESETS);
  for (const zh of [...Object.values(APPEARANCE_LABELS.accent), '强调色']) assert.ok(en[zh] && !/[㐀-鿿]/.test(en[zh]), `${zh} has an English entry`);
});

test('Settings offers the accent row, App wires it to the store, and the empty page gets it through the shared attributes', async () => {
  const [settings, app, page] = await Promise.all(['ui/Settings.jsx', 'ui/App.jsx', 'ui/host/studyhub-page.jsx'].map(read));
  assert.match(settings, /appearance\.onAccent/);
  assert.match(settings, /appearanceOptions\(["']accent["']\)/);
  assert.match(app, /onAccent:\s*\(value\)\s*=>\s*updateAppearance\(\{\s*accent:\s*value\s*\}\)/);
  assert.match(page, /useAppearanceAttrs/);
});

test('accent.css reaches both builds: the DSH host injects it right after style.css, the preview imports it right after style.css', async () => {
  const [workspace, dev] = await Promise.all(['ui/host/workspace.jsx', 'ui/dev.jsx'].map(read));
  assert.match(workspace, /import accentCss from ["']\.\.\/accent\.css["']/);
  assert.match(workspace, /css \+ ["']\\n["'] \+ accentCss/);
  assert.ok(dev.indexOf('./style.css') >= 0 && dev.indexOf('./accent.css') > dev.indexOf('./style.css'), 'imported after style.css');
});

/* ---------- the colours ---------- */

const styleCss = await read('ui/style.css');
const accentCss = await read('ui/accent.css');

/** A tiny CSS reader: rules with declarations and nested rules; comments dropped. Good enough for custom-property blocks. */
function parse(text) {
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  function body() {
    const node = { decls: {}, kids: [] };
    for (;;) {
      let j = i;
      while (j < text.length && !';{}'.includes(text[j])) j++;
      const statement = text.slice(i, j).trim(), end = text[j];
      i = j + 1;
      if (end === '{') { const kid = body(); kid.selector = statement; node.kids.push(kid); }
      else {
        const match = statement.match(/^(--[\w-]+)\s*:\s*([\s\S]+)$/);
        if (match) node.decls[match[1]] = match[2].trim();
        if (end === '}' || end === undefined) return node;
      }
      if (j >= text.length) return node;
    }
  }
  return body().kids;
}
const rule = (rules, selectorStart) => {
  const found = rules.find(r => r.selector.startsWith(selectorStart));
  assert.ok(found, `rule ${selectorStart}`);
  return found;
};
const styleRules = parse(styleCss);
const darkBase = rule(styleRules, '.study-app,\n.study-seat').decls;
const lightBase = rule(styleRules, '.study-app[data-theme="light"],').decls;
const cardBase = rule(styleRules, '.study-app :is(.today-card').decls;
const accentRules = parse(accentCss);
const presetRule = name => accentRules.find(r => r.selector.includes(`[data-accent=${name}]`));
/** The tokens a preset sets in one theme (the dark values, with the light ones on top for light). */
function overrides(name, theme) {
  const r = presetRule(name);
  if (!r) return {};
  const light = r.kids.find(k => /data-theme=light/.test(k.selector));
  return theme === 'light' ? { ...r.decls, ...light?.decls } : { ...r.decls };
}

const clamp = (x) => Math.min(255, Math.max(0, x));
/** A colour as [r, g, b, a] (0..255, 0..1): hex, var(), transparent, black and color-mix(in srgb, A p%, B). */
function color(value, scope) {
  value = value.trim();
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (ref) { assert.ok(scope[ref[1]], `${ref[1]} is defined`); return color(scope[ref[1]], scope); }
  if (value === 'transparent') return [0, 0, 0, 0];
  if (value === 'black') return [0, 0, 0, 1];
  const hex = value.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (hex) return [0, 2, 4].map(k => parseInt(hex[1].slice(k, k + 2), 16)).concat(hex[2] ? parseInt(hex[2], 16) / 255 : 1);
  const mixed = value.match(/^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,\s*(.+)\)$/);
  assert.ok(mixed, `a colour I can read, got ${value}`);
  const p = Number(mixed[2]) / 100, [a, b] = [color(mixed[1], scope), color(mixed[3], scope)];
  const alpha = a[3] * p + b[3] * (1 - p);
  return [0, 1, 2].map(k => alpha ? (a[k] * a[3] * p + b[k] * b[3] * (1 - p)) / alpha : 0).concat(alpha);
}
const over = (fg, bg) => [0, 1, 2].map(k => fg[k] * fg[3] + bg[k] * (1 - fg[3]));
const channel = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * channel(clamp(r)) + 0.7152 * channel(clamp(g)) + 0.0722 * channel(clamp(b));
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
/** Contrast of token `fg` on the opaque token `bg` in a scope. */
const ratio = (scope, fg, bg) => contrast(color(`var(${fg})`, scope), color(`var(${bg})`, scope));
const scopeOf = (name, theme) => ({ ...darkBase, ...(theme === 'light' ? lightBase : {}), ...overrides(name, theme) });

test('accent.css overrides a handful of tokens for each non-default preset, dark and light, and cinnabar needs no override at all', () => {
  assert.ok(Buffer.byteLength(accentCss) <= 2048, `accent.css is ${Buffer.byteLength(accentCss)} bytes, the budget is 2048`);
  assert.equal(presetRule('cinnabar'), undefined, 'the default renders from style.css alone');
  const names = new Set(['--accent', '--accent-soft', '--accent-text', '--bg-selected', '--accent-ink']);
  for (const name of PRESETS.slice(1)) {
    const r = presetRule(name);
    assert.ok(r, `${name} has a rule`);
    const light = r.kids.find(k => /data-theme=light/.test(k.selector));
    assert.ok(light, `${name} has a light block`);
    for (const set of [r.decls, light.decls]) {
      for (const key of Object.keys(set)) assert.ok(names.has(key), `${name}: ${key} is one of the accent tokens`);
      for (const key of ['--accent', '--accent-soft', '--accent-text', '--bg-selected']) assert.match(set[key] ?? '', /^#[0-9a-f]{6}$/i, `${name} sets ${key}`);
    }
    assert.match(r.selector, /\.study-app/);
    assert.match(r.selector, /\.study-seat/, `${name} reaches the seat too (host overlays), like the typeface does`);
  }
});

test('the accent is written once: style.css keeps a literal only in the two --accent lines, the card stock and the glow and ring derive from it', () => {
  assert.equal((styleCss.match(/c93d22|c03a1f/gi) || []).length, 2, 'dark and light --accent are the only cinnabar literals');
  assert.match(styleCss, /--accent-glow:\s*color-mix\(in srgb, var\(--accent\)/);
  assert.match(styleCss, /--ring:\s*0 0 0 3px color-mix\(in srgb, var\(--accent\)/);
  for (const key of ['--bg-selected', '--accent-soft', '--accent-glow', '--ring'])
    assert.match(cardBase[key], /color-mix\(in srgb, var\(--accent\)/, `card stock ${key} derives from --accent`);
  assert.doesNotMatch(Object.values(cardBase).join(' '), /c93d22|c03a1f|b3361c/i, 'no literal cinnabar on the card');
});

test('cinnabar renders as before: the derived card and glow tints equal the old literals (within rounding)', () => {
  const close = (a, b, tolerance, label) => a.forEach((x, k) => assert.ok(Math.abs(x - b[k]) <= tolerance, `${label}: ${a.map(Math.round)} vs ${b.map(Math.round)}`));
  const dk = scopeOf('cinnabar', 'dark'), card = { ...dk, ...cardBase };
  close(color(card['--bg-selected'], card).slice(0, 3), [201, 61, 34], 0.5, 'selected rgb');
  assert.ok(Math.abs(color(card['--bg-selected'], card)[3] - 0x14 / 255) < 0.003, 'selected alpha is #14');
  assert.ok(Math.abs(color(card['--accent-glow'], card)[3] - 0x33 / 255) < 0.003, 'card glow alpha is #33');
  close(color(card['--accent-soft'], card), [0xb3, 0x36, 0x1c, 1], 2.5, 'card accent-soft');
  assert.ok(Math.abs(color(dk['--accent-glow'], dk)[3] - 0x47 / 255) < 0.003, 'dark glow alpha is #47');
  assert.ok(Math.abs(color(dk['--ring'].replace('0 0 0 3px ', ''), dk)[3] - 0x40 / 255) < 0.003, 'dark ring alpha is #40');
  const lt = scopeOf('cinnabar', 'light');
  assert.ok(Math.abs(color(lt['--accent-glow'], lt)[3] - 0x33 / 255) < 0.003, 'light glow alpha is #33');
  assert.ok(Math.abs(color(lt['--ring'].replace('0 0 0 3px ', ''), lt)[3] - 0x33 / 255) < 0.003, 'light ring alpha is #33');
  assert.equal(dk['--accent'], '#c93d22');
  assert.equal(lt['--accent'], '#c03a1f');
});

const SURFACES = ['--bg-canvas', '--bg-sunken', '--bg-surface', '--bg-raised', '--bg-selected'];
for (const name of PRESETS) for (const theme of ['dark', 'light']) {
  test(`${name} (${theme}): accent text is AA on every surface, the ink is AA on the fill, the accent and its outline are visible`, () => {
    const scope = scopeOf(name, theme), failures = [];
    for (const bg of SURFACES) { const r = ratio(scope, '--accent-text', bg); if (r < 4.5) failures.push(`--accent-text on ${bg}: ${r.toFixed(2)}`); }
    const ink = ratio(scope, '--accent-ink', '--accent');
    if (ink < 4.5) failures.push(`--accent-ink on --accent: ${ink.toFixed(2)}`);
    for (const token of ['--accent', '--accent-soft']) { const r = ratio(scope, token, '--bg-canvas'); if (r < 3) failures.push(`${token} on the canvas (a rule, a focus outline): ${r.toFixed(2)}`); }
    assert.deepEqual(failures, []);
  });
  test(`${name} (${theme}) on card stock: the accent rule and fill show on paper, the derived tint and outline stay readable`, () => {
    const scope = { ...scopeOf(name, theme), ...cardBase }, failures = [], paper = color('var(--bg-raised)', scope);
    for (const [token, min] of [['--accent', 3], ['--accent-soft', 4.5]]) { const r = ratio(scope, token, '--bg-raised'); if (r < min) failures.push(`${token} on paper: ${r.toFixed(2)} < ${min}`); }
    const ink = ratio(scope, '--accent-ink', '--accent');
    if (ink < 4.5) failures.push(`--accent-ink on --accent: ${ink.toFixed(2)}`);
    /* A selected row on paper: AA, except where the default itself is below it (--text-faint and --accent-soft of cinnabar on the dark paper, 4.16 and 4.32,
       as shipped): a preset must be no worse than cinnabar. */
    const base = { ...scopeOf('cinnabar', theme), ...cardBase }, baseSolid = over(color('var(--bg-selected)', base), color('var(--bg-raised)', base));
    const solid = over(color('var(--bg-selected)', scope), paper);
    for (const fg of ['--text', '--text-dim', '--text-muted', '--text-faint', '--accent-soft']) {
      const floor = Math.min(4.5, contrast(color(`var(${fg})`, base), baseSolid) - 0.01), r = contrast(color(`var(${fg})`, scope), solid);
      if (r < floor) failures.push(`${fg} on a selected card row: ${r.toFixed(2)} < ${floor.toFixed(2)}`);
    }
    assert.deepEqual(failures, []);
  });
}

test('the presets are distinct and none is blue-violet (ui/DESIGN.md): the accent hue stays out of 215-290 degrees', () => {
  const hue = ([r, g, b]) => { const [x, y, z] = [r, g, b].map(v => v / 255), max = Math.max(x, y, z), d = max - Math.min(x, y, z); if (!d) return 0; const h = max === x ? ((y - z) / d) % 6 : max === y ? (z - x) / d + 2 : (x - y) / d + 4; return (h * 60 + 360) % 360; };
  const seen = new Set();
  for (const name of PRESETS) for (const theme of ['dark', 'light']) {
    const value = scopeOf(name, theme)['--accent'];
    seen.add(value);
    const [r, g, b] = color(value, {}), sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (sat > 24) assert.ok(hue([r, g, b]) < 215 || hue([r, g, b]) > 290, `${name} ${theme} ${value} hue ${hue([r, g, b]).toFixed(0)}`);
  }
  assert.equal(seen.size, PRESETS.length * 2, 'every preset and theme has its own colour');
});
