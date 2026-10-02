import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { dom, loadUsageModules } from './helpers/usage-dom.mjs';
import { USAGE_REGISTRY, USAGE_TIERS, USAGE_GROUPS, USAGE_NAV_GROUPS, USAGE_AREAS, USAGE_CLASS_HOOKS, usageEntry, TEXT_FIELD_KEY } from '../lib/usage-registry.js';
import * as uiRegistry from '../ui/usage/registry.js';
import { StudyService } from '../lib/service.js';

/* The registry is the one list of controls the report speaks about. It must stay honest: unique keys, names in both languages, a tier
   (docs/feature-tiers.md), every control a page marks with data-usage listed, every listed control actually marked, and the keys the
   main pages produce identical in Chinese and in English. */

const han = /[㐀-鿿]/;

async function sourceFiles(directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(jsx?|mjs)$/.test(item.name)) files.push(path);
  }
  return files;
}

test('registry integrity: unique keys, plain names in both languages, valid tier, group and sidebar group', () => {
  assert.ok(USAGE_REGISTRY.length >= 40);
  const keys = USAGE_REGISTRY.map(item => item.key);
  assert.equal(new Set(keys).size, keys.length, 'keys are unique');
  assert.equal(new Set(USAGE_REGISTRY.map(item => item.zh)).size, USAGE_REGISTRY.length, 'Chinese names are unique, so the report is not ambiguous');
  assert.equal(new Set(USAGE_REGISTRY.map(item => item.en)).size, USAGE_REGISTRY.length, 'English names are unique');
  for (const item of USAGE_REGISTRY) {
    assert.match(item.key, /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/, `${item.key}: a dotted lower-case key`);
    assert.ok(item.zh.trim().length >= 2 && han.test(item.zh), `${item.key}: a Chinese name`);
    assert.ok(item.en.trim().length >= 3 && !han.test(item.en), `${item.key}: an English name without Han`);
    assert.ok(USAGE_TIERS.includes(item.tier), `${item.key}: tier`);
    assert.ok(Object.hasOwn(USAGE_GROUPS, item.group), `${item.key}: group`);
    if (item.navGroup) assert.ok(Object.hasOwn(USAGE_NAV_GROUPS, item.navGroup), `${item.key}: sidebar group`);
    if (item.group === 'shortcut') assert.ok(item.keys, `${item.key}: says which keys`);
    if (item.shortcut) assert.equal(usageEntry(item.shortcut)?.group, 'shortcut', `${item.key}: its shortcut is registered`);
    assert.ok(Object.isFrozen(item));
  }
  assert.ok(usageEntry(TEXT_FIELD_KEY));
  assert.equal(new Set(Object.values(USAGE_CLASS_HOOKS)).size, Object.keys(USAGE_CLASS_HOOKS).length);
  assert.deepEqual(USAGE_AREAS.at(-1).id, 'other');
  assert.deepEqual(USAGE_TIERS, ['daily', 'periodic', 'once']);
});

test('the sidebar pages of the registry are the sidebar pages of the app, in the groups the app puts them in (docs/feature-tiers.md)', async () => {
  const { NAV_DEFAULTS } = await import('../ui/nav-order.js');
  for (const [group, pages] of Object.entries(NAV_DEFAULTS)) for (const page of pages) {
    const entry = usageEntry(`nav.${page}`);
    assert.ok(entry, `nav.${page} is registered`);
    assert.equal(entry.navGroup, group, `${page} sits in ${group}`);
  }
  const tiers = { daily: 'daily', periodic: 'periodic', setup: 'once' };
  for (const [group, pages] of Object.entries(NAV_DEFAULTS)) for (const page of pages) assert.equal(usageEntry(`nav.${page}`).tier, tiers[group], `${page}: tier follows the group`);
});

test('the page re-exports the one registry (lib/ owns it because the report is built by the backend)', () => {
  assert.equal(uiRegistry.USAGE_REGISTRY, USAGE_REGISTRY);
  assert.equal(uiRegistry.usageEntry, usageEntry);
});

