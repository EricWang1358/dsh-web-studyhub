import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  PRACTICE_DEFAULTS,
  mergePracticeSettings,
  resolvePracticeSettings,
  studyChainRecipes,
  validatePracticePatch,
} from '../lib/practice-settings.js';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `export { default as PracticePane } from './ui/settings/PracticePane.jsx';
      export { default as FinderSheet } from './ui/finder/FinderSheet.jsx';
      export { FINDER_ENTRIES } from './ui/finder/entries.js';
      export { withAvailability } from './ui/finder/availability.js';
      export { buildChainRecipes, summarizeChainState } from './ui/finder/chain-recipes.js';
      export { ENGLISH_SOURCES, mergeCatalogues, setUiLanguage, ui, uiCatalogue } from './ui/i18n.js';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom'],
  plugins: [nativeSelects],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});
const load = (requireFn) => {
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(requireFn, mod, mod.exports);
  return mod.exports;
};
const ssr = load(require);
Object.assign(ssr.uiCatalogue(), ssr.mergeCatalogues(ssr.ENGLISH_SOURCES).catalogue);
const hooklessSsr = load((name) => (name === 'react'
  ? {
    ...React,
    useMemo: (calc) => calc(),
    useId: () => 'id-1',
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useCallback: (cb) => cb,
    useRef: (v) => ({ current: v }),
    useContext: (ctx) => ctx?._currentValue,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useInsertionEffect: () => {},
  }
  : require(name)));

const h = React.createElement;
const noop = () => {};
const han = /\p{Script=Han}/u;
let activeHookOwner;
const hookSlot = (initial) => {
  const index = activeHookOwner.cursor++;
  if (!(index in activeHookOwner.slots)) activeHookOwner.slots[index] = initial();
  return [index, activeHookOwner.slots[index]];
};
const statefulReact = {
  ...React,
  useState: (initial) => {
    const owner = activeHookOwner;
    const [index, value] = hookSlot(() => (typeof initial === 'function' ? initial() : initial));
    return [value, (next) => { owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next; }];
  },
  useContext: (ctx) => ctx?._currentValue ?? null,
  useRef: (value) => hookSlot(() => ({ current: value }))[1],
  useId: () => hookSlot(() => `field-${activeHookOwner.cursor}`)[1],
  useInsertionEffect: () => {},
  useEffect: () => {},
};
const livePaneMod = load((name) => (name === 'react' ? statefulReact : require(name)));
const findNode = (tree, predicate) => {
  if (!tree || typeof tree !== 'object') return null;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props?.children)) {
    const match = findNode(child, predicate);
    if (match) return match;
  }
  return null;
};
const mountPracticePane = ({ fail = false, practice = {} } = {}) => {
  const calls = [];
  const owner = { cursor: 0, slots: [] };
  const data = { settings: Object.keys(practice).length ? { practice } : {} };
  const act = async (action, args, after, options) => {
    calls.push([action, args, options]);
    if (fail) throw new Error('save failed');
    const result = { ...PRACTICE_DEFAULTS, ...args.patch };
    await after?.(result, { isCurrent: () => true });
    return result;
  };
  const renderPane = () => {
    owner.cursor = 0;
    activeHookOwner = owner;
    try { return livePaneMod.PracticePane({ data, busy: false, act }); } finally { activeHookOwner = null; }
  };
  return {
    calls,
    toggle: () => findNode(renderPane(), (node) => node.props?.name === 'studyChainRecipes'),
    alert: () => findNode(renderPane(), (node) => node.props?.role === 'alert'),
  };
};
const HOST = {
  features: { examBlueprint: true },
  contexts: ['bank', 'study', 'materials', 'generation', 'authoring', 'audio', 'recording', 'notes', 'workflows', 'skeleton', 'system'],
};
const textOf = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const english = (fn) => {
  ssr.setUiLanguage('en');
  try { return fn(); } finally { ssr.setUiLanguage('zh'); }
};

test('Finder scenario guides setting (studyChainRecipes) stays out of PRACTICE_DEFAULTS until enabled', () => {
  const baselineKeys = ['autopilot', 'roundSize', 'newCardOrder', 'debrief', 'rereadMarks', 'leechFailures', 'leechWindow', 'leechRate'];
  assert.deepEqual(Object.keys(PRACTICE_DEFAULTS), baselineKeys);
  assert.deepEqual(Object.keys(resolvePracticeSettings(undefined)), baselineKeys);
  assert.equal(studyChainRecipes(undefined), false);

  const enabled = mergePracticeSettings(undefined, { studyChainRecipes: true });
  assert.equal(enabled.studyChainRecipes, true);
  assert.equal(studyChainRecipes(enabled), true);

  const cleared = mergePracticeSettings(enabled, { studyChainRecipes: null });
  assert.equal('studyChainRecipes' in cleared, false);
  assert.equal(studyChainRecipes(cleared), false);

  assert.deepEqual(validatePracticePatch({ studyChainRecipes: true }), { studyChainRecipes: true });
  assert.throws(() => mergePracticeSettings(undefined, { studyChainRecipes: 'on' }), /studyChainRecipes/);
});

test('PracticePane and Finder entries expose opt-in studyChainRecipes cleanly in Chinese and English', async () => {
  ssr.setUiLanguage('zh');
  const input = (html, name) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? '';
  const offHtml = renderToStaticMarkup(h(ssr.PracticePane, { data: { settings: {} }, busy: false, act: noop }));
  assert.doesNotMatch(input(offHtml, 'studyChainRecipes'), /checked/);

  const onHtml = renderToStaticMarkup(h(ssr.PracticePane, {
    data: { settings: { practice: { studyChainRecipes: true } } },
    busy: false,
    act: noop,
  }));
  assert.match(input(onHtml, 'studyChainRecipes'), /checked/);

  const entry = ssr.FINDER_ENTRIES.find((item) => item.id === 'finder-chain-recipes');
  assert.ok(entry);
  assert.equal(entry.area, 'settings');

  // Mount PracticePane interactively and toggle studyChainRecipes on -> off, plus verify rollback and error surfacing on failure.
  const okPane = mountPracticePane();
  assert.equal(okPane.toggle().props.checked, false);
  await okPane.toggle().props.onChange(true);
  assert.deepEqual(okPane.calls[0].slice(0, 2), ['settings.practice.set', { patch: { studyChainRecipes: true } }]);
  assert.equal(okPane.calls[0][2]?.rethrow, true);
  assert.equal(okPane.toggle().props.checked, true);

  await okPane.toggle().props.onChange(false);
  assert.deepEqual(okPane.calls[1].slice(0, 2), ['settings.practice.set', { patch: { studyChainRecipes: null } }]);
  assert.equal(okPane.toggle().props.checked, false);

  const failOn = mountPracticePane({ fail: true });
  await failOn.toggle().props.onChange(true);
  assert.equal(failOn.calls.length, 1);
  assert.deepEqual(failOn.calls[0].slice(0, 2), ['settings.practice.set', { patch: { studyChainRecipes: true } }]);
  assert.equal(failOn.toggle().props.checked, false, 'a failed enable rolls studyChainRecipes back to saved false');
  assert.match(String(failOn.alert()?.props?.children ?? ''), /save failed/, 'a failed enable surfaces the error alert');

  const failOff = mountPracticePane({ fail: true, practice: { studyChainRecipes: true } });
  assert.equal(failOff.toggle().props.checked, true);
  await failOff.toggle().props.onChange(false);
  assert.equal(failOff.calls.length, 1);
  assert.deepEqual(failOff.calls[0].slice(0, 2), ['settings.practice.set', { patch: { studyChainRecipes: null } }]);
  assert.equal(failOff.toggle().props.checked, true, 'a failed disable rolls studyChainRecipes back to saved true');
  assert.match(String(failOff.alert()?.props?.children ?? ''), /save failed/, 'a failed disable surfaces the error alert');

  english(() => {
    const enHtml = renderToStaticMarkup(h(ssr.PracticePane, { data: { settings: {} }, busy: false, act: noop }));
    assert.doesNotMatch(textOf(enHtml), han);
    assert.match(enHtml, /Show learning situation guides in Find a feature/);
    assert.doesNotMatch(textOf(ssr.ui(entry.title)), han);
    assert.doesNotMatch(textOf(ssr.ui(entry.what)), han);
  });
});

test('summarizeChainState and buildChainRecipes adapt to all four library situations and small fixtures', () => {
  const doc = { id: 's1', documentId: 'doc-1', title: 'Notes' };
  const sampleDoc = { id: 's-sample', documentId: 'doc-sample', title: 'Design Patterns', sample: true };
  const readyDeck = { id: 'd1', available: 12, wrong: 0 };
  const sampleDeck = { id: 'd-sample', available: 9, wrong: 2, sample: true };
  const parkedDeck = { id: 'd-parked', available: 10, wrong: 3, inactive: true };

  assert.equal(ssr.summarizeChainState({ sources: [], decks: [] }).recommendedId, 'kickoff');
  assert.equal(ssr.summarizeChainState({ sources: [sampleDoc], decks: [sampleDeck] }).recommendedId, 'kickoff');
  assert.equal(ssr.summarizeChainState({ sources: [doc], decks: [parkedDeck] }).recommendedId, 'kickoff');
  assert.equal(ssr.summarizeChainState({ sources: [doc], decks: [readyDeck, { id: 'd2', wrong: 3 }] }).recommendedId, 'clear-mistakes');
  assert.equal(ssr.summarizeChainState({ sources: [doc], decks: [readyDeck], today: { due: 4 } }).recommendedId, 'reading-loop');
  assert.equal(ssr.summarizeChainState({ sources: [doc], decks: [readyDeck], today: { due: 0, elsewhere: 5 } }).recommendedId, 'reading-loop');
  assert.equal(ssr.summarizeChainState({ sources: [doc], decks: [readyDeck], today: { due: 0 } }).recommendedId, 'exam-sprint');

  const marked = ssr.withAvailability(ssr.FINDER_ENTRIES, HOST);
  const recipes = ssr.buildChainRecipes(marked, { sources: [doc], decks: [readyDeck, { id: 'd2', wrong: 2 }] });
  assert.equal(recipes.length, 4);
  assert.equal(recipes[0].id, 'clear-mistakes');
  assert.equal(recipes[0].recommended, true);
  assert.equal(recipes[0].reason, '有待巩固错题');
  assert.equal(recipes[0].steps.length, 3);
  assert.equal(recipes[0].steps[0].id, 'retrain');
  assert.equal(recipes[0].steps[0].stepNumber, 1);

  const subset = ssr.buildChainRecipes(marked.filter((item) => item.id === 'page-book' || item.id === 'page-exam'), { sources: [], decks: [] });
  assert.equal(subset.length, 1);
  assert.equal(subset[0].id, 'exam-sprint');
  assert.equal(subset[0].recommended, true);
  assert.equal(subset[0].steps.length, 2);
});

test('FinderSheet keeps default-off parity and enables keyboard-navigable scenario guides when opted in', () => {
  const dataOn = {
    ...HOST,
    sources: [{ id: 's1', documentId: 'doc-1', title: 'Week 1' }],
    decks: [{ id: 'd1', available: 10, wrong: 2 }],
    settings: { practice: { studyChainRecipes: true } },
  };

  ssr.setUiLanguage('zh');
  const offHtml = renderToStaticMarkup(h(ssr.FinderSheet, { data: HOST, onGo: noop, onClose: noop, onTour: noop }));
  assert.doesNotMatch(offHtml, /data-finder-recipes/);

  const onHtml = renderToStaticMarkup(h(ssr.FinderSheet, { data: dataOn, initialRecentIds: [], onGo: noop, onClose: noop, onTour: noop }));
  assert.match(onHtml, /data-finder-recipes/);
  const recipeTags = [...onHtml.matchAll(/<details[^>]*class="finder-group finder-recipe"[^>]*>/g)].map((m) => m[0]);
  assert.equal(recipeTags.length, 4);
  assert.equal(recipeTags.filter((tag) => /\sopen=""/.test(tag)).length, 1);
  assert.match(recipeTags[0], /data-recipe="clear-mistakes"/);

  const searchHtml = renderToStaticMarkup(h(ssr.FinderSheet, { data: dataOn, initialQuery: '翻译', initialRecentIds: [], onGo: noop, onClose: noop, onTour: noop }));
  assert.doesNotMatch(searchHtml, /data-finder-recipes/);

  const went = [];
  const tree = hooklessSsr.FinderSheet({ data: dataOn, initialRecentIds: [], onGo: (entry) => went.push(entry.id), onClose: noop, onTour: noop });
  const stack = [tree];
  let inputNode = null;
  while (stack.length) {
    const node = stack.shift();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) { stack.unshift(...node); continue; }
    if (node.props?.role === 'combobox') { inputNode = node; break; }
    if (node.props?.children) stack.push(node.props.children);
    if (typeof node.type === 'function') {
      try { stack.push(node.type(node.props)); } catch { /* ignore */ }
    }
  }
  assert.ok(inputNode);
  inputNode.props.onKeyDown({ key: 'Enter', preventDefault: noop });
  assert.deepEqual(went, ['retrain']);

  english(() => {
    const enOn = renderToStaticMarkup(h(ssr.FinderSheet, { data: dataOn, initialRecentIds: [], onGo: noop, onClose: noop, onTour: noop }));
    assert.doesNotMatch(textOf(enOn), han);
    assert.match(textOf(enOn), /Learning situation guides/);
    assert.match(textOf(enOn), /After practice: clear weak points together/);
    assert.match(textOf(enOn), /Mistakes to review/);
  });
});
