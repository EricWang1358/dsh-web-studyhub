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
  stdin: { contents: `export { settingsGroupState, SETTINGS_GROUPS } from './ui/settings-groups.js';
    export { default as Settings, SettingsGroup } from './ui/Settings.jsx';
    export { CourseList } from './ui/CourseSettings.jsx';
    export { OnboardingPanel } from './ui/tour/SampleControls.jsx';
    export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const { settingsGroupState, SETTINGS_GROUPS, Settings, SettingsGroup, CourseList, OnboardingPanel, setUiLanguage } = mod.exports;
const h = React.createElement;
const noop = () => {};
const defaults = { first_interval_days: 1, second_interval_days: 6, initial_ease_factor: 2.5, minimum_ease_factor: 1.3 };

const big = () => Array.from({ length: 320 }, (_, i) => ({ id: `b${i}`, title: `Book · p.${i + 1}`, text: 'x', courses: ['A'],
  document: { id: 'a'.repeat(64), materialId: `document-${'a'.repeat(64)}-pdf`, format: 'pdf', page: i + 1, totalPages: 320, extractionVersion: 2 } }));
const data = (extra = {}) => ({ root: 'D:\\Study\\library', settings: { ...defaults }, sources: [], decks: [], drafts: [], courses: [], model: { ready: true }, focus: { mode: 'class', course: 'A', courses: [{ name: 'A' }] }, ...extra });
const all = { audio: { configured: true }, mineru: { configured: true }, retrieval: { status: { extension: { installed: true, canInstall: true }, companion: { running: true } }, plan: null } };

test('two groups, in this order, each with a plain title and one line about what it holds', () => {
  assert.deepEqual(SETTINGS_GROUPS.map((group) => [group.id, group.title]), [['common', '常用'], ['once', '一次性设置']]);
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

test('a group is a disclosure with a title, its one line and a marker when something is missing', () => {
  setUiLanguage('zh');
  const closed = renderToStaticMarkup(h(SettingsGroup, { id: 'once', title: '一次性设置', lead: '第一次用某项功能时设一次', open: false, missing: [] }, h('p', null, 'inside')));
  assert.match(closed, /<details class="settings-group"[^>]*data-settings-group="once"/);
  assert.doesNotMatch(closed, /<details[^>]*\sopen=""/);
  assert.match(closed, /<summary[^>]*class="settings-group__summary"/);
  assert.match(closed, /一次性设置/);
  assert.match(closed, /第一次用某项功能时设一次/);
  assert.doesNotMatch(closed, /settings-group__missing/);
  const open = renderToStaticMarkup(h(SettingsGroup, { id: 'once', title: '一次性设置', lead: 'x', open: true, missing: ['audio', 'mineru'] }, h('p', null, 'inside')));
  assert.match(open, /<details[^>]*\sopen=""/);
  assert.match(open, /settings-group__missing/);
  assert.match(open, /未设置[^<]*音频转写[^<]*MinerU/);
  assert.match(open, /inside/);
});

test('English renders without Han, group titles and the missing marker included', () => {
  setUiLanguage('en');
  try {
    const markup = SETTINGS_GROUPS.map((group) => renderToStaticMarkup(h(SettingsGroup, { id: group.id, title: group.title, lead: group.lead, open: true, missing: ['model', 'audio', 'mineru', 'retrieval'] }, null))).join('');
    assert.doesNotMatch(markup, han);
    assert.match(markup, /Everyday/);
    assert.match(markup, /Set up once/);
    assert.match(markup, /Not set up/);
  } finally { setUiLanguage('zh'); }
});

const page = (props = {}) => renderToStaticMarkup(h(Settings, { data: data(), busy: false, act: noop, call: noop, setNotice: noop, settings: { ...defaults }, setSettings: noop,
  legacy: '', setLegacy: noop, workspacePanel: h('div', { className: 'binding-panel' }, 'library'), exportData: noop, onRestored: noop, coursePanel: h(CourseList, { courses: [] }),
  onboardingPanel: h(OnboardingPanel, { sample: null, onTour: noop }), initialProfile: { consent: true, goal: 'exam', summary: '', signals: {}, ready: 0 }, ...props }));

test('the page is the two groups; the model and the language and appearance are in the common one, the rest in the one-time one', () => {
  setUiLanguage('zh');
  const html = page({ appearance: { language: 'zh', onLanguage: noop, theme: 'dark', themes: [['auto', '跟随系统'], ['dark', '深色'], ['light', '浅色']], onTheme: noop } });
  const groups = html.split(/<details class="settings-group"/).slice(1);
  assert.equal(groups.length, 2);
  const [common, once] = groups;
  assert.match(common, /data-settings-group="common"/);
  assert.match(common, /学习库与模型/);
  assert.match(common, /界面语言/);
  assert.match(common, /外观/);
  assert.match(once, /data-settings-group="once"/);
  for (const title of ['课程', '上手与示例', '陪学', '导入 study-lib-spar', '间隔复习 · SM-2', '数据备份与恢复'])
    assert.match(once, new RegExp(`<legend class="settings-section__title">${title}</legend>`), title);
  // (settings-audio draws once its settings arrive from the host; the anchor is checked in the source by tests/wp5-tour-steps.)
  for (const anchor of ['settings-model', 'settings-extensions', 'settings-update', 'settings-sample'])
    assert.match(html, new RegExp(`data-tour="${anchor}"`), `${anchor} stays`);
  assert.match(common, /data-tour="settings-model"/);
});

test('the tour opens every group so its anchors can be shown; a deep link opens the group it points into', () => {
  setUiLanguage('zh');
  const tour = page({ tourActive: true });
  assert.equal((tour.match(/<details class="settings-group"[^>]*\sopen=""/g) || []).length, 2);
  const closed = page();
  assert.equal((closed.match(/<details class="settings-group"[^>]*\sopen=""/g) || []).length, 0, 'configured: both closed');
  const deep = page({ focusSection: 'settings-extensions' });
  assert.match(deep, /<details class="settings-group"[^>]*data-settings-group="once"[^>]*\sopen=""|<details class="settings-group"[^>]*\sopen=""[^>]*data-settings-group="once"/);
  assert.equal((deep.match(/<details class="settings-group"[^>]*\sopen=""/g) || []).length, 1);
});

test('a missing model opens the common group on first render, with the marker', () => {
  setUiLanguage('zh');
  const html = page({ data: data({ model: { ready: false } }) });
  assert.match(html, /<details class="settings-group"[^>]*\sopen=""[^>]*data-settings-group="common"|<details class="settings-group"[^>]*data-settings-group="common"[^>]*\sopen=""/);
  assert.match(html, /未设置[^<]*AI 模型/);
});

test('the English page has no Han outside user data', () => {
  setUiLanguage('en');
  try {
    const html = page({ tourActive: true, appearance: { language: 'en', onLanguage: noop, theme: 'dark', themes: [['auto', '跟随系统'], ['dark', '深色'], ['light', '浅色']], onTheme: noop } });
    // The language names are written in their own language, on purpose (the sidebar's switch does the same).
    assert.doesNotMatch(html.replace(/D:\\Study\\library/g, '').replace('>中文<', '><'), han);
  } finally { setUiLanguage('zh'); }
});

test('Settings keeps the shared-button rule and never nests a fieldset group', async () => {
  setUiLanguage('zh');
  const html = page({ tourActive: true });
  assert.deepEqual(html.match(/<button(?![^>]*class="sh-)[^>]*>/g) || [], [], 'every button is a shared Button');
  assert.doesNotMatch(html, /<fieldset[^>]*settings-group/);
  const source = (await readFile(new URL('../ui/App.jsx', import.meta.url), 'utf8')).replace(/\r/g, '');
  assert.match(source, /focusSection=\{settingsFocus\}/);
  assert.match(source, /tourActive=\{!!tourStep\}/);
});