test('CI-style: every data-usage a page marks is registered, and every registered control is marked somewhere (or hooked, or a shortcut)', async () => {
  const marked = new Map();
  let combined = '';
  for (const file of await sourceFiles('ui')) {
    const text = await readFile(file, 'utf8');
    combined += `\n${text}`;
    for (const match of text.matchAll(/data-usage=(?:"([^"]+)"|\{`([^`]+)`\}|\{'([^']+)'\}|\{"([^"]+)"\})/g)) {
      const value = match[1] || match[2] || match[3] || match[4];
      if (!marked.has(value)) marked.set(value, file);
    }
  }
  // template keys such as nav.${id} stand for every page of the sidebar
  const templates = [...marked.keys()].filter(key => key.includes('${'));
  const expand = key => key.replace('${id}', '(?:library|wrongbook|workflows|notes|board|exam|dashboard|sources|generate|skeleton|audio|live)');
  for (const [key, file] of marked) {
    if (key.includes('${')) { assert.ok(USAGE_REGISTRY.some(item => new RegExp(`^${expand(key).replace('.', '\\.')}$`).test(item.key)), `${key} (${file}) matches no registered control`); continue; }
    assert.ok(usageEntry(key), `${key} is marked in ${file} but not registered`);
  }
  const capture = await readFile(join('ui', 'usage', 'capture.js'), 'utf8');
  for (const item of USAGE_REGISTRY) {
    if (item.key === TEXT_FIELD_KEY) continue;
    if (item.group === 'shortcut') { assert.ok(capture.includes(`'${item.key}'`) || capture.includes(`"${item.key}"`), `${item.key} is produced by ui/usage/capture.js`); continue; }
    if (item.hook) { assert.ok(combined.includes(item.hook), `${item.key}: the class ${item.hook} exists in the UI`); continue; }
    const direct = marked.has(item.key), viaTemplate = templates.some(key => new RegExp(`^${expand(key).replace('.', '\\.')}$`).test(item.key));
    assert.ok(direct || viaTemplate, `${item.key} is registered but no control carries data-usage="${item.key}"`);
  }
});

/* ---------- the keys of the main pages are the same in both languages ---------- */

