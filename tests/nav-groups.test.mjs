import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readAppSource } from './helpers/app-source.mjs';

/* The sidebar's places (#654): a main list of at most six pages under 回到题目 (seven rows), and 「更多」 with every other page in sections
   named by what they hold. Both are derived from ui/pages.js; nothing is dropped (every page keeps its anchor and its shortcut), a learner's
   saved order survives the change, and a page can be dragged between the main list and its own section. */
const han = /[㐀-鿿]/;
const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: { contents: "export * from './ui/SideNav.jsx'; export * from './ui/nav-order.js'; export * from './ui/pages.js'; export { setUiLanguage } from './ui/i18n.js';", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const { NavGroup, NavFold, NavItem, NAV_DEFAULTS, NAV_GROUPS, NAV_HOMES, NAV_SECTIONS, MAIN_LIMIT, PAGES, NAV_ORDER_KEY, LEGACY_ORDER_KEY,
  mergeOrder, moreIsOpen, readNavOrder, writeNavOrder, setUiLanguage } = mod.exports;
const html = (element) => renderToStaticMarkup(element);
const h = React.createElement;

/** Every page the sidebar had before #654 (15 pages, grouped then as 每天 / 阶段性 / 课程准备与管理). */
const BEFORE = ['library', 'sources', 'generate', 'tasks', 'wrongbook', 'notes', 'board', 'exam', 'examprep', 'book', 'dashboard', 'skeleton', 'audio', 'live'];

function store(entries = {}) {
  const map = new Map(Object.entries(entries));
  return { map, getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) };
}

test('at most six pages in the main list, so the sidebar shows at most seven rows with 回到题目; the rest sit in 「更多」', () => {
  assert.equal(MAIN_LIMIT, 6);
  assert.deepEqual(NAV_DEFAULTS.main, ['library', 'sources', 'generate', 'wrongbook', 'exam', 'dashboard'], 'today, materials, making questions, mistakes, exams, statistics');
  assert.ok(NAV_DEFAULTS.main.length <= MAIN_LIMIT);
  assert.deepEqual(NAV_DEFAULTS.main, Object.keys(PAGES).filter((id) => PAGES[id].main), 'derived from ui/pages.js, in registry order');
  const all = Object.values(NAV_DEFAULTS).flat();
  assert.deepEqual([...all].sort(), [...BEFORE].sort(), 'no page dropped');
  assert.equal(new Set(all).size, all.length, 'no page in two places');
});

test('「更多」 is in sections by what the pages are about, and every label says what is inside', () => {
  assert.deepEqual(NAV_SECTIONS.map((section) => [section.id, section.label]),
    [['material', '资料与出题'], ['practice', '练习与复习'], ['exam', '考试与统计'], ['notes', '任务、笔记与待办']]);
  assert.deepEqual(NAV_GROUPS.map((group) => group.id), ['main', 'material', 'practice', 'exam', 'notes']);
  for (const section of NAV_SECTIONS) assert.doesNotMatch(section.label, /每天|阶段性|常用|偶尔|准备与管理/, `${section.id}: a label about content, not about how often`);
  assert.deepEqual(NAV_DEFAULTS.material, ['audio', 'live']);
  assert.deepEqual(NAV_DEFAULTS.practice, ['book', 'skeleton']);
  assert.deepEqual(NAV_DEFAULTS.exam, ['examprep']);
  assert.deepEqual(NAV_DEFAULTS.notes, ['tasks', 'notes', 'board']);
  for (const id of BEFORE) assert.ok(NAV_SECTIONS.some((section) => section.id === NAV_HOMES[id]), `${id} has a home section to go back to`);
});

