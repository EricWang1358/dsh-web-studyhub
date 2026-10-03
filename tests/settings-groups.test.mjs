import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* Settings by when a setting is touched (docs/feature-tiers.md): 常用 (language, appearance, the model: touched whenever
   something is off) and 一次性设置 (keys, search extension, MinerU, audio, courses, import and backup: set once). A group is
   closed while what the library needs is set up, and open, with a plain marker, when something is missing. Deep links
   (the audio key, the search extension) and the tour open what they point at; every data-tour anchor stays. */
const han = /[㐀-鿿]/;
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: `export { settingsGroupState, SETTINGS_GROUPS, categoriesFor, categoryForAnchor } from './ui/settings-groups.js';
    export { default as Settings, SettingsNav } from './ui/Settings.jsx';
    export { CourseList } from './ui/CourseSettings.jsx';
    export { OnboardingPanel } from './ui/tour/SampleControls.jsx';
    export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const { settingsGroupState, SETTINGS_GROUPS, categoriesFor, categoryForAnchor, Settings, SettingsNav, CourseList, OnboardingPanel, setUiLanguage } = mod.exports;
const h = React.createElement;
const noop = () => {};
const defaults = { first_interval_days: 1, second_interval_days: 6, initial_ease_factor: 2.5, minimum_ease_factor: 1.3 };

const big = () => Array.from({ length: 320 }, (_, i) => ({ id: `b${i}`, title: `Book · p.${i + 1}`, text: 'x', courses: ['A'],
  document: { id: 'a'.repeat(64), materialId: `document-${'a'.repeat(64)}-pdf`, format: 'pdf', page: i + 1, totalPages: 320, extractionVersion: 2 } }));
const data = (extra = {}) => ({ root: 'D:\\Study\\library', settings: { ...defaults }, sources: [], decks: [], drafts: [], courses: [], model: { ready: true }, focus: { mode: 'class', course: 'A', courses: [{ name: 'A' }] }, ...extra });
const all = { audio: { configured: true }, mineru: { configured: true }, retrieval: { status: { extension: { installed: true, canInstall: true }, companion: { running: true } }, plan: null } };

test('three groups, in this order, each with a plain title and one line about what it holds', () => {
  assert.deepEqual(SETTINGS_GROUPS.map((group) => [group.id, group.title]), [['common', '常用'], ['once', '一次性设置'], ['advanced', '高级']]);
  for (const group of SETTINGS_GROUPS) assert.ok(group.lead && han.test(group.lead));
});

test('everything the library needs is set up: both groups are closed and nothing is marked', () => {
  const state = settingsGroupState({ data: data({ sources: [{ id: 'n', title: 'Note', text: 't', courses: ['A'] }] }), status: all });
  assert.deepEqual(state.common, { open: false, missing: [] });
  assert.deepEqual(state.once, { open: false, missing: [] });
});

test('no AI model: the common group opens and says the model is not set up', () => {
  const state = settingsGroupState({ data: data({ model: { ready: false } }), status: all });
  assert.deepEqual(state.common, { open: true, missing: ['model'] });
  assert.equal(state.once.open, false);
});

test('what only a feature the library already uses needs is marked: audio for recordings, MinerU for a book, search for a big book', () => {
  const audio = settingsGroupState({ data: data({ sources: [{ id: 'a1', title: 'Lecture', text: 't', courses: ['A'], audio: { fileName: 'l.m4a' } }] }), status: { ...all, audio: { configured: false } } });
  assert.deepEqual(audio.once, { open: true, missing: ['audio'] });
  const noAudioUse = settingsGroupState({ data: data(), status: { ...all, audio: { configured: false } } });
  assert.deepEqual(noAudioUse.once, { open: false, missing: [] }, 'a library with no recordings has no use for a transcription key');
  const book = settingsGroupState({ data: data({ sources: big() }), status: { ...all, mineru: { configured: false } } });
  assert.deepEqual(book.once.missing, ['mineru']);
  const search = settingsGroupState({ data: data({ sources: big().map((page) => ({ ...page, document: { ...page.document, origin: 'converted', converter: 'mineru', chapter: { index: 0, title: 'One', level: 1 } } })) }),
    status: { ...all, retrieval: { status: { extension: { installed: false, canInstall: true } }, plan: null } } });
  assert.deepEqual(search.once.missing, ['retrieval']);
  assert.equal(search.once.open, true);
});

test('a status that has not arrived yet marks nothing; the learner\'s own choice beats the default, the tour and a deep link beat both', () => {
  const unknown = settingsGroupState({ data: data({ sources: big() }), status: {} });
  assert.deepEqual(unknown.once.missing, []);
  const missingModel = data({ model: { ready: false } });
  assert.equal(settingsGroupState({ data: missingModel, status: all, saved: { common: false } }).common.open, false, 'folded by the learner');
  assert.equal(settingsGroupState({ data: data(), status: all, saved: { once: true } }).once.open, true, 'opened by the learner');
  assert.equal(settingsGroupState({ data: missingModel, status: all, saved: { common: false }, forceOpen: true }).common.open, true, 'the tour opens everything');
  assert.equal(settingsGroupState({ data: data(), status: all, forceOpen: ['once'] }).once.open, true, 'a deep link opens its own group');
  assert.equal(settingsGroupState({ data: data(), status: all, forceOpen: ['once'] }).common.open, false);
});

test('the category list sits under the three group headings, marks the selected one and says in words which need attention', () => {
  setUiLanguage('zh');
  const available = categoriesFor({ audio: true, generation: true, system: true });
  const html = renderToStaticMarkup(h(SettingsNav, { available, active: 'audio', missing: ['model', 'audio'], onSelect: noop }));
  assert.match(html, /<nav class="settings-nav"[^>]*aria-label="设置分类"/);
  for (const group of SETTINGS_GROUPS) assert.match(html, new RegExp(`<p class="settings-nav__label">${group.title}</p>`));
  assert.equal((html.match(/class="settings-nav__item"/g) || []).length, available.length);
  assert.match(html, /data-category="audio"[^>]*aria-current="page"|aria-current="page"[^>]*data-category="audio"/);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.equal((html.match(/class="settings-nav__todo">待设置</g) || []).length, 2, 'one marker per category that needs attention, in words');
  setUiLanguage('en');
  try {
    const english = renderToStaticMarkup(h(SettingsNav, { available, active: 'model', missing: ['model'], onSelect: noop }));
    assert.doesNotMatch(english, han);
    for (const word of ['Everyday', 'Set up once', 'Advanced', 'To set up', 'Settings categories']) assert.match(english, new RegExp(word));
  } finally { setUiLanguage('zh'); }
});

const page = (props = {}) => renderToStaticMarkup(h(Settings, { data: data(), busy: false, act: noop, call: noop, setNotice: noop, settings: { ...defaults }, setSettings: noop,
  legacy: '', setLegacy: noop, workspacePanel: h('div', { className: 'binding-panel' }, 'library'), exportData: noop, onRestored: noop, coursePanel: h(CourseList, { courses: [] }),
  onboardingPanel: h(OnboardingPanel, { sample: null, onTour: noop }), initialProfile: { consent: true, goal: 'exam', summary: '', signals: {}, ready: 0 }, ...props }));

test('the page is the category list and ONE category: the first one by default, the one a deep link points at, everything for the tour', () => {
  setUiLanguage('zh');
  const appearance = { language: 'zh', onLanguage: noop, theme: 'dark', themes: [['auto', '跟随系统'], ['dark', '深色'], ['light', '浅色']], onTheme: noop };
  const first = page({ appearance });
  assert.match(first, /<div class="settings-layout">/);
  assert.match(first, /class="settings-pane"/);
  assert.match(first, /界面语言/, 'the first category is the interface');
  assert.doesNotMatch(first, /数据备份与恢复|间隔复习 · SM-2/, 'the other categories are not on the page');
  assert.doesNotMatch(first, /<details/, 'no folded groups any more');
  const model = page({ focusSection: 'settings-model', appearance });
  assert.match(model, /data-tour="settings-model"/);
  assert.match(model, /aria-current="page"[^>]*data-category="model"|data-category="model"[^>]*aria-current="page"/);
  const notACategory = page({ appearance, focusSection: 'settings-nowhere' });
  assert.doesNotMatch(notACategory, /数据备份与恢复/, 'an anchor that is not a category does not open one');
  const tour = page({ tourActive: true, appearance });
  assert.doesNotMatch(tour, /settings-nav/, 'the tour shows the sections one after another, without the list');
  for (const title of ['学习库与模型', '课程', '上手与示例', '陪学', '导入 study-lib-spar', '间隔复习 · SM-2', '数据备份与恢复'])
    assert.match(tour, new RegExp(`<legend class="settings-section__title">${title}</legend>`), title);
  for (const anchor of ['settings-model', 'settings-extensions', 'settings-update', 'settings-sample'])
    assert.match(tour, new RegExp(`data-tour="${anchor}"`), `${anchor} stays`);
});

test('a missing model: the list says so and the model category is the one on first render', () => {
  setUiLanguage('zh');
  const html = page({ data: data({ model: { ready: false } }) });
  assert.match(html, /data-category="model"[^>]*>(?:(?!<\/button>).)*待设置/);
  assert.match(html, /data-tour="settings-model"/, 'the model category is shown, not the first one');
  assert.match(html, /aria-current="page"[^>]*data-category="model"|data-category="model"[^>]*aria-current="page"/);
});

test('the English page has no Han outside user data', () => {
  setUiLanguage('en');
  try {
    const appearance = { language: 'en', onLanguage: noop, theme: 'dark', themes: [['auto', '跟随系统'], ['dark', '深色'], ['light', '浅色']], onTheme: noop };
    for (const props of [{ tourActive: true, appearance }, { appearance }, { appearance, focusSection: 'settings-model' }]) {
      const html = page(props);
      // The language names are written in their own language, on purpose (the sidebar's switch does the same).
      assert.doesNotMatch(html.replace(/D:\\Study\\library/g, '').replaceAll('>中文<', '><')
        .replace(/\bvalue="(?:中文|中英双语)"/g, ''), han);
    }
  } finally { setUiLanguage('zh'); }
});

test('every "open settings" link that points at a one-time setting names its section, and Settings turns the name into its category', async () => {
  const source = (await readFile(new URL('../ui/App.jsx', import.meta.url), 'utf8')).replace(/\r/g, '');
  assert.ok((source.match(/setSettingsFocus\("settings-mineru"\)/g) || []).length >= 2, 'the import hub and the materials page point at MinerU');
  assert.match(source, /setSettingsFocus\("settings-extensions"\)/, 'the checklist points at the search settings');
  assert.match(source, /const openModelSettings = \(\) => \(host\.openModelSettings \? host\.openModelSettings\(\) : \(setSettingsFocus\("settings-model"\), navigatePage\("settings"\)\)\)/);
  for (const anchor of ['settings-mineru', 'settings-extensions', 'settings-model']) assert.ok(categoryForAnchor(anchor), anchor);
});

test('Settings keeps the shared-button rule outside the list and never nests a fieldset group', async () => {
  setUiLanguage('zh');
  const html = page({ tourActive: true });
  assert.deepEqual(html.match(/<button(?![^>]*class="sh-)[^>]*>/g) || [], [], 'every button is a shared Button');
  assert.doesNotMatch(html, /<fieldset[^>]*settings-group/);
  const withList = page({});
  assert.deepEqual((withList.match(/<button(?![^>]*class="sh-)[^>]*>/g) || []).filter((button) => !/class="settings-nav__item"/.test(button)), [], 'only the list items are plain buttons');
  const source = (await readFile(new URL('../ui/App.jsx', import.meta.url), 'utf8')).replace(/\r/g, '');
  assert.match(source, /focusSection=\{settingsFocus\}/);
  assert.match(source, /tourActive=\{!!tourStep\}/);
});
