import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GENERATION_SETTINGS_DEFAULTS } from '../lib/generation-settings.js';
import { nativeSelects } from './helpers/native-selects.mjs';
import { GENERATION_KINDS } from '../lib/generation-settings.js';

const require = createRequire(import.meta.url);
const built = await build({ stdin: { contents: `export { default as GenerationSettings, GenerationSettingsForm, generationFormErrors } from './ui/GenerationSettings.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export { toggleKind } from './ui/generate-form.js';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node',
  format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const load = requireFn => { const module = { exports: {} }; new Function('require', 'module', 'exports', built.outputFiles[0].text)(requireFn, module, module.exports); return module.exports; };
const ssr = load(require), noop = () => {};
let active;
const hook = initial => { const index = active.cursor++; if (!(index in active.slots)) active.slots[index] = initial(); return [index, active.slots[index]]; };
const hooks = { ...React,
  useState: initial => { const owner = active, [index, value] = hook(() => typeof initial === 'function' ? initial() : initial);
    return [value, next => { owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next; }]; },
  useContext: () => globalThis.__toast ?? null, useRef: value => hook(() => ({ current: value }))[1], useId: () => hook(() => `field-${active.cursor}`)[1],
  useInsertionEffect: () => {}, useEffect: (callback, deps) => { const [, slot] = hook(() => ({ deps: undefined, cleanup: null }));
    if (!slot.deps || deps.some((value, index) => value !== slot.deps[index])) {
      active.effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); }); slot.deps = deps;
    } },
};
const { GenerationSettingsForm } = load(name => name === 'react' ? hooks : require(name));
function editor(props = {}) {
  let current = { root: '/temporary/library', saved: GENERATION_SETTINGS_DEFAULTS, busy: false, act: noop, ...props };
  const owner = { cursor: 0, slots: [], effects: [] };
  return {
    render(next = {}) { current = { ...current, ...next }; owner.cursor = 0; active = owner;
      try { return GenerationSettingsForm(current); } finally { active = null; } },
    effects() { owner.effects.splice(0).forEach(callback => callback()); },
    unmount() { owner.slots.forEach(slot => slot?.cleanup?.()); },
  };
}
const find = (tree, predicate) => {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props?.children)) { const match = find(child, predicate); if (match) return match; }
  return null;
};
const control = (view, key) => find(view.render(), node => node.props?.name === key);
// A Select reports its value; a text or number input reports an event.
const edit = (view, key, value) => { const { props } = control(view, key); return props.options ? props.onChange(value) : props.onChange({ target: { value } }); };
const submit = view => view.render().props.onSubmit({ preventDefault() {} });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('the generation settings section renders twenty usable controls (five of them the question types) with shared limits in both languages', () => {
  for (const language of ['zh', 'en']) {
    ssr.setUiLanguage(language);
    const html = renderToStaticMarkup(React.createElement(ssr.GenerationSettings, { root: '/temporary/library', act: noop }));
    assert.match(html, /data-tour="settings-generation"/);
    assert.match(html, /data-tour="settings-generation-time"[^>]*>(?:(?!<div class="sh-field).)*name="jobTimeoutMinutes"/, 'the Jobs page links to the field of the time limit');
    assert.equal((html.match(/<(?:input|select|textarea)\b/g) || []).length, 20);
    const types = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*name="kinds-(\w+)"[^>]*>/g)];
    assert.deepEqual(types.map(match => match[1]), ['quiz', 'multi', 'flashcard', 'open', 'cloze'], 'the default question types are five checkboxes, not a select');
    assert.deepEqual(types.map(match => /checked/.test(match[0])), [true, false, false, false, false], 'single choice is ticked by default');
    assert.match(types[0][0], /disabled/, 'the only ticked type cannot be unticked');
    assert.equal((html.match(/name="kind"/g) || []).length, 0);
    const check = html.match(/<input[^>]*name="applySuggestions"[^>]*>/);
    assert.ok(check && /type="checkbox"/.test(check[0]) && !/checked/.test(check[0]), 'applying the review suggestions is a checkbox, off by default');
    for (const [name, min, max] of [['count', 1, 500], ['concurrency', 1, 8], ['batchSize', 1, 5], ['jobTimeoutMinutes', 5, 180], ['fillRounds', 0, 4]]) {
      const input = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))[0];
      assert.match(input, new RegExp(`min="${min}"`)); assert.match(input, new RegExp(`max="${max}"`));
    }
    assert.match(html, /name="focus"[^>]*maxLength="2000"/);
    if (language === 'en') assert.doesNotMatch(html.replace(/\bvalue="(?:中文|中英双语)"/g, '').replaceAll('>中文<', '><'), /[㐀-鿿]/);
  }
  ssr.setUiLanguage('zh');
});

test('覆盖强度 is the default the page really uses, and the count the page ignores says so in its name', async () => {
  for (const language of ['zh', 'en']) {
    const markup = html(language, GENERATION_SETTINGS_DEFAULTS);
    const level = markup.match(/<select[^>]*name="coverageLevel"[^>]*>(.*?)<\/select>/)?.[1] || '';
    assert.equal((level.match(/<option/g) || []).length, 3, `${language}: three levels to choose from`);
    assert.match(level, /value="standard"[^>]*selected|selected[^>]*value="standard"/, `${language}: the default level is chosen`);
    assert.doesNotMatch(markup, language === 'zh' ? />默认题数</ : />Default question count</, `${language}: no row promises a count the page does not use`);
  }
  const zh = html('zh', GENERATION_SETTINGS_DEFAULTS);
  assert.match(zh, /默认覆盖强度/);
  assert.match(zh, /对话里出题的默认题数/, 'the count is named for where it applies');
  assert.match(zh, /创建题组页按「覆盖强度」出题，不用它/, 'and the hint says the page does not use it');
  assert.ok(zh.indexOf('默认覆盖强度') < zh.indexOf('对话里出题的默认题数'), 'the default the page uses comes before the one it does not');
  assert.match(html('zh', { ...GENERATION_SETTINGS_DEFAULTS, coverageLevel: 'lean' }), /精简：只给最重要的小节出题/, 'the hint explains the chosen level');
  const calls = [];
  const view = editor({ act: async (action, args, after) => { calls.push({ action, args }); after({ generation: args.generation }); } });
  view.render(); view.effects();
  assert.equal(control(view, 'coverageLevel').props.value, 'standard');
  edit(view, 'coverageLevel', 'full');
  await submit(view);
  assert.equal(calls[0].args.generation.coverageLevel, 'full', 'saving sends the level');
  edit(view, 'coverageLevel', 'huge');
  assert.ok(find(view.render(), node => typeof node.props?.error === 'string' && node.props.name !== 'x'), 'an unknown level is refused before saving');
});

test('saving submits exact numeric settings and reset only edits the pending form', async () => {
  const calls = [], notices = [];
  globalThis.__toast = { success: text => notices.push(text) };
  const view = editor({ saved: { ...GENERATION_SETTINGS_DEFAULTS, concurrency: 5 },
    act: async (action, args, after) => { calls.push({ action, args }); after({ generation: args.generation }); } });
  view.render(); view.effects();
  edit(view, 'count', '18'); edit(view, 'batchSize', '2'); edit(view, 'focus', '  Explain conditions  ');
  await submit(view);
  assert.deepEqual(calls, [{ action: 'settings', args: { generation: { ...GENERATION_SETTINGS_DEFAULTS, concurrency: 5, count: 18, batchSize: 2, focus: 'Explain conditions' } } }]);
  assert.equal(notices.length, 1);
  delete globalThis.__toast;
  find(view.render(), node => node.props?.onClick && node.props.children === '恢复默认值（待保存）').props.onClick();
  assert.equal(control(view, 'count').props.value, 10);
  assert.equal(control(view, 'concurrency').props.value, 4);
  assert.equal(calls.length, 1, 'reset does not save or call the model');
});

test('snapshots update a pristine form and preserve a newer unsaved edit', () => {
  const view = editor(); view.render(); view.effects();
  view.render({ saved: { ...GENERATION_SETTINGS_DEFAULTS, count: 20 } }); view.effects();
  assert.equal(control(view, 'count').props.value, 20);
  edit(view, 'count', '21');
  view.render({ saved: { ...GENERATION_SETTINGS_DEFAULTS, count: 12 } }); view.effects();
  assert.equal(control(view, 'count').props.value, '21');
});

test('an older successful save never overwrites input typed after submission', async () => {
  const response = deferred(), view = editor({ act: async (_action, args, after) => { await response.promise; after({ generation: args.generation }); } });
  view.render(); view.effects(); edit(view, 'count', '18');
  const saving = submit(view); edit(view, 'count', '19');
  response.resolve(); await saving;
  assert.equal(control(view, 'count').props.value, '19');
  assert.match(find(view.render(), node => node.props?.role === 'status').props.children, /未保存/);
});

test('departed library saves and failures cannot change the new form or report stale notices', async () => {
  for (const failure of [false, true]) {
    const response = deferred(), notices = [];
    globalThis.__toast = { success: text => notices.push(text) };
    const old = editor({
      act: async (_action, args, after) => { await response.promise; after({ generation: args.generation }); } });
    old.render(); old.effects(); edit(old, 'count', '18'); const saving = submit(old); old.unmount();
    const fresh = editor({ root: '/another/library' }); fresh.render(); fresh.effects();
    if (failure) response.reject(new Error('old library failed')); else response.resolve();
    await saving;
    assert.equal(control(fresh, 'count').props.value, 10);
    assert.deepEqual(notices, []);
    delete globalThis.__toast;
    assert.equal(find(old.render(), node => node.props?.role === 'alert'), null);
  }
});

test('invalid fields show bounded feedback, and busy or duplicate submits make no extra write', async () => {
  let calls = 0; const response = deferred(), view = editor({ act: async () => { calls++; await response.promise; } });
  view.render(); view.effects(); edit(view, 'concurrency', '9');
  // The Field around the control adds aria-invalid, aria-describedby and the alert (tests/wave2-g-fields.test.mjs); here it must be handed the bounded message.
  assert.match(find(view.render(), node => typeof node.props?.error === 'string' && node.props.error.includes('1–8')).props.error, /1–8/);
  await submit(view); assert.equal(calls, 0);
  edit(view, 'concurrency', '2'); view.render({ busy: true }); await submit(view); assert.equal(calls, 0);
  assert.equal(control(view, 'count').props.disabled, true);
  view.render({ busy: false }); const saving = submit(view); await submit(view); assert.equal(calls, 1);
  response.resolve(); await saving;
});

const html = (language, saved) => { ssr.setUiLanguage(language); try { return renderToStaticMarkup(React.createElement(ssr.GenerationSettings, { root: '/temporary/library', saved, act: noop })); } finally { ssr.setUiLanguage('zh'); } };
const ticked = markup => [...markup.matchAll(/<input[^>]*type="checkbox"[^>]*name="kinds-(\w+)"[^>]*>/g)].filter(match => /checked/.test(match[0])).map(match => match[1]);

test('the default question types show the saved combination, in words, in both languages (the old 测验 + 闪卡 is one of them)', () => {
  const saved = { ...GENERATION_SETTINGS_DEFAULTS, kind: 'mixed', kinds: ['quiz', 'flashcard'], count: 10 };
  const zh = html('zh', saved), en = html('en', saved);
  assert.deepEqual(ticked(zh), ['quiz', 'flashcard']);
  assert.deepEqual(ticked(en), ['quiz', 'flashcard']);
  assert.doesNotMatch(zh.match(/name="kinds-quiz"[^>]*>/)[0], /disabled/, 'with two ticked, either can be unticked');
  // The question count is not a number of this group: the form plans by 覆盖强度, so the split is said without one (a count shown here would be a plan nobody makes).
  assert.match(zh, /单选测验 \+ 闪卡 · 总题数按题型平均分配/);
  assert.match(en, /Single choice \+ Flashcard · The total is shared evenly between the types/);
  assert.doesNotMatch(zh, /按 10 题平均分配|5 \+ 5/);
  const three = html('zh', { ...GENERATION_SETTINGS_DEFAULTS, kind: 'quiz', kinds: ['quiz', 'open', 'cloze'], count: 10 });
  assert.deepEqual(ticked(three), ['quiz', 'open', 'cloze']);
  assert.match(three, /总题数按题型平均分配/);
  assert.doesNotMatch(html('zh', GENERATION_SETTINGS_DEFAULTS), /平均分配/, 'one type has nothing to split');
  assert.doesNotMatch(en.replace(/\bvalue="(?:中文|中英双语)"/g, '').replaceAll('>中文<', '><'), /[㐀-鿿]/, 'every word of the group is English');
});

test('an old library (kind only) opens with its types ticked; a corrupt list falls back without losing the kind', () => {
  assert.deepEqual(ticked(html('zh', { kind: 'mixed' })), ['quiz', 'flashcard']);
  assert.deepEqual(ticked(html('zh', { kind: 'cloze' })), ['cloze']);
  assert.deepEqual(ticked(html('zh', { kind: 'multi', kinds: 'x' })), ['multi']);
  assert.deepEqual(ticked(html('zh', { kinds: ['open', 'nope'] })), ['open']);
  assert.deepEqual(ticked(html('zh', { kind: 'mixed', kinds: ['open'] })), ['open'], 'kinds wins');
});

test('ticking types edits the list and the legacy kind together; the last ticked type cannot be unticked; saving sends both', async () => {
  const calls = [];
  const view = editor({ act: async (action, args, after) => { calls.push({ action, args }); after({ generation: args.generation }); } });
  view.render(); view.effects();
  const picker = () => control(view, 'kinds').props;
  assert.deepEqual(picker().value, ['quiz']);
  picker().onChange(['quiz', 'flashcard']);
  assert.deepEqual(picker().value, ['quiz', 'flashcard']);
  assert.equal(find(view.render(), node => node.props?.name === 'kinds').props.value.length, 2);
  picker().onChange(['quiz', 'flashcard', 'cloze']);
  await submit(view);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].args.generation.kind, calls[0].args.generation.kinds], ['quiz', ['quiz', 'flashcard', 'cloze']], 'any other combination: the first kind, for an older version');
  picker().onChange(['flashcard', 'quiz']);
  await submit(view);
  assert.deepEqual([calls[1].args.generation.kind, calls[1].args.generation.kinds], ['mixed', ['flashcard', 'quiz']], 'exactly quiz + flashcard is what the old version called mixed');
  // reset goes back to the single default quiz
  find(view.render(), node => node.props?.onClick && node.props.children === '恢复默认值（待保存）').props.onClick();
  assert.deepEqual(picker().value, ['quiz']);
  assert.ok(GENERATION_KINDS.includes('mixed'), 'the legacy value stays a valid kind for older readers');
});

test('the checkbox group cannot reach an empty list, and keeps the order of the boxes', () => {
  const { toggleKind } = ssr;
  assert.deepEqual(toggleKind(['quiz'], 'quiz', false), ['quiz'], 'refused');
  assert.deepEqual(toggleKind(['quiz'], 'cloze', true), ['quiz', 'cloze']);
  assert.deepEqual(toggleKind(['cloze', 'quiz'], 'open', true), ['quiz', 'open', 'cloze'], 'always the order of the boxes');
  assert.deepEqual(toggleKind(['quiz', 'open'], 'quiz', false), ['open']);
  assert.deepEqual(toggleKind(['multi', 'open'], 'multi', true), ['multi', 'open']);
});
