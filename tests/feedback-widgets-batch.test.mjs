import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const mod = await loadUi(`
  export { default as ChoiceFeedback } from './ui/ChoiceFeedback.jsx';
  export { default as ShortcutHelp } from './ui/ShortcutHelp.jsx';
  export { default as Cloze } from './ui/Cloze.jsx';
  export { default as ThumbFeedback } from './ui/ThumbFeedback.jsx';
  export { default as SimilarTry } from './ui/review/SimilarTry.jsx';
  export { default as RetellPanel } from './ui/review/RetellPanel.jsx';
  export { default as RoundLookBack } from './ui/review/RoundLookBack.jsx';
  export { default as ReviewNavigator } from './ui/ReviewNavigator.jsx';
  export { default as StudyMath, warmStudyMathRenderer, resetStudyMathCacheForTests } from './ui/StudyMath.jsx';
  export { default as MathText } from './ui/MathText.jsx';
  export { default as Markdown } from './ui/Markdown.jsx';
  export { createInteractionTracker, classifyInteractionAction, INTERACTION_LIMIT } from './ui/use-session-performance.js';
  export { getAppearanceSound, saveAppearance, invalidateAppearanceCache } from './ui/appearance-prefs.js';
  export { playSound, scheduleSoundPrebake, resetSoundEngineForTests, SOUND_CUES } from './ui/sound-effects.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { setQueryData } from './ui/host-query.js';
  export { ENGLISH_SOURCES, mergeCatalogues, setUiLanguage, ui, uiCatalogue } from './ui/i18n.js';
`);
Object.assign(mod.uiCatalogue(), mod.mergeCatalogues(mod.ENGLISH_SOURCES).catalogue);

const h = React.createElement;
const noop = () => {};
const han = /\p{Script=Han}/u;

function mountSync(services = { call: async () => ({}), act: noop, busy: false, notify: noop, openModal: noop }, appData = null) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = [];
  const cleanups = [];
  let cursor = 0;
  let pending = [];
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return {
    render(Component, props) {
      cursor = 0;
      pending = [];
      const prev = internals.H;
      internals.H = {
        useContext: (ctx) => {
          if (ctx === mod.StudyServicesContext) return services;
          if (ctx === mod.AppContext) return appData ? { data: appData } : ctx._currentValue;
          return ctx._currentValue;
        },
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
        useEffect: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) pending.push({ i, fn, deps }); },
        useLayoutEffect: (fn, deps) => internals.H.useEffect(fn, deps),
        useInsertionEffect: (fn, deps) => internals.H.useEffect(fn, deps),
        useImperativeHandle: (ref, create) => {
          const val = create();
          if (typeof ref === 'function') ref(val);
          else if (ref && typeof ref === 'object') ref.current = val;
        },
        useId: () => { const i = cursor++; if (!(i in hooks)) hooks[i] = `:fw-${i}:`; return hooks[i]; },
        useDeferredValue: (v) => v,
        useSyncExternalStore: (_sub, getSnap) => getSnap(),
      };
      let tree;
      try {
        const Target = Component.$$typeof === Symbol.for('react.forward_ref')
          ? (p) => Component.render(p, null)
          : Component.$$typeof === Symbol.for('react.memo')
            ? Component.type
            : Component;
        tree = Target(props);
      } finally { internals.H = prev; }
      for (const eff of pending) {
        cleanups[eff.i]?.();
        cleanups[eff.i] = undefined;
        const done = eff.fn();
        hooks[eff.i] = { deps: eff.deps };
        if (typeof done === 'function') cleanups[eff.i] = done;
      }
      return tree;
    },
    unmount() { for (const c of cleanups) c?.(); },
  };
}

function walkTree(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) walkTree(child, visit); return; }
  if (node.props) {
    visit(node);
    if (typeof node.props.render === 'function' && Array.isArray(node.props.items)) {
      node.props.items.forEach((item) => walkTree(node.props.render(item), visit));
    }
    walkTree(node.props.children, visit);
  }
}

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.props) {
    if (typeof node.props.render === 'function' && Array.isArray(node.props.items)) {
      return node.props.items.map((item) => textOf(node.props.render(item))).join('');
    }
    return textOf(node.props.children);
  }
  return '';
}

