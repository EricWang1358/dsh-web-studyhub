import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* The sidebar is grouped by when a page is used (docs/feature-tiers.md): 每天 (every day), 阶段性 (now and then) and
   课程准备与管理 (once at the start of a course). The grouping removes nothing: every page, anchor, shortcut and the
   drag-to-reorder stay, and a group that was folded stays folded. */
const han = /[㐀-鿿]/;
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: "export * from './ui/SideNav.jsx'; export * from './ui/nav-order.js'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const { NavGroup, NavItem, NAV_DEFAULTS, NAV_GROUPS, mergeOrder, groupIsOpen, readNavGroups, writeNavGroups, setUiLanguage } = mod.exports;
const html = (element) => renderToStaticMarkup(element);
const h = React.createElement;

/** The twelve pages the sidebar had before it was grouped. */
const BEFORE = ['library', 'sources', 'generate', 'wrongbook', 'exam', 'dashboard', 'workflows', 'skeleton', 'notes', 'audio', 'live', 'board'];

test('three groups by when a page is used, and every page the sidebar had is still in exactly one of them', () => {
  assert.deepEqual(Object.keys(NAV_DEFAULTS), ['daily', 'periodic', 'setup']);
  assert.deepEqual(NAV_DEFAULTS.daily, ['library', 'sources', 'generate', 'wrongbook', 'workflows', 'notes', 'board'], 'adding the weekly material and making questions from it recur every week: they are daily');
  assert.deepEqual(NAV_DEFAULTS.periodic, ['exam', 'dashboard']);
  assert.deepEqual(NAV_DEFAULTS.setup, ['skeleton', 'audio', 'live']);
  const all = Object.values(NAV_DEFAULTS).flat();
  assert.deepEqual([...all].sort(), [...BEFORE].sort(), 'no page dropped, none added');
  assert.equal(new Set(all).size, all.length, 'no page in two groups');
});

test('the groups carry plain labels and say which of them can be folded', () => {
  assert.deepEqual(NAV_GROUPS.map((group) => [group.id, group.label]), [['daily', '每天'], ['periodic', '阶段性'], ['setup', '课程准备与管理']]);
  assert.equal(NAV_GROUPS.find((group) => group.id === 'daily').collapsible, false, 'the daily path is never folded away');
  assert.ok(NAV_GROUPS.filter((group) => group.id !== 'daily').every((group) => group.collapsible));
  for (const group of NAV_GROUPS) assert.ok(group.hint && han.test(group.hint), `${group.id} explains itself in one line`);
});

test('an order saved before the regrouping keeps its order inside the new groups', () => {
  const saved = { main: ['dashboard', 'library', 'generate'], upkeep: ['board', 'notes', 'live'] };
  const merged = mergeOrder(saved, NAV_DEFAULTS);
  assert.deepEqual(merged.daily, ['library', 'generate', 'board', 'notes', 'sources', 'wrongbook', 'workflows']);
  assert.deepEqual(merged.periodic, ['dashboard', 'exam']);
  assert.deepEqual(merged.setup, ['live', 'skeleton', 'audio']);
  assert.deepEqual(mergeOrder({ daily: ['notes'], periodic: 5 }, NAV_DEFAULTS).daily, ['notes', 'library', 'sources', 'generate', 'wrongbook', 'workflows', 'board'], 'an order in the new shape is used as it is');
  // 2.5.0 to 2.5.2 put 资料 and 创建题组 in the setup group: a saved order from then still ends up with them in 每天, and keeps its own order inside the groups
  const older = mergeOrder({ daily: ['notes', 'library'], periodic: ['dashboard'], setup: ['live', 'sources', 'generate', 'skeleton'] }, NAV_DEFAULTS);
  assert.deepEqual(older.daily, ['notes', 'library', 'sources', 'generate', 'wrongbook', 'workflows', 'board']);
  assert.deepEqual(older.setup, ['live', 'skeleton', 'audio']);
  assert.deepEqual(mergeOrder(null, NAV_DEFAULTS), NAV_DEFAULTS);
});

test('a folded group opens by itself while the learner is on one of its pages, and the daily group never folds', () => {
  const folded = { periodic: true, setup: true, daily: true };
  assert.equal(groupIsOpen('periodic', folded, 'review'), false);
  assert.equal(groupIsOpen('periodic', folded, 'exam'), true, 'the current page stays visible');
  assert.equal(groupIsOpen('setup', folded, 'skeleton'), true);
  assert.equal(groupIsOpen('setup', {}, 'library'), true, 'groups start open');
  assert.equal(groupIsOpen('daily', folded, 'library'), true);
});

