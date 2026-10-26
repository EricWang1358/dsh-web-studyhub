/* 设置 › 引导 (3.7 guidance, step 0): the category, the master switch, every registered item with its state, 再显示一次 and 重新显示全部提示, in both
   languages, with a blocked storage, and the clicks (they change only the registered keys). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const built = await build({ stdin: { contents: `export { default as GuidancePane } from './ui/settings/GuidancePane.jsx';
  export { SETTINGS_CATEGORIES, categoriesFor, categoryForAnchor } from './ui/settings-groups.js';
  export { GUIDANCE_ITEMS, guidanceItemsFor } from './ui/guidance/registry.js';
  export { GUIDANCE_KEY } from './ui/guidance/budget.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node',
  format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const load = requireFn => {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(requireFn, module, module.exports);
  return module.exports;
};
const ssr = load(require), h = React.createElement;
const han = /[㐀-鿿]/;
const words = html => html.replace(/<[^>]*>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, get length() { return map.size; }, key: i => [...map.keys()][i] ?? null, getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); }, removeItem: k => { map.delete(k); } };
}
const storagesOf = (initial) => ({ local: memoryStorage(initial), session: memoryStorage() });
const pane = (storages) => renderToStaticMarkup(h(ssr.GuidancePane, { storages }));
const SEEN = { 'study-welcome:/lib': 'dismissed', 'study-reader-hints': JSON.stringify(['pdf-page']), 'study-tour:/lib': JSON.stringify({ stepId: 'practice', done: true }) };

test('引导 is a category of the once group with its own anchor, on every host', async () => {
  const entry = ssr.SETTINGS_CATEGORIES.find(category => category.id === 'guidance');
  assert.ok(entry);
  assert.equal(entry.group, 'once');
  assert.equal(entry.title, '引导');
  assert.deepEqual(entry.anchors, ['settings-guidance']);
  assert.equal(entry.needs, undefined);
  assert.equal(ssr.categoryForAnchor('settings-guidance'), 'guidance');
  assert.ok(ssr.categoriesFor({}).some(category => category.id === 'guidance'));
  assert.equal(typeof (await entry.load()).default, 'function');
});

test('nothing seen: the master switch is on, one primary button (disabled: nothing to bring back), and a row per registered item', () => {
  ssr.setUiLanguage('zh');
  const html = pane(storagesOf());
  assert.match(html, /data-tour="settings-guidance"/);
  assert.match(html.match(/<input[^>]*name="guidanceOn"[^>]*>/)[0], /checked/);
  assert.match(html.match(/<input[^>]*name="guidanceOn"[^>]*>/)[0], /role="switch"/);
  assert.match(words(html), /显示引导提示/);
  assert.match(words(html), /首页的入门三步、模型设置的引导，以及出错或页面为空时的说明照常显示/, 'says what the switch does not hide');
  const primaries = html.match(/<button[^>]*sh-btn--primary[^>]*>/g) || [];
  assert.equal(primaries.length, 1, 'one primary button on the page');
  assert.match(primaries[0], /disabled/);
  assert.match(words(html), /现在没有看过的提示，不需要重新显示/);
  const listed = ssr.guidanceItemsFor({ experimental: false });
  assert.equal((html.match(/data-guidance-item="/g) || []).length, listed.length);
  assert.ok(listed.length < ssr.GUIDANCE_ITEMS.length, 'an experiment is not listed while experiments are hidden');
  assert.doesNotMatch(html, /Jev/);
  for (const item of listed) {
    const row = html.match(new RegExp(`<li[^>]*data-guidance-item="${item.id.replace('.', '\\.')}"[\\s\\S]*?</li>`))[0];
    assert.match(words(row), new RegExp(item.trigger.slice(0, 8).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${item.id}: the trigger in plain words`);
    assert.match(row, /data-guidance-state="unseen"/);
    assert.equal(/role="switch"/.test(row), item.proactive, `${item.id}: a switch only for what appears by itself`);
    assert.doesNotMatch(row, /再显示一次/, `${item.id}: nothing to bring back, no button`);
  }
  assert.doesNotMatch(html, /data-guidance="no-storage"/);
});

test('seen items: the state says so, 再显示一次 and the reset are on, the count is said', () => {
  ssr.setUiLanguage('zh');
  const html = pane(storagesOf(SEEN));
  assert.equal((html.match(/data-guidance-state="seen"/g) || []).length, 3);
  assert.match(words(html), /有 3 项已经看过/);
  assert.doesNotMatch(html.match(/<button[^>]*sh-btn--primary[^>]*>/)[0], /disabled/);
  const welcome = html.match(/<li[^>]*data-guidance-item="first-run\.later"[\s\S]*?<\/li>/)[0];
  assert.match(welcome, /aria-label="再显示一次：首页的入门三步"/, 'the button says which item');
  assert.doesNotMatch(welcome.match(/<button[^>]*>/)[0], /disabled/);
  assert.equal((html.match(/aria-label="再显示一次：/g) || []).length, 3, 'a button only where something was seen');
});

test('experiments shown: the Jev walk-through is listed too; hidden, a reset leaves its memory alone', () => {
  ssr.setUiLanguage('zh');
  const shown = renderToStaticMarkup(h(ssr.GuidancePane, { data: { experimental: true }, storages: storagesOf({ 'study-jev-guide-seen': '1' }) }));
  assert.match(shown, /data-guidance-item="jev\.guide"/);
  assert.match(shown.match(/<li[^>]*data-guidance-item="jev\.guide"[\s\S]*?<\/li>/)[0], /data-guidance-state="seen"/);
  const hidden = pane(storagesOf({ 'study-jev-guide-seen': '1' }));
  assert.doesNotMatch(hidden, /jev/i);
  assert.match(words(hidden), /现在没有看过的提示/, 'a hidden experiment is not counted');
});

test('master switch off: the item switches are off and disabled, and the page says why', () => {
  ssr.setUiLanguage('zh');
  const html = pane(storagesOf({ [ssr.GUIDANCE_KEY]: JSON.stringify({ off: true }) }));
  assert.doesNotMatch(html.match(/<input[^>]*name="guidanceOn"[^>]*>/)[0], /checked/);
  const item = html.match(/<input[^>]*name="guidance-reader\.pdf-page"[^>]*>/)[0];
  assert.doesNotMatch(item, /checked/);
  assert.match(item, /disabled/);
  assert.match(words(html), /上面的单项开关不起作用/);
});

test('a browser without storage: the page renders, warns that nothing is kept, and never throws', () => {
  ssr.setUiLanguage('zh');
  const html = pane({ local: null, session: null });
  assert.match(html, /data-guidance="no-storage"/);
  assert.match(html.match(/<input[^>]*name="guidanceOn"[^>]*>/)[0], /checked/, 'the default stays');
});

test('English: every word of the pane is translated', () => {
  ssr.setUiLanguage('en');
  try {
    for (const initial of [{}, SEEN, { [ssr.GUIDANCE_KEY]: JSON.stringify({ off: true }) }]) assert.doesNotMatch(words(pane(storagesOf(initial))), han);
    assert.doesNotMatch(words(pane({ local: null, session: null })), han);
    assert.match(words(pane(storagesOf())), /Show guidance tips/);
    assert.match(words(pane(storagesOf())), /Show all tips again/);
  } finally { ssr.setUiLanguage('zh'); }
});

test('the pane uses the shared settings primitives, the Tooltip for its one explanation, and no title= or raw colours', async () => {
  const source = await readFile(new URL('../ui/settings/GuidancePane.jsx', import.meta.url), 'utf8');
  assert.match(source, /SettingsSection/);
  assert.match(source, /<Switch /);
  assert.match(source, /<Tooltip layer content=/);
  assert.doesNotMatch(source, /<(?!SettingsSection\b)[A-Za-z][^>]*\stitle=/, 'no native title tooltip (a section title is a heading, not a tooltip)');
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|style=\{\{/);
  assert.doesNotMatch(source, /主对话/);
});

/* ---------- the clicks ---------- */

