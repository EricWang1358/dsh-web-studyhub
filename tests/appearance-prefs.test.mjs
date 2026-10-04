/* The appearance of this browser (设置 › 界面): theme, interface size, typeface and motion are ONE pure module that the app, the empty page
   before a session is open and the settings page share. It keeps the two storage keys earlier versions wrote (study-theme,
   study-interface), so an old choice survives and an older version still reads what a newer one saved; a change in one open panel or tab
   reaches the others; 恢复默认外观 and a tiny export/import go through the same whitelist. The real layout is checked in the browser. */
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
import * as legacy from '../ui/interface-prefs.js';

const { APPEARANCE_DEFAULTS, APPEARANCE_OPTIONS, APPEARANCE_LABELS, THEME_KEY, normalizeAppearance, loadAppearance, saveAppearance, appearanceAttrs,
  exportAppearance, importAppearance, createAppearanceStore } = appearance;
const han = /[㐀-鿿]/;
const memory = (initial = {}) => { const map = new Map(Object.entries(initial)); return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), map }; };
const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };

/* ---------- one definition ---------- */

test('one list of settings with defaults and the values each one allows; interface-prefs keeps exporting the same constants', () => {
  assert.deepEqual({ ...APPEARANCE_DEFAULTS }, { theme: 'auto', motion: 'auto', scale: 100, font: 'system', fontTitle: 'follow', fontCustom: '', accent: 'cinnabar', contrast: 'auto', density: 'standard', radius: 'standard' });
  assert.deepEqual(APPEARANCE_OPTIONS.theme, ['auto', 'dark', 'light', 'oled', 'paper']);
  assert.equal(APPEARANCE_OPTIONS.motion, legacy.MOTIONS);
  assert.equal(APPEARANCE_OPTIONS.scale, legacy.SCALES);
  assert.equal(APPEARANCE_OPTIONS.font, legacy.FONTS);
  // (a typed setting such as the font name has a gate instead of a list)
  for (const key of Object.keys(APPEARANCE_OPTIONS)) assert.ok(APPEARANCE_OPTIONS[key].includes(APPEARANCE_DEFAULTS[key]), `${key}: the default is one of the choices`);
  assert.equal(THEME_KEY, 'study-theme');
  assert.equal(legacy.INTERFACE_KEY, 'study-interface');
  for (const name of ['normalizeInterface', 'loadInterface', 'saveInterface', 'effectiveMotion', 'leaveDelayMs', 'INTERFACE_DEFAULTS'])
    assert.ok(name in legacy, `${name} is still exported`);
});

test('normalize: anything stored that is not an allowed value falls back, a number stored as text still counts, unknown settings are dropped', () => {
  assert.deepEqual(normalizeAppearance(null), { ...APPEARANCE_DEFAULTS });
  assert.deepEqual(normalizeAppearance('nope'), { ...APPEARANCE_DEFAULTS });
  assert.deepEqual(normalizeAppearance({ theme: 'light', motion: 'off', scale: 175, font: 'mono' }), { ...APPEARANCE_DEFAULTS, theme: 'light', motion: 'off', scale: 175, font: 'mono' });
  assert.equal(normalizeAppearance({ scale: '125' }).scale, 125);
  assert.equal(normalizeAppearance({ scale: 137 }).scale, 100);
  assert.equal(normalizeAppearance({ scale: null }).scale, 100);
  assert.equal(normalizeAppearance({ theme: 'neon', motion: 'wild', font: 'comic' }).theme, 'auto');
  assert.deepEqual(normalizeAppearance({ theme: 'dark', extra: 1, __proto__: { theme: 'light' } }), { ...APPEARANCE_DEFAULTS, theme: 'dark' });
  assert.deepEqual(Object.keys(normalizeAppearance({ evil: 1 })), Object.keys(APPEARANCE_DEFAULTS));
});

/* ---------- old users keep their values ---------- */

