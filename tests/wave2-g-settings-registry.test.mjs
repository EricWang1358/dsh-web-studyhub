import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// WP-G (#139): the settings registry is the one place a category is declared, loaded lazily and gated.
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: `export { SETTINGS_CATEGORIES, categoriesFor, partAvailable, categoryForAnchor } from './ui/settings-groups.js';
    export { default as Settings } from './ui/Settings.jsx';
    export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const { SETTINGS_CATEGORIES, categoriesFor, partAvailable, Settings, setUiLanguage } = mod.exports;
const h = React.createElement;
const root = new URL('../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const noop = () => {};
const defaults = { first_interval_days: 1, second_interval_days: 6, initial_ease_factor: 2.5, minimum_ease_factor: 1.3 };
const data = (extra = {}) => ({ root: 'D:\\Study\\library', settings: { ...defaults }, sources: [], decks: [], drafts: [], courses: [], model: { ready: true },
  focus: { mode: 'class', course: 'A', courses: [{ name: 'A' }] }, ...extra });
const withContext = names => ({ contexts: names });

test('every category declares a lazily loaded Component and its loader', () => {
  for (const category of SETTINGS_CATEGORIES) {
    assert.ok(category.Component && (typeof category.Component === 'function' || category.Component.$$typeof), `${category.id} has a Component`);
    assert.equal(typeof category.load, 'function', `${category.id} has a loader`);
  }
});

test('every category loads a module whose default export is a component', async () => {
  for (const category of SETTINGS_CATEGORIES) {
    const loaded = await category.load();
    assert.equal(typeof loaded.default, 'function', category.id);
  }
});

test('the registry gates capabilities: needs hides a category, partNeeds gates one part of it', () => {
  const ids = capabilities => categoriesFor(capabilities).map(category => category.id);
  assert.ok(!ids({}).includes('audio'));
  assert.ok(ids({ audio: true }).includes('audio'));
  assert.ok(ids({}).includes('mineru'), 'the external Marker route does not need the audio component');
  assert.equal(partAvailable('mineru', 'routes', {}), false, 'the MinerU routes need the audio component, declared in the registry');
  assert.equal(partAvailable('mineru', 'routes', { audio: true }), true);
  assert.equal(partAvailable('audio', 'anything', {}), true, 'a part nobody gated is available');
});

test('Settings has no switch over category ids and no capability checks of its own', () => {
  const source = read('ui/Settings.jsx');
  assert.doesNotMatch(source, /switch\s*\(/);
  assert.doesNotMatch(source, /capabilities\.(audio|generation|system)/);
  assert.match(source, /<category\.Component\b|<selected\.Component\b|\.Component\b/);
  assert.equal([...source.matchAll(/settingsGroupState\(/g)].length, 1, 'the group state is computed once');
  assert.doesNotMatch(source, /\["freeKey"|\['freeKey'/, 'the key fields come from lib/audio-providers.js');
});

test('the category panes never test a capability themselves', () => {
  for (const file of readdirSync(new URL('ui/settings/', root)).filter(name => name.endsWith('.jsx'))) {
    const source = read(`ui/settings/${file}`);
    assert.doesNotMatch(source, /capabilities\.(audio|generation|system)/, file);
    assert.doesNotMatch(source, /hasContext\(/, file);
  }
});

test('Settings renders the selected category through its registry component, behind a Suspense boundary', async () => {
  setUiLanguage('zh');
  const props = { data: data(), busy: false, act: noop, call: undefined, host: {}, setNotice: noop, settings: defaults, setSettings: noop, legacy: '', setLegacy: noop,
    workspacePanel: h('p', { id: 'workspace-panel' }, 'workspace'), coursePanel: h('p', { id: 'course-panel' }, 'courses'), onboardingPanel: null,
    exportData: noop, onRestored: noop, appearance: null, tourActive: true };
  const first = renderToStaticMarkup(h(Settings, props));
  await tick();
  const out = renderToStaticMarkup(h(Settings, props));
  assert.ok(out.length >= first.length);
  assert.match(out, /id="workspace-panel"/, 'the model pane renders the panel App hands in');
  assert.match(out, /id="course-panel"/);
  assert.match(out, /data-tour="settings-model"/);
});

test('without the audio component the MinerU routes are absent but the Marker section stays', async () => {
  const props = { data: data({ contexts: [] }), busy: false, act: noop, call: undefined, host: {}, setNotice: noop, settings: defaults, setSettings: noop, legacy: '', setLegacy: noop,
    workspacePanel: null, coursePanel: null, onboardingPanel: null, exportData: noop, onRestored: noop, appearance: null, tourActive: true };
  renderToStaticMarkup(h(Settings, props));
  await tick();
  const bare = renderToStaticMarkup(h(Settings, props));
  assert.match(bare, /data-tour="settings-marker"/);
  assert.doesNotMatch(bare, /data-tour="settings-mineru"/);
  assert.doesNotMatch(bare, /data-tour="settings-audio"/);
  const full = { ...props, data: data(withContext(['audio', 'generation', 'system'])) };
  renderToStaticMarkup(h(Settings, full));
  await tick();
  const out = renderToStaticMarkup(h(Settings, full));
  assert.match(out, /data-tour="settings-marker"/);
});

// ── the shell and the primitives are used everywhere in settings (#138 #139 #140 #141) ──
const SETTINGS_FILES = ['Settings.jsx', 'AudioSettings.jsx', 'MineruSettings.jsx', 'JevSettings.jsx', 'JevLevelCheck.jsx', 'GenerationSettings.jsx', 'ScienceSettings.jsx',
  'UsageSettings.jsx', 'CourseSettings.jsx', 'ExperimentalSettings.jsx', 'ExtensionsSettings.jsx', 'ReasoningEffortField.jsx', 'CourseField.jsx', 'SetupChecklist.jsx',
  'DailyRecapSettings.jsx', 'MarkerSettings.jsx', 'reading-settings/ReadingSettings.jsx',
  ...readdirSync(new URL('ui/settings/', root)).filter(name => name.endsWith('.jsx')).map(name => `settings/${name}`)];

test('settings files render fields through Field and the choice primitives', () => {
  for (const file of SETTINGS_FILES) {
    const source = read(`ui/${file}`);
    assert.doesNotMatch(source, /<label className=/, `${file}: a field is a <Field>, a choice is a <Checkbox>/<Switch>/<RadioCard>`);
    assert.doesNotMatch(source, /type="checkbox"|type='checkbox'|type="radio"|type='radio'/, `${file}: no hand-written checkbox or radio`);
    assert.doesNotMatch(source, /<fieldset className="settings-section|<fieldset className='settings-section/, `${file}: the section shell is <SettingsSection>`);
    assert.doesNotMatch(source, /inline-check|experimental-switch|\bjev-switch(?![\w-])|usage-switch|mineru-privacy__check/, `${file}: the old switch rows are gone`);
  }
});

test('settings-section__title and the other shell classes live in SettingsSection only (hand-written sections in WP-M files are listed)', () => {
  const allowed = new Set(['ui/components/SettingsSection.jsx', 'ui/UpdateCenter.jsx', 'ui/tour/SampleControls.jsx']);
  const walk = dir => readdirSync(new URL(dir, root)).flatMap(name => {
    const path = `${dir}${name}`;
    return statSync(new URL(path, root)).isDirectory() ? walk(`${path}/`) : /\.jsx?$/.test(name) ? [path] : [];
  });
  const offenders = walk('ui/').filter(file => !allowed.has(file) && /settings-section__title/.test(read(file)));
  assert.deepEqual(offenders, []);
});

test('a file that is not an Audio component never uses an audio-* class (#141)', () => {
  const walk = dir => readdirSync(new URL(dir, root)).flatMap(name => {
    const path = `${dir}${name}`;
    return statSync(new URL(path, root)).isDirectory() ? walk(`${path}/`) : /\.jsx$/.test(name) ? [path] : [];
  });
  // PdfConvertJob / PdfConversion / LiveAudioMonitor are other work packages (listed in the report).
  const other = new Set(['ui/PdfConvertJob.jsx', 'ui/PdfConversion.jsx', 'ui/LiveAudioMonitor.jsx', 'ui/LiveClass.jsx', 'ui/StudyMap.jsx', 'ui/dev.jsx', 'ui/host/workspace.jsx']);
  const offenders = [];
  for (const file of walk('ui/')) {
    if (/\/Audio[A-Za-z]*\.jsx$/.test(file) || other.has(file)) continue;
    const used = read(file).match(/className=(?:"[^"]*|\{`[^`]*|'[^']*)(?<![\w-])audio-[a-z]/);
    if (used) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('audio-settings.css is injected by Audio components only', () => {
  for (const file of readdirSync(new URL('ui/', root)).filter(name => name.endsWith('.jsx'))) {
    if (/^Audio[A-Za-z]*\.jsx$/.test(file)) continue;
    assert.doesNotMatch(read(`ui/${file}`), /audio-settings\.css/, file);
  }
});

test('the provider note has one definition and no !important (#97)', () => {
  const walk = dir => readdirSync(new URL(dir, root)).flatMap(name => {
    const path = `${dir}${name}`;
    return statSync(new URL(path, root)).isDirectory() ? walk(`${path}/`) : /\.css$/.test(name) ? [path] : [];
  });
  const defs = walk('ui/').flatMap(file => [...read(file).matchAll(/(^|\n)[^{}\n]*\.audio-provider-note[^{]*\{[^}]*\}/g)].map(match => [file, match[0]]));
  assert.ok(defs.length <= 1, `audio-provider-note is defined ${defs.length} times: ${defs.map(([file]) => file).join(', ')}`);
  for (const [, rule] of defs) assert.doesNotMatch(rule, /!important/);
  assert.doesNotMatch(read('ui/audio-dashboard.css'), /audio-provider-note[^}]*!important/);
  for (const file of ['JevSettings.jsx', 'JevLevelCheck.jsx', 'MineruSettings.jsx', 'AudioSettings.jsx']) assert.doesNotMatch(read(`ui/${file}`), /audio-provider-note/, file);
});
