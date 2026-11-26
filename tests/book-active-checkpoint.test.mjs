import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';
import {
  BOOK_DEFAULTS,
  bookConfusableDrill,
  bookInlinePractice,
  mergeBookSettings,
  resolveBookSettings,
} from '../lib/book-settings.js';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `export { default as BookToc } from './ui/book/BookToc.jsx';
      export { default as PointBody } from './ui/book/PointBody.jsx';
      export { default as BookConfusables } from './ui/book/BookConfusables.jsx';
      export { default as InlineRun } from './ui/review/InlineRun.jsx';
      export { default as PracticePane } from './ui/settings/PracticePane.jsx';
      export { filterWeakTocEntries, isWeakCrunchPoint } from './ui/book/book-weak-lens.js';
      export { maskConceptNames } from './ui/book/confusable-drill.js';
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

function renderWithHooks(fn, { services = {} } = {}) {
  const active = { cursor: 0, slots: [], effects: [] };
  const hook = (init) => {
    const i = active.cursor++;
    if (!(i in active.slots)) active.slots[i] = typeof init === 'function' ? init() : init;
    return [i, active.slots[i]];
  };
  const mockReact = {
    ...React,
    useState: (init) => {
      const owner = active;
      const [i, val] = hook(init);
      return [val, (next) => { owner.slots[i] = typeof next === 'function' ? next(owner.slots[i]) : next; }];
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
    useContext: (ctx) => (ctx === ssr.StudyServicesContext ? { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, ...services } : ctx?._currentValue ?? null),
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
    live,
    render: (renderFn) => {
      active.cursor = 0;
      const tree = renderFn(live);
      return tree;
    },
    flushEffects: () => active.effects.splice(0).forEach((e) => e()),
  };
}

function collectNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => collectNodes(n, pred, out)); return out; }
  if (pred(node)) out.push(node);
  collectNodes(node.props?.children, pred, out);
  return out;
}

test('lib/book-settings keeps BOOK_DEFAULTS intact and adds optional inlinePractice and confusableDrill booleans', () => {
  assert.deepEqual(BOOK_DEFAULTS, { qaToBook: 'manual' });
  assert.deepEqual(resolveBookSettings(undefined), { qaToBook: 'manual' });
  assert.equal(bookInlinePractice(undefined), false);
  assert.equal(bookConfusableDrill(undefined), false);

  const enabled = mergeBookSettings(undefined, { inlinePractice: true, confusableDrill: true });
  assert.deepEqual(enabled, { qaToBook: 'manual', inlinePractice: true, confusableDrill: true });
  assert.equal(bookInlinePractice(enabled), true);
  assert.equal(bookConfusableDrill(enabled), true);

  const cleared = mergeBookSettings(enabled, { inlinePractice: null, confusableDrill: false });
  assert.deepEqual(cleared, { qaToBook: 'manual', confusableDrill: false });
  assert.equal(bookInlinePractice(cleared), false);
  assert.equal(bookConfusableDrill(cleared), false);

  assert.throws(() => mergeBookSettings(undefined, { inlinePractice: 'yes' }), /Invalid book setting/);
  assert.throws(() => mergeBookSettings(undefined, { confusableDrill: 1 }), /Invalid book setting/);
});

test('PracticePane renders both opt-in Review book switches off by default, saves patches via settings.book.set, and translates to English', async () => {
  ssr.setUiLanguage('zh');
  const offHtml = renderToStaticMarkup(h(ssr.PracticePane, { data: { settings: {} }, busy: false, act: noop }));
  const input = (html, name) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? '';
  assert.doesNotMatch(input(offHtml, 'bookInlinePractice'), /checked/);
  assert.doesNotMatch(input(offHtml, 'bookConfusableDrill'), /checked/);

  const onHtml = renderToStaticMarkup(h(ssr.PracticePane, {
    data: { settings: { book: { inlinePractice: true, confusableDrill: true } } },
    busy: false,
    act: noop,
  }));
  assert.match(input(onHtml, 'bookInlinePractice'), /checked/);
  assert.match(input(onHtml, 'bookConfusableDrill'), /checked/);

  const calls = [];
  const harness = renderWithHooks();
  const act = async (action, args, after) => {
    calls.push([action, args]);
    await after?.({});
    return {};
  };
  const tree = harness.render((live) => live.PracticePane({ data: { settings: {} }, busy: false, act }));
  harness.flushEffects();
  const swInline = collectNodes(tree, (n) => n.props?.name === 'bookInlinePractice')[0];
  const swConf = collectNodes(tree, (n) => n.props?.name === 'bookConfusableDrill')[0];
  await swInline.props.onChange(true);
  await swConf.props.onChange(true);
  assert.deepEqual(calls, [
    ['settings.book.set', { patch: { inlinePractice: true } }],
    ['settings.book.set', { patch: { confusableDrill: true } }],
  ]);

  english(() => {
    const enHtml = renderToStaticMarkup(h(ssr.PracticePane, { data: { settings: {} }, busy: false, act: noop }));
    assert.doesNotMatch(textOf(enHtml), han);
    assert.match(enHtml, /Weak-section filter and inline self-check/);
    assert.match(enHtml, /Confusable concept self-check/);
  });
});

test('isWeakCrunchPoint and filterWeakTocEntries exclude un-questioned or fresh points and keep ancestor headings', () => {
  assert.equal(ssr.isWeakCrunchPoint({ id: 'h-none', questions: 0, fresh: 0, weakness: 0.6, weak: 0, due: 0 }), false);
  assert.equal(ssr.isWeakCrunchPoint({ id: 'h-fresh', questions: 4, fresh: 4, weakness: 0.6, weak: 0, due: 0 }), false);
  assert.equal(ssr.isWeakCrunchPoint({ id: 'h-solid', questions: 4, fresh: 0, weakness: 0.25, weak: 0, due: 0 }), false);
  assert.equal(ssr.isWeakCrunchPoint({ id: 'h-weak', questions: 4, fresh: 1, weakness: 0.3, weak: 1, due: 0 }), true);
  assert.equal(ssr.isWeakCrunchPoint({ id: 'h-due', questions: 4, fresh: 0, weakness: 0.2, weak: 0, due: 2 }), true);
  assert.equal(ssr.isWeakCrunchPoint({ id: 'h-learning', questions: 4, fresh: 1, weakness: 0.5, weak: 0, due: 0 }), true);

  const entries = [
    { id: 'c1', level: 2, title: '1 Foundations', chapter: 'c1' },
    { id: 'p1', level: 3, title: '1.1 No questions', chapter: 'c1' },
    { id: 's1', level: 3, title: '1.2 Section A', chapter: 'c1' },
    { id: 'p2', level: 4, title: '1.2.1 Deadlock', chapter: 'c1' },
    { id: 'c2', level: 2, title: '2 Scheduling', chapter: 'c2' },
    { id: 'p3', level: 3, title: '2.1 Mastered', chapter: 'c2' },
  ];
  const points = [
    { id: 'p1', questions: 0, fresh: 0, weakness: 0.6, weak: 0, due: 0 },
    { id: 'p2', questions: 3, fresh: 1, weakness: 0.8, weak: 2, due: 0 },
    { id: 'p3', questions: 5, fresh: 0, weakness: 0.1, weak: 0, due: 0 },
  ];
  const filtered = ssr.filterWeakTocEntries(entries, points);
  assert.equal(filtered.weakCount, 1);
  assert.deepEqual(filtered.entries.map((e) => e.id), ['c1', 's1', 'p2']);

  ssr.setUiLanguage('zh');
  const tocOff = renderToStaticMarkup(h(ssr.BookToc, { entries, here: 'p1', onGo: noop, coverage: null }));
  assert.doesNotMatch(tocOff, /薄弱节|book-toc__lens/);

  const tocLoading = renderToStaticMarkup(h(ssr.BookToc, { entries, here: 'p1', onGo: noop, coverage: null, showWeakLens: true, weakPoints: null }));
  assert.match(tocLoading, /book-toc__lens/, 'weak lens slot mounts immediately before book.crunch resolves to prevent late layout shift');
  assert.match(textOf(tocLoading), /全部 薄弱节/);

  const tocOn = renderToStaticMarkup(h(ssr.BookToc, { entries, here: 'p1', onGo: noop, coverage: null, showWeakLens: true, weakPoints: points }));
  assert.match(tocOn, /book-toc__lens/);
  assert.match(textOf(tocOn), /全部 薄弱节 \(1\)/);

  // Switch TOC lens interactively to 'weak'
  const tocHarness = renderWithHooks();
  const t1 = tocHarness.render((live) => live.BookToc({ entries, here: 'p1', onGo: noop, coverage: null, weakPoints: points }));
  const seg = collectNodes(t1, (n) => typeof n.props?.onChange === 'function' && n.props?.value === 'all')[0];
  assert.ok(seg);
  seg.props.onChange('weak');
  const t2 = tocHarness.render((live) => live.BookToc({ entries, here: 'p1', onGo: noop, coverage: null, weakPoints: points }));
  const listNode = collectNodes(t2, (n) => Array.isArray(n.props?.entries) && n.props.entries.length === 3)[0];
  assert.ok(listNode, 'switching lens renders the 3 filtered entries including chapter & parent section');

  english(() => {
    const enLoading = renderToStaticMarkup(h(ssr.BookToc, { entries, here: 'p1', onGo: noop, coverage: null, showWeakLens: true, weakPoints: null }));
    assert.doesNotMatch(textOf(enLoading), han);
    assert.match(textOf(enLoading), /All Weak/);
    const enToc = renderToStaticMarkup(h(ssr.BookToc, { entries, here: 'p1', onGo: noop, coverage: null, weakPoints: points }));
    assert.doesNotMatch(textOf(enToc), han);
    assert.match(textOf(enToc), /All Weak \(1\)/);
  });
});

test('PointBody renders 合书自测 only when inlineCheck handler is supplied, mounts InlineRun cleanly, and useStepKeys ignores arrows inside [data-inline-run] and [role="dialog"]', async () => {
  // Behavioral verification of useStepKeys keyboard guarding with real DOM ancestry.
  const readingUi = await loadInteractiveUi(`export { useStepKeys } from './ui/book/reading.js';`);
  const matchesSimple = (el, sel) => {
    const trimmed = sel.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('.')) return (el.classes || []).includes(trimmed.slice(1));
    const attrEq = /^\[([^=\]]+)="([^"]*)"\]$/.exec(trimmed);
    if (attrEq) return el.attrs?.[attrEq[1]] === attrEq[2];
    const attrOnly = /^\[([^=\]]+)\]$/.exec(trimmed);
    if (attrOnly) return Object.hasOwn(el.attrs || {}, attrOnly[1]);
    return el.tag === trimmed.toLowerCase();
  };
  const makeEl = (tag, { attrs = {}, classes = [], parent = null } = {}) => {
    const el = {
      tag: tag.toLowerCase(),
      attrs,
      classes,
      parentElement: parent,
      closest(selectorList) {
        const selectors = selectorList.split(',');
        for (let cur = el; cur; cur = cur.parentElement) {
          if (selectors.some((s) => matchesSimple(cur, s))) return cur;
        }
        return null;
      },
    };
    return el;
  };

  const bodyEl = makeEl('main');
  const readingParagraph = makeEl('p', { parent: bodyEl });
  const inlineRunEl = makeEl('div', { attrs: { 'data-inline-run': '' }, parent: bodyEl });
  const inlineOptionBtn = makeEl('button', { parent: inlineRunEl });
  const dialogEl = makeEl('div', { attrs: { role: 'dialog' }, parent: bodyEl });
  const dialogActionBtn = makeEl('button', { parent: dialogEl });

  const keyListeners = new Set();
  const dispatchArrow = (key, target) => {
    const event = {
      key,
      target,
      defaultPrevented: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    for (const listener of [...keyListeners]) listener(event);
    return event;
  };

  await withBrowserGlobals(async () => {
    const moves = [];
    const hook = readingUi.mountHook(
      ({ on }) => readingUi.exports.useStepKeys(on, (delta) => moves.push(delta)),
      { on: true },
    );
    try {
      assert.equal(keyListeners.size, 1, 'useStepKeys attaches keydown listener when active');

      // Inside [data-inline-run]: arrows must NOT step the book.
      assert.equal(dispatchArrow('ArrowLeft', inlineOptionBtn).defaultPrevented, false);
      assert.equal(dispatchArrow('ArrowRight', inlineOptionBtn).defaultPrevented, false);
      assert.deepEqual(moves, [], 'arrows inside [data-inline-run] do not call go()');

      // Inside [role="dialog"]: arrows must NOT step the book.
      assert.equal(dispatchArrow('ArrowLeft', dialogActionBtn).defaultPrevented, false);
      assert.equal(dispatchArrow('ArrowRight', dialogActionBtn).defaultPrevented, false);
      assert.deepEqual(moves, [], 'arrows inside [role="dialog"] do not call go()');

      // Ordinary reading body: ArrowLeft calls go(-1) and ArrowRight calls go(+1).
      assert.equal(dispatchArrow('ArrowLeft', readingParagraph).defaultPrevented, true);
      assert.equal(dispatchArrow('ArrowRight', readingParagraph).defaultPrevented, true);
      assert.deepEqual(moves, [-1, 1], 'arrows on ordinary reading content step -1 / +1');
    } finally {
      hook.unmount();
    }
    assert.equal(keyListeners.size, 0, 'unmounting removes keydown listener');
    dispatchArrow('ArrowRight', readingParagraph);
    assert.deepEqual(moves, [-1, 1], 'no further navigation after unmount');
  }, {
    window: {
      addEventListener: (type, fn) => { if (type === 'keydown') keyListeners.add(fn); },
      removeEventListener: (type, fn) => { if (type === 'keydown') keyListeners.delete(fn); },
    },
  });

  const node = {
    hid: 'h2',
    key: 'bk:p1',
    title: 'Deadlock',
    number: '1.1',
    gen: 'Mutual exclusion and hold-and-wait.',
    mine: '',
    questionTotal: 2,
    questions: [{ deckId: 'd1', cardId: 'q1', prompt: 'Q1?' }],
  };
  const baseHandlers = {
    gone: new Set(),
    qaOpen: () => false,
    toggleQa: noop,
    source: noop,
    card: noop,
    practice: noop,
    create: noop,
  };
  ssr.setUiLanguage('zh');
  const offHtml = renderToStaticMarkup(h(ssr.StudyServicesContext.Provider, {
    value: { call: async () => ({}), busy: false, notify: noop },
  }, h(ssr.PointBody, { node, course: 'OS', handlers: baseHandlers })));
  assert.doesNotMatch(offHtml, /合书自测|inline-practice/);

  const FakeInline = ({ label, shown }) => h('div', { 'data-fake-inline': label, 'data-fake-shown': String(shown), 'data-book-inline-answering': '' }, label);
  const onHandlers = {
    ...baseHandlers,
    inlineCheck: noop,
    inlineShown: false,
    inlineOpen: (hid) => hid === 'h2',
    inlineRunFor: (hid) => (hid === 'h2' ? { started: { id: 'run-1', total: 2 }, label: 'Deadlock · 2 道题', origin: null } : null),
    closeInlineRun: noop,
    InlineRun: FakeInline,
  };
  const onHtml = renderToStaticMarkup(h(ssr.StudyServicesContext.Provider, {
    value: { call: async () => ({}), busy: false, notify: noop },
  }, h(ssr.PointBody, { node, course: 'OS', handlers: onHandlers })));
  assert.match(onHtml, /收起自测/);
  assert.match(onHtml, /data-fake-inline="Deadlock · 2 道题"/);
  assert.match(onHtml, /data-fake-shown="false"/);

  // Confirm InlineRun supports custom backLabel and translates 收起自测 & {0} · {1} 道题 in English
  english(() => {
    assert.equal(ssr.uiFormat('{0} · {1} 道题', ['Deadlock', 1]), 'Deadlock · 1 question');
    assert.equal(ssr.uiFormat('{0} · {1} 道题', ['Deadlock', 2]), 'Deadlock · 2 questions');
    const inlineHtml = renderToStaticMarkup(h(ssr.StudyServicesContext.Provider, {
      value: { busy: false },
    }, h(ssr.InlineRun, {
      session: { run: null, entry: {}, actions: {} },
      label: ssr.uiFormat('{0} · {1} 道题', ['Deadlock', 2]),
      rootRef: { current: null },
      onClose: noop,
      backLabel: ssr.ui('收起自测'),
    })));
    assert.doesNotMatch(textOf(inlineHtml), han);
    assert.match(textOf(inlineHtml), /Hide check/);
    assert.match(textOf(inlineHtml), /Deadlock · 2 questions/);
  });
});

test('maskConceptNames and BookConfusables self-check mask headers, data-head, and cells safely before reveal', () => {
  assert.equal(
    ssr.maskConceptNames('Class A uses an array and Mutex locks A over B.', ['A', 'Mutex', 'B']),
    'Class ___ uses an array and ___ locks ___ over ___.',
  );
  assert.equal(
    ssr.maskConceptNames('(foo) bar extends (foo) barbie.', ['(foo) bar']),
    '___ extends (foo) barbie.',
  );
  assert.equal(
    ssr.maskConceptNames('缓存和缓存一致性不同于缓冲。', ['缓存', '缓存一致性', '缓冲']),
    '___和___不同于___。',
  );

  const confusables = [{
    id: 'C001',
    items: ['K001', 'K002'],
    names: ['Mutex', 'Semaphore'],
    hids: ['h2', 'h2'],
    rows: [
      { aspect: 'what', cells: ['Mutex enforces ownership', 'Semaphore counts permits'] },
      { aspect: 'mistake', cells: ['Confusing Mutex with Semaphore', 'Using Semaphore as Mutex'] },
    ],
  }];

  ssr.setUiLanguage('zh');
  const offHtml = renderToStaticMarkup(h(ssr.BookConfusables, { confusables, drill: false, onGo: noop }));
  assert.doesNotMatch(offHtml, /对照自测|data-confusable-masked/);

  const onHtml = renderToStaticMarkup(h(ssr.BookConfusables, { confusables, drill: true, onGo: noop }));
  assert.match(textOf(onHtml), /对照自测/);
  assert.doesNotMatch(onHtml, /data-confusable-masked/);

  // Toggle quiz mode and reveal via hook harness (BookConfusables is wrapped in React.memo)
  const harness = renderWithHooks();
  const initialTree = harness.render((live) => live.BookConfusables.type({ confusables, drill: true, onGo: noop }));
  const startBtn = collectNodes(initialTree, (n) => n.props?.['aria-pressed'] === false && typeof n.props?.onClick === 'function')[0];
  startBtn.props.onClick();

  const maskedTree = harness.render((live) => live.BookConfusables.type({ confusables, drill: true, onGo: noop }));
  const maskedHtml = renderToStaticMarkup(maskedTree);
  assert.match(maskedHtml, /data-confusable-masked=""/);
  assert.doesNotMatch(maskedHtml, /Mutex|Semaphore|data-term-link=/, 'concept names, cells, data-head, and K-links are all hidden while masked');
  assert.match(maskedHtml, /data-head="概念 A"/);
  assert.match(maskedHtml, /data-head="概念 B"/);
  assert.match(textOf(maskedHtml), /___ enforces ownership/);
  assert.match(textOf(maskedHtml), /Confusing ___ with ___/);

  const revealBtn = collectNodes(maskedTree, (n) => String(n.props?.children) === '揭晓名称')[0];
  revealBtn.props.onClick();
  const revealedHtml = renderToStaticMarkup(harness.render((live) => live.BookConfusables.type({ confusables, drill: true, onGo: noop })));
  assert.doesNotMatch(revealedHtml, /data-confusable-masked/);
  assert.match(revealedHtml, /Mutex/);
  assert.match(revealedHtml, /重新遮住/);

  english(() => {
    const enHtml = renderToStaticMarkup(h(ssr.BookConfusables, { confusables, drill: true, onGo: noop }));
    assert.doesNotMatch(textOf(enHtml), han);
    assert.match(textOf(enHtml), /Self-check/);
  });
});
