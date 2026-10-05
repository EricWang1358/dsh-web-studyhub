import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GENERATION_SETTINGS_DEFAULTS } from '../lib/generation-settings.js';

const require = createRequire(import.meta.url);
const built = await build({ stdin: { contents: `export { default as GenerationSettings, GenerationSettingsForm, generationFormErrors } from './ui/GenerationSettings.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node',
  format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
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
const edit = (view, key, value) => control(view, key).props.onChange({ target: { value } });
const submit = view => view.render().props.onSubmit({ preventDefault() {} });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('the generation settings section renders ten usable controls with shared limits in both languages', () => {
  for (const language of ['zh', 'en']) {
    ssr.setUiLanguage(language);
    const html = renderToStaticMarkup(React.createElement(ssr.GenerationSettings, { root: '/temporary/library', act: noop }));
    assert.match(html, /data-tour="settings-generation"/);
    assert.equal((html.match(/<(?:input|select|textarea)\b/g) || []).length, 10);
    for (const [name, min, max] of [['count', 1, 30], ['concurrency', 1, 6], ['batchSize', 1, 5], ['jobTimeoutMinutes', 5, 60], ['fillRounds', 0, 4]]) {
      const input = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))[0];
      assert.match(input, new RegExp(`min="${min}"`)); assert.match(input, new RegExp(`max="${max}"`));
    }
    assert.match(html, /name="focus"[^>]*maxLength="2000"/);
    if (language === 'en') assert.doesNotMatch(html.replace(/\bvalue="(?:中文|中英双语)"/g, '').replaceAll('>中文<', '><'), /[㐀-鿿]/);
  }
  ssr.setUiLanguage('zh');
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
  assert.equal(control(view, 'concurrency').props.value, 3);
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
  view.render(); view.effects(); edit(view, 'concurrency', '7');
  // The Field around the control adds aria-invalid, aria-describedby and the alert (tests/wave2-g-fields.test.mjs); here it must be handed the bounded message.
  assert.match(find(view.render(), node => typeof node.props?.error === 'string' && node.props.error.includes('1–6')).props.error, /1–6/);
  await submit(view); assert.equal(calls, 0);
  edit(view, 'concurrency', '2'); view.render({ busy: true }); await submit(view); assert.equal(calls, 0);
  assert.equal(control(view, 'count').props.disabled, true);
  view.render({ busy: false }); const saving = submit(view); await submit(view); assert.equal(calls, 1);
  response.resolve(); await saving;
});
