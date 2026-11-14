import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { loadUi } from './helpers/ui-module.mjs';
import { draftView, seedView } from './helpers/coverage-view.mjs';

const m = await loadUi(`
  export { default as CatalogToolbar } from './ui/study-map/CatalogToolbar.jsx';
  export { default as Draft, collectFlaggedCardIndices } from './ui/Draft.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { seedCoverage, forgetCoverage } from './ui/coverage/use-coverage.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const noop = () => {};

function mountSync(Component, initialProps) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = [];
  const cleanups = [];
  let cursor = 0;
  let pending = [];
  let currentProps = initialProps;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const render = (nextProps = currentProps) => {
    currentProps = nextProps;
    cursor = 0;
    pending = [];
    const prev = internals.H;
    internals.H = {
      useContext: (ctx) => ctx._currentValue,
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
      useId: () => { const i = cursor++; if (!(i in hooks)) hooks[i] = `:w5${i}:`; return hooks[i]; },
      useDeferredValue: (v) => v,
      useSyncExternalStore: (_sub, getSnap) => getSnap(),
    };
    let tree;
    try { tree = Component(currentProps); } finally { internals.H = prev; }
    for (const eff of pending) {
      cleanups[eff.i]?.();
      cleanups[eff.i] = undefined;
      const done = eff.fn();
      hooks[eff.i] = { deps: eff.deps };
      if (typeof done === 'function') cleanups[eff.i] = done;
    }
    return tree;
  };
  const unmount = () => { for (const c of cleanups) c?.(); };
  return { render, unmount };
}

function walkEls(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) walkEls(c, visit); return; }
  if (node.props) {
    visit(node);
    walkEls(node.props.children, visit);
    walkEls(node.props.description, visit);
    walkEls(node.props.actions, visit);
  }
}

const elText = (node) => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(elText).join('');
  return typeof node === 'object' && node.props ? elText(node.props.children) : '';
};

test('Wave 5: CatalogToolbar Escape clears non-empty search, blurs empty search, and respects IME', () => {
  const searched = [];
  let blurred = 0;
  const findSearch = (tree) => {
    let el = null;
    walkEls(tree, (n) => { if (!el && n.props?.className === 'map-tools__search') el = n; });
    return el;
  };

  const makeEvt = (key, extra = {}) => {
    let prevented = false;
    let stopped = false;
    return {
      event: {
        key,
        isComposing: false,
        ...extra,
        currentTarget: { blur: () => { blurred += 1; } },
        preventDefault: () => { prevented = true; },
        stopPropagation: () => { stopped = true; },
      },
      state: () => ({ prevented, stopped }),
    };
  };

  const nonEmptyTree = m.CatalogToolbar({ search: 'circuit', onSearch: (v) => searched.push(v), showArchived: false, onToggleArchived: noop });
  const inputNonEmpty = findSearch(nonEmptyTree);
  assert.ok(inputNonEmpty?.props?.onKeyDown, 'search field attaches onKeyDown');

  const imeEvt = makeEvt('Escape', { isComposing: true });
  inputNonEmpty.props.onKeyDown(imeEvt.event);
  assert.deepEqual(imeEvt.state(), { prevented: false, stopped: false });
  assert.deepEqual(searched, []);

  const imeKeyCodeEvt = makeEvt('Escape', { keyCode: 229 });
  inputNonEmpty.props.onKeyDown(imeKeyCodeEvt.event);
  assert.deepEqual(imeKeyCodeEvt.state(), { prevented: false, stopped: false });
  assert.deepEqual(searched, []);

  const clearEvt = makeEvt('Escape');
  inputNonEmpty.props.onKeyDown(clearEvt.event);
  assert.deepEqual(clearEvt.state(), { prevented: true, stopped: true });
  assert.deepEqual(searched, ['']);
  assert.equal(blurred, 0);

  const emptyTree = m.CatalogToolbar({ search: '', onSearch: (v) => searched.push(v), showArchived: false, onToggleArchived: noop });
  const inputEmpty = findSearch(emptyTree);
  const blurEvt = makeEvt('Escape');
  inputEmpty.props.onKeyDown(blurEvt.event);
  assert.deepEqual(blurEvt.state(), { prevented: false, stopped: false });
  assert.equal(blurred, 1);
  assert.deepEqual(searched, ['']);
});

test('Wave 5: Draft supports Ctrl/Cmd+S save and Alt+N / Alt+Shift+N flagged cycling', () => {
  m.setUiLanguage('zh');
  const card = (id, prompt, extra = {}) => ({
    id, kind: 'quiz', topic: 't', prompt, answer: 'a', hint: 'h', explanation: 'e', misconception: 'x', options: [], citations: [], ...extra,
  });
  const flaggedDraft = {
    id: 'd1',
    title: 'Wave5 Draft',
    draftVersion: 3,
    cards: [card('c1', 'Q1'), card('c2', 'Q2'), card('c3', 'Q3'), card('c4', 'Q4')],
    quality: { errors: ['Card 3: duplicate prompt'] },
    editorial: {
      requested: 4,
      generation: { sourceIds: ['s1'], kind: 'quiz' },
      reviewedCards: {},
      rejectedIssues: { c1: ['Citation missing'] },
      quality: { issues: { c4: ['Missing rubric'] } },
    },
  };
  assert.deepEqual(m.collectFlaggedCardIndices(flaggedDraft), [0, 2, 3]);

  const acts = [];
  const prevApp = m.AppContext._currentValue;
  const prevStudy = m.StudyServicesContext._currentValue;
  m.AppContext._currentValue = { data: { sources: [{ id: 's1', title: 'S1' }], decks: [], drafts: [flaggedDraft], jobs: [] } };
  m.StudyServicesContext._currentValue = {
    call: async () => ({}),
    act: (name, payload, cb) => acts.push({ name, payload, cb }),
    busy: false,
    notify: noop,
    askInChat: noop,
    host: {},
    openSettings: noop,
    navigate: noop,
    openModal: noop,
  };

  try {
    m.forgetCoverage();
    seedView(m, draftView({ draftId: 'd1', draftVersion: 3, covered: ['r1.p1'] }));

    const baseProps = {
      data: { sources: [{ id: 's1', title: 'S1' }], decks: [], drafts: [flaggedDraft], jobs: [], modelReady: true, runs: [] },
      draft: flaggedDraft,
      draftLoaded: '{}',
      setDraft: noop,
      draftText: '',
      setDraftText: noop,
      jsonMode: false,
      setJsonMode: noop,
      openDraft: noop,
      topUpDraft: noop,
      openSourceAt: noop,
      onOpenPublished: noop,
      onStartPublished: noop,
      clearRecovery: noop,
      setPage: noop,
      setModal: noop,
      blankCard: noop,
      patchCard: noop,
      parseDraft: JSON.parse,
    };

    const app = mountSync(m.Draft, baseProps);
    const findDraftControls = (tree) => {
      let pageEl = null;
      let nextBtn = null;
      walkEls(tree, (n) => {
        if (!pageEl && n.type === 'section' && String(n.props?.className || '').includes('draft-page')) pageEl = n;
        if (!nextBtn && String(n.props?.className || '').includes('draft-next-flagged')) nextBtn = n;
      });
      return { pageEl, nextBtn };
    };

    const fireDraftKey = (pageEl, key, extra = {}) => {
      let prevented = false;
      pageEl.props.onKeyDown({
        key,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        isComposing: false,
        ...extra,
        preventDefault: () => { prevented = true; },
      });
      return prevented;
    };

    let tree = app.render();
    let { pageEl, nextBtn } = findDraftControls(tree);
    assert.ok(pageEl?.props?.onKeyDown, '.draft-page attaches onKeyDown');
    assert.equal(nextBtn?.props?.title, 'Alt+N / Alt+Shift+N');
    assert.equal(elText(nextBtn), '下一道待核对 (0/3)');

    // Ctrl+S and Cmd+S save when unsavedDraft is true; IME is ignored
    assert.equal(fireDraftKey(pageEl, 's', { ctrlKey: true, isComposing: true }), false);
    assert.equal(acts.length, 0);
    assert.equal(fireDraftKey(pageEl, 's', { ctrlKey: true }), true);
    assert.equal(fireDraftKey(pageEl, 'S', { metaKey: true }), true);
    assert.equal(acts.length, 2);
    assert.equal(acts[0].name, 'draft.save');
    assert.deepEqual(acts[0].payload, { deck: flaggedDraft });

    // Ctrl+S when already clean prevents browser Save dialog without dispatching draft.save
    tree = app.render({ ...baseProps, draftLoaded: JSON.stringify(flaggedDraft) });
    ({ pageEl } = findDraftControls(tree));
    assert.equal(fireDraftKey(pageEl, 's', { ctrlKey: true }), true);
    assert.equal(acts.length, 2);

    // Alt+N cycles forward through 0 -> 1 -> 2 -> 0, Alt+Shift+N cycles backward
    const flaggedTexts = [];
    for (const evt of [
      ['n', { altKey: true }],
      ['n', { altKey: true }],
      ['n', { altKey: true }],
      ['n', { altKey: true }],
      ['N', { altKey: true, shiftKey: true }],
    ]) {
      assert.equal(fireDraftKey(pageEl, evt[0], evt[1]), true);
      tree = app.render({ ...baseProps, draftLoaded: JSON.stringify(flaggedDraft) });
      ({ pageEl, nextBtn } = findDraftControls(tree));
      flaggedTexts.push(elText(nextBtn));
    }
    assert.deepEqual(flaggedTexts, [
      '下一道待核对 (1/3)',
      '下一道待核对 (2/3)',
      '下一道待核对 (3/3)',
      '下一道待核对 (1/3)',
      '下一道待核对 (3/3)',
    ]);

    app.unmount();
  } finally {
    m.forgetCoverage();
    m.AppContext._currentValue = prevApp;
    m.StudyServicesContext._currentValue = prevStudy;
    m.setUiLanguage('zh');
  }
});