let active;
const hook = initial => { const index = active.cursor++; if (!(index in active.slots)) active.slots[index] = initial(); return [index, active.slots[index]]; };
const toasts = [];
const hooks = { ...React,
  useState: initial => { const owner = active, [index, value] = hook(() => typeof initial === 'function' ? initial() : initial);
    return [value, next => { owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next; }]; },
  useContext: () => ({ success: text => toasts.push(['success', text]), info: text => toasts.push(['info', text]), show() {}, warning() {}, error() {}, dismiss() {} }),
  useRef: value => hook(() => ({ current: value }))[1], useId: () => hook(() => `field-${active.cursor}`)[1], useInsertionEffect: () => {}, useEffect: () => {},
};
const live = load(name => name === 'react' ? hooks : require(name));
function view(props) {
  const owner = { cursor: 0, slots: [] };
  return () => { owner.cursor = 0; active = owner; try { return live.GuidancePane(props); } finally { active = null; } };
}
const find = (tree, predicate) => {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props?.children)) { const match = find(child, predicate); if (match) return match; }
  return null;
};

test('重新显示全部提示 clears the seen items only, says what comes back, and opens nothing', () => {
  live.setUiLanguage('zh');
  toasts.length = 0;
  const storages = storagesOf({ ...SEEN, 'study-ui-language': 'zh', [ssr.GUIDANCE_KEY]: JSON.stringify({ muted: ['skeleton.archify'] }) });
  const render = view({ storages });
  const reset = find(render(), node => node.props?.['data-guidance'] === 'reset-all');
  reset.props.onClick();
  for (const key of Object.keys(SEEN)) assert.equal(storages.local.getItem(key), null, `${key} cleared`);
  assert.equal(storages.local.getItem('study-ui-language'), 'zh');
  assert.deepEqual(JSON.parse(storages.local.getItem(ssr.GUIDANCE_KEY)).muted, ['skeleton.archify'], 'a switched-off item stays off');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0][1], /已重新显示 3 项：功能导览看到哪一步、首页的入门三步、提问的是哪一页。下次打开对应的页面时会再出现。/);
  assert.equal(find(render(), node => node.props?.['data-guidance'] === 'reset-all').props.disabled, true, 'nothing left to bring back');
});

