import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadInteractiveUi } from './helpers/react-harness.mjs';

import {
  PRACTICE_DEFAULTS,
  mergePracticeSettings,
  readerDoubtLedger,
  resolvePracticeSettings,
  validatePracticePatch,
} from '../lib/practice-settings.js';
import { createThreadMemory } from '../ui/document-preview/thread-memory.js';
import { collectReaderDoubts } from '../ui/document-preview/doubt-ledger.js';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `export { default as PracticePane } from './ui/settings/PracticePane.jsx';
      export { FINDER_ENTRIES } from './ui/finder/entries.js';
      export { LearningPanel } from './ui/document-preview/DocumentLearning.jsx';
      export { default as DoubtLedger } from './ui/document-preview/DoubtLedger.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { ENGLISH_SOURCES, mergeCatalogues, setUiLanguage, ui, uiCatalogue, uiFormat } from './ui/i18n.js';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
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

const h = React.createElement;
const noop = () => {};
const han = /\p{Script=Han}/u;
const textOf = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const english = (fn) => {
  ssr.setUiLanguage('en');
  try { return fn(); } finally { ssr.setUiLanguage('zh'); }
};

function renderWithHooks() {
  const active = { cursor: 0, slots: [], effects: [] };
  const hook = (init) => {
    const i = active.cursor++;
    if (!(i in active.slots)) active.slots[i] = typeof init === 'function' ? init() : init;
    return [i, active.slots[i]];
  };
  const mockReact = {
    ...React,
    useState: (init) => {
      const [i, val] = hook(init);
      return [val, (next) => { active.slots[i] = typeof next === 'function' ? next(active.slots[i]) : next; }];
    },
    useMemo: (calc, deps) => {
      const i = active.cursor++;
      const slot = active.slots[i];
      const same = slot && Array.isArray(deps) && Array.isArray(slot.deps) && deps.length === slot.deps.length
        && deps.every((v, idx) => Object.is(v, slot.deps[idx]));
      if (!same) active.slots[i] = { deps, value: calc() };
      return active.slots[i].value;
    },
    useCallback: (cb, deps) => mockReact.useMemo(() => cb, deps),
    useRef: (init) => hook(() => ({ current: init }))[1],
    useContext: (ctx) => (ctx === ssr.StudyServicesContext ? { call: async () => ({}), busy: false, notify: noop } : ctx?._currentValue ?? null),
    useId: () => `id-${active.cursor++}`,
    useEffect: (cb, deps) => {
      const i = active.cursor++;
      const slot = active.slots[i] || { deps: undefined, cleanup: null };
      active.slots[i] = slot;
      if (!slot.deps || !deps || deps.some((v, idx) => !Object.is(v, slot.deps[idx]))) {
        active.effects.push(() => { slot.cleanup?.(); slot.cleanup = cb(); });
        slot.deps = deps;
      }
    },
    useLayoutEffect: () => { active.cursor++; },
    useInsertionEffect: () => { active.cursor++; },
    useDeferredValue: (v) => v,
  };
  const live = load((name) => (name === 'react' ? mockReact : require(name)));
  return {
    render: (fn) => {
      active.cursor = 0;
      const out = fn(live);
      while (active.effects.length) active.effects.shift()();
      return out;
    },
  };
}

function collectNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => collectNodes(n, pred, out)); return out; }
  if (pred(node)) out.push(node);
  collectNodes(node.props?.children, pred, out);
  return out;
}

test('lib/practice-settings preserves PRACTICE_DEFAULTS and manages optional readerDoubtLedger', () => {
  const baselineKeys = ['autopilot', 'roundSize', 'newCardOrder', 'debrief', 'rereadMarks', 'leechFailures', 'leechWindow', 'leechRate'];
  assert.deepEqual(Object.keys(PRACTICE_DEFAULTS), baselineKeys);
  assert.deepEqual(Object.keys(resolvePracticeSettings(undefined)), baselineKeys);
  assert.equal(readerDoubtLedger(undefined), false);

  const enabled = mergePracticeSettings(undefined, { readerDoubtLedger: true });
  assert.equal(enabled.readerDoubtLedger, true);
  assert.equal(readerDoubtLedger(enabled), true);

  const cleared = mergePracticeSettings(enabled, { readerDoubtLedger: null });
  assert.equal('readerDoubtLedger' in cleared, false);
  assert.equal(readerDoubtLedger(cleared), false);

  assert.deepEqual(validatePracticePatch({ readerDoubtLedger: true }), { readerDoubtLedger: true });
  assert.throws(() => mergePracticeSettings(undefined, { readerDoubtLedger: 'on' }), /readerDoubtLedger/);
});

test('PracticePane and Finder expose opt-in readerDoubtLedger switch with English copy', async () => {
  ssr.setUiLanguage('zh');
  const offHtml = renderToStaticMarkup(h(ssr.PracticePane, { data: { settings: {} }, busy: false, act: noop }));
  const input = (html, name) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? '';
  assert.doesNotMatch(input(offHtml, 'readerDoubtLedger'), /checked/);

  const onHtml = renderToStaticMarkup(h(ssr.PracticePane, {
    data: { settings: { practice: { readerDoubtLedger: true } } },
    busy: false,
    act: noop,
  }));
  assert.match(input(onHtml, 'readerDoubtLedger'), /checked/);

  const entry = ssr.FINDER_ENTRIES.find((item) => item.id === 'reader-doubt-ledger');
  assert.ok(entry);
  assert.equal(entry.area, 'material');

  const interactive = await loadInteractiveUi(`
    export { default as PracticePane } from './ui/settings/PracticePane.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  interactive.exports.setUiLanguage('zh');
  const calls = [];
  const act = async (action, args) => {
    calls.push([action, args]);
    return { ok: true };
  };
  const mounted = interactive.mount(() => interactive.React.createElement(
    interactive.exports.StudyServicesContext.Provider,
    { value: { openSettings: noop, host: { capabilities: { chat: true } } } },
    interactive.React.createElement(interactive.exports.PracticePane, {
      data: { settings: {} },
      busy: false,
      act,
    }),
  ));
  try {
    const findSwitch = () => mounted.find((node) => node.type === 'input' && node.props?.name === 'readerDoubtLedger');
    const initialToggle = findSwitch();
    assert.ok(initialToggle, 'readerDoubtLedger switch mounts in PracticePane');
    assert.equal(initialToggle.props.checked, false);

    await mounted.act(() => initialToggle.props.onChange({ target: { checked: true } }));
    assert.deepEqual(calls[0], ['settings.practice.set', { patch: { readerDoubtLedger: true } }]);
    assert.equal(findSwitch()?.props.checked, true);

    await mounted.act(() => findSwitch().props.onChange({ target: { checked: false } }));
    assert.deepEqual(calls[1], ['settings.practice.set', { patch: { readerDoubtLedger: null } }]);
    assert.equal(findSwitch()?.props.checked, false);
  } finally {
    mounted.unmount();
  }

  english(() => {
    const enHtml = renderToStaticMarkup(h(ssr.PracticePane, { data: { settings: {} }, busy: false, act: noop }));
    assert.doesNotMatch(textOf(enHtml), han);
    assert.match(enHtml, /Show document doubt ledger when no text is selected/);
    assert.doesNotMatch(textOf(ssr.ui(entry.title)), han);
    assert.doesNotMatch(textOf(ssr.ui(entry.what)), han);
  });
});

