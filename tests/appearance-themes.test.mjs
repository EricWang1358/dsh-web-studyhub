/* #66: two more themes (OLED black, 护眼纸色), a high-contrast setting, interface density and corner style. They are only data-* attributes on the
   app root plus token overrides in ui/appearance-themes.css: the tests check the pure settings module, the shape of that stylesheet (what each
   block is allowed to touch, that "standard" has no rule at all so it renders exactly as before, the size budget), that both hosts load it, and
   the Settings page. Contrast ratios of the new colours live in tests/wp1-tokens.test.mjs; the real layout is checked in the browser. */
import test from 'node:test';
import { warmSettingsPanes } from './helpers/settings-panes.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as appearance from '../ui/appearance-prefs.js';
import { readAppSource } from './helpers/app-source.mjs';

const { APPEARANCE_DEFAULTS, APPEARANCE_OPTIONS, APPEARANCE_LABELS, THEMES, THEME_CYCLE, normalizeAppearance, appearanceAttrs, exportAppearance, importAppearance,
  loadAppearance, saveAppearance } = appearance;
const han = /[㐀-鿿]/;
const calm = { light: false, reducedMotion: false, contrast: false };
const memory = (initial = {}) => { const map = new Map(Object.entries(initial)); return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), map }; };

/* ---------- the settings ---------- */

test('themes grow by two, the old three keep their place and the sidebar toggle keeps cycling only those', () => {
  assert.deepEqual([...THEMES], ['auto', 'dark', 'light', 'oled', 'paper']);
  assert.deepEqual([...THEME_CYCLE], ['auto', 'dark', 'light']);
  for (const id of THEME_CYCLE) assert.ok(THEMES.includes(id));
  assert.deepEqual(APPEARANCE_OPTIONS.theme, THEMES);
  assert.deepEqual({ oled: '纯黑 OLED', paper: '护眼纸色' }, { oled: APPEARANCE_LABELS.theme.oled, paper: APPEARANCE_LABELS.theme.paper });
});

test('contrast, density and corner style are settings with a default, a whitelist and a label for every value', () => {
  assert.deepEqual([APPEARANCE_DEFAULTS.contrast, APPEARANCE_DEFAULTS.density, APPEARANCE_DEFAULTS.radius], ['auto', 'standard', 'standard']);
  assert.deepEqual(APPEARANCE_OPTIONS.contrast, ['auto', 'standard', 'high']);
  assert.deepEqual(APPEARANCE_OPTIONS.density, ['compact', 'standard', 'comfortable']);
  assert.deepEqual(APPEARANCE_OPTIONS.radius, ['sharp', 'standard', 'soft']);
  for (const key of ['contrast', 'density', 'radius']) for (const value of APPEARANCE_OPTIONS[key]) assert.ok(APPEARANCE_LABELS[key][value], `${key}.${value} has a zh label`);
  assert.deepEqual(normalizeAppearance({ theme: 'oled', contrast: 'high', density: 'compact', radius: 'soft' }), { ...APPEARANCE_DEFAULTS, theme: 'oled', contrast: 'high', density: 'compact', radius: 'soft' });
  assert.deepEqual(normalizeAppearance({ contrast: 'max', density: 'tiny', radius: 'round', theme: 'amoled' }), { ...APPEARANCE_DEFAULTS }, 'values nobody offers fall back');
});

test('an old browser keeps its look, and the new settings are saved in the existing study-interface object', () => {
  assert.deepEqual(loadAppearance(memory({ 'study-theme': 'light', 'study-interface': JSON.stringify({ scale: 125 }) })), { ...APPEARANCE_DEFAULTS, theme: 'light', scale: 125 });
  const storage = memory();
  saveAppearance({ theme: 'paper', contrast: 'high', density: 'comfortable', radius: 'sharp' }, storage);
  assert.equal(storage.map.get('study-theme'), 'paper', 'the theme key stays one plain string');
  assert.deepEqual(JSON.parse(storage.map.get('study-interface')), { motion: 'auto', scale: 100, font: 'system', fontTitle: 'follow', fontCustom: '', accent: 'cinnabar', contrast: 'high', density: 'comfortable', radius: 'sharp' });
  assert.deepEqual(loadAppearance(storage), { ...APPEARANCE_DEFAULTS, theme: 'paper', contrast: 'high', density: 'comfortable', radius: 'sharp' });
});