function htmlOf(el, services = { call: async () => ({}), act: noop, busy: false, notify: noop, openModal: noop }, appData = null) {
  return renderToStaticMarkup(
    h(mod.AppContext.Provider, { value: appData ? { data: appData } : undefined },
      h(mod.StudyServicesContext.Provider, { value: services }, el)),
  );
}

test('ChoiceFeedback renders explicit pass/fail verdict mark at head in ZH and EN', () => {
  const card = { id: 'c1', kind: 'quiz' };
  const options = [{ id: 'a', text: 'Alpha' }, { id: 'b', text: 'Beta' }];
  const solution = { options: [{ id: 'a', correct: true }, { id: 'b', correct: false }] };

  mod.setUiLanguage('zh');
  try {
    const okHtml = renderToStaticMarkup(h(mod.ChoiceFeedback, { card, options, feedback: { selected: ['a'] }, solution, multiple: false }));
    assert.match(okHtml, /choice-feedback__verdict--ok/);
    assert.match(okHtml, /data-passed="true"/);
    assert.match(okHtml, /答对了/);

    const badHtml = renderToStaticMarkup(h(mod.ChoiceFeedback, { card, options, feedback: { selected: ['b'] }, solution, multiple: false }));
    assert.match(badHtml, /choice-feedback__verdict--bad/);
    assert.match(badHtml, /data-passed="false"/);
    assert.match(badHtml, /答错了/);

    const forcedOk = renderToStaticMarkup(h(mod.ChoiceFeedback, { card, options, feedback: { selected: ['b'] }, solution, multiple: false, passed: true }));
    assert.match(forcedOk, /data-passed="true"/);

    mod.setUiLanguage('en');
    const enBad = renderToStaticMarkup(h(mod.ChoiceFeedback, { card, options, feedback: { selected: ['b'] }, solution, multiple: false }));
    const plain = enBad.replace(/<[^>]+>/g, ' ').trim();
    assert.doesNotMatch(plain, han);
    assert.match(plain, /Answered wrong/);
  } finally {
    mod.setUiLanguage('zh');
  }
});

