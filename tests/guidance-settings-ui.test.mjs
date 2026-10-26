/* 设置 › 引导 (3.7 guidance, step 0): the category, the master switch (what it hides and leaves, said exactly), every registered item with its state,
   再显示一次 and 重新显示全部提示 with toasts that only promise what can happen (master off, an item switched off, a library with its own deck), in both
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
const esc = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, get length() { return map.size; }, key: i => [...map.keys()][i] ?? null, getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); }, removeItem: k => { map.delete(k); } };
}
const storagesOf = (initial) => ({ local: memoryStorage(initial), session: memoryStorage() });
const pane = (storages, props = {}) => renderToStaticMarkup(h(ssr.GuidancePane, { storages, ...props }));
const rowOf = (html, id) => html.match(new RegExp(`<li[^>]*data-guidance-item="${esc(id)}"[\\s\\S]*?</li>`))[0];
const SEEN = { 'study-welcome:/lib': 'dismissed', 'study-reader-hints': JSON.stringify(['pdf-page']), 'study-setup-done:/lib:Cloud': '1' };
const OWN_DECK = { decks: [{ id: 'mine', title: 'Mine' }] };
const OFF = { [ssr.GUIDANCE_KEY]: JSON.stringify({ off: true }) };

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

test('nothing seen: the master switch is on and says exactly what it hides and leaves; one primary button (disabled); a row per item', () => {
  ssr.setUiLanguage('zh');
  const html = pane(storagesOf());
  assert.match(html, /data-tour="settings-guidance"/);
  const master = html.match(/<input[^>]*name="guidanceOn"[^>]*>/)[0];
  assert.match(master, /checked/);
  assert.match(master, /role="switch"/);
  assert.match(words(html), /显示引导提示/);
  // Every proactive item is named by the master switch's hint; what it leaves is named too.
  const hint = words(html).match(/关掉后，[^。]*。/)[0];
  for (const phrase of ['阅读页的两条提示', '「补全原文件」的说明', '主题组提醒', 'Archify 推荐卡', '「笔记换了位置」']) assert.ok(hint.includes(phrase), phrase);
  assert.deepEqual(ssr.GUIDANCE_ITEMS.filter(item => item.proactive).map(item => item.id).sort(),
    ['book.moves', 'library.topic-groups', 'reader.original-notice', 'reader.page-presets', 'reader.pdf-page', 'skeleton.archify'], 'the hint lists exactly these');
  for (const phrase of ['首页的入门三步', '模型设置的引导', '出错和空页面的说明', '课程准备「全部完成」那句']) assert.ok(hint.includes(phrase), `${phrase} stays`);
  const primaries = html.match(/<button[^>]*sh-btn--primary[^>]*>/g) || [];
  assert.equal(primaries.length, 1, 'one primary button on the page');
  assert.match(primaries[0], /disabled/);
  assert.match(words(html), /现在没有可以重新显示的提示/);
  const listed = ssr.guidanceItemsFor();
  assert.equal((html.match(/data-guidance-item="/g) || []).length, listed.length);
  assert.doesNotMatch(html, /Jev/);
  assert.doesNotMatch(html, /功能导览看到哪一步/, 'the tour resume point is not listed');
  for (const item of listed) {
    const row = rowOf(html, item.id);
    assert.match(words(row), new RegExp(esc(item.trigger.slice(0, 8))), `${item.id}: the trigger in plain words`);
    assert.match(row, /data-guidance-state="unseen"/);
    assert.equal(/role="switch"/.test(row), item.proactive, `${item.id}: a switch only for what appears by itself`);
    assert.doesNotMatch(row, /再显示一次/, `${item.id}: nothing to bring back, no button`);
  }
  assert.doesNotMatch(html, /data-guidance="no-storage"|data-guidance="master-off"/);
});

test('seen items: the state says so, 再显示一次 and the reset are on, the count is said', () => {
  ssr.setUiLanguage('zh');
  const html = pane(storagesOf(SEEN));
  assert.equal((html.match(/data-guidance-state="seen"/g) || []).length, 3);
  assert.match(words(html), /有 3 项已经看过/);
  assert.doesNotMatch(html.match(/<button[^>]*sh-btn--primary[^>]*>/)[0], /disabled/);
  assert.match(rowOf(html, 'first-run.later'), /aria-label="再显示一次：首页的入门三步"/, 'the button says which item');
  assert.equal((html.match(/aria-label="再显示一次：/g) || []).length, 3, 'a button only where something was seen');
});

test('a library with its own deck: 入门三步 cannot come back, so it is not counted, has no button, and says why', () => {
  ssr.setUiLanguage('zh');
  const html = pane(storagesOf(SEEN), { data: OWN_DECK });
  const row = rowOf(html, 'first-run.later');
  assert.match(row, /data-guidance-state="seen"/);
  assert.doesNotMatch(row, /再显示一次/);
  assert.match(words(row), /这个学习库已经有自己的题组，入门三步不会再出现/);
  assert.match(words(html), /有 2 项已经看过/);
});

test('experiments: the Jev walk-through only with the experiments switch AND the system component; hidden, it is not counted', () => {
  ssr.setUiLanguage('zh');
  const seenJev = { 'study-jev-guide-seen': '1' };
  const shown = pane(storagesOf(seenJev), { data: { experimental: true }, capabilities: { system: true } });
  assert.match(rowOf(shown, 'jev.guide'), /data-guidance-state="seen"/);
  for (const props of [{}, { data: { experimental: true } }, { capabilities: { system: true } }]) {
    const hidden = pane(storagesOf(seenJev), props);
    assert.doesNotMatch(hidden, /jev/i, JSON.stringify(props));
    assert.match(words(hidden), /现在没有可以重新显示的提示/, 'a hidden experiment is not counted');
  }
});

test('master switch off: the reason sits right under it and each disabled item switch points to it (aria-describedby)', () => {
  ssr.setUiLanguage('zh');
  const html = pane(storagesOf(OFF));
  assert.doesNotMatch(html.match(/<input[^>]*name="guidanceOn"[^>]*>/)[0], /checked/);
  const note = html.match(/<p[^>]*data-guidance="master-off"[^>]*>/)[0];
  const id = note.match(/id="([^"]+)"/)[1];
  assert.ok(html.indexOf(note) < html.indexOf('data-guidance="reset-all"'), 'the reason is under the master switch, above the list');
  assert.match(words(html), /下面每一项的开关暂时不起作用/);
  for (const item of ssr.guidanceItemsFor().filter(entry => entry.proactive)) {
    const input = html.match(new RegExp(`<input[^>]*name="guidance-${esc(item.id)}"[^>]*>`))[0];
    assert.doesNotMatch(input, /checked/);
    assert.match(input, /disabled/);
    assert.match(input, new RegExp(`aria-describedby="${esc(id)}(?: [^"]*)?"`), `${item.id} points to the reason`);
  }
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
    for (const initial of [{}, SEEN, OFF]) assert.doesNotMatch(words(pane(storagesOf(initial))), han);
    assert.doesNotMatch(words(pane(storagesOf(SEEN), { data: OWN_DECK })), han);
    assert.doesNotMatch(words(pane({ local: null, session: null })), han);
    assert.match(words(pane(storagesOf())), /Show guidance tips/);
    assert.match(words(pane(storagesOf())), /The first three steps on the home page/);
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
const lastToast = () => toasts.at(-1)?.[1] ?? '';
const nested = text => /「[^」]*「/.test(text);

test('重新显示全部提示 clears the seen items only, says honestly when they appear, and opens nothing', () => {
  live.setUiLanguage('zh');
  toasts.length = 0;
  const storages = storagesOf({ ...SEEN, 'study-ui-language': 'zh', 'study-tour:/lib': '{"stepId":"practice"}' });
  const render = view({ storages });
  find(render(), node => node.props?.['data-guidance'] === 'reset-all').props.onClick();
  for (const key of Object.keys(SEEN)) assert.equal(storages.local.getItem(key), null, `${key} cleared`);
  assert.equal(storages.local.getItem('study-ui-language'), 'zh');
  assert.equal(storages.local.getItem('study-tour:/lib'), '{"stepId":"practice"}', 'a paused tour keeps its resume point');
  assert.equal(toasts.length, 1);
  assert.equal(lastToast(), '已重新显示 3 项：首页的入门三步、课程准备「全部完成」、提问的是哪一页。它们不会马上弹出来，而是在各自该出现的时候再出现。');
  assert.ok(!nested(lastToast()));
  assert.equal(find(render(), node => node.props?.['data-guidance'] === 'reset-all').props.disabled, true, 'nothing left to bring back');
});

test('master switch off: the reset says which items stay hidden until it is on (and only when a proactive item was cleared)', () => {
  live.setUiLanguage('zh');
  toasts.length = 0;
  const render = view({ storages: storagesOf({ ...SEEN, ...OFF }) });
  find(render(), node => node.props?.['data-guidance'] === 'reset-all').props.onClick();
  assert.match(lastToast(), /其中提问的是哪一页要等「显示引导提示」打开后才会出现。$/);
  toasts.length = 0;
  const quiet = view({ storages: storagesOf({ 'study-welcome:/lib': 'dismissed', ...OFF }) });
  find(quiet(), node => node.props?.['data-guidance'] === 'reset-all').props.onClick();
  assert.doesNotMatch(lastToast(), /显示引导提示/, 'nothing proactive was cleared: no caveat');
  toasts.length = 0;
  const one = view({ storages: storagesOf({ 'study-reader-hints': JSON.stringify(['pdf-page']), ...OFF }) });
  find(one(), node => node.props?.['aria-label'] === '再显示一次：提问的是哪一页').props.onClick();
  assert.equal(lastToast(), '提问的是哪一页已重置，但现在被「显示引导提示」关着；打开后，下次在原始 PDF 旁提问时会再出现。');
});

test('an item switched off: 再显示一次 and the reset say its own switch keeps it hidden', () => {
  live.setUiLanguage('zh');
  toasts.length = 0;
  const stored = { 'study-original-notice': JSON.stringify(['doc-1']), [ssr.GUIDANCE_KEY]: JSON.stringify({ muted: ['reader.original-notice'] }) };
  const render = view({ storages: storagesOf(stored) });
  find(render(), node => node.props?.['aria-label'] === '再显示一次：「补全原文件」的说明').props.onClick();
  assert.equal(lastToast(), '「补全原文件」的说明已重置，但现在被它自己的开关关着；打开后，下次打开只保存了文字的资料时会再出现。');
  toasts.length = 0;
  const all = view({ storages: storagesOf(stored) });
  find(all(), node => node.props?.['data-guidance'] === 'reset-all').props.onClick();
  assert.match(lastToast(), /「补全原文件」的说明自己的开关关着，打开后才会出现。$/);
});

test('a library with its own deck: the reset leaves 入门三步 alone and does not promise it', () => {
  live.setUiLanguage('zh');
  toasts.length = 0;
  const storages = storagesOf(SEEN);
  const render = view({ storages, data: OWN_DECK });
  find(render(), node => node.props?.['data-guidance'] === 'reset-all').props.onClick();
  assert.equal(storages.local.getItem('study-welcome:/lib'), 'dismissed', 'kept: it cannot come back here anyway');
  assert.doesNotMatch(lastToast(), /入门三步/);
  assert.match(lastToast(), /已重新显示 2 项/);
});

test('the master switch and an item switch write the one guidance key; 再显示一次 clears one item; a refused write says nothing changed', () => {
  live.setUiLanguage('zh');
  toasts.length = 0;
  const storages = storagesOf(SEEN);
  const render = view({ storages });
  find(render(), node => node.props?.name === 'guidanceOn').props.onChange(false);
  assert.equal(JSON.parse(storages.local.getItem(ssr.GUIDANCE_KEY)).off, true);
  assert.match(lastToast(), /^引导提示已关闭：阅读页的两条提示、「补全原文件」的说明、主题组提醒、Archify 推荐卡和「笔记换了位置」不再出现。$/);
  assert.equal(find(render(), node => node.props?.name === 'guidance-reader.pdf-page').props.disabled, true);
  find(render(), node => node.props?.name === 'guidanceOn').props.onChange(true);
  find(render(), node => node.props?.name === 'guidance-library.topic-groups').props.onChange(false);
  assert.deepEqual(JSON.parse(storages.local.getItem(ssr.GUIDANCE_KEY)).muted, ['library.topic-groups']);
  assert.equal(find(render(), node => node.props?.name === 'guidance-library.topic-groups').props.checked, false);
  find(render(), node => node.props?.['aria-label'] === '再显示一次：首页的入门三步').props.onClick();
  assert.equal(storages.local.getItem('study-welcome:/lib'), null);
  assert.equal(storages.local.getItem('study-setup-done:/lib:Cloud'), '1', 'only that item');
  assert.equal(lastToast(), '首页的入门三步：还没有自己的题组时，下次打开学习库首页时会再出现。');
  const full = storagesOf(SEEN); full.local.setItem = () => { throw new Error('full'); };
  const refused = view({ storages: full });
  find(refused(), node => node.props?.name === 'guidanceOn').props.onChange(false);
  assert.ok(find(refused(), node => node.props?.role === 'alert' && /这次的改动没有生效/.test(node.props.children)));
});
