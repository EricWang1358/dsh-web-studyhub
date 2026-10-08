/* 设置 › 备考补习 (S-3): the category in the registry, what the pane says about the host's switch, the four personal defaults, 恢复默认. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';
import { EXAM_PREP_DEFAULTS } from '../lib/exam-prep-settings.js';
import { PAPER_WORDS } from '../lib/exam-prep-roles.js';

const require = createRequire(import.meta.url);
const built = await build({ stdin: { contents: `export { default as ExamPrepPane, ExamPrepStatus, PaperWords } from './ui/settings/ExamPrepPane.jsx';
  export { SETTINGS_CATEGORIES, SETTINGS_GROUPS, categoriesFor, categoryForAnchor } from './ui/settings-groups.js';
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

/* ---------- the registry ---------- */

test('备考补习 is a category of the once group with its own anchor, gated by the generation component', async () => {
  const entry = ssr.SETTINGS_CATEGORIES.find(category => category.id === 'exam-prep');
  assert.ok(entry);
  assert.equal(entry.group, 'once');
  assert.equal(entry.title, '备考补习');
  assert.deepEqual(entry.anchors, ['settings-exam-prep']);
  assert.equal(entry.needs, 'generation');
  assert.equal(ssr.categoryForAnchor('settings-exam-prep'), 'exam-prep');
  assert.ok(ssr.categoriesFor({ generation: true }).some(category => category.id === 'exam-prep'));
  assert.ok(!ssr.categoriesFor({}).some(category => category.id === 'exam-prep'));
  assert.equal(typeof (await entry.load()).default, 'function');
});

/* ---------- what the pane draws ---------- */

const pane = (props = {}) => renderToStaticMarkup(h(ssr.ExamPrepPane, { data: { settings: {}, features: { examBlueprint: true } }, busy: false, act: noop, ...props }));

test('the page is on by default: one switch is on, one line says so, and no text sends the learner to the plugin manager', () => {
  ssr.setUiLanguage('zh');
  const html = pane({ host: { openPluginManager: noop } });
  assert.match(html, /data-tour="settings-exam-prep"/);
  assert.match(input(html, 'enabled'), /checked/);
  assert.match(words(html), /开启备考补习/);
  assert.match(words(html), /可以去「备考补习」页新建考点清单/);
  assert.doesNotMatch(words(html), /插件管理器|还没有开启/);
  assert.match(words(html), /runtime\.pilot\.examBlueprint/, 'the host switch is named once, as a hint for deployments');
});

test('turned off by the learner: the switch shows it, the defaults are still there, and nothing says to ask DSH', () => {
  ssr.setUiLanguage('zh');
  const html = pane({ data: { settings: { examPrep: { enabled: false } }, features: { examBlueprint: false } }, host: { openPluginManager: noop } });
  assert.doesNotMatch(input(html, 'enabled'), /checked/);
  assert.doesNotMatch(words(html), /已开启|插件管理器/);
  assert.match(words(html), /自动识别资料用途/, 'the defaults can be set while the page is off');
});

test('forced on by the host configuration: the pane says so and has no switch to flip', () => {
  ssr.setUiLanguage('zh');
  const html = pane({ data: { settings: { examPrep: { enabled: false } }, features: { examBlueprint: true, examBlueprintByHost: true } } });
  assert.match(words(html), /已经由 DSH 的配置开启/);
  assert.equal(input(html, 'enabled'), '');
  assert.match(words(html), /自动识别资料用途/);
});

test('the page switch saves at once like the others, and 恢复默认 does not turn the page back on', async () => {
  const { view, calls } = paneView();
  const status = () => find(view.render(), node => node.type === live.ExamPrepStatus).props;
  assert.equal(status().checked, true, 'on by default');
  await status().onChange(false);
  assert.deepEqual(calls[0].slice(0, 2), ['settings.examPrep.set', { patch: { enabled: false } }]);
  assert.equal(status().checked, false);
  await button(view, '恢复默认').props.onClick();
  assert.equal(calls.at(-1)[0], 'settings.examPrep.reset');
  assert.equal(status().checked, false, 'the switch is not a personal default');
});