test('ShortcutHelp lists undo, clear multi-select, and source-split focus toggle in ZH and EN', () => {
  mod.setUiLanguage('zh');
  try {
    const zh = renderToStaticMarkup(h(mod.ShortcutHelp, { page: 'review', onClose: noop }));
    assert.match(zh, /<kbd>Z<\/kbd><kbd>Ctrl\+Z<\/kbd>/);
    assert.match(zh, /撤销上一题评分/);
    assert.match(zh, /<kbd>0<\/kbd><kbd>Backspace<\/kbd>/);
    assert.match(zh, /多选题：清空已选选项/);
    assert.match(zh, /<kbd>Alt\+`<\/kbd>/);
    assert.match(zh, /资料对照栏：在题目与资料之间切换焦点/);

    mod.setUiLanguage('en');
    const en = renderToStaticMarkup(h(mod.ShortcutHelp, { page: 'review', onClose: noop }));
    const plain = en.replace(/<[^>]+>/g, ' ').trim();
    assert.doesNotMatch(plain, han);
    assert.match(plain, /Undo (?:last|the previous) grade/);
    assert.match(plain, /Multi-select: clear selected options/);
    assert.match(plain, /Source split: switch focus between question and source/);
  } finally {
    mod.setUiLanguage('zh');
  }
});

test('Cloze sets autocomplete/spellcheck off on inputs, fixes wrong-blank hierarchy, shows multi-blank summary and equivalent override', () => {
  const card = {
    id: 'cl1',
    kind: 'cloze',
    cloze: { text: 'First {{b1}} and second {{b2}}.', blanks: [{ id: 'b1' }, { id: 'b2' }] },
  };
  mod.setUiLanguage('zh');
  try {
    const inputHtml = renderToStaticMarkup(h(mod.Cloze, { card, values: { b1: '', b2: '' }, onChange: noop, onSubmit: noop }));
    assert.match(inputHtml, /autoComplete="off"|autocomplete="off"/i);
    assert.match(inputHtml, /autoCapitalize="off"|autocapitalize="off"/i);
    assert.match(inputHtml, /spellCheck="false"|spellcheck="false"/i);

    let equivalentClicks = 0;
    const gradedEl = h(mod.Cloze, {
      card,
      values: { b1: 'right', b2: 'typo' },
      onChange: noop,
      details: [
        { id: 'b1', correct: true },
        { id: 'b2', correct: false, expected: 'exact' },
      ],
      solution: { cloze: { answers: [{ id: 'b1', value: 'right' }, { id: 'b2', value: 'exact' }] } },
      onMarkEquivalent: () => { equivalentClicks += 1; },
    });
    const gradedHtml = renderToStaticMarkup(gradedEl);
    assert.match(gradedHtml, /答对 1\/2 空/);
    assert.match(gradedHtml, /表述等价 · 算我答对/);
    // Error mark sits inside .cloze-yours before .cloze-expected-row
    const yoursIdx = gradedHtml.indexOf('cloze-yours');
    const wrongMarkIdx = gradedHtml.indexOf('cloze-mark--wrong');
    const expectedIdx = gradedHtml.indexOf('cloze-expected');
    assert.ok(yoursIdx > 0 && wrongMarkIdx > yoursIdx && wrongMarkIdx < expectedIdx, 'red cross sits with user wrong input before expected answer');

    // Equivalent button invokes callback
    const app = mountSync();
    const tree = app.render(mod.Cloze, {
      card,
      values: { b1: 'right', b2: 'typo' },
      onChange: noop,
      details: [{ id: 'b1', correct: true }, { id: 'b2', correct: false, expected: 'exact' }],
      onMarkEquivalent: () => { equivalentClicks += 1; },
    });
    let eqBtn = null;
    walkTree(tree, (n) => { if (!eqBtn && typeof n.props?.onClick === 'function' && textOf(n).includes('表述等价')) eqBtn = n; });
    assert.ok(eqBtn);
    eqBtn.props.onClick();
    assert.equal(equivalentClicks, 1);
    app.unmount();

    // All correct hides equivalent button
    const passedHtml = renderToStaticMarkup(h(mod.Cloze, {
      card,
      values: { b1: 'right', b2: 'exact' },
      onChange: noop,
      details: [{ id: 'b1', correct: true }, { id: 'b2', correct: true }],
      onMarkEquivalent: noop,
    }));
    assert.match(passedHtml, /答对 2\/2 空/);
    assert.doesNotMatch(passedHtml, /表述等价/);

    mod.setUiLanguage('en');
    const enHtml = renderToStaticMarkup(gradedEl);
    const plain = enHtml.replace(/<[^>]+>/g, ' ').trim();
    assert.doesNotMatch(plain, han);
    assert.match(plain, /Got 1\/2 blanks right/);
    assert.match(plain, /Equivalent phrasing · count as right/);
  } finally {
    mod.setUiLanguage('zh');
  }
});

test('ThumbFeedback does not auto-close/submit general-quality without tags, pauses on hover/focus, and submits explicitly or after >=4s idle', async () => {
  const origWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let nextTimerId = 1;
  const scheduled = [];
  globalThis.setTimeout = (fn, ms) => {
    const id = nextTimerId++;
    timers.set(id, { fn, ms });
    scheduled.push({ id, ms });
    return id;
  };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { addEventListener: noop, removeEventListener: noop },
  });

  const calls = [];
  const services = { call: async (op, args) => { calls.push({ op, args }); return { tags: args.tags || [], scheduled: [] }; }, act: noop, busy: false, notify: noop, openModal: noop };
  const props = { run: { id: 'r1', deckId: 'd1', card: { id: 'c1', prompt: 'Explain entropy.' } }, canShortcut: () => true };

  try {
    const app = mountSync(services);
    let tree = app.render(mod.ThumbFeedback, props);
    let downBtn = null;
    walkTree(tree, (n) => { if (!downBtn && n.type === 'button' && n.props['aria-label'] === '这题有问题') downBtn = n; });
    assert.ok(downBtn);

    // Clicking 👎 opens tray with ZERO auto-close timer
    downBtn.props.onClick();
    tree = app.render(mod.ThumbFeedback, props);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(timers.size, 0, 'opening tray with no tags schedules no auto-close/general-quality timer');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.tags, []);

    // Hovering tray and picking a tag pauses auto-submit timer
    let tray = null;
    walkTree(tree, (n) => { if (!tray && n.props?.className === 'thumb-tray') tray = n; });
    assert.ok(tray);
    tray.props.onMouseEnter();

    let firstChip = null;
    walkTree(tree, (n) => { if (!firstChip && typeof n.props?.onClick === 'function' && textOf(n).includes('题干太空')) firstChip = n; });
    assert.ok(firstChip);
    firstChip.props.onClick();
    tree = app.render(mod.ThumbFeedback, props);
    assert.equal(timers.size, 0, 'auto-submit stays paused while hovered in tray');

    // Explicit submit button appears and submits picked tags immediately
    let submitBtn = null;
    walkTree(tree, (n) => { if (!submitBtn && typeof n.props?.onClick === 'function' && textOf(n).includes('提交标签')) submitBtn = n; });
    assert.ok(submitBtn, 'explicit submit button is rendered when tags are pending');

    // Leaving hover starts >=4000ms idle timer
    tray = null;
    walkTree(tree, (n) => { if (!tray && n.props?.className === 'thumb-tray') tray = n; });
    tray.props.onMouseLeave();
    assert.equal(timers.size, 1);
    const [idleTimer] = [...timers.values()];
    assert.ok(idleTimer.ms >= 4000, `idle delay (${idleTimer.ms}ms) must be >= 4000ms`);

    // Firing explicit submit flushes immediately and cancels timer
    submitBtn.props.onClick();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    assert.equal(timers.size, 0);
    assert.deepEqual(calls.at(-1).args.tags, ['stem-vague']);
    app.unmount();
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
    if (origWindow) Object.defineProperty(globalThis, 'window', origWindow);
    else delete globalThis.window;
  }
});

test('#1275: ThumbFeedback tag tray closes on outside pointerdown so learners without tags can dismiss it and see the 修题 tip', async () => {
  const origWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const origDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const docListeners = new Map();
  const fakeRoot = { contains: (node) => node === fakeRoot || node === insideNode };
  const insideNode = { closest: () => null };
  const outsideNode = { closest: () => null };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { addEventListener: noop, removeEventListener: noop },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      head: { querySelector: () => null, appendChild: noop },
      body: {},
      documentElement: {},
      createElement: () => ({ setAttribute: noop, textContent: '' }),
      querySelector: () => null,
      addEventListener: (type, fn, cap = false) => {
        const list = docListeners.get(type) || [];
        list.push({ fn, cap: Boolean(cap) });
        docListeners.set(type, list);
      },
      removeEventListener: (type, fn, cap = false) => {
        const list = docListeners.get(type);
        if (!list) return;
        const idx = list.findIndex((e) => e.fn === fn && e.cap === Boolean(cap));
        if (idx >= 0) list.splice(idx, 1);
      },
    },
  });
  const dispatchPointerDown = (target) => {
    for (const { fn } of [...(docListeners.get('pointerdown') || [])]) fn({ target });
  };

  const services = { call: async () => ({ tags: [], scheduled: [] }), act: noop, busy: false, notify: noop, openModal: noop };
  const props = { run: { id: 'r1', deckId: 'd1', card: { id: 'c1', prompt: 'Explain entropy.' } }, canShortcut: () => true };

  try {
    const app = mountSync(services);
    let tree = app.render(mod.ThumbFeedback, props);
    if (tree.props?.ref && typeof tree.props.ref === 'object') tree.props.ref.current = fakeRoot;
    let downBtn = null;
    walkTree(tree, (n) => { if (!downBtn && n.type === 'button' && n.props['aria-label'] === '这题有问题') downBtn = n; });
    downBtn.props.onClick();
    tree = app.render(mod.ThumbFeedback, props);
    if (tree.props?.ref && typeof tree.props.ref === 'object') tree.props.ref.current = fakeRoot;

    const hasTray = (node) => { let found = false; walkTree(node, (n) => { if (n.props?.className === 'thumb-tray') found = true; }); return found; };
    assert.equal(hasTray(tree), true, 'tray opens after voting down');

    dispatchPointerDown(insideNode);
    tree = app.render(mod.ThumbFeedback, props);
    assert.equal(hasTray(tree), true, 'clicking inside the tray keeps it open');

    dispatchPointerDown(outsideNode);
    tree = app.render(mod.ThumbFeedback, props);
    assert.equal(hasTray(tree), false, 'clicking outside the tray closes it cleanly');
    app.unmount();
  } finally {
    if (origWindow) Object.defineProperty(globalThis, 'window', origWindow);
    else delete globalThis.window;
    if (origDocument) Object.defineProperty(globalThis, 'document', origDocument);
    else delete globalThis.document;
  }
});

test('SimilarTry ignores stale response if active card changes before review.similar resolves', async () => {
  let resolveSimilar = null;
  const detours = [];
  const services = {
    call: () => new Promise((resolve) => { resolveSimilar = resolve; }),
    act: noop, busy: false, notify: noop, openModal: noop,
  };
  const makeSession = (cardId) => ({
    run: { id: 'r1', index: 0, deckId: 'd1', mode: 'quiz', card: { id: cardId }, feedback: { correct: false }, queueVersion: 0, revision: 0 },
    actions: { studyPrerequisites: (...args) => { detours.push(args); }, assistCard: async () => {} },
  });

  const app = mountSync(services);
  const tree = app.render(mod.SimilarTry, { session: makeSession('c1'), data: { assist: [] }, model: { ready: true }, onModelSettings: noop });
  let goBtn = null;
  walkTree(tree, (n) => { if (!goBtn && typeof n.props?.onClick === 'function' && n.props['data-usage'] === 'review.similar') goBtn = n; });
  assert.ok(goBtn);

  const pending = goBtn.props.onClick();
  // User moves to card c2 while request for c1 is still in flight
  app.render(mod.SimilarTry, { session: makeSession('c2'), data: { assist: [] }, model: { ready: true }, onModelSettings: noop });
  resolveSimilar({ item: { deckId: 'd1', cardId: 'sim-1' } });
  await pending;
  assert.equal(detours.length, 0, 'stale similar response must not yank user to old card detour');
  app.unmount();
});

test('RetellPanel preserves edits made while submit is in-flight and ignores stale card responses', async () => {
  let resolveCall = null;
  const doneResults = [];
  const services = {
    call: () => new Promise((resolve) => { resolveCall = resolve; }),
    act: noop, busy: false, notify: noop, openModal: noop,
  };
  const baseProps = {
    op: 'teach.retell',
    args: { deckId: 'd1', cardId: 'c1' },
    draftKey: 'd1:c1',
    model: { ready: true },
    onModelSettings: noop,
    onDone: (r) => doneResults.push(r),
  };

  const app = mountSync(services);
  let tree = app.render(mod.RetellPanel, baseProps);
  const findTextarea = (t) => { let el = null; walkTree(t, (n) => { if (!el && n.type === 'textarea') el = n; }); return el; };
  const findForm = (t) => { let el = null; walkTree(t, (n) => { if (!el && n.type === 'form') el = n; }); return el; };

  // User types initial answer and submits
  findTextarea(tree).props.onChange({ target: { value: 'initial draft' } });
  tree = app.render(mod.RetellPanel, baseProps);
  const submitting = findForm(tree).props.onSubmit({ preventDefault: noop });
  tree = app.render(mod.RetellPanel, baseProps);

  // While in-flight, user keeps editing
  findTextarea(tree).props.onChange({ target: { value: 'initial draft plus new thoughts' } });
  tree = app.render(mod.RetellPanel, baseProps);

  resolveCall({ passed: true, right: ['good'], missed: [], wrong: [] });
  await submitting;
  tree = app.render(mod.RetellPanel, baseProps);
  assert.equal(findTextarea(tree).props.value, 'initial draft plus new thoughts', 'in-flight edits are preserved');
  assert.equal(doneResults.length, 1);

  // Second check: switching draftKey mid-flight ignores stale response
  const submitting2 = findForm(tree).props.onSubmit({ preventDefault: noop });
  app.render(mod.RetellPanel, { ...baseProps, args: { deckId: 'd1', cardId: 'c2' }, draftKey: 'd1:c2' });
  resolveCall({ passed: false, right: [], missed: ['x'], wrong: [] });
  await submitting2;
  assert.equal(doneResults.length, 1, 'stale card response does not fire onDone');
  app.unmount();
});

test('sound-effects caches appearance sound preference and schedules idle pre-bake without creating AudioContext', () => {
  const origStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const origIdle = Object.getOwnPropertyDescriptor(globalThis, 'requestIdleCallback');
  const origCancelIdle = Object.getOwnPropertyDescriptor(globalThis, 'cancelIdleCallback');
  let reads = 0;
  const map = new Map();
  const storage = {
    getItem: (k) => { reads += 1; return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { map.set(k, String(v)); },
  };
  const idleCallbacks = [];
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'requestIdleCallback', {
    configurable: true,
    value: (cb) => { idleCallbacks.push(cb); return idleCallbacks.length; },
  });
  Object.defineProperty(globalThis, 'cancelIdleCallback', { configurable: true, value: noop });

  try {
    mod.resetSoundEngineForTests();
    // First muted playSound reads storage once (2 keys), subsequent 10 calls do 0 storage reads!
    assert.equal(mod.playSound('tap'), false);
    const readsAfterFirst = reads;
    assert.ok(readsAfterFirst > 0);
    for (let i = 0; i < 10; i++) assert.equal(mod.playSound('flip'), false);
    assert.equal(reads, readsAfterFirst, 'repeated playSound calls read from memory cache, zero localStorage I/O');

    // Enabling sound via saveAppearance updates cache & schedules idle prebake
    mod.saveAppearance({ sound: 'subtle' }, storage);
    assert.equal(mod.getAppearanceSound(storage), 'subtle');
    assert.equal(reads, readsAfterFirst, 'saveAppearance refreshes memory cache directly without re-reading storage');
    assert.ok(idleCallbacks.length >= 1, 'enabling sound schedules idle PCM pre-bake');

    // Run idle callback and verify all cues bake cleanly without AudioContext
    idleCallbacks.at(-1)({ timeRemaining: () => 50 });
  } finally {
    mod.resetSoundEngineForTests();
    if (origStorage) Object.defineProperty(globalThis, 'localStorage', origStorage); else delete globalThis.localStorage;
    if (origIdle) Object.defineProperty(globalThis, 'requestIdleCallback', origIdle); else delete globalThis.requestIdleCallback;
    if (origCancelIdle) Object.defineProperty(globalThis, 'cancelIdleCallback', origCancelIdle); else delete globalThis.cancelIdleCallback;
  }
});

test('RoundLookBack renders ChoiceFeedback + multi-select AnswerState, in-page blind-recall toggle, and follow-up trigger', () => {
  const rows = [
    {
      number: 1,
      entryIndex: 0,
      deckId: 'd1',
      cardId: 'm1',
      kind: 'multi',
      status: 'wrong',
      card: {
        id: 'm1',
        kind: 'multi',
        multiple: true,
        prompt: 'Pick all prime numbers',
        options: [{ id: 'a', text: '2' }, { id: 'b', text: '3' }, { id: 'c', text: '4' }],
      },
      feedback: { selected: ['a', 'c'] },
      solution: {
        explanation: '2 and 3 are prime.',
        options: [{ id: 'a', correct: true }, { id: 'b', correct: true }, { id: 'c', correct: false }],
      },
    },
  ];
  const run = { id: 'run-lb-multi', mode: 'quiz', navigation: [{ answered: true }], correctionsPending: 0 };
  const services = { call: async () => ({ rows }), act: noop, busy: false, notify: noop, openModal: noop };
  mod.setQueryData('review.lookBack', { runId: run.id }, { rows });

  mod.setUiLanguage('zh');
  try {
    const asked = [];
    const app = mountSync(services);
    const props = { run, onAsk: (row) => asked.push(row.cardId) };
    let tree = app.render(mod.RoundLookBack, props);

    // Even with setting off, in-page 先遮答案自测 toggle is available and starts aria-pressed=false
    let veilBtn = null;
    let rowLine = null;
    walkTree(tree, (n) => {
      if (!veilBtn && typeof n.props?.onClick === 'function' && textOf(n).trim() === '先遮答案自测') veilBtn = n;
      if (!rowLine && n.props?.className === 'look-back__line') rowLine = n;
    });
    assert.ok(veilBtn, 'in-page blind recall toggle is shown when wrong >= 1');
    assert.equal(veilBtn.props['aria-pressed'], false);

    // Expand row 1 -> ChoiceFeedback + multi-select AnswerState + onAsk trigger
    rowLine.props.onClick();
    tree = app.render(mod.RoundLookBack, props);
    const expandedHtml = htmlOf(tree, services);
    assert.match(expandedHtml, /choice-feedback/);
    assert.match(expandedHtml, /漏选：<strong>B<\/strong>/);
    assert.match(expandedHtml, /错选：<strong>C<\/strong>/);
    assert.match(expandedHtml, /漏选 · 正确答案/);
    assert.match(expandedHtml, /已选 · 错选/);
    assert.match(expandedHtml, />追问</);

    // Toggle blind recall ON in-place -> row becomes veiled
    veilBtn.props.onClick();
    tree = app.render(mod.RoundLookBack, props);
    const veiledHtml = htmlOf(tree, services);
    assert.match(veiledHtml, /揭晓答案与解析/);
    assert.doesNotMatch(veiledHtml, /2 and 3 are prime/);
    app.unmount();

    // Without external onAsk, live services.call renders in-place ExplanationFollowup (追问？ / 重新讲清楚)
    const app2 = mountSync(services);
    let tree2 = app2.render(mod.RoundLookBack, { run });
    let rowLine2 = null;
    walkTree(tree2, (n) => { if (!rowLine2 && n.props?.className === 'look-back__line') rowLine2 = n; });
    rowLine2.props.onClick();
    tree2 = app2.render(mod.RoundLookBack, { run });
    const inPlaceHtml = htmlOf(tree2, services);
    assert.match(inPlaceHtml, /追问？/);
    assert.match(inPlaceHtml, /重新讲清楚/);
    app2.unmount();
  } finally {
    mod.setUiLanguage('zh');
  }
});

test('ReviewNavigator marks answered ticks with data-outcome and session.css styles pass/fail colors', async () => {
  const navigation = [
    { index: 0, answered: true, passed: true, level: 'learning', topic: 'T1' },
    { index: 1, answered: true, passed: false, level: 'weak', topic: 'T2' },
    { index: 2, answered: false, level: 'new', topic: 'T3' },
  ];
  const html = renderToStaticMarkup(h(mod.ReviewNavigator, { run: { id: 'r', index: 2, navigation }, onJump: noop }));
  const ticks = [...html.matchAll(/<button[^>]*class="review-tick\b[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.equal(ticks.length, 3);
  assert.match(ticks[0], /data-outcome="right"/);
  assert.match(ticks[1], /data-outcome="wrong"/);
  assert.doesNotMatch(ticks[2], /data-outcome=/);

  const sessionCss = await readFile(new URL('../ui/review/session.css', import.meta.url), 'utf8');
  assert.match(sessionCss, /\[data-answered="true"\]\[data-outcome="right"\][\s\S]*?var\(--ok\)/);
  assert.match(sessionCss, /\[data-answered="true"\]\[data-outcome="wrong"\][\s\S]*?var\(--bad\)/);
});

test('StudyMath renders synchronously without flicker once renderer is warmed; MathText & Markdown are memoized', async () => {
  assert.equal(mod.MathText.$$typeof, Symbol.for('react.memo'), 'MathText is wrapped in React.memo');
  assert.equal(mod.Markdown.$$typeof, Symbol.for('react.memo'), 'Markdown is wrapped in React.memo');

  const mdSrc = await readFile(new URL('../ui/Markdown.jsx', import.meta.url), 'utf8');
  assert.match(mdSrc, /useIsoLayoutEffect\(\(\) => \{ measure\(\); \}, \[measure, children\]\)/);

  mod.resetStudyMathCacheForTests();
  try {
    // Before warming: SSR renders raw source cleanly
    const cold = renderToStaticMarkup(h(mod.StudyMath, { formula: { source: 'x^2 + 1', display: false, raw: '$x^2 + 1$' } }));
    assert.match(cold, /md-math-source/);

    // After warming: first render immediately outputs KaTeX HTML (zero 3-phase flicker)
    await mod.warmStudyMathRenderer();
    const warm = renderToStaticMarkup(h(mod.StudyMath, { formula: { source: 'x^2 + 1', display: false, raw: '$x^2 + 1$' } }));
    assert.match(warm, /md-math-content/);
    assert.match(warm, /class="katex"/);
    assert.doesNotMatch(warm, /md-math-source/);
  } finally {
    mod.resetStudyMathCacheForTests();
  }
});

test('use-session-performance INP tracker aggregates interactionId latencies by review action', () => {
  const tracker = mod.createInteractionTracker({ limit: 3 });
  assert.equal(tracker.summary(), null, 'null until observe() is called');
  tracker.observe();
  assert.deepEqual(tracker.summary(), { all: { count: 0, median: 0, p98: 0, worst: 0 }, byAction: {} });

  const makeTarget = (match) => ({ closest: (sel) => (sel.includes(match) ? {} : null) });
  // Non-interaction entries (interactionId=0) are ignored
  assert.equal(tracker.recordEvent({ interactionId: 0, duration: 50, target: makeTarget('.option') }, 'review'), null);

  // Same interactionId merges to worst duration
  tracker.recordEvent({ interactionId: 10, duration: 24, target: makeTarget('.option') }, 'review');
  tracker.recordEvent({ interactionId: 10, duration: 48, target: makeTarget('.option') }, 'review');
  tracker.recordEvent({ interactionId: 11, duration: 32, target: makeTarget('.grade-btn') }, 'review');
  tracker.recordEvent({ interactionId: 12, duration: 64, target: makeTarget('.flip-card') }, 'review');
  tracker.recordEvent({ interactionId: 13, duration: 20, target: makeTarget('.cloze-blank--input') }, 'review');

  const summary = tracker.summary();
  assert.equal(summary.all.count, 3, 'bounded to limit=3 (evicted oldest interactionId=10)');
  assert.equal(summary.all.worst, 64);
  assert.equal(summary.byAction['review.grade'].worst, 32);
  assert.equal(summary.byAction['review.flip'].worst, 64);
  assert.equal(summary.byAction['review.submit'].worst, 20);
  assert.equal(mod.classifyInteractionAction(makeTarget('.option'), 'library'), 'other');
});