test('an old browser: study-theme alone, study-interface alone, or both load exactly what they held', () => {
  assert.deepEqual(loadAppearance(memory({ 'study-theme': 'light' })), { ...APPEARANCE_DEFAULTS, theme: 'light' });
  assert.deepEqual(loadAppearance(memory({ 'study-theme': 'dark' })).theme, 'dark');
  assert.deepEqual(loadAppearance(memory({ 'study-interface': JSON.stringify({ motion: 'reduced', scale: 150, font: 'serif' }) })), { ...APPEARANCE_DEFAULTS, motion: 'reduced', scale: 150, font: 'serif' });
  assert.deepEqual(loadAppearance(memory({ 'study-theme': 'light', 'study-interface': JSON.stringify({ scale: 200 }) })), { ...APPEARANCE_DEFAULTS, theme: 'light', scale: 200 });
  assert.deepEqual(loadAppearance(memory()), { ...APPEARANCE_DEFAULTS });
});

test('a stored value nobody can read costs nothing: junk, a foreign shape, a blocked storage', () => {
  for (const raw of ['{broken', 'null', '[]', '"x"', '7']) assert.deepEqual(loadAppearance(memory({ 'study-interface': raw })), { ...APPEARANCE_DEFAULTS }, raw);
  assert.equal(loadAppearance(memory({ 'study-theme': 'neon' })).theme, 'auto');
  assert.deepEqual(loadAppearance(blocked), { ...APPEARANCE_DEFAULTS });
  assert.deepEqual(loadAppearance(null), { ...APPEARANCE_DEFAULTS });
  assert.doesNotThrow(() => saveAppearance({ theme: 'dark' }, blocked));
});

test('saving writes the old keys in the old shapes: an older version reads what a newer one saved', () => {
  const storage = memory();
  saveAppearance({ theme: 'light', motion: 'off', scale: 125, font: 'mono' }, storage);
  assert.equal(storage.map.get('study-theme'), 'light', 'a plain string, as App always wrote it');
  const rest = { ...APPEARANCE_DEFAULTS, motion: 'off', scale: 125, font: 'mono' };
  delete rest.theme;
  assert.deepEqual(JSON.parse(storage.map.get('study-interface')), rest, 'no theme in the interface object');
  assert.deepEqual(legacy.loadInterface(storage), rest, 'the previous reader still works');
  // and what an older version wrote, a newer one reads, with a setting this version does not know ignored
  const future = memory({ 'study-interface': JSON.stringify({ motion: 'full', scale: 110, font: 'serif', accent: 'jade', sparkle: 'on' }) });
  assert.deepEqual(loadAppearance(future), { ...APPEARANCE_DEFAULTS, motion: 'full', scale: 110, font: 'serif', accent: 'jade' });
  assert.deepEqual(legacy.loadInterface(future), { ...rest, motion: 'full', scale: 110, font: 'serif', accent: 'jade' });
});

/* ---------- the attributes both surfaces wear ---------- */

test('appearanceAttrs: the four data-* attributes, with auto resolved from the system and an explicit choice winning', () => {
  const dark = { light: false, reducedMotion: false };
  assert.deepEqual(appearanceAttrs({ ...APPEARANCE_DEFAULTS }, dark), { 'data-theme': 'dark', 'data-palette': 'standard', 'data-motion': 'full', 'data-ui-scale': 100, 'data-ui-font': 'system',
    'data-contrast': 'standard', 'data-density': 'standard', 'data-radius': 'standard', 'data-accent': 'cinnabar', 'data-ui-title': 'follow' });
  assert.equal(appearanceAttrs({ theme: 'auto' }, { light: true, reducedMotion: false })['data-theme'], 'light');
  assert.equal(appearanceAttrs({ theme: 'dark' }, { light: true, reducedMotion: false })['data-theme'], 'dark');
  assert.equal(appearanceAttrs({ theme: 'light' }, dark)['data-theme'], 'light');
  assert.equal(appearanceAttrs({ motion: 'auto' }, { light: false, reducedMotion: true })['data-motion'], 'reduced');
  assert.equal(appearanceAttrs({ motion: 'full' }, { light: false, reducedMotion: true })['data-motion'], 'full');
  assert.deepEqual(appearanceAttrs({ scale: 150, font: 'serif', motion: 'off' }, dark), { 'data-theme': 'dark', 'data-palette': 'standard', 'data-motion': 'off', 'data-ui-scale': 150, 'data-ui-font': 'serif',
    'data-contrast': 'standard', 'data-density': 'standard', 'data-radius': 'standard', 'data-accent': 'cinnabar', 'data-ui-title': 'follow' });
  assert.equal(appearanceAttrs({ scale: 999, font: 'x' }, dark)['data-ui-scale'], 100, 'an invalid value never reaches the DOM');
});

