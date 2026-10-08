/* 设置 › 练习: the category in the registry, the three personal defaults the pane draws, saving at once, 恢复默认. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';
import { PRACTICE_DEFAULTS } from '../lib/practice-settings.js';

const require = createRequire(import.meta.url);
const built = await build({ stdin: { contents: `export { default as PracticePane, ROUND_SIZES } from './ui/settings/PracticePane.jsx';
  export { SETTINGS_CATEGORIES, categoriesFor, categoryForAnchor } from './ui/settings-groups.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node',
  format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const load = requireFn => {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(requireFn, module, module.exports);
  return module.exports;
};
const ssr = load(require), h = React.createElement, noop = () => {};
const han = /[㐀-鿿]/;
const words = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const input = (html, name) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? '';

test('练习 is a category of the common group with its own anchor, available on every host', async () => {
  const entry = ssr.SETTINGS_CATEGORIES.find(category => category.id === 'practice');
  assert.ok(entry);
  assert.equal(entry.group, 'common');
  assert.equal(entry.title, '练习');
  assert.deepEqual(entry.anchors, ['settings-practice']);
  assert.equal(entry.needs, undefined);
  assert.equal(ssr.categoryForAnchor('settings-practice'), 'practice');
  assert.ok(ssr.categoriesFor({}).some(category => category.id === 'practice'));
  assert.equal(typeof (await entry.load()).default, 'function');
});

const pane = (props = {}) => renderToStaticMarkup(h(ssr.PracticePane, { data: { settings: {} }, busy: false, act: noop, ...props }));

test('nothing saved: the defaults show as the contract says, and there is nothing to reset', () => {
  ssr.setUiLanguage('zh');
  const html = pane();
  assert.match(html, /data-tour="settings-practice"/);
  assert.doesNotMatch(input(html, 'autopilot'), /checked/);
  assert.match(input(html, 'debrief'), /checked/);
  assert.match(html, /<option[^>]*value="20"[^>]*selected|<option[^>]*selected[^>]*value="20"/);
  assert.match(words(html), /每轮题数/);
  assert.match(words(html), /当前是 20 题一轮，新题最多 10 道/);
  assert.match(words(html), /自动驾驶/);
  assert.match(words(html), /本轮点评由模型来写/);
  assert.match(html.match(/<button[^>]*>(?:(?!<\/button>).)*恢复默认/)[0], /disabled/);
});

test('the hints say what the code does: the countdowns, and the one place the practice asks the model', () => {
  ssr.setUiLanguage('zh');
  const text = words(pane());
  assert.match(text, /等 1\.5 秒自动进入下一题/);
  assert.match(text, /5 秒后自动开始建议的下一步/);
  assert.match(text, /唯一自动调用模型的地方/);
  assert.match(text, /关掉后不再调用模型/);
});

test('saved choices are shown, a size outside the list is kept, and 恢复默认 is available', () => {
  const html = pane({ data: { settings: { practice: { autopilot: true, roundSize: 25, debrief: false } } } });
  assert.match(input(html, 'autopilot'), /checked/);
  assert.doesNotMatch(input(html, 'debrief'), /checked/);
  assert.match(html, /<option[^>]*value="25"[^>]*selected|<option[^>]*selected[^>]*value="25"/);
  assert.doesNotMatch(html.match(/<button[^>]*>(?:(?!<\/button>).)*恢复默认/)[0], /disabled/);
});

test('the pane is one section of the shared settings primitives, with no raw colours', async () => {
  const source = await readFile(new URL('../ui/settings/PracticePane.jsx', import.meta.url), 'utf8');
  assert.match(source, /SettingsSection/);
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|style=\{\{/);
});

test('English: every word of the pane is translated', () => {
  ssr.setUiLanguage('en');
  try {
    for (const data of [{ settings: {} }, { settings: { practice: { autopilot: true, roundSize: 30, debrief: false } } }]) assert.doesNotMatch(words(pane({ data })), han);
    assert.match(words(pane()), /Autopilot/);
    assert.match(words(pane()), /questions per round/i);
  } finally { ssr.setUiLanguage('zh'); }
});

/* ---------- saving ---------- */