test('which groups are folded is remembered per viewer, and a blocked storage changes nothing', () => {
  const store = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) } });
    assert.deepEqual(readNavGroups(), {});
    writeNavGroups({ setup: true, periodic: false });
    assert.deepEqual(readNavGroups(), { setup: true }, 'only folded groups are kept');
    store.set('study-nav-groups', '{"setup": true, "bogus": true, "daily": true}');
    assert.deepEqual(readNavGroups(), { setup: true }, 'unknown and never-folded groups are ignored');
    store.set('study-nav-groups', 'not json');
    assert.deepEqual(readNavGroups(), {});
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } } });
    assert.deepEqual(readNavGroups(), {});
    assert.doesNotThrow(() => writeNavGroups({ setup: true }));
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else delete globalThis.localStorage; }
});

test('a group is a labelled region: a button that folds it, the rows inside, the state in aria and data attributes', () => {
  setUiLanguage('zh');
  const row = h(NavItem, { glyph: 'exam', label: '模拟考试', 'data-tour': 'nav-exam', 'data-nav-id': 'exam' });
  const open = html(h(NavGroup, { id: 'periodic', label: '阶段性', hint: '隔一阵用一次', collapsible: true, open: true, onToggle() {} }, row));
  assert.match(open, /^<div class="nav-group" role="group" aria-labelledby="nav-group-periodic-label" data-nav-group="periodic" data-open="true">/);
  assert.match(open, /<button type="button" class="nav-group-label" data-usage="nav.group" id="nav-group-periodic-label" aria-expanded="true" aria-controls="nav-group-periodic-items" title="隔一阵用一次">/);
  assert.match(open, /<span class="nav-group-text">阶段性<\/span>/);
  assert.match(open, /<div class="nav-group-items" id="nav-group-periodic-items">/);
  assert.match(open, /data-tour="nav-exam"/);
  const folded = html(h(NavGroup, { id: 'periodic', label: '阶段性', collapsible: true, open: false, onToggle() {} }, row));
  assert.match(folded, /aria-expanded="false"/);
  assert.match(folded, /data-open="false"/);
  assert.match(folded, /<div class="nav-group-items" id="nav-group-periodic-items" hidden="">/, 'the rows stay in the page (anchors, shortcuts) but are not shown');
  assert.match(folded, /data-tour="nav-exam"/);
});

test('the daily group is a plain heading, not a button: there is nothing to fold', () => {
  setUiLanguage('zh');
  const markup = html(h(NavGroup, { id: 'daily', label: '每天', collapsible: false, open: true }, h('i')));
  assert.doesNotMatch(markup, /<button/);
  assert.match(markup, /<div class="nav-group-label is-static" id="nav-group-daily-label">/);
  assert.match(markup, /data-open="true"/);
});

test('English renders without Han, and the group labels have English text', () => {
  setUiLanguage('en');
  try {
    const markup = NAV_GROUPS.map((group) => html(h(NavGroup, { id: group.id, label: group.label, hint: group.hint, collapsible: group.collapsible, open: false, onToggle() {} }, h('i')))).join('');
    assert.doesNotMatch(markup, han);
    assert.match(markup, /Every day/);
    assert.match(markup, /Now and then/);
    assert.match(markup, /Setup &amp; manage/);
  } finally { setUiLanguage('zh'); }
});

test('App renders the sidebar through the groups: resume and coach lead the daily group, every page keeps its anchor', async () => {
  const source = (await readFile(new URL('../ui/App.jsx', import.meta.url), 'utf8')).replace(/\r/g, '');
  assert.match(source, /<NavGroup\b/);
  assert.match(source, /NAV_GROUPS\.map/);
  assert.match(source, /data-tour=\{`nav-\$\{id\}`\}/, 'the nav-<page> tour anchors stay');
  assert.match(source, /groupIsOpen\(/);
  const daily = source.indexOf('<ResumeNavItem'), groups = source.indexOf('NAV_GROUPS.map');
  assert.ok(groups > 0 && daily > groups, 'the resume row is drawn inside the group loop, not before it');
  assert.doesNotMatch(source, /navOrder\.order\.main|navOrder\.order\.upkeep/);
});

test('stylesheet contract: a group label is one fixed height, and in the narrow rail it shrinks to a divider', async () => {
  const css = (await readFile(new URL('../ui/side-groups.css', import.meta.url), 'utf8')).replace(/\r/g, '');
  assert.match(css, /\.nav-group-label\s*\{[^}]*height:\s*var\(--nav-group\)/s);
  assert.match(css, /--nav-group:\s*\d+px/);
  assert.match(css, /\.sidebar\.is-narrow\s+\.nav-group-label\s*\{[^}]*height:/s);
  assert.match(css, /\.sidebar\.is-narrow\s+\.nav-group-text/);
  assert.match(css, /\.side-nav\s+\.nav\.is-dragging/, 'a lifted row still floats above its neighbours inside a group');
});