test('the master switch and an item switch write the one guidance key; 再显示一次 clears one item', () => {
  live.setUiLanguage('zh');
  toasts.length = 0;
  const storages = storagesOf(SEEN);
  const render = view({ storages });
  find(render(), node => node.props?.name === 'guidanceOn').props.onChange(false);
  assert.equal(JSON.parse(storages.local.getItem(ssr.GUIDANCE_KEY)).off, true);
  assert.match(toasts.at(-1)[1], /引导提示已关闭/);
  assert.equal(find(render(), node => node.props?.name === 'guidance-reader.pdf-page').props.disabled, true);
  find(render(), node => node.props?.name === 'guidanceOn').props.onChange(true);
  find(render(), node => node.props?.name === 'guidance-library.topic-groups').props.onChange(false);
  assert.deepEqual(JSON.parse(storages.local.getItem(ssr.GUIDANCE_KEY)).muted, ['library.topic-groups']);
  assert.equal(find(render(), node => node.props?.name === 'guidance-library.topic-groups').props.checked, false);
  const again = find(render(), node => node.props?.['aria-label'] === '再显示一次：首页的入门三步');
  again.props.onClick();
  assert.equal(storages.local.getItem('study-welcome:/lib'), null);
  assert.equal(storages.local.getItem('study-tour:/lib') !== null, true, 'only that item');
  assert.match(toasts.at(-1)[1], /「首页的入门三步」会在你下次打开「学习库首页」时再出现。/);
});