test('export and import carry the new settings through the same whitelist', () => {
  const prefs = { ...APPEARANCE_DEFAULTS, theme: 'oled', contrast: 'high', density: 'compact', radius: 'soft' };
  assert.deepEqual(importAppearance(exportAppearance(prefs)), prefs);
  assert.deepEqual(importAppearance(JSON.stringify({ studyhubAppearance: 1, theme: 'paper', density: 'gigantic', radius: 'soft' })), { ...APPEARANCE_DEFAULTS, theme: 'paper', radius: 'soft' });
});

/* ---------- the attributes ---------- */

test('oled and paper ride on a base mode: data-theme stays dark or light (editors, the tour, every old rule), data-palette says which', () => {
  assert.equal(appearanceAttrs({ theme: 'oled' }, calm)['data-theme'], 'dark');
  assert.equal(appearanceAttrs({ theme: 'oled' }, calm)['data-palette'], 'oled');
  assert.equal(appearanceAttrs({ theme: 'paper' }, { ...calm, light: false })['data-theme'], 'light', 'an explicit choice wins over a dark OS');
  assert.equal(appearanceAttrs({ theme: 'paper' }, calm)['data-palette'], 'paper');
  for (const theme of ['auto', 'dark', 'light']) assert.equal(appearanceAttrs({ theme }, calm)['data-palette'], 'standard', theme);
  assert.equal(appearanceAttrs({ theme: 'light' }, calm)['data-theme'], 'light');
});

test('contrast: auto follows the OS "more contrast" request, an explicit choice wins, and only high or standard reach the DOM', () => {
  assert.equal(appearanceAttrs({}, calm)['data-contrast'], 'standard');
  assert.equal(appearanceAttrs({ contrast: 'auto' }, { ...calm, contrast: true })['data-contrast'], 'high');
  assert.equal(appearanceAttrs({ contrast: 'standard' }, { ...calm, contrast: true })['data-contrast'], 'standard');
  assert.equal(appearanceAttrs({ contrast: 'high' }, calm)['data-contrast'], 'high');
  assert.equal(appearanceAttrs({ contrast: 'bogus' }, { ...calm, contrast: true })['data-contrast'], 'high', 'junk is the default, and the default is auto');
});

test('density and radius reach the DOM as written, defaults as standard', () => {
  const attrs = appearanceAttrs({}, calm);
  assert.equal(attrs['data-density'], 'standard');
  assert.equal(attrs['data-radius'], 'standard');
  assert.equal(appearanceAttrs({ density: 'compact', radius: 'soft' }, calm)['data-density'], 'compact');
  assert.equal(appearanceAttrs({ density: 'compact', radius: 'soft' }, calm)['data-radius'], 'soft');
  assert.equal(appearanceAttrs({ density: '9', radius: 'x' }, calm)['data-density'], 'standard');
});

test('systemNow asks for the contrast preference too, without a matchMedia it is simply off', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  try {
    globalThis.matchMedia = query => ({ matches: query.includes('contrast') });
    assert.equal(appearance.systemNow().contrast, true);
    assert.equal(appearanceAttrs({})['data-contrast'], 'high');
    delete globalThis.matchMedia;
    assert.equal(appearance.systemNow().contrast, false);
  } finally { if (original) Object.defineProperty(globalThis, 'matchMedia', original); else delete globalThis.matchMedia; }
});

/* ---------- the stylesheet ---------- */

