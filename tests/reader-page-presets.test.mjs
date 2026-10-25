import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';
import { addNode, emptyThread } from '../ui/document-preview/ask-thread.js';

/* #485: the presets of 按页提问 — the four built-ins, whose wording is fixed and which can only be hidden, and the learner's own, which are
   added, edited, hidden and deleted. They are kept in this browser (or for this visit when it cannot store them), and a preset of one's own
   sends its prompt exactly as written, never through the translation catalogue. */

const han = /[㐀-鿿]/;
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `
  export * from './ui/i18n.js';
  export { LearningPanel } from './ui/document-preview/DocumentLearning.jsx';
  export { default as QuickIntents, PAGE_INTENTS } from './ui/document-preview/QuickIntents.jsx';
  export { default as PagePresets } from './ui/document-preview/PagePresets.jsx';
  export * from './ui/document-preview/reader/page-presets.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const lib = module.exports;

const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const render = element => renderToStaticMarkup(element);
const KEY = 'study-reader-page-presets';
/** A storage as a browser gives it, for tests (the presets are read through ui/storage.js). */
const memoryStorage = () => {
  const store = new Map();
  return { store, getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
};
/** Render with `value` stored as this browser's presets (the panel reads the browser's storage on mount). */
function withStoredPresets(value, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  lib.forgetPagePresets();
  const storage = memoryStorage();
  if (value) storage.setItem(KEY, JSON.stringify(value));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try { return run(storage); } finally {
    lib.forgetPagePresets();
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage;
  }
}
/** The buttons of a React element tree that carry a click and a plain label (the chips and the entry of QuickIntents). */
const buttonsOf = element => {
  const found = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.props?.onClick && typeof node.props.children === 'string') found.push(node);
    walk(node.props?.children);
  };
  walk(element);
  return found;
};
const pageScope = (extra = {}) => ({ kind: 'page', page: 2, sourceId: 'p2', empty: false, ...extra });
const pagePanel = (extra = {}) => ({ capture: { quote: '' }, scope: pageScope(), thread: emptyThread(), question: '', askReady: true, modelReady: true,
  resolution: { status: 'resolved', scope: 'page', selection: { documentId: 'doc', revision: 'r1', sourceId: 'p2', page: 2 } }, jobs: [], now: 0, call() {}, ...extra });
const oneOwn = { id: 'p1', name: '三句话', prompt: '用三句话总结这一页。' };

test('the four built-in presets keep their exact wording; hiding one is remembered by its intent', () => {
  assert.deepEqual(lib.PAGE_INTENTS.map(({ label, question, intent }) => [label, question, intent]), [
    ['讲解这一页', '请按原文顺序讲解这一页。', 'explain'],
    ['翻译这一页', '请把这一页完整翻译过来，保持原来的顺序。', 'translate'],
    ['按知识点拆分这一页', '请把这一页按知识点拆开，每个知识点用一两句话说清。', 'points'],
    ['提取这一页的公式与代码', '请把这一页的公式和代码原样提取出来，并说明各自的用途。', 'extract'],
  ]);
  assert.deepEqual(lib.BUILTIN_PRESETS, lib.PAGE_INTENTS.map(chip => chip.intent), 'a hidden built-in is remembered by its intent, never by a copy of its text');
});

test('presets are kept in this browser, and a browser without storage keeps them for this visit', () => {
  lib.forgetPagePresets();
  const storage = memoryStorage();
  assert.deepEqual(lib.readPagePresets(storage), { hidden: [], custom: [] });
  const saved = lib.savePagePresets(lib.addCustomPreset(lib.emptyPagePresets(), { id: 'p1', name: ' 总结 ', prompt: ' 用三句话总结这一页。 ' }), storage);
  assert.deepEqual(saved, { hidden: [], custom: [{ id: 'p1', name: '总结', prompt: '用三句话总结这一页。' }] }, 'the name and the prompt are trimmed');
  assert.deepEqual(JSON.parse(storage.store.get(KEY)), saved, 'written under the reader key');
  lib.forgetPagePresets();
  assert.deepEqual(lib.readPagePresets(storage), saved, 'read back after a reload');
  const hidden = lib.setPresetShown(lib.setPresetShown(saved, 'translate', false), 'p1', false);
  lib.savePagePresets(hidden, storage);
  lib.forgetPagePresets();
  assert.deepEqual(lib.readPagePresets(storage).hidden.sort(), ['p1', 'translate'], 'a built-in and a preset of one\'s own are hidden the same way');
  // An older or hand-edited value cannot break the panel: unusable presets are dropped, junk JSON is nothing at all.
  storage.setItem(KEY, '{"hidden":["nonsense",3],"custom":[{"name":""},{"name":"A","prompt":"B"}]}');
  lib.forgetPagePresets();
  assert.deepEqual(lib.readPagePresets(storage), { hidden: ['nonsense'], custom: [{ id: 'preset-1', name: 'A', prompt: 'B' }] });
  storage.setItem(KEY, 'not json');
  lib.forgetPagePresets();
  assert.deepEqual(lib.readPagePresets(storage), { hidden: [], custom: [] });
  // A blocked browser (no storage at all) still keeps them while the reader is open, and a new visit starts from nothing.
  lib.forgetPagePresets();
  assert.deepEqual(lib.readPagePresets(null), { hidden: [], custom: [] });
  lib.savePagePresets(saved, null);
  assert.deepEqual(lib.readPagePresets(null), saved, 'this visit keeps what could not be stored');
  lib.forgetPagePresets();
  assert.deepEqual(lib.readPagePresets(null), { hidden: [], custom: [] });
});

test('adding, editing and deleting a preset touches only that preset', () => {
  const base = lib.emptyPagePresets();
  const one = lib.addCustomPreset(base, { id: 'p1', name: '三句话', prompt: '用三句话总结这一页。' });
  assert.deepEqual(base.custom, [], 'the presets are not changed in place');
  assert.deepEqual(lib.updateCustomPreset(one, 'p1', { name: '两句话', prompt: '用两句话总结这一页。' }).custom,
    [{ id: 'p1', name: '两句话', prompt: '用两句话总结这一页。' }]);
  assert.deepEqual(lib.updateCustomPreset(one, 'nope', { name: 'x', prompt: 'y' }), one, 'an unknown id changes nothing');
  assert.deepEqual(lib.removeCustomPreset(lib.setPresetShown(one, 'p1', false), 'p1'), { hidden: [], custom: [] }, 'deleting it forgets its hiding too');
  assert.notEqual(lib.addCustomPreset(base, { name: 'A', prompt: 'B' }).custom[0].id, lib.addCustomPreset(base, { name: 'A', prompt: 'B' }).custom[0].id, 'every preset of one\'s own has its own id');
});

test('a preset needs a name, a prompt, a length that fits, and a name of its own', () => {
  const others = [{ id: 'p1', name: '总结', prompt: 'x' }, { id: 'p2', name: 'Summary', prompt: 'y' }];
  assert.deepEqual(lib.validatePreset({ name: '  ', prompt: '' }, others), { name: 'name-required', prompt: 'prompt-required' });
  assert.deepEqual(lib.validatePreset({ name: 'x'.repeat(lib.PRESET_NAME_MAX + 1), prompt: 'q' }, others), { name: 'name-long' });
  assert.deepEqual(lib.validatePreset({ name: 'n', prompt: 'p'.repeat(lib.PRESET_PROMPT_MAX + 1) }, others), { prompt: 'prompt-long' });
  assert.deepEqual(lib.validatePreset({ name: ' 总结 ', prompt: 'q' }, others), { name: 'name-duplicate', duplicate: '总结' }, 'spacing does not make a name different');
  assert.deepEqual(lib.validatePreset({ name: 'summary', prompt: 'q' }, others), { name: 'name-duplicate', duplicate: 'Summary' }, 'nor does case');
  assert.deepEqual(lib.validatePreset({ name: '总结', prompt: 'q' }, others, 'p1'), {}, 'the preset being edited is not its own duplicate');
  assert.deepEqual(lib.validatePreset({ name: '新名字', prompt: 'q' }, others), {});
});

test('what the panel shows is the built-ins not hidden, then the presets of one\'s own', () => {
  const presets = { hidden: ['translate', 'p2'], custom: [{ id: 'p1', name: '三句话', prompt: '用三句话总结这一页。' }, { id: 'p2', name: '考我', prompt: '就这一页出两道题。' }] };
  const chips = lib.visiblePagePresets(presets, lib.PAGE_INTENTS);
  assert.deepEqual(chips.map(chip => chip.label), ['讲解这一页', '按知识点拆分这一页', '提取这一页的公式与代码', '三句话'], 'the built-in wording is the one of PAGE_INTENTS');
  assert.deepEqual(chips[3], { key: 'p1', label: '三句话', question: '用三句话总结这一页。', own: true }, 'a preset of one\'s own says whose it is');
});

test('the page panel shows the presets of this browser, and the way to manage them at the end of the row', () => {
  lib.setUiLanguage('zh');
  const stored = { hidden: ['translate'], custom: [oneOwn] };
  withStoredPresets(stored, () => {
    const out = render(React.createElement(lib.LearningPanel, pagePanel({ onQuick() {} })));
    assert.match(out, /role="group" aria-label="快捷提问"/);
    for (const label of ['讲解这一页', '按知识点拆分这一页', '提取这一页的公式与代码', '三句话']) assert.match(text(out), new RegExp(label), label);
    assert.doesNotMatch(text(out), /翻译这一页/, 'a hidden built-in is kept but not shown');
    assert.match(out, /点击即发送：「用三句话总结这一页。」/, 'the hover says the exact prompt that goes out');
    assert.equal((out.match(/自定义预设…/g) || []).length, 1, 'one way in, at the end of the row');
    assert.ok(out.indexOf('三句话</button>') < out.indexOf('自定义预设…'), 'the entry comes after the presets');
    // A page without saved text has no presets at all (nothing to ask), and no entry either.
    const blank = render(React.createElement(lib.LearningPanel, pagePanel({ scope: pageScope({ empty: true, sourceId: '' }), resolution: null })));
    assert.doesNotMatch(blank, /自定义预设…/);
  });
  lib.setUiLanguage('zh');
});

test('the entry is disabled like the built-ins: while an answer is coming, with no model, on a refused page', () => {
  lib.setUiLanguage('zh');
  const entry = out => /<button[^>]*>(?:<[^>]+>)*自定义预设…/.exec(out)?.[0] || '';
  withStoredPresets(null, () => {
    assert.match(entry(render(React.createElement(lib.LearningPanel, pagePanel({ onQuick() {} })))), /自定义预设…/);
    assert.doesNotMatch(entry(render(React.createElement(lib.LearningPanel, pagePanel({ onQuick() {} })))), /disabled/, 'a page that can be asked uses the entry');
    assert.match(entry(render(React.createElement(lib.LearningPanel, pagePanel({ onQuick() {}, askReady: false, modelReady: false })))), /disabled/, 'no model');
    const asking = addNode(emptyThread(), { id: 'n1', parentId: null, question: 'q' });
    assert.match(entry(render(React.createElement(lib.LearningPanel, pagePanel({ onQuick() {}, thread: asking })))), /disabled/, 'an answer is coming');
    assert.match(entry(render(React.createElement(lib.LearningPanel, pagePanel({ question: 'q', pageRefusal: { status: 'stale' } })))), /disabled/, 'the page is refused');
  });
});

test('a preset of one\'s own asks with its exact words; a built-in still asks with its own', () => {
  lib.setUiLanguage('zh');
  const asked = [], opened = [];
  const chips = lib.visiblePagePresets({ hidden: [], custom: [oneOwn] }, lib.PAGE_INTENTS);
  const found = buttonsOf(lib.QuickIntents({ chips, onAsk: (...args) => asked.push(args), onCustom: () => opened.push(true) }));
  assert.equal(found.length, 6, 'four built-ins and one of one\'s own, then the entry');
  found.find(button => button.props.children === '三句话').props.onClick();
  assert.deepEqual(asked[0], ['用三句话总结这一页。', '三句话', undefined], 'the prompt and the name, and no built-in intent');
  found.find(button => button.props.children === '自定义预设…').props.onClick();
  assert.deepEqual(opened, [true], 'the entry opens the manager instead of asking');
  lib.setUiLanguage('en');
  try {
    // A preset that says the same as a built-in is still sent exactly as typed: the catalogue translates the interface, never the learner's words.
    const own = lib.visiblePagePresets({ hidden: [], custom: [{ id: 'p2', name: '讲解这一页', prompt: '讲解这一页。' }] }, lib.PAGE_INTENTS);
    const englishAsked = [];
    const englishFound = buttonsOf(lib.QuickIntents({ chips: own, onAsk: (...args) => englishAsked.push(args) }));
    englishFound.find(button => button.props.children === '讲解这一页').props.onClick();
    assert.deepEqual(englishAsked[0], ['讲解这一页。', '讲解这一页', undefined], 'never translated');
    englishFound.find(button => button.props.children === 'Explain this page').props.onClick();
    assert.deepEqual(englishAsked[1], ['Please explain this page in the order of the source.', 'Explain this page', 'explain'], 'the built-ins are translated as before');
  } finally { lib.setUiLanguage('zh'); }
});

test('the manager lists the built-ins, which can only be hidden, and the presets of one\'s own, which can be edited and deleted', () => {
  lib.setUiLanguage('zh');
  const presets = { hidden: ['translate'], custom: [oneOwn] };
  const out = render(React.createElement(lib.PagePresets, { presets, onChange() {}, onClose() {} }));
  assert.match(out, /<dialog[^>]*class="sh-dialog/);
  assert.match(text(out), /按页提问的预设/);
  for (const name of ['讲解这一页', '翻译这一页', '按知识点拆分这一页', '提取这一页的公式与代码']) assert.match(text(out), new RegExp(name), name);
  assert.equal((out.match(/type="checkbox"/g) || []).length, 5, 'one checkbox per preset');
  assert.equal((out.match(/checked=""/g) || []).length, 4, 'the hidden built-in is unchecked, the rest checked');
  assert.equal((out.match(/aria-label="编辑「三句话」"/g) || []).length, 1, 'only a preset of one\'s own is edited');
  assert.equal((out.match(/aria-label="删除「三句话」"/g) || []).length, 1);
  assert.equal((out.match(/aria-label="删除「讲解这一页」"/g) || []).length, 0, 'a built-in is never deleted');
  assert.equal((out.match(/aria-label="编辑「讲解这一页」"/g) || []).length, 0);
  assert.match(text(out), /内置的四个不能改、不能删，只能隐藏/);
  assert.match(text(out), /添加预设/);
  assert.doesNotMatch(out, /<textarea/, 'the form waits for 添加预设');
  const empty = render(React.createElement(lib.PagePresets, { presets: lib.emptyPagePresets(), onChange() {}, onClose() {} }));
  assert.match(text(empty), /还没有自己的预设。/);
  assert.doesNotMatch(empty, /aria-label="删除「/);
});

test('English: the dialog and the entry are English, and a preset of one\'s own is shown as written', () => {
  lib.setUiLanguage('en');
  try {
    const presets = { hidden: [], custom: [{ id: 'p1', name: 'Three lines', prompt: 'Summarise this page in three sentences.' }] };
    const dialog = render(React.createElement(lib.PagePresets, { presets, onChange() {}, onClose() {} }));
    assert.doesNotMatch(dialog.replace(/Three lines|Summarise this page in three sentences\./g, ''), han);
    assert.match(text(dialog), /Presets for asking about a page/);
    assert.match(text(dialog), /Built-in presets/);
    assert.match(text(dialog), /My presets/);
    assert.match(text(dialog), /Add a preset/);
    assert.match(text(dialog), /Finish/, 'the way out');
    withStoredPresets(presets, () => {
      const out = render(React.createElement(lib.LearningPanel, pagePanel({ onQuick() {} })));
      assert.doesNotMatch(out.replace(/Three lines/g, ''), han);
      assert.match(text(out), /Three lines/);
      assert.match(text(out), /Custom presets…/);
      assert.match(text(out), /Explain this page/, 'the built-ins are English too');
    });
  } finally { lib.setUiLanguage('zh'); }
});