test('appearanceAttrs asks the browser when no system state is given, and the empty state of a missing matchMedia is dark and full', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  try {
    globalThis.matchMedia = query => ({ matches: query.includes('light') });
    assert.equal(appearanceAttrs({})['data-theme'], 'light');
    assert.equal(appearanceAttrs({})['data-motion'], 'full');
    delete globalThis.matchMedia;
    assert.equal(appearanceAttrs({})['data-theme'], 'dark');
  } finally { if (original) Object.defineProperty(globalThis, 'matchMedia', original); else delete globalThis.matchMedia; }
});

/* ---------- export / import ---------- */

test('export is one small JSON line and import reads it back through the same whitelist', () => {
  const prefs = { ...APPEARANCE_DEFAULTS, theme: 'light', motion: 'reduced', scale: 150, font: 'serif', accent: 'jade' };
  const text = exportAppearance(prefs);
  assert.ok(text.length < 260, 'tiny');
  assert.doesNotMatch(text, /\n/);
  assert.deepEqual(importAppearance(text), { ...APPEARANCE_DEFAULTS, ...prefs });
  assert.deepEqual(importAppearance(exportAppearance({ theme: 'bogus' })), { ...APPEARANCE_DEFAULTS });
  assert.deepEqual(importAppearance(JSON.stringify({ studyhubAppearance: 1, theme: 'dark', scale: 137, accent: 'magenta', __proto__: { x: 1 } })), { ...APPEARANCE_DEFAULTS, theme: 'dark' }, 'out-of-list values and unknown settings are dropped');
  for (const bad of ['', 'nope', '{broken', 'null', '[]', '7', '{"theme":"dark"}', JSON.stringify({ studyhubAppearance: 2, theme: 'dark' }), 'x'.repeat(5000), null, undefined, {}])
    assert.equal(importAppearance(bad), null, String(bad).slice(0, 20));
});

/* ---------- the store: one setting, every open panel, other tabs ---------- */

test('the store loads what is kept, saves every change in the old keys and tells every open panel once', () => {
  const storage = memory({ 'study-theme': 'light', 'study-interface': JSON.stringify({ scale: 150 }) });
  const store = createAppearanceStore({ storage });
  assert.equal(store.get().theme, 'light');
  assert.equal(store.get().scale, 150);
  assert.equal(store.get(), store.get(), 'a stable snapshot');
  const heard = [];
  store.subscribe(() => heard.push(store.get().font));
  store.update({ font: 'serif' });
  assert.deepEqual(heard, ['serif']);
  assert.equal(JSON.parse(storage.map.get('study-interface')).font, 'serif');
  assert.equal(JSON.parse(storage.map.get('study-interface')).scale, 150, 'a patch keeps the rest');
  assert.equal(storage.map.get('study-theme'), 'light');
  const before = store.get();
  store.update({ font: 'serif' });
  store.update({ scale: 150 });
  store.update({});
  assert.equal(store.get(), before, 'nothing changed, nobody re-renders');
  assert.equal(heard.length, 1);
  store.update({ theme: 'dark' });
  assert.equal(storage.map.get('study-theme'), 'dark');
  assert.equal(heard.length, 2);
});