// The sheets are wrapped in @layer and the scope, so rules are indented; these tests read blocks by their selector line.
const normalize = text => text.replace(/\r\n/g, '\n').replace(/^[ \t]+/gm, '');
const themes = normalize(await readFile('ui/appearance-themes.css', 'utf8'));
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '');
/** Every top-level rule of the file (also inside @media): { selector, decls } with comments removed. */
function rules(source) {
  const out = [];
  const text = stripComments(source);
  const walk = (body, media = '') => {
    let i = 0;
    while (i < body.length) {
      const open = body.indexOf('{', i);
      if (open < 0) break;
      const head = body.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (depth && j < body.length) { depth += body[j] === '{' ? 1 : body[j] === '}' ? -1 : 0; j += 1; }
      const inner = body.slice(open + 1, j - 1);
      if (head.startsWith('@layer') || head === ':is(.study-app, .study-seat)') walk(inner, media);
      else if (head.startsWith('@media')) walk(inner, head);
      else out.push({ media, selector: head.replace(/\s+/g, ' '), decls: Object.fromEntries([...inner.matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)].map(([, name, value]) => [name, value.trim()])) });
      i = j;
    }
  };
  walk(text);
  return out;
}
const all = rules(themes);
const forAttr = (attr, value) => all.filter(rule => !rule.media && rule.selector.includes(`[${attr}='${value}']`));

