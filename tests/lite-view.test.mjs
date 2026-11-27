import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mapProps } from './helpers/study-map-props.mjs';
import { richLibrary, homeElementProps, services, sidebarApp } from './helpers/lite-view-fixtures.mjs';
import { loadInteractiveUi, click, textOf, withBrowserGlobals } from './helpers/react-harness.mjs';

/* 简洁版 (the lite view): an opt-in switch of this browser that only changes what the sidebar and the library home draw. It writes its own value and nothing
   else, the guided tour shows the full view, 恢复默认外观 leaves it alone, and 找功能 never sends the learner to a button it took off the home. */

const stored = new Map();
const written = [];
const storage = {
  getItem: (key) => (stored.has(key) ? stored.get(key) : null),
  setItem: (key, value) => { written.push(key); stored.set(key, String(value)); },
  removeItem: (key) => { written.push(key); stored.delete(key); },
};
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
const fresh = () => { stored.clear(); written.length = 0; };

/* Parts that load themselves after mount (or read the library in an effect) draw nothing in a static render: each is replaced by a marker, so a test sees
   whether the home mounts it at all. */
const STUBS = { 'LazyDeskPlayStrip.jsx': 'desk-play', 'CrunchCard.jsx': 'crunch', 'WeeklyCard.jsx': 'weekly' };
const stubs = { name: 'lite-stubs', setup(builder) {
  builder.onLoad({ filter: /(LazyDeskPlayStrip|CrunchCard|WeeklyCard)\.jsx$/ }, (args) => {
    const name = STUBS[args.path.split(/[\\/]/).at(-1)];
    return { contents: `import React from 'react'; export default function Stub() { return <i data-stub="${name}" />; }`, loader: 'jsx' };
  });
} };

const ENTRY = `export { default as StudyMap } from './ui/StudyMap.jsx';
  export { default as SidebarNav } from './ui/app/SidebarNav.jsx';
  export { default as AppearanceSection } from './ui/settings/AppearanceSection.jsx';
  export { PageView } from './ui/app/page-views.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export { tripNotice } from './ui/finder/trip.js';
  export { liteViewStore } from './ui/use-lite-view.js';
  export { NEXT_STEP_IDS } from './ui/study-map/next-step.js';`;