test('another tab changing a key reaches this one without writing anything back', () => {
  const storage = memory();
  const store = createAppearanceStore({ storage });
  let heard = 0;
  store.subscribe(() => { heard += 1; });
  assert.equal(store.get().theme, 'auto');
  storage.setItem('study-theme', 'dark');
  storage.setItem('study-interface', JSON.stringify({ scale: 175, motion: 'off' }));
  const writes = [];
  const spy = { getItem: storage.getItem, setItem: (key, value) => { writes.push(key); storage.setItem(key, value); } };
  const watched = createAppearanceStore({ storage: spy });
  watched.get(); watched.reload();
  assert.deepEqual(writes, [], 'reading never writes');
  store.reload();
  assert.deepEqual(store.get(), { ...APPEARANCE_DEFAULTS, theme: 'dark', motion: 'off', scale: 175 });
  assert.equal(heard, 1);
  store.reload();
  assert.equal(heard, 1, 'unchanged values are not news');
});

test('恢复默认外观 puts every setting back and keeps it; a blocked storage still applies for the session', () => {
  const storage = memory({ 'study-theme': 'light', 'study-interface': JSON.stringify({ scale: 200, font: 'mono', motion: 'off' }) });
  const store = createAppearanceStore({ storage });
  let heard = 0;
  store.subscribe(() => { heard += 1; });
  const { reset } = store;
  reset();
  assert.deepEqual(store.get(), { ...APPEARANCE_DEFAULTS });
  assert.equal(heard, 1);
  assert.deepEqual(loadAppearance(storage), { ...APPEARANCE_DEFAULTS }, 'and it is what the next visit loads');
  const offline = createAppearanceStore({ storage: blocked });
  assert.deepEqual(offline.get(), { ...APPEARANCE_DEFAULTS });
  offline.update({ scale: 150 });
  assert.equal(offline.get().scale, 150);
});

/* ---------- the surfaces ---------- */

async function bundle(contents) {
  const out = await build({ stdin: { contents, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
  return mod.exports;
}

test('every label has an English entry, so 设置 › 界面 reads fully in both languages', async () => {
  const { ui, setUiLanguage } = await bundle("export { ui, setUiLanguage } from './ui/i18n.js';");
  setUiLanguage('en');
  try {
    for (const [key, labels] of Object.entries(APPEARANCE_LABELS)) for (const [value, zh] of Object.entries(labels)) {
      assert.ok(APPEARANCE_OPTIONS[key].includes(isNaN(value) ? value : Number(value)), `${key}.${value} is a real choice`);
      assert.doesNotMatch(ui(zh), han, `${key}.${value} ${zh}`);
    }
    for (const zh of ['恢复默认外观', '导出外观', '导入外观', '外观设置（一小段文字，可粘贴到另一台电脑）', '已导出，可以复制保存。', '已应用这份外观设置。', '这不是 StudyHub 的外观设置，没有改动。'])
      assert.doesNotMatch(ui(zh), han, zh);
  } finally { setUiLanguage('zh'); }
});

test('the empty page before a session wears the same attributes as the app, read from the same store', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memory({ 'study-theme': 'light', 'study-interface': JSON.stringify({ scale: 150, font: 'serif', motion: 'off' }) }) });
  try {
    const { NoSessionNotice } = await bundle("export { NoSessionNotice } from './ui/host/studyhub-page.jsx';");
    const html = renderToStaticMarkup(React.createElement(NoSessionNotice, {}));
    assert.match(html, /class="study-app"/);
    for (const [name, value] of [['data-theme', 'light'], ['data-ui-scale', '150'], ['data-ui-font', 'serif'], ['data-motion', 'off']])
      assert.match(html, new RegExp(`${name}="${value}"`), name);
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage; }
});