const require = createRequire(import.meta.url);
async function bundle(entry, exports) {
  const compiled = await build({ stdin: { contents: exports, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'],
    loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
  return module.exports;
}
const m = await loadUsageModules();
const pages = await bundle('pages', `
  export { default as StudyMap } from './ui/StudyMap.jsx';
  export { default as Review } from './ui/Review.jsx';
  export { default as ReviewToolbar } from './ui/ReviewToolbar.jsx';
  export { default as Settings } from './ui/Settings.jsx';
  export { default as Sources } from './ui/Sources.jsx';
  export { default as ShortcutHelp } from './ui/ShortcutHelp.jsx';
  export { NavItem, NavGroup } from './ui/SideNav.jsx';
  export { setUiLanguage, ui } from './ui/i18n.js';`);
const h = React.createElement;
const noop = () => {};
const withLanguage = (language, fn) => { pages.setUiLanguage(language); m.setUiLanguage(language); try { return fn(); } finally { pages.setUiLanguage('zh'); m.setUiLanguage('zh'); } };
const CONTROLS = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);
/** Every control of a rendered page, in document order, with the key it would be recorded under. */
function keysOf(html, area) {
  const page = dom(`<main data-usage-area="${area}">${html}</main>`);
  return page.all.filter(item => CONTROLS.has(item.tagName) || item.getAttribute('role') === 'tab').map(item => m.resolveUsageControl(item)?.key ?? null);
}

const deck = { id: 'd1', title: '行为型模式', folder: 'CS3219', course: 'CS3219', topics: ['Memento'], available: 5, count: 5, quizCount: 3, createdAt: '2026-09-01T00:00:00Z' };
const progress = { d1: { counts: { mastered: 1, familiar: 1, learning: 1, weak: 1, new: 1 }, total: 5, mastery: 60, due: 1, status: 'active', topics: [] } };
const sources = [{ id: 'p1', title: '讲义 第 1 页', text: 'x', document: { id: 'pdf', page: 1 } }, { id: 'p2', title: '讲义 第 2 页', text: 'x', document: { id: 'pdf', page: 2 } }];
const home = () => renderToStaticMarkup(h(pages.StudyMap, { data: { root: '/tmp/lib', decks: [deck], progress, sources, drafts: [], jobs: [], runs: [], today: { due: 1, weak: 2, new: 0, size: 3 }, focus: { mode: 'class', course: 'CS3219', courses: [{ name: 'CS3219' }], fresh: [] } },
  busy: false, start: noop, resume: noop, endRun: noop, manage: noop, openDraft: noop, continueDraft: noop, retryGeneration: noop, addSource: noop, createManual: noop, importLibrary: noop, askInChat: noop, notebooks: { notebooks: [] }, onFocus: noop, cancelJob: noop, dismissJob: noop, generateFromSources: noop, openModelSettings: noop, canChat: false }));
const review = kind => renderToStaticMarkup(h(pages.Review, { run: { id: 'r', index: 0, total: 3, card: { id: 'q', kind, topic: 'Context', prompt: 'Who processes payments?', options: [{ id: 'a', text: 'Payment System' }, { id: 'b', text: 'Ledger' }] }, revealed: kind !== 'quiz', feedback: null, solution: null },
  data: { sources: [] }, host: {}, choice: kind === 'quiz', isCloze: false, selected: [], clozeValues: {}, shellTitle: 'Review', busy: false }));
const settings = () => renderToStaticMarkup(h(pages.Settings, { data: { sources: [], contexts: ['system'], settings: {}, root: '/tmp/lib' }, busy: false, act: noop, call: async () => ({}), host: {}, setNotice: noop,
  settings: { first_interval_days: 1, second_interval_days: 6, initial_ease_factor: 2.5, minimum_ease_factor: 1.3 }, setSettings: noop, legacy: '', setLegacy: noop, workspacePanel: null, coursePanel: null, onboardingPanel: null, exportData: noop, onRestored: noop, initialProfile: { consent: false, goal: '', summary: '', signals: {} } }));

for (const [name, area, render] of [['home', 'library', home], ['practice (choice card)', 'review', () => review('quiz')], ['practice (flashcard)', 'review', () => review('flashcard')], ['settings', 'settings', settings], ['shortcut sheet', 'review', () => renderToStaticMarkup(h(pages.ShortcutHelp, { page: 'review', onClose: noop }))]]) {
  test(`the ${name} page produces the same control keys in Chinese and in English`, () => {
    const zh = withLanguage('zh', () => keysOf(render(), area)), en = withLanguage('en', () => keysOf(render(), area));
    assert.ok(zh.length >= 3, `${zh.length} controls`);
    assert.deepEqual(en, zh);
    assert.ok(zh.every(key => typeof key === 'string' && key.length < 96 && !/[@\\?=&#%<>"]|\/\//.test(key)), JSON.stringify(zh));
    assert.ok(zh.some(key => /\//.test(key) || /^[a-z]+\./.test(key)), 'some controls are named');
  });
}

test('the sidebar rows carry data-usage in the app and key identically in both languages', async () => {
  const app = await readFile(join('ui', 'App.jsx'), 'utf8');
  assert.match(app, /data-usage=\{`nav\.\$\{id\}`\}/, 'the page rows are keyed by page id');
  assert.match(app, /data-usage="nav\.settings"/);
  const zh = withLanguage('zh', () => renderToStaticMarkup(h(pages.NavItem, { glyph: 'library', label: pages.ui('学习库'), 'data-usage': 'nav.library' })));
  const en = withLanguage('en', () => renderToStaticMarkup(h(pages.NavItem, { glyph: 'library', label: pages.ui('学习库'), 'data-usage': 'nav.library' })));
  assert.deepEqual(keysOf(en, 'library'), keysOf(zh, 'library'));
  assert.deepEqual(keysOf(zh, 'library'), ['nav.library']);
});

/* ---------- operations: contracts, and not an agent tool ---------- */

async function withHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'study-usage-ops-'));
  const before = process.env.DSH_HOME; process.env.DSH_HOME = home;
  t.after(async () => { if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(home, { recursive: true, force: true }); });
  return home;
}

test('the operations exist with schemas like the other operations, and reject malformed arguments', async t => {
  await withHome(t);
  const root = await mkdtemp(join(tmpdir(), 'study-usage-ops-lib-'));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  const system = service.runtime.describe().find(context => context.id === 'system');
  for (const name of ['usage.frequency.status', 'usage.frequency.set', 'usage.frequency.record', 'usage.frequency.report', 'usage.frequency.export', 'usage.frequency.clear']) {
    const operation = system.operations.find(item => item.name === name);
    assert.ok(operation, name);
    assert.ok(operation.description.length > 20, `${name} says what it does`);
    assert.notDeepEqual(operation.input, { type: 'object', additionalProperties: true }, `${name} has a real input schema`);
  }
  await assert.rejects(service.call('usage.frequency.record', { records: 'nav.library' }), /records/);
  await assert.rejects(service.call('usage.frequency.record', {}), /records/);
  await assert.rejects(service.call('usage.frequency.set', { enabled: 'yes' }), /enabled/);
  await assert.rejects(service.call('usage.frequency.report', { period: 12 }), /period/);
  await assert.rejects(service.call('usage.frequency.export', { format: 'pdf' }), /format/);
  assert.equal((await service.call('usage.frequency.status')).enabled, false);
  const on = await service.call('usage.frequency.set', { enabled: true });
  assert.equal(on.enabled, true);
  const report = await service.call('usage.frequency.report', { period: 7, language: 'en' });
  assert.equal(report.summary.interactions, 0, 'a fresh record has an empty report, not an error');
  const exported = await service.call('usage.frequency.export', { format: 'json', period: 'all', language: 'en' });
  assert.equal(JSON.parse(exported.content).app, 'StudyHub');
  assert.equal(JSON.parse(exported.content).version, JSON.parse(await readFile('package.json', 'utf8')).version, 'the export names the app version');
  const status = await service.call('usage.frequency.clear');
  assert.equal(status.hasData, false);
});

test('the usage operations are for the panel only: the assistant\'s study_workspace tool refuses them, and no domain tool lists them', async t => {
  const home = await withHome(t);
  const plugin = await import('../lib/index.js');
  const tools = [];
  const ctx = {
    tools: { register: tool => tools.push(tool) }, commands: { register: () => {} }, llm: {}, systemPrompt: { section: () => {} }, sessions: { get: () => undefined },
    get: name => name === 'connection' ? { fetch: { register: () => () => {} } } : undefined, inject: (_dependencies, fn) => fn(ctx), effect: fn => fn(),
  };
  plugin.apply(ctx, {});
  const workspace = tools.find(tool => tool.name === 'study_workspace');
  assert.ok(workspace);
  const cwd = await mkdtemp(join(tmpdir(), 'study-usage-agent-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const agent = { id: 'a', session: { header: { cwd } } };
  for (const action of ['usage.frequency.status', 'usage.frequency.set', 'usage.frequency.record', 'usage.frequency.report', 'usage.frequency.export', 'usage.frequency.clear']) {
    await assert.rejects(workspace.execute({ action, payload_json: JSON.stringify({ enabled: true, records: [] }) }, { agent }), /not available|panel/i, action);
  }
  assert.ok(!(await readdir(home)).includes('study'), 'the refused calls wrote nothing');
  const text = JSON.stringify(tools.map(tool => [tool.name, tool.description, Object.keys(tool.parameters || {})]));
  assert.ok(!/usage\.frequency|usage-frequency/.test(text), 'no tool advertises them');
  const { studyToolDescription, studyUsagePrompt, libraryContracts } = await import('../lib/study-contracts.js');
  assert.ok(!/usage\.frequency/.test(studyToolDescription + studyUsagePrompt + JSON.stringify(libraryContracts)));
});

test('the panel route still carries them (the host handler answers them like any panel action)', async t => {
  const home = await withHome(t);
  const { createHostHandler } = await import('../lib/host.js');
  const cwd = await mkdtemp(join(tmpdir(), 'study-usage-host-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const session = { header: { cwd } };
  const handle = createHostHandler({ sessions: { get: () => session }, effect: () => {} }, { libraryRoot: cwd });
  const status = await handle('call', { sessionId: 's', action: 'usage.frequency.status', args: {} });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.value.enabled, false);
  const set = await handle('call', { sessionId: 's', action: 'usage.frequency.set', args: { enabled: true } });
  assert.equal(set.value.enabled, true);
  assert.ok((await readdir(join(home, 'study'))).includes('usage-frequency.json'));
});
