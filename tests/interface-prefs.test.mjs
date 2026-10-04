import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INTERFACE_DEFAULTS, MOTIONS, normalizeInterface, loadInterface, saveInterface, effectiveMotion, leaveDelayMs, INTERFACE_KEY } from '../ui/interface-prefs.js';

/* Interface preferences (设置 › 界面): how much the interface moves. Stored per browser; "auto" follows the system's reduced-motion setting. */

const memory = (initial = {}) => { const map = new Map(Object.entries(initial)); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), map }; };

test('four motion choices, "auto" by default, and anything stored that is not one of them falls back', () => {
  assert.deepEqual(MOTIONS, ['auto', 'full', 'reduced', 'off']);
  assert.equal(INTERFACE_DEFAULTS.motion, 'auto');
  assert.deepEqual(normalizeInterface(null), INTERFACE_DEFAULTS);
  assert.deepEqual(normalizeInterface({ motion: 'off' }).motion, 'off');
  assert.equal(normalizeInterface({ motion: 'wild' }).motion, 'auto');
  assert.equal(normalizeInterface('nope').motion, 'auto');
});

test('the choice is remembered per browser; a blocked or corrupt storage costs nothing', () => {
  const storage = memory();
  assert.deepEqual(loadInterface(storage), INTERFACE_DEFAULTS);
  saveInterface({ motion: 'reduced' }, storage);
  assert.equal(JSON.parse(storage.map.get(INTERFACE_KEY)).motion, 'reduced');
  assert.equal(loadInterface(storage).motion, 'reduced');
  assert.deepEqual(loadInterface(memory({ [INTERFACE_KEY]: 'not json' })), INTERFACE_DEFAULTS);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadInterface(blocked), INTERFACE_DEFAULTS);
  assert.doesNotThrow(() => saveInterface({ motion: 'off' }, blocked));
});

test('what actually runs: auto follows the system, an explicit choice wins', () => {
  assert.equal(effectiveMotion('auto', false), 'full');
  assert.equal(effectiveMotion('auto', true), 'reduced', 'the system asks for less motion');
  assert.equal(effectiveMotion('full', true), 'full', 'the learner overrides the system');
  assert.equal(effectiveMotion('reduced', false), 'reduced');
  assert.equal(effectiveMotion('off', false), 'off');
});

test('switching pages waits for the leave animation only when there is one', () => {
  assert.equal(leaveDelayMs('full'), 90);
  assert.equal(leaveDelayMs('reduced'), 0);
  assert.equal(leaveDelayMs('off'), 0);
});

test('the stylesheet obeys it: no stagger on every child of a page, one entrance for the page itself, and the off/reduced rules keep spinners alive', () => {
  const css = readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(css, /:is\(\.page, \.review-page\) > \* \{\s*animation: page-in/, 'the entrance used to be a composited layer per child of the page');
  assert.match(css, /:is\(\.page, \.review-page\) \{[^}]*animation: page-in 0\.2s/);
  assert.match(css, /\.study-app\[data-motion='off'\][^{]*\{[^}]*animation-duration: 0\.01ms !important/);
  assert.match(css, /\.study-app\[data-motion='off'\][\s\S]*?:not\([^)]*spin[^)]*\)/, 'spinners and other busy indicators still turn');
  assert.match(css, /\.study-app\[data-motion='reduced'\]/);
});

test('the Animation setting is in 设置 › 界面 with its four choices, in both languages', async () => {
  const { build } = await import('esbuild');
  const { createRequire } = await import('node:module');
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const out = await build({ stdin: { contents: "export { default as Settings } from './ui/Settings.jsx'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  const { Settings, setUiLanguage } = mod.exports;
  const noop = () => {};
  const render = () => renderToStaticMarkup(React.createElement(Settings, { data: { settings: {}, focus: { courses: [] }, sources: [], decks: [], root: 'r' }, busy: false, act: noop, call: noop, host: {}, setNotice: noop,
    settings: {}, setSettings: noop, legacy: '', setLegacy: noop, exportData: noop, onRestored: noop, workspacePanel: null, coursePanel: null, onboardingPanel: null,
    appearance: { language: 'zh', onLanguage: noop, theme: 'dark', themes: [['dark', '深色'], ['light', '浅色']], onTheme: noop, motion: 'auto', onMotion: noop }, tourActive: true }));
  try {
    const zh = render();
    for (const label of ['动画', '跟随系统', '标准', '减弱', '无动画']) assert.match(zh, new RegExp(label), label);
    setUiLanguage('en');
    const en = render();
    assert.match(en, />Animation</);
    assert.match(en, />Reduced</);
    assert.match(en, />Off</);
  } finally { setUiLanguage('zh'); }
});

test('interface size and typeface: a fixed list of sizes up to 200%, the registry typefaces, and anything else falls back', async () => {
  const { SCALES, FONTS, normalizeInterface: normalize } = await import('../ui/interface-prefs.js');
  assert.deepEqual(SCALES, [90, 100, 110, 125, 150, 175, 200]);
  assert.deepEqual(FONTS, ['system', 'serif', 'kai', 'round', 'mono', 'custom']);
  assert.equal(INTERFACE_DEFAULTS.scale, 100);
  assert.equal(INTERFACE_DEFAULTS.font, 'system');
  assert.equal(normalize({ scale: 150 }).scale, 150);
  assert.equal(normalize({ scale: '125' }).scale, 125, 'a number stored as text still counts');
  assert.equal(normalize({ scale: 137 }).scale, 100, 'not one of the sizes');
  assert.equal(normalize({ scale: 400 }).scale, 100);
  assert.equal(normalize({ font: 'serif' }).font, 'serif');
  assert.equal(normalize({ font: 'comic' }).font, 'system');
  assert.deepEqual(normalize({ motion: 'off', scale: 175, font: 'mono' }), { ...INTERFACE_DEFAULTS, motion: 'off', scale: 175, font: 'mono' });
});

test('the stylesheet scales the whole interface with CSS zoom for each size and switches the typeface by attribute', () => {
  const css = readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(css, /\.study-app\s*\{\s*zoom:\s*var\(--study-ui-scale,\s*1\)/, 'dialogs share the applied scale when converting viewport bounds');
  for (const scale of [90, 110, 125, 150, 175, 200])
    assert.match(css, new RegExp(String.raw`\.study-app\[data-ui-scale='${scale}'\]\s*\{\s*--study-ui-scale:\s*${scale / 100}`), `${scale}%`);
  assert.doesNotMatch(css, /data-ui-scale='100'/, 'the default needs no rule');
  assert.match(css, /\.study-app\[data-ui-font='serif'\][^{]*\{[^}]*--font-ui:/);
  assert.match(css, /\.study-app\[data-ui-font='mono'\][^{]*\{[^}]*--font-ui:/);
});