test('thread-memory.entries and collectReaderDoubts merge session Q&As with kept annotations without duplicating', () => {
  const mem = createThreadMemory();
  const sel1 = { sourceId: 's1', start: 0, end: 18, quote: 'Page replacement.' };
  const sel2 = { sourceId: 's1', start: 30, end: 52, quote: 'Belady anomaly case.' };
  mem.remember('s1:0-18', {
    nodes: [
      { id: 'n1', question: 'Why LRU stacks?', answer: 'Because stack property prevents Belady anomaly.', status: 'answered' },
      { id: 'n-kept', question: 'Already annotated?', answer: 'Yes stored in annotations.', status: 'answered' },
      { id: 'n-fail', question: 'Failed ask?', answer: '', status: 'failed' },
    ],
  }, new Set(), sel1);
  mem.remember('page|s1:1', {
    nodes: [{ id: 'p1', question: 'Page Q', answer: 'Should skip page| entries', status: 'answered' }],
  }, new Set(), { sourceId: 's1', page: 1 });

  const doubts = collectReaderDoubts({
    annotationItems: [
      { id: 'n-kept', key: 's1:0-18', question: 'Already annotated?', answer: 'Yes stored in annotations.', selection: sel1, status: 'resolved' },
      { id: 'a2', key: 's1:30-52', question: 'When does Belady happen?', answer: 'FIFO on certain access patterns.', selection: sel2, status: 'resolved' },
      { id: 'a-stale', key: 's1:60-70', question: 'Stale note', answer: 'Old answer', status: 'stale' },
    ],
    heldEntries: mem.entries(),
  });

  assert.deepEqual(doubts.map((d) => [d.id, d.kept]), [
    ['n1', false],
    ['n-kept', true],
    ['a2', true],
  ]);
  assert.equal(doubts[0].quote, 'Page replacement.');
  assert.equal(doubts[2].quote, 'Belady anomaly case.');

  // Cross-key normalization (heldKey with trailing quote vs passageKey without quote) + sibling follow-up preservation
  const mem2 = createThreadMemory();
  mem2.remember('s1|0|18|Page replacement.', {
    nodes: [
      { id: 'r1', parentId: null, question: 'Why LRU?', answer: 'Stack property.', status: 'answered' },
      { id: 'r2', parentId: null, question: 'When Belady?', answer: 'FIFO anomaly.', status: 'answered' },
      { id: 'c1', parentId: 'r1', label: '举个例子', question: 'Give an example.', answer: 'LRU 3 frames.', status: 'answered' },
      { id: 'c2', parentId: 'r2', label: '举个例子', question: 'Give an example.', answer: 'FIFO 1-2-3-4.', status: 'answered' },
      { id: 'dup-diff-id', parentId: null, question: 'Kept same Q?', answer: 'Should dedup against passageKey.', status: 'answered' },
    ],
  }, new Set(), sel1);
  const richDoubts = collectReaderDoubts({
    annotationItems: [
      { id: 'kept-id', key: 's1|0|18', question: 'Kept same Q?', answer: 'Kept canonical.', selection: sel1, status: 'resolved' },
    ],
    heldEntries: mem2.entries(),
  });
  assert.deepEqual(richDoubts.map((d) => d.id), ['r1', 'r2', 'c1', 'c2', 'kept-id']);
  assert.equal(richDoubts.find((d) => d.id === 'c1')?.trail, 'Why LRU?');
  assert.equal(richDoubts.find((d) => d.id === 'c2')?.trail, 'When Belady?');
});