let active;
const hook = initial => { const index = active.cursor++; if (!(index in active.slots)) active.slots[index] = initial(); return [index, active.slots[index]]; };
const hooks = { ...React,
  useState: initial => { const owner = active, [index, value] = hook(() => typeof initial === 'function' ? initial() : initial);
    return [value, next => { owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next; }]; },
  useContext: () => null, useRef: value => hook(() => ({ current: value }))[1], useId: () => hook(() => `field-${active.cursor}`)[1],
  useInsertionEffect: () => {}, useEffect: (callback, deps) => { const [, slot] = hook(() => ({ deps: undefined, cleanup: null }));
    if (!slot.deps || deps.some((value, index) => value !== slot.deps[index])) { active.effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); }); slot.deps = deps; } },
};
const live = load(name => name === 'react' ? hooks : require(name));
function editor(component, props) {
  let current = props;
  const owner = { cursor: 0, slots: [], effects: [] };
  return { render(next = {}) { current = { ...current, ...next }; owner.cursor = 0; active = owner; try { return component(current); } finally { active = null; } },
    effects() { owner.effects.splice(0).forEach(callback => callback()); } };
}
const find = (tree, predicate) => {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props?.children)) { const match = find(child, predicate); if (match) return match; }
  return null;
};
const named = (view, name) => find(view.render(), node => node.props?.name === name);
const button = (view, label) => find(view.render(), node => node.props?.onClick && node.props.children === label);
const paneView = (extra = {}) => {
  const calls = [], act = async (action, args, after, options) => {
    calls.push([action, args, options]);
    if (extra.fail) throw new Error(extra.fail);
    const result = action.endsWith('reset') ? { ...PRACTICE_DEFAULTS } : { ...PRACTICE_DEFAULTS, ...args.patch };
    await after?.(result, { isCurrent: () => true });
    return result;
  };
  const view = editor(live.PracticePane, { data: extra.data ?? { settings: {} }, busy: false, act });
  view.render(); view.effects();
  return { view, calls };
};

test('a switch saves just its own field at once and shows the choice without waiting for the library', async () => {
  const { view, calls } = paneView();
  await named(view, 'autopilot').props.onChange(true);
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['settings.practice.set', { patch: { autopilot: true } }]]);
  assert.equal(calls[0][2].rethrow, true, 'a refusal reaches the pane');
  assert.equal(named(view, 'autopilot').props.checked, true);
  await named(view, 'debrief').props.onChange(false);
  assert.deepEqual(calls[1].slice(0, 2), ['settings.practice.set', { patch: { debrief: false } }]);
  assert.equal(named(view, 'debrief').props.checked, false);
  assert.equal(named(view, 'autopilot').props.checked, true, 'the earlier choice stays');
});

test('the round size select offers the sizes and saves a number', async () => {
  const { view, calls } = paneView();
  assert.deepEqual(named(view, 'roundSize').props.options.map(option => option.value), ssr.ROUND_SIZES.map(String));
  await named(view, 'roundSize').props.onChange('30');
  assert.deepEqual(calls[0].slice(0, 2), ['settings.practice.set', { patch: { roundSize: 30 } }]);
  assert.equal(named(view, 'roundSize').props.value, '30');
});

test('a refused save puts the control back and says why', async () => {
  const { view } = paneView({ fail: '练习设置无效' });
  await named(view, 'autopilot').props.onChange(true);
  assert.equal(named(view, 'autopilot').props.checked, false);
  assert.ok(find(view.render(), node => node.props?.role === 'alert'));
});

test('恢复默认 forgets the saved choices', async () => {
  const { view, calls } = paneView({ data: { settings: { practice: { autopilot: true } } } });
  await button(view, '恢复默认').props.onClick();
  assert.deepEqual(calls[0].slice(0, 2), ['settings.practice.reset', {}]);
});
