import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudyRuntime } from '../lib/runtime/builtins.js';

// Exercise the components' event handlers and effect lifetimes without a DOM renderer.
// The separate public-UI browser check covers layout and the native file input.
let active;
const realRequire = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export { BackupSection } from './ui/Settings.jsx';
  export { default as CourseSettings } from './ui/CourseSettings.jsx';
  export { default as ExtensionsSettings } from './ui/ExtensionsSettings.jsx';
  export { DisplaySettings } from './ui/reading-settings/ReadingSettings.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
const hook = (initial) => { const index = active.cursor++; if (!(index in active.slots)) active.slots[index] = initial(); return [index, active.slots[index]]; };
const effect = (callback, deps) => {
  const [, slot] = hook(() => ({ deps: undefined, cleanup: null }));
  if (!slot.deps || !deps || deps.some((value, i) => value !== slot.deps[i])) {
    active.effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); }); slot.deps = deps;
  }
};
const hooks = { ...React,
  useState: initial => { const owner = active, [index, value] = hook(() => typeof initial === 'function' ? initial() : initial);
    return [value, next => { owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next; }]; },
  useRef: value => hook(() => ({ current: value }))[1], useId: () => hook(() => `test-${active.cursor}`)[1],
  useMemo: (create, deps) => { const [, slot] = hook(() => ({ deps: undefined, value: undefined }));
    if (!slot.deps || !deps || deps.some((value, i) => value !== slot.deps[i])) { slot.value = create(); slot.deps = deps; }
    return slot.value; },
  useEffect: effect, useLayoutEffect: effect,
};
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => name === 'react' ? hooks : realRequire(name), module, module.exports);
const { BackupSection, CourseSettings, ExtensionsSettings, DisplaySettings } = module.exports;
function renderHook(component, props) {
  const owner = { cursor: 0, slots: [], effects: [] };
  return {
    render(nextProps) { if (nextProps) props = { ...props, ...nextProps }; active = owner; owner.cursor = 0; try { return component(props); } finally { active = null; } },
    effects() { for (const callback of owner.effects.splice(0)) callback(); },
    unmount() { for (const slot of owner.slots) slot?.cleanup?.(); },
  };
}
const find = (tree, predicate) => {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props?.children)) { const found = find(child, predicate); if (found) return found; }
  return null;
};
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const state = JSON.stringify({ version: 4, sources: [], decks: [], drafts: [], runs: [], attempts: [] });
const file = (name, read) => ({ name, size: state.length, text: read || (() => Promise.resolve(state)) });
const backup = () => renderHook(BackupSection, { root: '/temporary/library', busy: false, act() {}, exportData() {} });
const inputOf = tree => find(tree, node => node.type === 'input' && node.props.type === 'file');
const chosenOf = tree => find(tree, node => node.type?.name === 'RestorePreview')?.props.file;