test('the stylesheet fits the 4 KB budget and loads from both hosts', async () => {
  assert.ok(Buffer.byteLength(themes) <= 4096, `appearance-themes.css is ${Buffer.byteLength(themes)} bytes`);
  const [workspace, dev] = await Promise.all(['ui/host/workspace.jsx', 'ui/dev.jsx'].map(file => readFile(file, 'utf8')));
  assert.match(workspace, /import \w+ from ["']\.\.\/appearance-themes\.css["']/, 'the DSH host injects it');
  assert.match(workspace, /el\.textContent = [^\n]*\b(themesCss|appearanceThemesCss)\b/);
  assert.match(dev, /import ["']\.\/appearance-themes\.css["']/, 'the standalone preview bundles it');
  assert.ok(dev.indexOf('./styles.js') < dev.indexOf('./appearance-themes.css'), 'after the global sheets, so equal specificity resolves to the overrides');
});

test('every block exists for the app root and for the seat that hosts overlays beside it', () => {
  for (const [attr, value] of [['data-palette', 'oled'], ['data-palette', 'paper'], ['data-density', 'compact'], ['data-density', 'comfortable'], ['data-radius', 'sharp'], ['data-radius', 'soft'], ['data-contrast', 'high']]) {
    const found = forAttr(attr, value);
    assert.ok(found.length >= 1, `${attr}=${value}`);
    assert.ok(found.some(rule => rule.selector.includes(`.study-seat:has(> .study-app[${attr}='${value}']`)), `${attr}=${value} also reaches .study-seat`);
  }
});

test('standard, the default, has no rule: it renders exactly as before', () => {
  for (const [attr, value] of [['data-density', 'standard'], ['data-radius', 'standard'], ['data-palette', 'standard'], ['data-contrast', 'standard']])
    assert.equal(forAttr(attr, value).length, 0, `${attr}=${value}`);
});

test('density scales only --space-* and --lh-*, in order: compact < standard < comfortable', async () => {
  const style = normalize(await readFile('ui/tokens.css', 'utf8'));
  const base = Object.fromEntries([...style.slice(style.indexOf('.study-app,\n.study-seat {')).split('\n}')[0].matchAll(/(--(?:space|lh)-[\w]+)\s*:\s*([\d.]+)(px)?;/g)].map(([, name, value]) => [name, Number(value)]));
  assert.ok(Object.keys(base).length >= 12, 'the base block has the space and line-height tokens');
  for (const [value, direction] of [['compact', -1], ['comfortable', 1]]) {
    const decls = Object.assign({}, ...forAttr('data-density', value).map(rule => rule.decls));
    assert.deepEqual(Object.keys(decls).filter(name => !/^--(space|lh)-/.test(name)), [], `${value} touches only space and line height`);
    assert.deepEqual(Object.keys(decls).sort(), Object.keys(base).sort(), `${value} sets every one of them`);
    for (const [name, number] of Object.entries(decls)) assert.ok(direction * (parseFloat(number) - base[name]) > 0, `${value} ${name}: ${number} vs ${base[name]}`);
  }
  const compact = Object.assign({}, ...forAttr('data-density', 'compact').map(rule => rule.decls));
  const spaces = Object.entries(compact).filter(([name]) => name.startsWith('--space-')).map(([, number]) => parseFloat(number));
  assert.deepEqual([...spaces].sort((a, b) => a - b), spaces, 'the compact steps still grow');
  assert.ok(Math.min(...Object.entries(compact).filter(([name]) => name.startsWith('--lh-')).map(([, number]) => parseFloat(number))) >= 1.2, 'lines never collide');
});

test('corner style scales only --radius, --radius-sm and --radius-card, in order', async () => {
  const style = normalize(await readFile('ui/tokens.css', 'utf8'));
  const standard = Object.fromEntries(['--radius', '--radius-sm', '--radius-card'].map(name => [name, parseFloat(style.match(new RegExp(`\\n\\s*${name}:\\s*([\\d.]+)px`))[1])]));
  for (const [value, direction] of [['sharp', -1], ['soft', 1]]) {
    const decls = Object.assign({}, ...forAttr('data-radius', value).map(rule => rule.decls));
    assert.deepEqual(Object.keys(decls).sort(), ['--radius', '--radius-card', '--radius-sm'], `${value} sets exactly those three`);
    for (const [name, number] of Object.entries(decls)) assert.ok(direction * (parseFloat(number) - standard[name]) > 0, `${value} ${name}: ${number} vs ${standard[name]}`);
    assert.ok(parseFloat(decls['--radius-sm']) < parseFloat(decls['--radius']) && parseFloat(decls['--radius']) < parseFloat(decls['--radius-card']), `${value} keeps small < normal < card`);
  }
});

test('the extra palettes override tokens only: colours, shadows and the glass fill, no layout', () => {
  for (const value of ['oled', 'paper']) {
    const decls = Object.assign({}, ...forAttr('data-palette', value).map(rule => rule.decls));
    assert.ok(Object.keys(decls).length >= 10, `${value} is a real token block`);
    assert.deepEqual(Object.keys(decls).filter(name => !name.startsWith('--')), [], `${value} writes custom properties only`);
    assert.deepEqual(Object.keys(decls).filter(name => /^--(space|lh|radius|fs|font)/.test(name)), [], `${value} leaves layout tokens alone`);
    assert.ok(decls['--bg-canvas'] && decls['--line'], `${value} sets canvas and line`);
  }
});

test('palettes keep the cinnabar identity: the accent stays red-orange, no blue-violet hue anywhere in the new colours', () => {
  const hue = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return null;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  for (const value of ['oled', 'paper']) {
    const decls = Object.assign({}, ...forAttr('data-palette', value).map(rule => rule.decls));
    for (const [name, number] of Object.entries(decls)) {
      if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(number) || /^--(info)$/.test(name)) continue;
      const degrees = hue(number);
      if (degrees !== null) assert.ok(!(degrees >= 230 && degrees <= 300), `${value} ${name} ${number} is blue-violet (${degrees.toFixed(0)}deg)`);
    }
    if (decls['--accent']) { const degrees = hue(decls['--accent']); assert.ok(degrees < 20 || degrees > 340, `${value} accent stays cinnabar`); }
  }
});

test('high contrast overrides only lines, faint text, decoration and the focus ring, and has a block per base theme', () => {
  const allowed = /^--(line|line-soft|line-strong|text-faint|decor-faint|ring)$/;
  const blocks = forAttr('data-contrast', 'high');
  assert.ok(blocks.length >= 3, 'dark, light and card stock');
  for (const rule of blocks) for (const name of Object.keys(rule.decls).filter(name => name.startsWith('--')))
    assert.match(name, allowed, `${rule.selector.slice(0, 50)} sets ${name}`);
  assert.ok(blocks.some(rule => rule.selector.includes("[data-theme='light']")), 'light needs darker lines, not the dark ones');
  assert.ok(blocks.some(rule => rule.selector.includes(':is(')), 'card stock is re-scoped, so it needs its own lines');
  assert.ok(blocks.some(rule => /outline-width\s*:\s*3px|outline\s*:\s*3px/.test(JSON.stringify(rule.decls).replace(/"/g, '')) || rule.decls['outline-width'] === '3px'), 'a thicker focus outline');
});

test('forced colours: buttons, focus and selected states fall back to system colours', () => {
  const forced = all.filter(rule => rule.media.includes('forced-colors: active'));
  assert.ok(forced.length >= 3, 'rules inside @media (forced-colors: active)');
  const text = JSON.stringify(forced);
  assert.match(text, /:focus-visible/, 'focus');
  assert.match(text, /Highlight\b/, 'focus and selected use Highlight');
  assert.match(text, /HighlightText/, 'selected text');
  assert.match(text, /ButtonText|ButtonBorder/, 'buttons');
  assert.match(text, /aria-pressed/, 'segmented controls and toggles');
  assert.match(text, /\.sh-btn/, 'the shared Button');
  for (const rule of forced) assert.doesNotMatch(JSON.stringify(rule.decls), /var\(--|#[0-9a-f]{3,8}\b/i, `${rule.selector.slice(0, 40)} uses system colours only`);
});

test('no animation and no image or font in the new stylesheet', () => {
  assert.doesNotMatch(stripComments(themes), /@keyframes|animation|transition|url\(|@font-face|backdrop-filter|@import/);
});

/* ---------- Settings page ---------- */

async function bundle(contents) {
  const out = await build({ stdin: { contents, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  return mod.exports;
}

test('设置 › 界面 offers the new themes, contrast, density and corner style in both languages', async () => {
  const { Settings, setUiLanguage, ui } = await bundle("export { default as Settings } from './ui/Settings.jsx'; export { setUiLanguage, ui } from './ui/i18n.js';");
  await warmSettingsPanes(Settings);
  const noop = () => {};
  const render = extra => renderToStaticMarkup(React.createElement(Settings, { data: { settings: {}, focus: { courses: [] }, sources: [], decks: [], root: 'r' }, busy: false, act: noop, call: noop, host: {}, setNotice: noop,
    settings: {}, setSettings: noop, legacy: '', setLegacy: noop, exportData: noop, onRestored: noop, workspacePanel: null, coursePanel: null, onboardingPanel: null,
    appearance: { language: 'zh', onLanguage: noop, theme: 'dark', onTheme: noop, motion: 'auto', onMotion: noop, scale: 100, onScale: noop, font: 'system', onFont: noop,
      contrast: 'auto', onContrast: noop, density: 'standard', onDensity: noop, radius: 'standard', onRadius: noop, ...extra }, tourActive: true }));
  try {
    const zh = render({});
    for (const label of ['纯黑 OLED', '护眼纸色', '对比度', '高对比', '界面密度', '紧凑', '宽松', '圆角', '利落', '圆润']) assert.match(zh, new RegExp(label), label);
    assert.match(zh, /aria-label="对比度"/);
    for (const key of ['contrast', 'density', 'radius'])
      for (const zhLabel of Object.values(APPEARANCE_LABELS[key])) { setUiLanguage('en'); assert.doesNotMatch(ui(zhLabel), han, `${key}: ${zhLabel}`); setUiLanguage('zh'); }
    for (const zhLabel of [APPEARANCE_LABELS.theme.oled, APPEARANCE_LABELS.theme.paper, '对比度', '界面密度', '圆角', '外观 · ']) { setUiLanguage('en'); assert.doesNotMatch(ui(zhLabel), han, zhLabel); setUiLanguage('zh'); }
    setUiLanguage('en');
    const en = render({});
    for (const label of ['>Pure black \\(OLED\\)<', '>Paper \\(eye comfort\\)<', '>High<', '>Compact<', '>Comfortable<', '>Sharp<', '>Soft<']) assert.match(en, new RegExp(label), label);
    assert.doesNotMatch(render({ onContrast: undefined, onDensity: undefined, onRadius: undefined }), /界面密度|aria-label="Interface density"/, 'without the handlers there are no rows');
  } finally { setUiLanguage('zh'); }
});

test('App wires the three handlers and keeps the sidebar toggle on the three-step cycle', async () => {
  const app = await readAppSource();
  for (const key of ['contrast', 'density', 'radius']) assert.match(app, new RegExp(`on${key[0].toUpperCase()}${key.slice(1)}: \\(value\\) => updateAppearance\\(\\{ ${key}: value \\}\\)`), key);
  assert.match(app, /THEME_CYCLE/, 'the toggle cycles the short list, oled and paper are chosen in Settings');
});