const compiled = await build({ stdin: { contents: ENTRY, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react-dom'], plugins: [stubs], loader: { '.css': 'text' }, logLevel: 'silent' });
const windowListeners = [];
const bundleModule = { exports: {} };
globalThis.window = { addEventListener: (type, listener) => windowListeners.push({ type, listener }), removeEventListener() {} };
try { new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), bundleModule, bundleModule.exports); }
finally { delete globalThis.window; }
const app = bundleModule.exports;
// The interface's default follows the machine's language (Chinese on one machine, English on CI): every assertion below reads the Chinese one.
app.setUiLanguage('zh');
const { tripNotice, NEXT_STEP_IDS } = app;
const rules = await import('../ui/lite-view.js');
const { NAV_DEFAULTS, NAV_ORDER_KEY } = await import('../ui/nav-order.js');
const { createAppearanceStore } = await import('../ui/appearance-prefs.js');
const { FINDER_ENTRIES, PREPARE_STEPS } = await import('../ui/finder/entries.js');
const { searchFeatures } = await import('../ui/finder/search.js');
const { categoryForAnchor } = await import('../ui/settings-groups.js');

const h = React.createElement;
const provided = (context, element) => h(app.StudyServicesContext.Provider, { value: services() }, context ? h(app.AppContext.Provider, { value: context }, element) : element);
const withLite = (on, fn) => { app.liteViewStore.set(on); try { return fn(); } finally { app.liteViewStore.set(false); } };
const home = ({ data = richLibrary(), context = null } = {}) => renderToStaticMarkup(provided(context, h(app.StudyMap, homeElementProps(mapProps, data))));
const libraryPage = ({ data = richLibrary(), touring = null } = {}) => {
  const noop = () => {};
  const context = { ...sidebarApp({ data, touring }), lib: { gen: {} }, set: { setRevealHome: noop }, session: {}, intents: { revealHome: 0 }, drafts: {}, tour: { tourStep: touring },
    dailyPlan: { date: '2026-01-01', state: null }, settingsEntry: {}, learn: {}, connection: {} };
  return renderToStaticMarkup(provided(context, h(app.PageView, { page: 'library' })));
};
const sidebar = ({ context = sidebarApp(), alert = null } = {}) => renderToStaticMarkup(provided(context, h(app.SidebarNav, { alert, reason: alert ? 'why the dot' : '', tasks: null })));
const rowsOf = (html, group) => {
  const start = html.indexOf(`data-nav-group="${group}"`);
  if (start < 0) return [];
  const next = html.indexOf('data-nav-group="', start + 1);
  return [...html.slice(start, next < 0 ? undefined : next).matchAll(/data-nav-id="([a-z]+)"/g)].map((match) => match[1]);
};

/** Each block the lite home leaves out, by what only that block draws. */
const HIDDEN_BLOCKS = {
  '下一步 card': /class="next-card"/,
  '课程准备': /data-setup-checklist/,
  '总纲 buttons': /outline-entry/,
  '课程进度': /class="course-route"/,
  '学法 line': /class="course-method-line"/,
  '重点 line': /class="focus-progress"/,
  '掌握度 and 掌握图谱': /class="desk-mastery"/,
  'pace line': /data-pace-meta="course"/,
  '推荐下一步': /推荐下一步/,
  '只学这个主题': /只学这个主题/,
  'desk-play strip': /data-stub="desk-play"/,
  '查看图谱': /查看图谱/,
  'topic-group reminder': /个主题，还没按知识域归并/,
  'what is open inside 全局笔记本': /class="nb-search"/,
};
/** What stays, by the same rule. */
const KEPT_BLOCKS = {
  'course heading and switcher': /data-tour="home-course"/,
  'Today card': /class="today-card /,
  'start button': /today-go/,
  '本轮设置': /today-setup|本轮设置/,
  '其他开始方式': /class="desk-more"/,
  'unfinished rounds': /class="resume-list"/,
  '待发布': /home-drafts/,
  'generation progress and failure cards': /class="home-activity"/,
  'companion bar': /Companion lesson|companions-bar/,
  '学习目录': /data-tour="home-catalog"/,
  'add/import menu': /catalog-menu-toggle/,
  'search': /map-tools__search/,
  '已归档': /map-tools__archived/,
  'book backup warning': /data-book-backup/,
  // One line, drawn only for a course with an exam date: a due round outranks the exam card, and this still says the exam is coming.
  'exam countdown': /距考试 5 天/,
  // Publishing, searching and opening other workspaces' notebooks have no other way in, so the directory stays, folded to its heading.
  '全局笔记本': /class="nb-dir"/,
  'deck rows': /data-deck-id="d1"/,
};

test('the rule: OFF answers the learner\'s own order and shows every part; ON keeps four main pages and draws the rest in their 更多 section, without touching the order', () => {
  const order = structuredClone(NAV_DEFAULTS), before = structuredClone(order);
  assert.equal(rules.liteNavOrder(order, false), order, 'the same object: nothing is recomputed');
  const lite = rules.liteNavOrder(order, true);
  assert.deepEqual(lite.main, ['library', 'sources', 'generate', 'wrongbook']);
  assert.ok(lite.exam.includes('exam') && lite.exam.includes('dashboard'), '模拟考试 and 统计 are in 考试与统计');
  assert.deepEqual(Object.values(lite).flat().sort(), Object.values(before).flat().sort(), 'no page is lost');
  assert.deepEqual(order, before, 'the order handed in is not changed');
  // The learner's own choices: a kept page they moved to 更多 stays there, a page they dragged into the main list is drawn in 更多.
  const own = { ...before, main: ['book', 'sources', 'library', 'tasks'], practice: before.practice.filter((id) => id !== 'book').concat('wrongbook'),
    notes: before.notes.filter((id) => id !== 'tasks'), material: before.material.concat('generate'), exam: before.exam.concat('exam', 'dashboard') };
  const shown = rules.liteNavOrder(own, true);
  assert.deepEqual(shown.main, ['sources', 'library'], 'only the kept pages the learner has in the main list, in their order');
  assert.ok(shown.practice.includes('book') && shown.notes.includes('tasks') && shown.practice.includes('wrongbook'));
  for (const part of rules.LITE_HIDDEN) {
    assert.equal(rules.liteShows(false, part), true, part);
    assert.equal(rules.liteShows(true, part), false, part);
  }
  assert.equal(rules.liteViewOn({ saved: true, touring: false }), true);
  assert.equal(rules.liteViewOn({ saved: true, touring: true }), false, 'the guided tour shows the full view');
  assert.equal(rules.liteViewOn({ saved: false, touring: false }), false);
});

test('the setting: off by default, kept under its own key only, read again when another tab changes it, and 恢复默认外观 leaves it on', () => {
  fresh();
  const store = rules.createLiteViewStore({ storage });
  assert.equal(store.get(), false, 'off for everyone until the learner turns it on');
  let told = 0;
  store.subscribe(() => { told += 1; });
  store.set(true);
  assert.equal(store.get(), true);
  assert.equal(told, 1);
  assert.deepEqual([...new Set(written)], [rules.LITE_VIEW_KEY], 'nothing but its own value is written');
  const appearance = createAppearanceStore({ storage });
  appearance.update({ theme: 'dark', scale: 150 });
  appearance.reset();
  store.reload();
  assert.equal(store.get(), true, '恢复默认外观 does not turn 简洁版 off');
  stored.set(rules.LITE_VIEW_KEY, 'off');
  store.reload();
  assert.equal(store.get(), false);
  assert.equal(told, 2);
  // The app's own store follows the other tab through the storage event.
  fresh();
  app.liteViewStore.reload();
  stored.set(rules.LITE_VIEW_KEY, 'on');
  for (const { type, listener } of windowListeners) if (type === 'storage') listener({ key: rules.LITE_VIEW_KEY });
  assert.equal(app.liteViewStore.get(), true);
  app.liteViewStore.set(false);
});

test('the switch sits at the top of 设置 › 界面 with its hint, shows the saved value and writes only it', async () => {
  fresh();
  const appearance = { language: 'zh', theme: 'auto', accent: 'cinnabar', onLanguage() {}, onTheme() {}, onReset() {} };
  const html = withLite(false, () => renderToStaticMarkup(h(app.AppearanceSection, { appearance })));
  assert.ok(html.indexOf('data-tour="settings-appearance-lite"') > 0 && html.indexOf('data-tour="settings-appearance-lite"') < html.indexOf('data-tour="settings-appearance-language"'), 'first in the section');
  assert.match(html, /侧栏和首页只留练题常用的部分，其余页面仍在「更多」里；不删数据，也不改复习安排。/);
  assert.match(html, /role="switch"/);
  assert.doesNotMatch(html.slice(0, html.indexOf('settings-appearance-language')), /checked=""/);
  assert.equal(categoryForAnchor('settings-appearance-lite'), 'appearance');

  fresh();
  const ui = await loadInteractiveUi(`export { default as AppearanceSection } from './ui/settings/AppearanceSection.jsx'; export { liteViewStore } from './ui/use-lite-view.js';
    export { createAppearanceStore } from './ui/appearance-prefs.js';`);
  ui.exports.liteViewStore.reload();
  const prefs = ui.exports.createAppearanceStore({ storage });
  const view = ui.mount(ui.React.createElement(ui.exports.AppearanceSection, { appearance: { ...appearance, onReset: prefs.reset } }));
  const box = () => view.find((node) => node.type === 'input' && node.props.role === 'switch' && node.props['data-usage'] === 'settings.lite-view');
  assert.equal(box().props.checked, false);
  await view.act(() => box().props.onChange({ target: { checked: true } }));
  assert.equal(box().props.checked, true);
  assert.equal(stored.get(rules.LITE_VIEW_KEY), 'on');
  assert.deepEqual([...new Set(written)], [rules.LITE_VIEW_KEY]);
  await view.act(() => click(view.find((node) => node.type === 'button' && /appearance-reset/.test(node.props.className || ''))));
  assert.equal(box().props.checked, true, '恢复默认外观 leaves the switch on');
  assert.equal(stored.get(rules.LITE_VIEW_KEY), 'on');
  view.unmount();
});

test('OFF: the sidebar and the home draw every part, and no line about 简洁版', () => {
  app.setUiLanguage('zh');
  fresh();
  app.liteViewStore.reload();
  const side = sidebar();
  assert.deepEqual(rowsOf(side, 'main'), NAV_DEFAULTS.main);
  assert.match(side, /coach-nav/);
  assert.match(side, /aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/);
  const html = home();
  for (const [name, pattern] of Object.entries({ ...HIDDEN_BLOCKS, ...KEPT_BLOCKS })) assert.match(html, pattern, name);
  assert.doesNotMatch(html, /简洁版/);
  const page = libraryPage();
  for (const [name, pattern] of [['今天先做什么', /class="daily-plan/], ['期末一周', /data-stub="crunch"/], ['本周', /data-stub="weekly"/]]) assert.match(page, pattern, name);
});

test('ON: the main list is 学习库, 资料, 创建题组 and 错题与待巩固; every other page is in a closed 更多; no 为你定制 row and no reordering', () => {
  app.setUiLanguage('zh');
  const html = withLite(true, () => sidebar());
  assert.deepEqual(rowsOf(html, 'main'), ['library', 'sources', 'generate', 'wrongbook']);
  assert.ok(rowsOf(html, 'exam').includes('exam') && rowsOf(html, 'exam').includes('dashboard'));
  assert.deepEqual(['main', 'material', 'practice', 'exam', 'notes'].flatMap((group) => rowsOf(html, group)).sort(), Object.values(NAV_DEFAULTS).flat().sort(), 'every page keeps a row');
  assert.match(html, /data-nav-fold="more" data-open="false"/);
  assert.match(html, /data-tour="nav-resume"|resume-nav/);
  assert.doesNotMatch(html, /coach-nav/);
  assert.doesNotMatch(html, /aria-keyshortcuts="Alt/);
  // On a page that moved into 更多 the fold opens, as for any other page of it; the dot of a row folded away is carried by 更多.
  assert.match(withLite(true, () => sidebar({ context: sidebarApp({ page: 'dashboard' }) })), /data-nav-fold="more" data-open="true"/);
  const dotted = withLite(true, () => sidebar({ alert: { id: 'exam' } }));
  assert.match(dotted, /class="nav nav-fold__toggle has-alert"/);
});

test('ON never writes the saved sidebar order: a mounted sidebar keeps the learner\'s own, offers no drag, key move or reset, and the 更多 words invite no dragging', async () => {
  const own = { ...NAV_DEFAULTS, main: ['wrongbook', 'exam', 'library', 'dashboard', 'sources', 'generate'] };
  const run = async (lite) => {
    fresh();
    stored.set(NAV_ORDER_KEY, JSON.stringify(own));
    if (lite) stored.set(rules.LITE_VIEW_KEY, 'on');
    const ui = await loadInteractiveUi(`export { default as SidebarNav } from './ui/app/SidebarNav.jsx'; export { AppContext } from './ui/app/app-context.js';
      export { NavFold, NavItem } from './ui/SideNav.jsx';`);
    const view = ui.mount(ui.React.createElement(ui.exports.AppContext.Provider, { value: sidebarApp() },
      ui.React.createElement(ui.exports.SidebarNav, { alert: null, reason: '', tasks: null })));
    const result = {
      saved: stored.get(NAV_ORDER_KEY),
      // The rows as the sidebar hands them over (the Tooltip adds its own long-press handlers to the button inside).
      rows: view.findAll((node) => node.type === ui.exports.NavItem && node.props['data-nav-id']),
      fold: view.find((node) => node.type === ui.exports.NavFold),
      reset: view.find((node) => node.props?.className === 'nav-reset'),
      keys: written.filter((key) => key === rules.LITE_VIEW_KEY),
    };
    view.unmount();
    return result;
  };
  const off = await run(false), on = await run(true);
  assert.equal(on.saved, off.saved, 'the saved order is exactly what the full sidebar keeps');
  assert.deepEqual(JSON.parse(on.saved).main, own.main);
  assert.deepEqual(on.rows.map((row) => row.props['data-nav-id']).slice(0, 4), ['wrongbook', 'library', 'sources', 'generate']);
  for (const row of on.rows) for (const handler of ['onKeyDown', 'onPointerDown', 'onClickCapture']) assert.equal(row.props[handler], undefined, `${row.props['data-nav-id']}: ${handler}`);
  assert.ok(off.rows.every((row) => typeof row.props.onKeyDown === 'function'));
  assert.match(off.fold.props.purpose, /按住/);
  assert.doesNotMatch(on.fold.props.purpose, /按住|拖/);
  assert.ok(off.reset, 'a customised order can be reset in the full view');
  assert.equal(on.reset, null, 'no reset while ON: it would rewrite the saved order');
  assert.deepEqual(on.keys, [], 'drawing the sidebar writes no setting');
  fresh();
});

test('ON: the home leaves each listed block out and keeps each kept one; DailyPlan and 本周 are not mounted, 期末一周 is', () => {
  app.setUiLanguage('zh');
  fresh();
  const html = withLite(true, () => home());
  for (const [name, pattern] of Object.entries(HIDDEN_BLOCKS)) assert.doesNotMatch(html, pattern, name);
  for (const [name, pattern] of Object.entries(KEPT_BLOCKS)) assert.match(html, pattern, name);
  assert.match(html, /现在是简洁版，部分内容已收起。/);
  assert.match(html, />切回完整版<\/button>/);
  assert.equal((html.match(/sh-btn--primary[^"]*today-go/g) || []).length, 1, 'the Today card keeps the one primary button');
  const page = withLite(true, () => libraryPage());
  assert.doesNotMatch(page, /daily-plan|今天先做什么/, 'DailyPlan is not mounted, so it asks for no proposal');
  assert.doesNotMatch(page, /data-stub="(weekly|desk-play)"/);
  // The only thing on the home that says, unasked, that another course's exam is near: it draws itself only inside a course's final weeks.
  assert.match(page, /data-stub="crunch"/);
  assert.deepEqual(written.filter((key) => key !== rules.LITE_VIEW_KEY), [], 'no dismissal or other key is written');
});

test('ON keeps the door to the main chat that only the 下一步 card had: it moves into 其他开始方式', () => {
  app.setUiLanguage('zh');
  const html = withLite(true, () => home({ data: richLibrary({ coach: { ready: 0 } }) }));
  const fold = html.slice(html.indexOf('class="desk-more"'), html.indexOf('class="resume-list"'));
  assert.match(fold, /data-hand-off="guide\.start"/);
});

/** A quiet day on the rich library: no round open, nothing due, no draft, nothing wrong and no lately imported material, so the 下一步 card is the one that speaks. */
const quietDay = (patch = {}) => {
  const base = richLibrary();
  return richLibrary({ runs: [], drafts: [], jobs: [], today: { due: 0, weak: 0, new: 0, size: 0 }, decks: base.decks.map((item) => ({ ...item, wrong: 0 })),
    sources: base.sources.map((item) => ({ ...item, createdAt: '2026-01-01T00:00:00Z' })), ...patch });
};
const newMaterial = (id, title) => ({ id, title, text: 'x', course: 'CS3219', createdAt: new Date().toISOString() });
/** The home with the way to the review book, as the app gives it. */
const bookProps = (data, actions = {}) => {
  const props = homeElementProps(mapProps, data);
  Object.assign(props.actions, { onOpenExamBook: () => {}, ...actions });
  return props;
};
const bookHome = (data) => renderToStaticMarkup(provided(null, h(app.StudyMap, bookProps(data))));
const doorsOf = (html) => (html.match(/data-hand-off="guide\.start"/g) || []).length;
const foldOf = (html) => html.slice(html.indexOf('class="desk-more"'), html.indexOf('data-tour="home-today"'));

/** What only the 下一步 card tells the learner unasked, by the state that says it. */
const CARD_ONLY = {
  'one new material without questions': { id: 'new-source', data: () => quietDay({ sources: [newMaterial('s1', 'Lecture 1')] }), says: [/「Lecture 1」还没出过题/, /用这份资料出题/] },
  'several new materials without questions': { id: 'new-source', data: () => quietDay({ sources: [newMaterial('s1', 'Lecture 1'), newMaterial('s2', 'Lecture 2')] }),
    says: [/2 份新资料还没出过题/, /用这 2 份新资料出题/] },
};

test('ON keeps the 下一步 card for the reminder nothing else gives: a new material without questions', () => {
  app.setUiLanguage('zh');
  fresh();
  for (const [name, { id, data, says }] of Object.entries(CARD_ONLY)) {
    const off = bookHome(data()), on = withLite(true, () => bookHome(data()));
    for (const html of [off, on]) {
      assert.match(html, new RegExp(`class="next-card" data-next="${id}"`), name);
      for (const pattern of says) assert.match(html, pattern, name);
    }
    assert.equal((on.match(/sh-btn--primary/g) || []).length, 1, `${name}: the card holds the one primary button`);
    assert.equal(doorsOf(on), 1, `${name}: 「不知道从哪开始？」 is said once, on the card`);
    assert.match(on, /现在是简洁版/, name);
    assert.match(on, /距考试 5 天/, `${name}: the countdown stays`);
  }
});

test('ON leaves a coming exam to 期末一周, which has the book and covers every course: the home says it once', () => {
  app.setUiLanguage('zh');
  fresh();
  const off = bookHome(quietDay()), on = withLite(true, () => bookHome(quietDay()));
  assert.match(off, /class="next-card" data-next="exam"/);
  assert.doesNotMatch(on, /class="next-card"/);
  assert.match(on, /距考试 5 天/, 'the countdown stays');
  assert.equal(doorsOf(on), 1);
  assert.match(foldOf(on), /data-hand-off="guide\.start"/);
});

test('ON draws the 下一步 card for that state alone', () => {
  for (const id of NEXT_STEP_IDS) {
    assert.equal(rules.liteShowsNext(true, id), id === 'new-source', id);
    assert.equal(rules.liteShowsNext(false, id), true, id);
  }
  app.setUiLanguage('zh');
  // Wrong answers waiting: the deck rows and 错题与待巩固 in the sidebar say so, and the door waits under 其他开始方式.
  const wrong = withLite(true, () => bookHome(quietDay({ decks: richLibrary().decks, courses: [] })));
  assert.doesNotMatch(wrong, /class="next-card"/);
  assert.equal(doorsOf(wrong), 1);
  assert.match(foldOf(wrong), /data-hand-off="guide\.start"/);
});

test('ON: the kept card\'s button does what it does in the full view, and 今天先不 moves 「不知道从哪开始？」 under 其他开始方式', async () => {
  app.setUiLanguage('zh');
  const ui = await loadInteractiveUi(`export { default as StudyMap } from './ui/StudyMap.jsx'; export { StudyServicesContext } from './ui/study-context.jsx';
    export { liteViewStore } from './ui/use-lite-view.js'; export { default as NextStepCard } from './ui/study-map/NextStepCard.jsx';
    export { HandOff } from './ui/hand-off/HandOff.jsx'; export { default as DeskIntro } from './ui/study-map/DeskIntro.jsx';`, { plugins: [stubs] });
  const pressed = [];
  const actions = { generateFromSources: (ids) => pressed.push(['generate', ids]) };
  for (const key of ['one new material without questions', 'several new materials without questions']) {
    fresh();
    stored.set(rules.LITE_VIEW_KEY, 'on');
    ui.exports.liteViewStore.reload();
    await withBrowserGlobals(async () => {
      const view = ui.mount(ui.React.createElement(ui.exports.StudyServicesContext.Provider, { value: services() },
        ui.React.createElement(ui.exports.StudyMap, bookProps(CARD_ONLY[key].data(), actions))));
      const card = () => view.find((node) => node.type === ui.exports.NextStepCard);
      const foldDoor = () => view.find((node) => node.type === 'details' && node.props.className === 'desk-more');
      const doorsInFold = () => (foldDoor() ? view.findAll((node) => node.type === ui.exports.HandOff, foldDoor()).length : 0);
      assert.ok(card(), key);
      assert.equal(doorsInFold(), 0, `${key}: the card has the door`);
      await view.act(() => click(view.find((node) => node.type === 'button' && node.props['data-usage'] === 'home.next')));
      await view.act(() => click(view.find((node) => node.type === 'button' && node.props['data-usage'] === 'home.next-later')));
      assert.equal(card(), null, `${key}: put off for today`);
      assert.equal(doorsInFold(), 1, `${key}: the door waits under 其他开始方式`);
      view.unmount();
    });
  }
  assert.deepEqual(pressed.map(([name, ids]) => [name, [...ids].sort()]), [['generate', ['s1']], ['generate', ['s1', 's2']]]);
  ui.exports.liteViewStore.set(false);
  fresh();
});

test('ON with an empty library after 以后再说 keeps the explanation of the next step', () => {
  app.setUiLanguage('zh');
  const empty = richLibrary({ decks: [], progress: {}, drafts: [], jobs: [], runs: [], next: undefined, coach: { ready: 0 }, courses: [], bookCourses: [], topicGrouping: undefined,
    today: { due: 0, weak: 0, new: 0, size: 0 }, focus: { mode: 'class', course: '', courses: [], fresh: [] }, paceForecast: undefined });
  const off = home({ data: empty }), on = withLite(true, () => home({ data: empty }));
  const next = (html) => html.match(/<p class="desk-next">.*?<\/p>/)?.[0];
  assert.ok(next(off));
  assert.equal(next(on), next(off));
});

test('ON leaves the first screen of a new learner as it was', () => {
  app.setUiLanguage('zh');
  const empty = richLibrary({ decks: [], progress: {}, sources: [], drafts: [], jobs: [], runs: [], next: undefined, coach: { ready: 0 }, courses: [], bookCourses: [], topicGrouping: undefined,
    focus: { mode: 'class', course: '', courses: [], fresh: [] }, paceForecast: undefined });
  const render = () => renderToStaticMarkup(provided(null, h(app.StudyMap, homeElementProps(mapProps, empty, { firstRun: { form: 'page', on: {} } }))));
  const off = render();
  assert.match(off, /first-run-page/);
  assert.equal(withLite(true, render), off);
});

test('one click on the quiet line turns it off and the screen from before returns', async () => {
  app.setUiLanguage('zh');
  fresh();
  const ui = await loadInteractiveUi(`export { default as StudyMap } from './ui/StudyMap.jsx'; export { StudyServicesContext } from './ui/study-context.jsx';
    export { liteViewStore } from './ui/use-lite-view.js';`, { plugins: [stubs] });
  ui.exports.liteViewStore.reload();
  await withBrowserGlobals(async () => {
    const view = ui.mount(ui.React.createElement(ui.exports.StudyServicesContext.Provider, { value: services() },
      ui.React.createElement(ui.exports.StudyMap, homeElementProps(mapProps, richLibrary()))));
    const present = () => ({
      next: !!view.find((node) => node.props?.className === 'next-card'),
      deskPlay: !!view.find((node) => node.props?.['data-stub'] === 'desk-play'),
      line: !!view.find((node) => node.type === 'button' && node.props['data-usage'] === 'home.lite-off'),
      drafts: /待发布/.test(textOf(view.tree)),
      notebooksOpen: !!view.find((node) => node.type === 'form' && node.props.className === 'nb-search'),
    });
    const before = present();
    assert.deepEqual(before, { next: true, deskPlay: true, line: false, drafts: true, notebooksOpen: true });
    await view.act(() => ui.exports.liteViewStore.set(true));
    assert.deepEqual(present(), { next: false, deskPlay: false, line: true, drafts: true, notebooksOpen: false });
    await view.act(() => click(view.find((node) => node.type === 'button' && node.props['data-usage'] === 'home.lite-off')));
    assert.deepEqual(present(), before);
    assert.equal(stored.get(rules.LITE_VIEW_KEY), 'off');
    assert.ok(!written.includes('study-nb-dir-open'), 'folding it with the view saves no fold choice of the notebook directory');
    view.unmount();
  });
});

test('while the guided tour runs the sidebar and the home are the full view, and the saved setting is not changed', () => {
  app.setUiLanguage('zh');
  fresh();
  const touring = { ...sidebarApp({ touring: 'nav' }) };
  const full = { home: home({ context: { tour: { tourStep: 'home' } } }), side: sidebar({ context: touring }), page: libraryPage({ touring: 'home' }) };
  app.liteViewStore.set(true);
  try {
    written.length = 0;
    assert.equal(home({ context: { tour: { tourStep: 'home' } } }), full.home);
    assert.equal(sidebar({ context: touring }), full.side);
    assert.equal(libraryPage({ touring: 'home' }), full.page);
    assert.equal(app.liteViewStore.get(), true);
    assert.deepEqual(written, []);
    assert.match(home({ context: { tour: { tourStep: null } } }), /现在是简洁版/, 'and it is back when the tour ends');
  } finally { app.liteViewStore.set(false); }
});

test('找功能 finds the switch by the words a learner would type, and it leads to the switch', () => {
  const entry = FINDER_ENTRIES.find((item) => item.id === 'lite-view');
  assert.ok(entry);
  assert.equal(entry.title, '简洁版');
  assert.deepEqual(entry.anchors, ['settings-appearance-lite']);
  assert.equal(entry.page, 'settings');
  for (const word of ['简洁', '精简', '核心', '功能太多', '找不到']) {
    assert.ok(entry.aliases.includes(word), word);
    assert.ok(searchFeatures(FINDER_ENTRIES, word, { translate: (text) => text }).slice(0, 3).some((item) => item.id === 'lite-view'), `search: ${word}`);
  }
});

test('找功能 stays honest: no control it lights sits only on a hidden part, and directions through a hidden home button say so and offer the full view', () => {
  app.setUiLanguage('zh');
  const anchors = (html) => new Set([...html.matchAll(/data-tour="([a-z0-9-]+)"/g)].map((match) => match[1]));
  const full = anchors(home() + sidebar() + libraryPage());
  const lite = anchors(withLite(true, () => home() + sidebar() + libraryPage()));
  const gone = [...full].filter((anchor) => !lite.has(anchor));
  assert.deepEqual(FINDER_ENTRIES.filter((entry) => gone.includes(entry.anchors[0])).map((entry) => entry.id), [], `anchors the lite view removes: ${gone}`);

  const gate = FINDER_ENTRIES.find((item) => item.id === 'custom-book-gate');
  const plain = tripNotice(gate, -1);
  assert.match(plain.text, /先在首页点「总纲」/);
  assert.equal(plain.action, undefined);
  assert.deepEqual(tripNotice(gate, -1, { lite: false, showFull() {} }), plain);
  let shown = 0;
  const told = tripNotice(gate, -1, { lite: true, showFull: () => { shown += 1; } });
  assert.match(told.text, /现在是简洁版，首页的「总纲」按钮收起了/);
  assert.ok(told.text.includes(PREPARE_STEPS.outline.text), 'then the same directions');
  assert.equal(told.action.label, '切回完整版');
  told.action.run();
  assert.equal(shown, 1);
  // A trip that needs nothing hidden says what it always said.
  const hint = FINDER_ENTRIES.find((item) => item.id === 'hint');
  assert.deepEqual(tripNotice(hint, -1, { lite: true, showFull() {} }), tripNotice(hint, -1));
  assert.equal(tripNotice(gate, 0, { lite: true, showFull() {} }), null, 'found where it says: nothing to explain');
});

test('带我去 with 简洁版 on: the notice offers the full view, and its button turns the setting off', async () => {
  fresh();
  stored.set(rules.LITE_VIEW_KEY, 'on');
  const ui = await loadInteractiveUi(`export { useFinder } from './ui/finder/use-finder.js'; export { liteViewStore } from './ui/use-lite-view.js';`);
  ui.exports.liteViewStore.reload();
  const notices = [];
  const hook = ui.mountHook(() => ui.exports.useFinder({ nav: { page: 'library', navigate() {} }, settingsEntry: { openSettings() {} },
    core: { notify: (value) => notices.push(value) }, tour: {}, rootRef: { current: { querySelector: () => null } }, learn: {} }));
  await hook.current.go(FINDER_ENTRIES.find((item) => item.id === 'custom-book-gate'));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].action.label, '切回完整版');
  assert.equal(stored.get(rules.LITE_VIEW_KEY), 'on', 'going somewhere changes nothing');
  notices[0].action.run();
  assert.equal(stored.get(rules.LITE_VIEW_KEY), 'off');
  hook.unmount();
  fresh();
});