test('nothing saved: the four defaults show as the contract says, the built-in words are read-only, and there is nothing to reset', () => {
  ssr.setUiLanguage('zh');
  const html = pane();
  assert.match(input(html, 'autoRoles'), /checked/);
  assert.doesNotMatch(input(html, 'showOtherCourses'), /checked/);
  assert.match(html, /<option[^>]*value="auto"[^>]*selected|<option[^>]*selected[^>]*value="auto"/);
  assert.match(words(html), /清单语言/);
  assert.match(words(html), /自动（跟随界面语言）/);
  assert.match(words(html), /默认显示其它课程的资料/);
  for (const word of PAPER_WORDS) assert.ok(words(html).includes(word), `built-in word ${word}`);
  assert.doesNotMatch(html, /sh-chip/, 'no word of the learner yet');
  const reset = html.match(/<button[^>]*>(?:(?!<\/button>).)*恢复默认/)[0];
  assert.match(reset, /disabled/);
});

test('saved choices are shown, and 恢复默认 is available', () => {
  const examPrep = { autoRoles: false, paperWords: ['练习卷', 'drill'], language: 'en', showOtherCourses: true };
  const html = pane({ data: { settings: { examPrep }, features: { examBlueprint: true } } });
  assert.doesNotMatch(input(html, 'autoRoles'), /checked/);
  assert.match(input(html, 'showOtherCourses'), /checked/);
  assert.match(html, /<option[^>]*value="en"[^>]*selected|<option[^>]*selected[^>]*value="en"/);
  assert.equal((html.match(/class="sh-chip /g) || []).length, 2);
  assert.ok(words(html).includes('练习卷') && words(html).includes('drill'));
  assert.match(html, /aria-label="移除「练习卷」"/);
  assert.doesNotMatch(html.match(/<button[^>]*>(?:(?!<\/button>).)*恢复默认/)[0], /disabled/);
});

test('the pane is one section of the shared settings primitives, with no raw colours', async () => {
  const source = await readFile(new URL('../ui/settings/ExamPrepPane.jsx', import.meta.url), 'utf8');
  assert.match(source, /SettingsSection/);
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|style=\{\{/);
  assert.doesNotMatch(source, /蓝图/);
});

test('English: every word of the pane is translated, off and on, and no learner text says blueprint apart from the switch name', () => {
  ssr.setUiLanguage('en');
  try {
    const saved = { examPrep: { paperWords: ['mock'], language: 'zh' } };
    for (const data of [{ settings: { examPrep: { enabled: false } }, features: { examBlueprint: false } }, { settings: saved, features: { examBlueprint: true } },
      { settings: {}, features: { examBlueprint: true, examBlueprintByHost: true } }]) {
      const html = pane({ data, host: { openPluginManager: noop } });
      assert.doesNotMatch(words(html), han);
      assert.doesNotMatch(words(html).replace(/examBlueprint/g, ''), /blueprint/i);
    }
    assert.match(words(pane()), /Personal defaults/);
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
    if (extra.drop) return undefined;
    const result = action.endsWith('reset') ? { ...EXAM_PREP_DEFAULTS, paperWords: [] } : { ...EXAM_PREP_DEFAULTS, ...args.patch };
    await after?.(result, { isCurrent: () => true });
    return result;
  };
  const view = editor(live.ExamPrepPane, { data: extra.data ?? { settings: {}, features: { examBlueprint: true } }, busy: false, act });
  view.render(); view.effects();
  return { view, calls };
};

test('a switch saves just its own field at once and shows the choice without waiting for the library', async () => {
  const { view, calls } = paneView();
  await named(view, 'autoRoles').props.onChange(false);
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['settings.examPrep.set', { patch: { autoRoles: false } }]]);
  assert.equal(calls[0][2].rethrow, true, 'a refusal reaches the pane');
  assert.equal(named(view, 'autoRoles').props.checked, false);
  await named(view, 'showOtherCourses').props.onChange(true);
  assert.deepEqual(calls[1].slice(0, 2), ['settings.examPrep.set', { patch: { showOtherCourses: true } }]);
  assert.equal(named(view, 'showOtherCourses').props.checked, true);
  assert.equal(named(view, 'autoRoles').props.checked, false, 'the earlier choice stays');
});

test('the language select saves its value', async () => {
  const { view, calls } = paneView();
  assert.deepEqual(named(view, 'language').props.options.map(option => option.value), ['auto', 'zh', 'en']);
  await named(view, 'language').props.onChange('zh');
  assert.deepEqual(calls[0].slice(0, 2), ['settings.examPrep.set', { patch: { language: 'zh' } }]);
  assert.equal(named(view, 'language').props.value, 'zh');
});

test('words are added from the input (trimmed, once, within the limits) and removed from the tags', async () => {
  const { view, calls } = paneView({ data: { settings: { examPrep: { paperWords: ['mock'] } }, features: {} } });
  const words = () => find(view.render(), node => node.type === live.PaperWords).props;
  await words().onChange(['mock', '练习卷']);
  assert.deepEqual(calls[0].slice(0, 2), ['settings.examPrep.set', { patch: { paperWords: ['mock', '练习卷'] } }]);
  assert.deepEqual(words().words, ['mock', '练习卷']);
  const field = editor(live.PaperWords, { words: ['mock'], disabled: false, onChange: list => calls.push(['added', list]) });
  const submit = () => find(field.render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  const type = value => find(field.render(), node => node.props?.name === 'paperWord').props.onChange({ target: { value } });
  assert.equal(find(field.render(), node => node.props?.name === 'paperWord').props.value, '');
  assert.equal(find(field.render(), node => node.props?.type === 'submit').props.disabled, true, 'nothing to add yet');
  type('  Drill '); submit();
  assert.deepEqual(calls.at(-1), ['added', ['mock', 'Drill']]);
  assert.equal(find(field.render(), node => node.props?.name === 'paperWord').props.value, '', 'the input is emptied after an add');
  const before = calls.length;
  type('MOCK'); submit();
  assert.equal(calls.length, before, 'a repeat adds nothing');
  assert.match(field.render().props.error, /已经在列表里/);
  type('x'.repeat(21)); submit();
  assert.match(field.render().props.error, /最多 20 个字符/);
  type('fine');
  assert.equal(field.render().props.error, undefined, 'typing clears the message');
  const full = editor(live.PaperWords, { words: Array.from({ length: 20 }, (_, at) => `w${at}`), disabled: false, onChange: list => calls.push(['added', list]) });
  find(full.render(), node => node.props?.name === 'paperWord').props.onChange({ target: { value: 'extra' } });
  find(full.render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.match(full.render().props.error, /最多 20 个关键词/);
  const chip = find(field.render(), node => node.props?.removeLabel);
  assert.equal(chip.props.removeLabel, '移除「mock」');
  chip.props.onRemove();
  assert.deepEqual(calls.at(-1), ['added', []]);
});

test('恢复默认 asks for the reset and shows the defaults', async () => {
  const { view, calls } = paneView({ data: { settings: { examPrep: { language: 'en', autoRoles: false, paperWords: ['mock'] } }, features: {} } });
  assert.equal(button(view, '恢复默认').props.disabled, false);
  await button(view, '恢复默认').props.onClick();
  assert.equal(calls[0][0], 'settings.examPrep.reset');
  assert.equal(named(view, 'language').props.value, 'auto');
  assert.equal(named(view, 'autoRoles').props.checked, true);
  assert.deepEqual(find(view.render(), node => node.type === live.PaperWords).props.words, []);
});

test('a refused save puts the old choice back and says why; a busy page or a dropped call saves nothing', async () => {
  const failing = paneView({ fail: 'Invalid exam prep setting: language' });
  await named(failing.view, 'language').props.onChange('en');
  assert.equal(named(failing.view, 'language').props.value, 'auto');
  assert.match(find(failing.view.render(), node => node.props?.role === 'alert' && node.props?.tone === 'error').props.children, /exam prep/i);
  const dropped = paneView({ drop: true });
  await named(dropped.view, 'autoRoles').props.onChange(false);
  assert.equal(named(dropped.view, 'autoRoles').props.checked, true, 'another action was running: nothing changed');
  const busy = paneView();
  busy.view.render({ busy: true });
  assert.equal(named(busy.view, 'autoRoles').props.disabled, true);
  await named(busy.view, 'autoRoles').props.onChange(false);
  assert.equal(busy.calls.length, 0);
});

test('when the library reports new settings the pane follows them', async () => {
  const { view } = paneView();
  view.render({ data: { settings: { examPrep: { language: 'en' } }, features: {} } });
  view.effects();
  assert.equal(named(view, 'language').props.value, 'en');
});