test('App and the empty page no longer read or write the theme by hand, and Settings builds its choices from the module', async () => {
  const [page, settings] = await Promise.all(['ui/host/studyhub-page.jsx', 'ui/settings/AppearanceSection.jsx'].map(file => readFile(new URL(`../${file}`, import.meta.url), 'utf8'))), app = await readAppSource();
  for (const [name, source] of [['App', app], ['studyhub-page', page]]) {
    assert.doesNotMatch(source, /["']study-theme["']/, `${name} goes through appearance-prefs`);
    assert.match(source, /useAppearance/, name);
    assert.match(source, /appearanceAttrs|useAppearanceAttrs/, name);
  }
  assert.doesNotMatch(app, /loadInterface|saveInterface/);
  assert.doesNotMatch(settings, /\[90, 100, 110/, 'sizes come from SCALES');
  assert.doesNotMatch(settings, /value: "system"/, 'typefaces come from FONTS');
  assert.match(settings, /APPEARANCE_OPTIONS/);
});

test('设置 › 界面 offers 恢复默认外观 and export / import, in both languages, next to the existing choices', async () => {
  const { Settings, setUiLanguage } = await bundle("export { default as Settings } from './ui/Settings.jsx'; export { setUiLanguage } from './ui/i18n.js';");
  await warmSettingsPanes(Settings);
  const noop = () => {};
  const render = extra => renderToStaticMarkup(React.createElement(Settings, { data: { settings: {}, focus: { courses: [] }, sources: [], decks: [], root: 'r' }, busy: false, act: noop, call: noop, host: {}, setNotice: noop,
    settings: {}, setSettings: noop, legacy: '', setLegacy: noop, exportData: noop, onRestored: noop, workspacePanel: null, coursePanel: null, onboardingPanel: null,
    appearance: { language: 'zh', onLanguage: noop, theme: 'dark', onTheme: noop, motion: 'auto', onMotion: noop, scale: 100, onScale: noop, font: 'system', onFont: noop, ...extra }, tourActive: true }));
  try {
    const full = { onReset: noop, onExport: () => exportAppearance({}), onImport: () => true };
    const zh = render(full);
    for (const label of ['恢复默认外观', '导出外观', '导入外观', '深色', '浅色', '90%', '200%', '系统默认', '衬线', '等宽', '无动画']) assert.match(zh, new RegExp(label), label);
    assert.match(zh, /aria-label="界面字体"/);
    assert.doesNotMatch(render({}), /恢复默认外观/, 'without the handlers there is nothing to restore');
    setUiLanguage('en');
    const en = render(full);
    for (const label of ['Restore default appearance', 'Export appearance', 'Import appearance', '>Dark<', '>Light<', '>System default<', '>Serif .Song.<', '>Kai<', '>Rounded<', '>Monospace<']) assert.match(en, new RegExp(label), label);
  } finally { setUiLanguage('zh'); }
});

test('the hook module listens for the storage event: only the two appearance keys (or a clear) reload, and a panel re-renders only for a real change', async () => {
  const had = ['window', 'localStorage'].map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const handlers = [];
  const storage = memory({ 'study-theme': 'dark' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: (type, handler) => handlers.push([type, handler]) } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    const { appearanceStore } = await bundle("export { appearanceStore } from './ui/use-appearance.js';");
    const listener = handlers.find(([type]) => type === 'storage')?.[1];
    assert.ok(listener, 'a storage listener is registered');
    assert.equal(appearanceStore.get().theme, 'dark');
    let heard = 0;
    appearanceStore.subscribe(() => { heard += 1; });
    storage.setItem('study-theme', 'light');
    listener({ key: 'study-reader-settings' });
    assert.equal(appearanceStore.get().theme, 'dark', 'another key is none of its business');
    listener({ key: 'study-theme' });
    assert.equal(appearanceStore.get().theme, 'light');
    storage.setItem('study-interface', JSON.stringify({ scale: 150 }));
    listener({ key: 'study-interface' });
    assert.equal(appearanceStore.get().scale, 150);
    listener({ key: null });
    assert.equal(heard, 2, 'a clear that changes nothing is not news');
  } finally { ['window', 'localStorage'].forEach((key, i) => { if (had[i]) Object.defineProperty(globalThis, key, had[i]); else delete globalThis[key]; }); }
});