async function mergePanel(t) {
  const root = await mkdtemp(join(tmpdir(), 'course-profile-panel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = createStudyRuntime(root);
  t.after(() => runtime.dispose());
  await runtime.call('source.add', { id: 'guide-a', title: 'Guide A', text: 'Examiner A guidance.' });
  await runtime.call('source.add', { id: 'guide-b', title: 'Guide B', text: 'Examiner B guidance.' });
  const target = await runtime.call('course.save', { name: 'Target', guidanceSourceIds: ['guide-a'], focusTopics: ['Target topic'] });
  const from = await runtime.call('course.save', { name: 'Duplicate', guidanceSourceIds: ['guide-b'], focusTopics: ['Merged topic'],
    exam: { format: 'closed-book', totalMarks: 100, writingMinutes: 90, readingMinutes: 0 } });
  let data = await runtime.call('snapshot');
  const view = renderHook(CourseSettings, { data, courseId: target.id, mergeFrom: [from.id], onClose() {},
    act: async (action, args, done) => { const result = await runtime.call(action, args); data = await runtime.call('snapshot'); await done?.(result); } });
  return { runtime, target, view, render: () => view.render({ data }) };
}

test('saving a course after merging preserves the merged exam, focus topics and examiner guidance', async t => {
  const { runtime, target, render } = await mergePanel(t);
  await find(render(), node => node.props?.children === '确认合并').props.onClick();
  const merged = render();
  assert.equal(find(merged, node => node.props?.['aria-label'] === '重点知识点').props.value, 'Target topic; Merged topic');
  assert.equal(find(merged, node => node.type?.name === 'NumberField' && node.props.label === '总分').props.value, '100');
  await find(merged.props.footer, node => node.props?.children === '保存课程信息').props.onClick();
  const saved = await runtime.call('course.get', { id: target.id });
  assert.deepEqual(saved.guidanceSourceIds, ['guide-a', 'guide-b']);
  assert.deepEqual(saved.focusTopics, ['Target topic', 'Merged topic']);
  assert.deepEqual(saved.exam, { format: 'closed-book', totalMarks: 100, writingMinutes: 90, readingMinutes: 0, sections: [] });
});

test('merging course profiles keeps pending local edits while adding the newly merged topics and guidance', async t => {
  const { runtime, target, render } = await mergePanel(t);
  const initial = render();
  find(initial, node => node.props?.['aria-label'] === '重点知识点').props.onChange({ target: { value: 'Local topic' } });
  find(initial, node => node.type?.name === 'NumberField' && node.props.label === '总分').props.onChange('45');
  find(initial, node => node.type?.name === 'SourcePicker').props.onChange([]);
  await find(render(), node => node.props?.children === '确认合并').props.onClick();
  const merged = render();
  assert.equal(find(merged, node => node.props?.['aria-label'] === '重点知识点').props.value, 'Local topic; Merged topic');
  assert.equal(find(merged, node => node.type?.name === 'NumberField' && node.props.label === '总分').props.value, '45');
  await find(merged.props.footer, node => node.props?.children === '保存课程信息').props.onClick();
  const saved = await runtime.call('course.get', { id: target.id });
  assert.deepEqual(saved.guidanceSourceIds, ['guide-b'], 'a deliberate local deselection is not restored by the merge');
  assert.deepEqual(saved.focusTopics, ['Local topic', 'Merged topic']);
  assert.equal(saved.exam.totalMarks, 45);
  assert.equal(saved.exam.writingMinutes, 90);
  assert.equal(saved.exam.format, 'closed-book');
});

test('the most recently selected backup owns the preview, even when an older file reads last', async () => {
  const view = backup(), old = deferred(), input = inputOf(view.render());
  const earlier = input.props.onChange({ target: { files: [file('old.json', () => old.promise)] } });
  await input.props.onChange({ target: { files: [file('new.json')] } });
  assert.equal(chosenOf(view.render()).name, 'new.json');
  old.resolve(state); await earlier;
  assert.equal(chosenOf(view.render()).name, 'new.json');
});

test('an obsolete backup read failure cannot hide the new preview or report an unrelated error', async () => {
  const view = backup(), old = deferred(), input = inputOf(view.render());
  const earlier = input.props.onChange({ target: { files: [file('old.json', () => old.promise)] } });
  await input.props.onChange({ target: { files: [file('new.json')] } });
  old.reject(new Error('old disk read failed')); await earlier;
  const tree = view.render();
  assert.equal(chosenOf(tree).name, 'new.json');
  assert.equal(find(tree, node => node.type?.name === 'InlineMessage'), null);
});

test('a current backup failure retains its cause, and leaving the section invalidates a pending read', async t => {
  const previousDocument = globalThis.document;
  globalThis.document = { querySelector: () => ({ textContent: '' }) };
  t.after(() => { globalThis.document = previousDocument; });
  const view = backup(), input = inputOf(view.render()); view.effects();
  await input.props.onChange({ target: { files: [file('broken.json', () => Promise.reject(new Error('disk read failed')))] } });
  assert.match(find(view.render(), node => node.type?.name === 'InlineMessage').props.children, /disk read failed/);
  const old = deferred(); input.props.ref.current = { value: 'new-library-file' };
  const pending = input.props.onChange({ target: { files: [file('old.json', () => old.promise)] } });
  view.unmount(); old.resolve(state); await pending;
  assert.equal(input.props.ref.current.value, 'new-library-file', 'a departed read must not clear a newer file input');
  assert.equal(chosenOf(view.render()), undefined);
});

test('the initial retrieval settings response preserves a URL typed while the read was pending', async t => {
  const previousDocument = globalThis.document;
  globalThis.document = { querySelector: () => ({ textContent: '' }) };
  t.after(() => { globalThis.document = previousDocument; });
  const response = deferred(), view = renderHook(ExtensionsSettings, { call: () => response.promise });
  const tree = view.render(); view.effects();
  const endpoint = find(tree, node => node.type === 'input' && node.props.type === 'url');
  endpoint.props.onChange({ target: { value: 'https://chosen.example' } });
  response.resolve({ selected: 'builtin', effective: 'builtin', providers: [], otherTools: [], hfEndpoint: 'https://saved.example' });
  await response.promise; await Promise.resolve();
  assert.equal(find(view.render(), node => node.type === 'input' && node.props.type === 'url').props.value, 'https://chosen.example');
});

test('clearing the backup choice or changing libraries invalidates a pending file read', async t => {
  const previousDocument = globalThis.document;
  globalThis.document = { querySelector: () => ({ textContent: '' }) };
  t.after(() => { globalThis.document = previousDocument; });
  for (const action of ['clear', 'library']) {
    const view = backup(), pending = deferred(), tree = view.render(); view.effects();
    const input = inputOf(tree);
    input.props.ref.current = { value: 'later-file', click() {} };
    const read = input.props.onChange({ target: { files: [file('old.json', () => pending.promise)] } });
    if (action === 'clear') find(view.render(), node => node.props?.icon === 'upload').props.onClick();
    else { view.render({ root: '/another/temporary/library' }); view.effects(); }
    pending.resolve(state); await read;
    assert.equal(chosenOf(view.render()), undefined, action);
    assert.equal(input.props.ref.current.value, 'later-file', action);
    view.unmount();
  }
});

test('untouched endpoint input still loads the saved setting and leaving ignores its pending response', async t => {
  const previousDocument = globalThis.document;
  globalThis.document = { querySelector: () => ({ textContent: '' }) };
  t.after(() => { globalThis.document = previousDocument; });
  for (const leave of [false, true]) {
    const response = deferred(), view = renderHook(ExtensionsSettings, { call: () => response.promise });
    view.render(); view.effects(); if (leave) view.unmount();
    response.resolve({ selected: 'builtin', effective: 'builtin', providers: [], otherTools: [], hfEndpoint: 'https://saved.example' });
    await response.promise; await Promise.resolve();
    assert.equal(find(view.render(), node => node.type === 'input' && node.props.type === 'url').props.value, leave ? '' : 'https://saved.example');
    view.unmount();
  }
});

function display(t, { left, width = 304, scale = 1, right = 1220, top = 100, bottom = 850 }) {
  const previous = { document: globalThis.document, window: globalThis.window, ResizeObserver: globalThis.ResizeObserver };
  const listeners = new Map(), observers = [];
  globalThis.document = { querySelector: () => ({ textContent: '' }), addEventListener() {}, removeEventListener() {} };
  globalThis.window = { innerWidth: right, innerHeight: bottom, addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener: type => listeners.delete(type) };
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const bounds = { left: 0, right, bottom }, panel = { style: {}, offsetWidth: width, get offsetLeft() { return left / scale; },
    getBoundingClientRect() { const shift = Number(/translateX\(([-\d.]+)px\)/.exec(this.style.transform || '')?.[1] || 0) * scale;
      return { left: left + shift, right: left + shift + width * scale, width: width * scale, top }; } };
  const root = { closest: () => ({ getBoundingClientRect: () => bounds }), getBoundingClientRect: () => ({ left: 0 }), contains: () => true };
  const view = renderHook(DisplaySettings, { settings: {}, onChange() {}, onReset() {} });
  let tree = view.render(); tree.props.ref.current = root; view.effects();
  find(tree, node => node.props?.['data-usage'] === 'reader.display').props.onClick();
  tree = view.render(); find(tree, node => node.props?.className === 'reader-popover__panel').props.ref.current = panel; view.effects();
  return { view, bounds, panel, listeners, observers, move: value => { left = value; } };
}

test('an open reading display panel stays in its viewer when the toolbar moves after resize', t => {
  const shown = display(t, { left: 800, right: 1220 });
  shown.bounds.right = 360; shown.move(275);
  assert.ok(shown.listeners.has('resize'), 'the open panel follows window resizing');
  shown.listeners.get('resize')();
  assert.ok(shown.panel.getBoundingClientRect().right <= 352);
  assert.ok(shown.observers.length > 0, 'pane resizing is observed even without a window resize');
  shown.bounds.right = 320; shown.move(180); shown.observers[0].callback();
  assert.ok(shown.panel.getBoundingClientRect().right <= 312);
  shown.view.unmount();
  assert.equal(shown.listeners.has('resize'), false);
  assert.ok(shown.observers.every(observer => observer.disconnected));
});

test('reading panel positioning converts physical pixels into CSS pixels at 200% interface scale', t => {
  const shown = display(t, { left: 500, right: 720, scale: 2 });
  const box = shown.panel.getBoundingClientRect();
  assert.ok(box.left >= 8 && box.right <= 712, JSON.stringify(box));
  assert.equal(shown.panel.style.transform, 'translateX(-198px)');
  shown.view.unmount();
});

test('the reading panel reserves only the visible height below the toolbar when interface scaling makes its controls taller', t => {
  const shown = display(t, { left: 500, right: 720, scale: 2 });
  assert.equal(shown.panel.style.maxHeight, '371px');
  globalThis.window.innerHeight = 600;
  shown.listeners.get('resize')();
  assert.equal(shown.panel.style.maxHeight, '246px', 'resizing also updates the height available for scrolling');
  shown.view.unmount();
});
