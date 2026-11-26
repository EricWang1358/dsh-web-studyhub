import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  PRACTICE_DEFAULTS,
  mergePracticeSettings,
  normalizePracticeSettings,
  notesPracticeBridge,
  resolvePracticeSettings,
  validatePracticePatch,
} from '../lib/practice-settings.js';
import {
  MAX_NOTE_PRACTICE_SCOPE,
  buildNotePracticeScope,
  countNotesWithCards,
  filterNotesWithCards,
  noteLinkedCount,
} from '../ui/notes-practice-bridge.js';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `export { default as BlogNotes } from './ui/BlogNotes.jsx';
      export { default as PracticePane } from './ui/settings/PracticePane.jsx';
      export { FINDER_ENTRIES } from './ui/finder/entries.js';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { ENGLISH_SOURCES, mergeCatalogues, setUiLanguage, ui, uiCatalogue } from './ui/i18n.js';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom', 'dompurify'],
  plugins: [nativeSelects],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});
const noopPurify = { sanitize: (v) => String(v ?? '') };
const load = (requireFn) => {
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(requireFn, mod, mod.exports);
  return mod.exports;
};
const withDomPurify = (requireFn) => (name) => (name === 'dompurify' ? { __esModule: true, default: noopPurify, ...noopPurify } : requireFn(name));
const uiMod = load(withDomPurify(require));
Object.assign(uiMod.uiCatalogue(), uiMod.mergeCatalogues(uiMod.ENGLISH_SOURCES).catalogue);
const hooklessSsr = load(withDomPurify((name) => (name === 'react'
  ? {
    ...React,
    useMemo: (calc) => calc(),
    useId: () => 'id-notes-1',
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useCallback: (cb) => cb,
    useRef: (v) => ({ current: v }),
    useContext: (ctx) => ctx?._currentValue,
    useEffect: () => {},
    useLayoutEffect: () => {},
    useInsertionEffect: () => {},
    useDeferredValue: (v) => v,
  }
  : require(name))));

const h = React.createElement;
const noop = () => {};
const han = /\p{Script=Han}/u;
const textOf = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function mountSync(services) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = [];
  let cursor = 0;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return {
    render(Component, props) {
      cursor = 0;
      const prev = internals.H;
      internals.H = {
        useContext: (ctx) => (ctx === uiMod.StudyServicesContext ? services : ctx._currentValue),
        useState: (init) => {
          const i = cursor++;
          if (!(i in hooks)) hooks[i] = [typeof init === 'function' ? init() : init, (val) => {
            hooks[i][0] = typeof val === 'function' ? val(hooks[i][0]) : val;
          }];
          return hooks[i];
        },
        useRef: (init) => { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
        useMemo: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
        useCallback: (fn, deps) => internals.H.useMemo(() => fn, deps),
        useEffect: () => { cursor++; },
        useLayoutEffect: () => { cursor++; },
        useInsertionEffect: () => { cursor++; },
        useId: () => { const i = cursor++; if (!(i in hooks)) hooks[i] = `:n${i}:`; return hooks[i]; },
        useDeferredValue: (v) => v,
        useSyncExternalStore: (_sub, getSnap) => getSnap(),
      };
      let tree;
      try { tree = Component(props); } finally { internals.H = prev; }
      return tree;
    },
    unmount() {},
  };
}

function walkTree(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walkTree(child, visit); return; }
  if (node.props) {
    visit(node);
    walkTree(node.props.children, visit);
  }
}

function nodeText(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  return node.props ? nodeText(node.props.children) : '';
}

test('Study notes practice bridge flag (notesPracticeBridge) merges, normalizes, and validates strictly', () => {
  const baselineKeys = ['autopilot', 'roundSize', 'newCardOrder', 'debrief', 'rereadMarks', 'leechFailures', 'leechWindow', 'leechRate'];
  assert.deepEqual(Object.keys(PRACTICE_DEFAULTS), baselineKeys);
  assert.deepEqual(Object.keys(resolvePracticeSettings(undefined)), baselineKeys);
  assert.equal(notesPracticeBridge(undefined), false);

  assert.equal('notesPracticeBridge' in normalizePracticeSettings({ notesPracticeBridge: false }), false);
  const enabled = mergePracticeSettings(undefined, { notesPracticeBridge: true });
  assert.equal(enabled.notesPracticeBridge, true);
  assert.equal(notesPracticeBridge(enabled), true);

  const cleared = mergePracticeSettings(enabled, { notesPracticeBridge: null });
  assert.equal('notesPracticeBridge' in cleared, false);
  assert.equal(notesPracticeBridge(cleared), false);

  assert.deepEqual(validatePracticePatch({ notesPracticeBridge: true }), { notesPracticeBridge: true });
  assert.throws(() => mergePracticeSettings(undefined, { notesPracticeBridge: 1 }), /notesPracticeBridge/);
});

test('notesPracticeBridge switch in PracticePane saves true/null patches and registers its Finder entry in zh and en', async () => {
  uiMod.setUiLanguage('zh');
  try {
    const input = (html, name) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? '';
    const offHtml = renderToStaticMarkup(h(uiMod.PracticePane, { data: { settings: {} }, busy: false, act: noop }));
    assert.doesNotMatch(input(offHtml, 'notesPracticeBridge'), /checked/);

    const onHtml = renderToStaticMarkup(h(uiMod.PracticePane, {
      data: { settings: { practice: { notesPracticeBridge: true } } },
      busy: false,
      act: noop,
    }));
    assert.match(input(onHtml, 'notesPracticeBridge'), /checked/);

    const entry = uiMod.FINDER_ENTRIES.find((item) => item.id === 'notes-practice-bridge');
    assert.ok(entry);
    assert.equal(entry.area, 'practice');
    assert.equal(entry.page, 'settings');
    assert.deepEqual(entry.anchors, ['settings-practice']);

    const mountPracticePane = ({ fail = false, practice = {} } = {}) => {
      const calls = [];
      const host = mountSync({ host: { capabilities: { chat: true } } });
      const data = { settings: Object.keys(practice).length ? { practice } : {} };
      const act = async (action, args, after, options) => {
        calls.push([action, args, options]);
        if (fail) throw new Error('save failed');
        const result = { ...PRACTICE_DEFAULTS, ...args.patch };
        await after?.(result, { isCurrent: () => true });
        return result;
      };
      const renderPane = () => host.render(uiMod.PracticePane, { data, busy: false, act });
      const findInPane = (predicate) => {
        let found = null;
        walkTree(renderPane(), (node) => { if (!found && predicate(node)) found = node; });
        return found;
      };
      return {
        calls,
        getToggle: () => findInPane((node) => node.props?.name === 'notesPracticeBridge'),
        getAlert: () => findInPane((node) => node.props?.role === 'alert'),
      };
    };

    const okPane = mountPracticePane();
    assert.equal(okPane.getToggle().props.checked, false);
    await okPane.getToggle().props.onChange(true);
    assert.deepEqual(okPane.calls[0].slice(0, 2), ['settings.practice.set', { patch: { notesPracticeBridge: true } }]);
    assert.equal(okPane.calls[0][2]?.rethrow, true);
    assert.equal(okPane.getToggle().props.checked, true);

    await okPane.getToggle().props.onChange(false);
    assert.deepEqual(okPane.calls[1].slice(0, 2), ['settings.practice.set', { patch: { notesPracticeBridge: null } }]);
    assert.equal(okPane.getToggle().props.checked, false);

    const failOn = mountPracticePane({ fail: true });
    await failOn.getToggle().props.onChange(true);
    assert.equal(failOn.calls.length, 1);
    assert.deepEqual(failOn.calls[0].slice(0, 2), ['settings.practice.set', { patch: { notesPracticeBridge: true } }]);
    assert.equal(failOn.getToggle().props.checked, false, 'a failed enable rolls notesPracticeBridge back to saved false');
    assert.match(nodeText(failOn.getAlert()), /save failed/, 'a failed enable surfaces the error alert');

    const failOff = mountPracticePane({ fail: true, practice: { notesPracticeBridge: true } });
    assert.equal(failOff.getToggle().props.checked, true);
    await failOff.getToggle().props.onChange(false);
    assert.equal(failOff.calls.length, 1);
    assert.deepEqual(failOff.calls[0].slice(0, 2), ['settings.practice.set', { patch: { notesPracticeBridge: null } }]);
    assert.equal(failOff.getToggle().props.checked, true, 'a failed disable rolls notesPracticeBridge back to saved true');
    assert.match(nodeText(failOff.getAlert()), /save failed/, 'a failed disable surfaces the error alert');

    uiMod.setUiLanguage('en');
    const enHtml = renderToStaticMarkup(h(uiMod.PracticePane, { data: { settings: {} }, busy: false, act: noop }));
    assert.doesNotMatch(textOf(enHtml), han);
    assert.match(enHtml, /Practise linked questions straight from Study notes/);
    assert.doesNotMatch(uiMod.ui(entry.title), han);
    assert.doesNotMatch(uiMod.ui(entry.what), han);
  } finally {
    uiMod.setUiLanguage('zh');
  }
});

test('buildNotePracticeScope deduplicates refs, skips missing & archived decks, and filters list items', () => {
  const note = {
    cards: [
      { deckId: 'd1', cardId: 'c1', prompt: 'Q1' },
      { deckId: 'd1', cardId: 'c1', prompt: 'Q1 dup' },
      { deckId: 'd1', cardId: 'c2', prompt: 'Missing', missing: true },
      { deckId: 'd-arch', cardId: 'c3', prompt: 'Archived deck question' },
      { deckId: 'd2', cardId: 'c4', prompt: 'Q4' },
    ],
  };
  const decks = [{ id: 'd1', archived: false }, { id: 'd-arch', archived: true }, { id: 'd2' }];
  const plan = buildNotePracticeScope(note, decks);
  assert.deepEqual(plan.scope, [{ deckId: 'd1', cardId: 'c1' }, { deckId: 'd2', cardId: 'c4' }]);
  assert.equal(plan.totalLinked, 5);
  assert.equal(plan.skippedCount, 3);

  const many = { cards: Array.from({ length: MAX_NOTE_PRACTICE_SCOPE + 10 }, (_, idx) => ({ deckId: 'd1', cardId: `c-${idx}` })) };
  assert.equal(buildNotePracticeScope(many, decks).scope.length, MAX_NOTE_PRACTICE_SCOPE);

  const list = [
    { id: 'n1', cardCount: 2 },
    { id: 'n2', cardCount: 0 },
    { id: 'dr', kind: 'daily-recap', daily: { answeredCount: 10 }, cardCount: 0 },
  ];
  assert.equal(noteLinkedCount(list[2]), 10);
  assert.equal(countNotesWithCards(list), 2);
  assert.deepEqual(filterNotesWithCards(list, true).map((n) => n.id), ['n1', 'dr']);
  assert.equal(filterNotesWithCards(list, false).length, 3);
});

test('BlogNotes keeps baseline unchanged when off, and shows filter +整套开练 bar when enabled', () => {
  const services = { call: async () => ({}), act: noop, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
  const notesList = [
    { id: 'n-linked', title: 'Linked note', status: 'draft', cardCount: 2, courses: ['Physics'], updatedAt: '2026-11-18T02:00:00Z' },
    { id: 'n-empty', title: 'Plain reflection', status: 'draft', cardCount: 0, courses: ['Physics'], updatedAt: '2026-11-18T01:00:00Z' },
  ];
  const openNote = {
    id: 'n-linked',
    title: 'Linked note',
    status: 'draft',
    markdown: '# Entropy\n\nSummary notes.',
    cards: [
      { deckId: 'd1', cardId: 'c1', prompt: 'First question' },
      { deckId: 'd1', cardId: 'c2', prompt: 'Second question' },
      { deckId: 'd-arch', cardId: 'c3', prompt: 'Archived' },
    ],
    revision: 1,
  };
  const decks = [{ id: 'd1', title: 'Thermo', archived: false }, { id: 'd-arch', title: 'Old', archived: true }];
  const offData = { root: 'lib', focus: { course: '*', courses: [] }, notes: notesList, decks, sources: [], settings: { practice: {} } };
  const onData = { ...offData, settings: { practice: { notesPracticeBridge: true } } };

  uiMod.setUiLanguage('zh');
  try {
    // 1. Default OFF: no filter toggle & no practice bar
    const offListHtml = renderToStaticMarkup(h(uiMod.StudyServicesContext.Provider, { value: services },
      h(hooklessSsr.BlogNotes, { data: offData })));
    assert.doesNotMatch(offListHtml, /只看含关联题/);

    const offDetailHtml = renderToStaticMarkup(h(uiMod.StudyServicesContext.Provider, { value: services },
      h(uiMod.BlogNotes, { data: offData, initialId: openNote.id, initialNote: openNote, onPracticeCards: noop })));
    assert.doesNotMatch(offDetailHtml, /note-practice-bar|练这 2 道关联题/);

    // 2. Opt-in ON: list shows filter toggle and switches visible list
    const listApp = mountSync(services);
    let tree = listApp.render(uiMod.BlogNotes, { data: onData });
    let filterBtn = null;
    walkTree(tree, (n) => {
      if (!filterBtn && typeof n.type !== 'string' && typeof n.props?.onClick === 'function' && nodeText(n).includes('只看含关联题 (1)')) {
        filterBtn = n;
      }
    });
    assert.ok(filterBtn);
    assert.equal(filterBtn.props['aria-pressed'], false);
    const onListHtmlBefore = renderToStaticMarkup(h(uiMod.StudyServicesContext.Provider, { value: services }, tree));
    assert.match(onListHtmlBefore, /Plain reflection/);
    filterBtn.props.onClick();
    tree = listApp.render(uiMod.BlogNotes, { data: onData });
    const onListHtmlFiltered = renderToStaticMarkup(h(uiMod.StudyServicesContext.Provider, { value: services }, tree));
    assert.match(onListHtmlFiltered, /Linked note/);
    assert.doesNotMatch(onListHtmlFiltered, /Plain reflection/);
    listApp.unmount();

    // 3. Opt-in ON: note reader renders .note-practice-bar, skips archived card, and launches practise round on click
    const startedScopes = [];
    const detailApp = mountSync(services);
    const detailTree = detailApp.render(uiMod.BlogNotes, {
      data: onData,
      initialId: openNote.id,
      initialNote: openNote,
      onPracticeCards: (scope) => startedScopes.push(scope),
    });
    const detailHtml = renderToStaticMarkup(h(uiMod.StudyServicesContext.Provider, { value: services }, detailTree));
    assert.match(detailHtml, /class="note-practice-bar"/);
    assert.match(detailHtml, /这篇笔记关联了 2 道可练原题/);
    assert.match(detailHtml, /另有 1 道已失效或归档，已自动跳过/);
    assert.match(detailHtml, /练这 2 道关联题/);

    let practiseBtn = null;
    walkTree(detailTree, (n) => {
      if (!practiseBtn && typeof n.type !== 'string' && typeof n.props?.onClick === 'function' && nodeText(n).includes('练这 2 道关联题')) {
        practiseBtn = n;
      }
    });
    assert.ok(practiseBtn);
    assert.equal(practiseBtn.props.iconEnd, 'arrow-right');
    practiseBtn.props.onClick();
    assert.deepEqual(startedScopes, [[{ deckId: 'd1', cardId: 'c1' }, { deckId: 'd1', cardId: 'c2' }]]);

    // 4. English UI: zero Han strings leaked
    uiMod.setUiLanguage('en');
    const enListHtml = renderToStaticMarkup(h(uiMod.StudyServicesContext.Provider, { value: services },
      h(uiMod.BlogNotes, { data: { ...onData, notes: [{ id: 'n1', title: 'Note A', status: 'draft', cardCount: 2 }, { id: 'n2', title: 'Note B', status: 'draft', cardCount: 0 }] } })));
    assert.doesNotMatch(textOf(enListHtml), han);
    assert.match(textOf(enListHtml), /With linked questions \(1\)/);

    const enDetailHtml = renderToStaticMarkup(h(uiMod.StudyServicesContext.Provider, { value: services },
      h(uiMod.BlogNotes, { data: onData, initialId: openNote.id, initialNote: openNote, onPracticeCards: noop })));
    assert.doesNotMatch(textOf(enDetailHtml), han);
    assert.match(textOf(enDetailHtml), /Practise these 2 linked questions/);
    assert.match(textOf(enDetailHtml), /1 unavailable or archived question was skipped/);
    detailApp.unmount();
  } finally {
    uiMod.setUiLanguage('zh');
  }
});