test('a learner who reordered the old sidebar keeps their order: it is migrated once, and the old key goes away', () => {
  // Saved by 4.3: their 每天 order puts 错题与待巩固 and 学习笔记 first, their 阶段性 order 统计 before 模拟考试, their setup order 课堂实录 first.
  const local = store({ [LEGACY_ORDER_KEY]: JSON.stringify({
    daily: ['wrongbook', 'notes', 'library', 'sources', 'generate', 'tasks', 'workflows', 'board'],
    periodic: ['dashboard', 'book', 'exam', 'examprep'],
    setup: ['live', 'skeleton', 'audio'],
  }) });
  const order = readNavOrder(local);
  assert.deepEqual(order.main, ['wrongbook', 'library', 'sources', 'generate', 'dashboard', 'exam'], 'the main list in the learner\'s sequence');
  assert.deepEqual(order.material, ['live', 'audio']);
  assert.deepEqual(order.practice, ['book', 'skeleton'], 'book (阶段性) came before skeleton (setup) in their sequence, and retired workflows is dropped');
  assert.deepEqual(order.notes, ['notes', 'tasks', 'board']);
  writeNavOrder(order, local);
  assert.equal(local.map.has(LEGACY_ORDER_KEY), false, 'read once: the old key is removed');
  assert.deepEqual(JSON.parse(local.map.get(NAV_ORDER_KEY)), order, 'the migrated order is the new one');
  assert.deepEqual(readNavOrder(local), order, 'and it reads back the same');
  // An order saved before the regrouping of 2.5 (main / upkeep) migrates the same way.
  const older = readNavOrder(store({ [LEGACY_ORDER_KEY]: JSON.stringify({ main: ['dashboard', 'library'], upkeep: ['board', 'live'] }) }));
  assert.deepEqual(older.main, ['dashboard', 'library', 'sources', 'generate', 'wrongbook', 'exam']);
  assert.deepEqual(older.notes, ['board', 'tasks', 'notes']);
  assert.deepEqual(readNavOrder(store()), mergeOrder(null, NAV_DEFAULTS), 'nothing saved: the defaults');
  assert.deepEqual(readNavOrder(store({ [LEGACY_ORDER_KEY]: 'not json' })), mergeOrder(null, NAV_DEFAULTS), 'a damaged old order is ignored');
});

test('a page dragged from 「更多」 into the main list stays there after a reload, and the main list keeps its limit', () => {
  const local = store({ [NAV_ORDER_KEY]: JSON.stringify({ main: ['library', 'sources', 'generate', 'wrongbook', 'book'], practice: ['skeleton'], exam: ['exam', 'dashboard', 'examprep'] }) });
  const order = readNavOrder(local);
  assert.deepEqual(order.main, ['library', 'sources', 'generate', 'wrongbook', 'book']);
  assert.deepEqual(order.exam, ['exam', 'dashboard', 'examprep'], 'pages taken out of the main list are in their own section');
  const crowded = readNavOrder(store({ [NAV_ORDER_KEY]: JSON.stringify({ main: BEFORE }) }));
  assert.equal(crowded.main.length, MAIN_LIMIT);
});

test('「更多」 is open when the learner opened it, and while the page on screen is in it (unless they closed it right there)', () => {
  assert.equal(moreIsOpen({ open: false, activePage: 'library', order: NAV_DEFAULTS }), false);
  assert.equal(moreIsOpen({ open: true, activePage: 'library', order: NAV_DEFAULTS }), true);
  assert.equal(moreIsOpen({ open: false, activePage: 'book', order: NAV_DEFAULTS }), true, 'the current page stays visible');
  assert.equal(moreIsOpen({ open: false, activePage: 'book', order: NAV_DEFAULTS, closedOn: 'book' }), false, 'closed by the learner on this page');
  assert.equal(moreIsOpen({ open: false, activePage: 'review', order: NAV_DEFAULTS }), false);
  assert.equal(moreIsOpen({ open: false, activePage: 'book', order: { ...NAV_DEFAULTS, main: [...NAV_DEFAULTS.main.slice(0, 5), 'book'], practice: ['skeleton'] } }), false,
    'a page dragged into the main list is not in 「更多」');
});

test('a section is a labelled group with a fixed-height heading; the main list names itself for screen readers only', () => {
  setUiLanguage('zh');
  const row = h(NavItem, { glyph: 'book', label: '复习全书', 'data-tour': 'nav-book', 'data-nav-id': 'book' });
  const section = html(h(NavGroup, { id: 'practice', label: '练习与复习' }, row));
  assert.match(section, /^<div class="nav-group" role="group" aria-labelledby="nav-group-practice-label" data-nav-group="practice">/);
  assert.match(section, /<div class="nav-group-label" id="nav-group-practice-label"><span class="nav-group-text">练习与复习<\/span><\/div>/);
  assert.match(section, /<div class="nav-group-items">.*data-tour="nav-book"/s);
  assert.doesNotMatch(section, /<button[^>]*nav-group-label/, 'nothing to fold on a section: 「更多」 is the one fold');
  const main = html(h(NavGroup, { id: 'main', label: '主导航', hidden: true }, row));
  assert.match(main, /class="nav-group-label sh-visually-hidden"/);
});