test('LearningPanel keeps off-parity when disabled and DoubtLedger supports veil toggle, reveal, jump, card save, and English UI', () => {
  const sel = { sourceId: 's1', start: 0, end: 22, quote: 'Critical section invariant.' };
  const doubts = [
    { id: 'd1', key: 's1:0-22', question: 'Why mutex?', answer: 'Ensures **mutual exclusion** [[mutex|Mutex]].', quote: sel.quote, selection: sel, kept: false },
    { id: 'd2', key: 's1:30-50', question: 'Kept note?', answer: 'Yes, stored.', quote: 'Semaphore count.', selection: { ...sel, start: 30, end: 50, quote: 'Semaphore count.' }, kept: true },
  ];
  const basePanelProps = {
    capture: null,
    jobs: [],
    call: async () => ({}),
    decks: [{ id: 'deck-1', title: 'OS Notes' }],
    saveReady: true,
    doubts,
    onSelectDoubt: noop,
    onOpenCard: noop,
  };

  ssr.setUiLanguage('zh');
  const offHtml = renderToStaticMarkup(h(ssr.StudyServicesContext.Provider, { value: { call: async () => ({}), busy: false } },
    h(ssr.LearningPanel, { ...basePanelProps, doubtLedgerOn: false }),
  ));
  assert.doesNotMatch(offHtml, /data-doubt-ledger|遮住答案自测/);

  const onHtml = renderToStaticMarkup(h(ssr.StudyServicesContext.Provider, { value: { call: async () => ({}), busy: false } },
    h(ssr.LearningPanel, { ...basePanelProps, doubtLedgerOn: true }),
  ));
  assert.match(onHtml, /data-doubt-ledger/);
  assert.match(textOf(onHtml), /本文疑问 \(2\)/);
  assert.match(textOf(onHtml), /遮住答案自测/);
  assert.match(textOf(onHtml), /Why mutex\?/);
  assert.match(textOf(onHtml), /mutual exclusion/);
  assert.match(textOf(onHtml), /存成闪卡/);

  // Interactive answer veil check: enabling veil hides answer text behind 揭晓回答 until clicked
  const harness = renderWithHooks();
  const t1 = harness.render((live) => live.DoubtLedger({ doubts, decks: basePanelProps.decks, saveReady: true, onSelectDoubt: noop }));
  const veilToggle = collectNodes(t1, (n) => n.props?.['aria-pressed'] === false && typeof n.props?.onClick === 'function')[0];
  assert.ok(veilToggle);
  veilToggle.props.onClick();

  const t2 = harness.render((live) => live.DoubtLedger({ doubts, decks: basePanelProps.decks, saveReady: true, onSelectDoubt: noop }));
  const maskedHtml = renderToStaticMarkup(t2);
  assert.match(maskedHtml, /data-doubt-masked=""/);
  assert.doesNotMatch(maskedHtml, /mutual exclusion/);
  assert.match(textOf(maskedHtml), /揭晓回答/);

  const revealBtn = collectNodes(t2, (n) => String(n.props?.children) === '揭晓回答')[0];
  assert.ok(revealBtn);
  revealBtn.props.onClick();
  const revealedHtml = renderToStaticMarkup(harness.render((live) => live.DoubtLedger({ doubts, decks: basePanelProps.decks, saveReady: true, onSelectDoubt: noop })));
  assert.match(revealedHtml, /mutual exclusion/);
  assert.match(textOf(revealedHtml), /重新遮住/);

  // Swapping to different IDs of the same length resets revealed state back to masked
  const swapped = [
    { ...doubts[0], id: 'd3', answer: 'New hidden answer three.' },
    { ...doubts[1], id: 'd4', answer: 'New hidden answer four.' },
  ];
  const swappedHtml = renderToStaticMarkup(harness.render((live) => live.DoubtLedger({ doubts: swapped, decks: basePanelProps.decks, saveReady: true, onSelectDoubt: noop })));
  assert.doesNotMatch(swappedHtml, /New hidden answer three/);

  // Without StudyServicesContext or saveCall, SaveAnswerAsCard is omitted (no standalone.call crash); with saveCall, it renders
  const noProviderHtml = renderToStaticMarkup(h(ssr.DoubtLedger, { doubts, decks: basePanelProps.decks, saveReady: true, onSelectDoubt: noop }));
  assert.doesNotMatch(textOf(noProviderHtml), /存成闪卡/);
  const explicitCallHtml = renderToStaticMarkup(h(ssr.DoubtLedger, { doubts, decks: basePanelProps.decks, saveReady: true, saveCall: async () => ({}), onSelectDoubt: noop }));
  assert.match(textOf(explicitCallHtml), /存成闪卡/);

  english(() => {
    const enHtml = renderToStaticMarkup(h(ssr.StudyServicesContext.Provider, { value: { call: async () => ({}), busy: false } },
      h(ssr.LearningPanel, { ...basePanelProps, doubtLedgerOn: true }),
    ));
    assert.doesNotMatch(textOf(enHtml), han);
    assert.match(textOf(enHtml), /Document questions \(2\)/);
    assert.match(textOf(enHtml), /Hide answers to quiz yourself/);
    assert.match(textOf(enHtml), /Jump to passage/);
    assert.match(textOf(enHtml), /Save as flashcard/);

    const enSingleHtml = renderToStaticMarkup(h(ssr.StudyServicesContext.Provider, { value: { call: async () => ({}), busy: false } },
      h(ssr.LearningPanel, { ...basePanelProps, doubts: [doubts[0]], doubtLedgerOn: true }),
    ));
    assert.doesNotMatch(textOf(enSingleHtml), han);
    assert.match(textOf(enSingleHtml), /Document question \(1\)/);
  });
});