test('「更多」 is a row with aria-expanded over a native fold, so the finder and the tour can open it; folded, the rows stay in the page', () => {
  setUiLanguage('zh');
  const child = h(NavItem, { glyph: 'book', label: '复习全书', 'data-tour': 'nav-book' });
  const closed = html(h(NavFold, { id: 'more', glyph: 'more', label: '更多', purpose: '其余的功能', open: false, onToggle() {}, 'data-tour': 'nav-more' }, child));
  assert.match(closed, /<div class="nav-fold" data-nav-fold="more" data-open="false">/);
  assert.match(closed, /<button type="button" data-tour="nav-more" aria-expanded="false" aria-controls="nav-fold-more"[^>]*class="nav nav-fold__toggle"/);
  assert.match(closed, /<details class="nav-fold__items" id="nav-fold-more"><summary hidden="">更多<\/summary>.*data-tour="nav-book"/s, 'the rows are there, in a closed <details>');
  const open = html(h(NavFold, { id: 'more', glyph: 'more', label: '更多', open: true, onToggle() {} }, child));
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /<details class="nav-fold__items" id="nav-fold-more" open="">/);
  const flagged = html(h(NavFold, { id: 'more', glyph: 'more', label: '更多', alert: '1 个任务没有完成，点开看原因', open: false, onToggle() {} }, child));
  assert.match(flagged, /<span class="nav-dot" aria-hidden="true"><\/span>/, 'the dot of a row folded away is on 「更多」');
  assert.match(flagged, /role="tooltip"[^>]*>1 个任务没有完成，点开看原因/, 'with its reason');
});

test('English renders without Han, and every label has English text', () => {
  setUiLanguage('en');
  try {
    const markup = NAV_GROUPS.map((group) => html(h(NavGroup, { id: group.id, label: group.label }, h('i')))).join('')
      + html(h(NavFold, { id: 'more', glyph: 'more', label: 'More', open: false, onToggle() {} }, h('i')));
    assert.doesNotMatch(markup, han);
    assert.match(markup, /Materials and questions/);
    assert.match(markup, /Practice and review/);
    assert.match(markup, /Exams and statistics/);
    assert.match(markup, /Tasks, notes and to-dos/);
  } finally { setUiLanguage('zh'); }
});

test('the sidebar draws its rows from the registry: the main list, then 「更多」 with its sections; every page keeps its anchor', async () => {
  const source = (await readAppSource()).replace(/\r/g, '');
  assert.match(source, /<NavGroup id="main"/);
  assert.match(source, /NAV_GROUPS\.filter\(\(group\) => group\.more/);
  assert.match(source, /<NavFold id="more"/);
  assert.match(source, /data-tour="nav-more"/);
  assert.match(source, /data-tour=\{`nav-\$\{id\}`\}/, 'the nav-<page> tour anchors stay');
  assert.doesNotMatch(source, /'library', 'sources', 'generate'/, 'no second list of pages in the shell');
  const main = source.indexOf('<NavGroup id="main"'), resume = source.indexOf('<ResumeNavItem'), more = source.indexOf('<NavFold id="more"');
  assert.ok(main > 0 && resume > main && more > resume, '回到题目 leads the main list, 「更多」 follows it');
});

test('stylesheet contract: a section label is one fixed height, the fold has no summary of its own on screen, the dot sits on the icon', async () => {
  const css = (await readFile(new URL('../ui/side-groups.css', import.meta.url), 'utf8')).replace(/\r/g, '');
  assert.match(css, /\.nav-group-label\s*\{[^}]*height:\s*var\(--nav-group\)/s);
  assert.match(css, /--nav-group:\s*\d+px/);
  assert.match(css, /\.nav-fold__items > summary\s*\{\s*display:\s*none;/);
  assert.match(css, /\.nav-dot\s*\{[^}]*position:\s*absolute[^}]*top:[^}]*right:/s);
  assert.doesNotMatch(css, /is-narrow/, 'there is no icon rail any more (#657)');
  const shell = (await readFile(new URL('../ui/shell.css', import.meta.url), 'utf8')).replace(/\r/g, '');
  assert.match(shell, /\.side-nav\s+\.nav\.is-dragging/, 'a lifted row still floats above its neighbours');
  assert.doesNotMatch(shell, /\.sidebar\.is-narrow/, 'no 62px rail rules are left');
});
