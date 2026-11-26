import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadInteractiveUi } from './helpers/react-harness.mjs';

import {
  PRACTICE_DEFAULTS,
  lookBackBlindRecall,
  mergePracticeSettings,
  normalizePracticeSettings,
  resolvePracticeSettings,
  validatePracticePatch,
} from '../lib/practice-settings.js';
import {
  LOOKBACK_ERROR_REASONS,
  maskedClozeTextOf,
  maskedPromptOf,
  reasonGroups,
  reasonLabelOf,
  refsForReason,
  rowReasonKey,
  toggleRowReason,
} from '../ui/review/lookback-recall.js';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `export { default as RoundLookBack, formatLookBackMarkdown } from './ui/review/RoundLookBack.jsx';
      export { default as PracticePane } from './ui/settings/PracticePane.jsx';
      export { FINDER_ENTRIES } from './ui/finder/entries.js';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { AppContext } from './ui/app/app-context.js';
      export { setQueryData } from './ui/host-query.js';
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
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const uiMod = mod.exports;
Object.assign(uiMod.uiCatalogue(), uiMod.mergeCatalogues(uiMod.ENGLISH_SOURCES).catalogue);

const h = React.createElement;
const noop = () => {};
const han = /\p{Script=Han}/u;

function mountSync(services, appData = null) {
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
          if (ctx === uiMod.StudyServicesContext) return services;
          if (ctx === uiMod.AppContext) return appData ? { data: appData } : ctx._currentValue;
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
        useId: () => { const i = cursor++; if (!(i in hooks)) hooks[i] = `:lb-recall-${i}:`; return hooks[i]; },
        useDeferredValue: (v) => v,
        useSyncExternalStore: (_sub, getSnap) => getSnap(),
      };
      let tree;
      try { tree = Component(props); } finally { internals.H = prev; }
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

function htmlOfElement(el, services, appData) {
  return renderToStaticMarkup(
    h(uiMod.AppContext.Provider, { value: appData ? { data: appData } : undefined },
      h(uiMod.StudyServicesContext.Provider, { value: services }, el)),
  );
}

test('lib/practice-settings keeps PRACTICE_DEFAULTS intact and manages opt-in lookBackBlindRecall', () => {
  const baselineKeys = ['autopilot', 'roundSize', 'newCardOrder', 'debrief', 'rereadMarks', 'leechFailures', 'leechWindow', 'leechRate'];
  assert.deepEqual(Object.keys(PRACTICE_DEFAULTS), baselineKeys);
  assert.deepEqual(Object.keys(resolvePracticeSettings(undefined)), baselineKeys);
  assert.equal(lookBackBlindRecall(undefined), false);
  assert.equal(lookBackBlindRecall({}), false);

  const normalizedFalse = normalizePracticeSettings({ lookBackBlindRecall: false });
  assert.equal('lookBackBlindRecall' in normalizedFalse, false);
  const normalizedTrue = normalizePracticeSettings({ lookBackBlindRecall: true });
  assert.equal(normalizedTrue.lookBackBlindRecall, true);
  assert.equal(lookBackBlindRecall(normalizedTrue), true);

  const enabled = mergePracticeSettings(undefined, { lookBackBlindRecall: true });
  assert.equal(enabled.lookBackBlindRecall, true);
  const cleared = mergePracticeSettings(enabled, { lookBackBlindRecall: null });
  assert.equal('lookBackBlindRecall' in cleared, false);
  assert.equal(lookBackBlindRecall(cleared), false);

  assert.deepEqual(validatePracticePatch({ lookBackBlindRecall: true }), { lookBackBlindRecall: true });
  assert.deepEqual(validatePracticePatch({ lookBackBlindRecall: null }), { lookBackBlindRecall: null });
  assert.throws(() => mergePracticeSettings(undefined, { lookBackBlindRecall: 'yes' }), /lookBackBlindRecall/);
});

test('PracticePane and Finder entries expose opt-in lookBackBlindRecall in Chinese and English', async () => {
  uiMod.setUiLanguage('zh');
  try {
    const input = (html, name) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? '';
    const offHtml = renderToStaticMarkup(h(uiMod.PracticePane, { data: { settings: {} }, busy: false, act: noop }));
    assert.doesNotMatch(input(offHtml, 'lookBackBlindRecall'), /checked/);

    const onHtml = renderToStaticMarkup(h(uiMod.PracticePane, {
      data: { settings: { practice: { lookBackBlindRecall: true } } },
      busy: false,
      act: noop,
    }));
    assert.match(input(onHtml, 'lookBackBlindRecall'), /checked/);

    const entry = uiMod.FINDER_ENTRIES.find((item) => item.id === 'lookback-blind-recall');
    assert.ok(entry);
    assert.equal(entry.area, 'practice');
    assert.equal(entry.page, 'settings');
    assert.deepEqual(entry.anchors, ['settings-practice']);

    const interactive = await loadInteractiveUi(`
      export { default as PracticePane } from './ui/settings/PracticePane.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { ToastContext } from './ui/components/index.js';
    `);
    const savedCalls = [];
    const toastApi = { success: noop, error: noop, info: noop };
    const paneServices = { openSettings: noop, host: { capabilities: { chat: true } } };
    const recordAct = async (action, args) => { savedCalls.push({ action, args }); return { ok: true }; };
    let paneData = { settings: {} };
    const mounted = interactive.mount(() => interactive.React.createElement(
      interactive.exports.ToastContext.Provider, { value: toastApi },
      interactive.React.createElement(
        interactive.exports.StudyServicesContext.Provider, { value: paneServices },
        interactive.React.createElement(interactive.exports.PracticePane, { data: paneData, busy: false, act: recordAct }),
      ),
    ));
    try {
      const findSwitch = () => mounted.find((n) => n.type === 'input' && n.props?.name === 'lookBackBlindRecall');
      const swOff = findSwitch();
      assert.ok(swOff, 'lookBackBlindRecall switch is rendered');
      assert.equal(swOff.props.checked, false);
      await mounted.act(() => swOff.props.onChange({ target: { checked: true } }));
      assert.deepEqual(savedCalls[0], { action: 'settings.practice.set', args: { patch: { lookBackBlindRecall: true } } });

      paneData = { settings: { practice: { lookBackBlindRecall: true } } };
      mounted.rerender();
      const swOn = findSwitch();
      assert.equal(swOn.props.checked, true);
      await mounted.act(() => swOn.props.onChange({ target: { checked: false } }));
      assert.deepEqual(savedCalls[1], { action: 'settings.practice.set', args: { patch: { lookBackBlindRecall: null } } });
    } finally {
      mounted.unmount();
    }

    uiMod.setUiLanguage('en');
    const enHtml = renderToStaticMarkup(h(uiMod.PracticePane, { data: { settings: {} }, busy: false, act: noop }));
    const plain = enHtml.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.doesNotMatch(plain, han);
    assert.match(enHtml, /Hide answers first and tag mistake reasons on round results/);
    assert.doesNotMatch(uiMod.ui(entry.title), han);
    assert.doesNotMatch(uiMod.ui(entry.what), han);
  } finally {
    uiMod.setUiLanguage('zh');
  }
});

test('lookback-recall pure helpers mask cloze prompts and aggregate mistake reasons safely', () => {
  assert.equal(LOOKBACK_ERROR_REASONS.length, 4);
  assert.equal(reasonLabelOf('concept'), '概念混淆');
  assert.equal(reasonLabelOf('unknown'), '');

  const clozeRow = {
    number: 1,
    deckId: 'd1',
    cardId: 'c-cloze',
    status: 'wrong',
    card: {
      kind: 'cloze',
      prompt: 'Complete {{theorem}} identity.',
      cloze: { text: 'Bayes links {{posterior}} to prior.', blanks: [{ id: 'posterior' }] },
    },
  };
  assert.equal(maskedPromptOf(clozeRow), 'Complete ＿＿ identity.');
  assert.equal(maskedClozeTextOf(clozeRow), 'Bayes links ＿＿ to prior.');
  assert.equal(maskedClozeTextOf({ number: 2, card: { kind: 'quiz', prompt: 'MCQ?' } }), '');

  let map = {};
  const key1 = rowReasonKey(clozeRow);
  map = toggleRowReason(map, key1, 'concept');
  assert.equal(map[key1], 'concept');
  map = toggleRowReason(map, key1, 'invalid');
  assert.equal(map[key1], 'concept');
  map = toggleRowReason(map, key1, 'concept');
  assert.equal(key1 in map, false);

  const rows = [
    clozeRow,
    { number: 1, deckId: 'd1', cardId: 'c-cloze', status: 'wrong' }, // duplicate ref
    { number: 2, deckId: 'd2', cardId: 'c-ok', status: 'right' },
    { number: 3, deckId: 'd2', cardId: 'c-slip', status: 'wrong' },
  ];
  map = { 'd1:c-cloze': 'derivation', 'd2:c-ok': 'concept', 'd2:c-slip': 'slip' };
  assert.deepEqual(refsForReason(rows, map, 'derivation'), [{ deckId: 'd1', cardId: 'c-cloze' }]);
  assert.deepEqual(refsForReason(rows, map, 'concept'), [], 'right rows are never scheduled for wrong-reason retry');
  assert.deepEqual(
    reasonGroups(rows, map).map((g) => [g.id, g.refs.length]),
    [['derivation', 1], ['slip', 1]],
  );
});

test('RoundLookBack keeps baseline untouched when off, and enables blind recall + error reasons when on', () => {
  const sampleRows = [
    {
      number: 1,
      entryIndex: 0,
      deckId: 'd1',
      cardId: 'c1',
      kind: 'quiz',
      status: 'wrong',
      sourceTitle: 'Ch1',
      page: 4,
      card: {
        id: 'c1',
        kind: 'quiz',
        prompt: 'Which law governs entropy increase?',
        options: [{ id: 'a', text: 'Second Law' }, { id: 'b', text: 'First Law' }],
      },
      feedback: { selected: ['b'], correction: { keywordExpansion: 'Hidden feedback note' } },
      solution: {
        explanation: 'Hidden explanation secret',
        misconception: 'Confusing energy conservation with entropy',
        options: [{ id: 'a', correct: true, explanation: 'Correct secret' }],
      },
    },
    {
      number: 2,
      entryIndex: 1,
      deckId: 'd1',
      cardId: 'c2',
      kind: 'cloze',
      status: 'wrong',
      card: {
        id: 'c2',
        kind: 'cloze',
        prompt: 'Fill in {{blank1}} rule',
        cloze: { text: 'Carnot efficiency depends on {{blank1}} temperatures.', blanks: [{ id: 'blank1' }] },
      },
      feedback: { answers: { blank1: 'wrong' } },
      solution: { cloze: { answers: [{ id: 'blank1', value: 'reservoir' }] }, explanation: 'Carnot ratio secret' },
    },
    {
      number: 3,
      entryIndex: 2,
      deckId: 'd1',
      cardId: 'c3',
      kind: 'quiz',
      status: 'right',
      card: { id: 'c3', kind: 'quiz', prompt: 'Right question?', options: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }] },
      feedback: { selected: ['a'] },
      solution: { explanation: 'Good job', options: [{ id: 'a', correct: true }] },
    },
  ];
  const practiced = [];
  const services = { call: async () => ({ rows: sampleRows }), act: noop, busy: false, notify: noop, openModal: noop };
  const runOff = { id: 'run-off', mode: 'path', navigation: [{ answered: true }, { answered: true }, { answered: true }], correctionsPending: 0 };
  const runOn = { id: 'run-on', mode: 'path', navigation: [{ answered: true }, { answered: true }, { answered: true }], correctionsPending: 0 };

  uiMod.setUiLanguage('zh');
  try {
    // 1. Default OFF: answers stay directly visible with no veil/reason pills, while an in-page 先遮答案自测 toggle lets learners opt in
    uiMod.setQueryData('review.lookBack', { runId: runOff.id }, { rows: sampleRows });
    const appOff = mountSync(services);
    const propsOff = { run: runOff, onPracticeWrong: (refs) => practiced.push(refs) };
    let tree = appOff.render(uiMod.RoundLookBack, propsOff);
    let expandBtn = null;
    let offVeilToggle = null;
    walkTree(tree, (n) => {
      if (typeof n.type === 'string' || typeof n.props?.onClick !== 'function') return;
      const label = textOf(n).trim();
      if (!expandBtn && label === '全部展开') expandBtn = n;
      if (!offVeilToggle && label === '先遮答案自测') offVeilToggle = n;
    });
    assert.ok(expandBtn);
    assert.ok(offVeilToggle, 'in-page blind recall toggle is discoverable even when setting defaults off');
    assert.equal(offVeilToggle.props['aria-pressed'], false);
    expandBtn.props.onClick();
    tree = appOff.render(uiMod.RoundLookBack, propsOff);
    const offHtml = htmlOfElement(tree, services, null);
    assert.match(offHtml, /aria-pressed="false"[^>]*>先遮答案自测/);
    assert.doesNotMatch(offHtml, /揭晓答案与解析|错因归类/);
    assert.match(offHtml, /Hidden explanation secret/);
    // Clicking the in-page toggle activates blind recall without changing global settings
    offVeilToggle.props.onClick();
    tree = appOff.render(uiMod.RoundLookBack, propsOff);
    const triedOnHtml = htmlOfElement(tree, services, null);
    assert.match(triedOnHtml, /aria-pressed="true"[^>]*>先遮答案自测/);
    assert.match(triedOnHtml, /揭晓答案与解析/);
    assert.doesNotMatch(triedOnHtml, /Hidden explanation secret/);
    appOff.unmount();

    // 2. Opt-in ON via settings.practice.lookBackBlindRecall
    uiMod.setQueryData('review.lookBack', { runId: runOn.id }, { rows: sampleRows });
    const onSettings = { settings: { practice: { lookBackBlindRecall: true } } };
    const appOn = mountSync(services, onSettings);
    const propsOn = { run: runOn, onPracticeWrong: (refs) => practiced.push(refs), practiceSettings: { lookBackBlindRecall: true } };
    tree = appOn.render(uiMod.RoundLookBack, propsOn);

    // Toggle 先遮答案自测 starts active & expand all rows
    let veilToggle = null;
    let expandOnBtn = null;
    walkTree(tree, (n) => {
      if (typeof n.type === 'string' || typeof n.props?.onClick !== 'function') return;
      const label = textOf(n).trim();
      if (label === '先遮答案自测') veilToggle = n;
      if (label === '全部展开') expandOnBtn = n;
    });
    assert.ok(veilToggle);
    assert.equal(veilToggle.props['aria-pressed'], true);
    expandOnBtn.props.onClick();
    tree = appOn.render(uiMod.RoundLookBack, propsOn);

    // Veiled state hides wrong explanations/corrections & cloze {{answer}}, keeps neutral MCQ options
    const veiledHtml = htmlOfElement(tree, services, onSettings);
    assert.doesNotMatch(veiledHtml, /Hidden explanation secret/);
    assert.doesNotMatch(veiledHtml, /Carnot ratio secret/);
    assert.doesNotMatch(veiledHtml, /Hidden feedback note/);
    assert.match(veiledHtml, /Second Law/);
    assert.match(veiledHtml, /First Law/);
    assert.match(veiledHtml, /＿＿/);
    assert.match(veiledHtml, /揭晓答案与解析/);

    // Click 揭晓答案与解析 on the first wrong row
    const revealButtons = [];
    walkTree(tree, (n) => {
      if (typeof n.type === 'function' && n.type.name === 'LookBack' && n.props.onReveal) {
        revealButtons.push(n.props.onReveal);
      }
    });
    assert.equal(revealButtons.length, 2, 'two wrong rows have veil callbacks');
    revealButtons[0]();
    tree = appOn.render(uiMod.RoundLookBack, propsOn);

    const afterRevealHtml = htmlOfElement(tree, services, onSettings);
    assert.match(afterRevealHtml, /Hidden explanation secret/);
    assert.match(afterRevealHtml, /Hidden feedback note/);
    assert.doesNotMatch(afterRevealHtml, /Carnot ratio secret/, 'second wrong row stays veiled until revealed');
    assert.match(afterRevealHtml, /概念混淆/);

    // Tag row 1 as 'concept'
    let pickFirstConcept = null;
    walkTree(tree, (n) => {
      if (!pickFirstConcept && typeof n.type === 'function' && n.type.name === 'LookBack' && !n.props.veiled && n.props.showReasons && n.props.onPickReason) {
        pickFirstConcept = n.props.onPickReason;
      }
    });
    assert.ok(pickFirstConcept);
    pickFirstConcept('concept');
    tree = appOn.render(uiMod.RoundLookBack, propsOn);

    let reasonRetryBtn = null;
    walkTree(tree, (n) => {
      if (!reasonRetryBtn && typeof n.type !== 'string' && typeof n.props?.onClick === 'function' && textOf(n).includes('重练「概念混淆」(1)')) reasonRetryBtn = n;
    });
    assert.ok(reasonRetryBtn, 'per-reason retry button appears once a wrong row is tagged');
    assert.equal(reasonRetryBtn.props.iconEnd, 'arrow-right');
    reasonRetryBtn.props.onClick();
    assert.deepEqual(practiced.at(-1), [{ deckId: 'd1', cardId: 'c1' }]);

    // formatLookBackMarkdown includes the tagged reason when present and omits it when absent
    const md = uiMod.formatLookBackMarkdown(
      sampleRows.map((row) => ({ ...row, mode: 'path' })),
      uiMod.ui,
      { reasonsByKey: { 'd1:c1': 'concept' } },
    );
    assert.match(md, /\*\*错因归类\*\*：概念混淆/);

    // English rendering: zero Han characters when switched to EN
    uiMod.setUiLanguage('en');
    tree = appOn.render(uiMod.RoundLookBack, propsOn);
    const enHtml = htmlOfElement(tree, services, onSettings);
    const enPlain = enHtml.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    assert.doesNotMatch(enPlain, han, `unexpected Han in English UI: ${enPlain}`);
    assert.match(enPlain, /Practise “Confused concept” \(1\)/);
    assert.match(enPlain, /Hide answers to self-test/);
    assert.match(enPlain, /Reveal answer &amp; explanation|Reveal answer & explanation/);
    const mdEn = uiMod.formatLookBackMarkdown(
      [{ ...sampleRows[0], mode: 'path' }],
      uiMod.ui,
      { reasonsByKey: { 'd1:c1': 'concept' } },
    );
    assert.match(mdEn, /\*\*Mistake reason\*\*：Confused concept/);
    appOn.unmount();
  } finally {
    uiMod.setUiLanguage('zh');
  }
});

test('RoundLookBack preserves revealed rows and veil state when review.lookBack refreshes with updated errorReason', () => {
  const baseRows = [
    {
      number: 1,
      entryIndex: 0,
      deckId: 'd1',
      cardId: 'c1',
      kind: 'quiz',
      status: 'wrong',
      card: {
        id: 'c1',
        kind: 'quiz',
        prompt: 'Which law governs entropy increase?',
        options: [{ id: 'a', text: 'Second Law' }, { id: 'b', text: 'First Law' }],
      },
      feedback: { selected: ['b'] },
      solution: {
        explanation: 'Row1 explanation stays visible',
        options: [{ id: 'a', correct: true }],
      },
    },
    {
      number: 2,
      entryIndex: 1,
      deckId: 'd1',
      cardId: 'c2',
      kind: 'quiz',
      status: 'wrong',
      card: {
        id: 'c2',
        kind: 'quiz',
        prompt: 'What is Bayes rule?',
        options: [{ id: 'a', text: 'Posterior formula' }, { id: 'b', text: 'Prior only' }],
      },
      feedback: { selected: ['b'] },
      solution: {
        explanation: 'Row2 explanation stays hidden until revealed',
        options: [{ id: 'a', correct: true }],
      },
    },
  ];
  const runA = { id: 'run-refresh-a', mode: 'path', navigation: [{ answered: true }, { answered: true }], correctionsPending: 0 };
  const runB = { id: 'run-refresh-b', mode: 'path', navigation: [{ answered: true }, { answered: true }], correctionsPending: 0 };
  const services = { call: async () => ({ rows: baseRows }), act: noop, busy: false, notify: noop, openModal: noop };
  const onSettings = { settings: { practice: { lookBackBlindRecall: true } } };

  uiMod.setUiLanguage('zh');
  const app = mountSync(services, onSettings);
  try {
    uiMod.setQueryData('review.lookBack', { runId: runA.id }, { rows: baseRows });
    const propsA = { run: runA, onPracticeWrong: noop, practiceSettings: { lookBackBlindRecall: true } };
    let tree = app.render(uiMod.RoundLookBack, propsA);

    // Expand all rows, then reveal only row 1.
    let expandBtn = null;
    walkTree(tree, (n) => {
      if (!expandBtn && typeof n.type !== 'string' && typeof n.props?.onClick === 'function' && textOf(n).trim() === '全部展开') expandBtn = n;
    });
    assert.ok(expandBtn);
    expandBtn.props.onClick();
    tree = app.render(uiMod.RoundLookBack, propsA);

    const lookBacksBefore = [];
    walkTree(tree, (n) => { if (typeof n.type === 'function' && n.type.name === 'LookBack') lookBacksBefore.push(n); });
    assert.equal(lookBacksBefore.length, 2);
    assert.equal(lookBacksBefore[0].props.veiled, true);
    assert.equal(lookBacksBefore[1].props.veiled, true);

    lookBacksBefore[0].props.onReveal();
    tree = app.render(uiMod.RoundLookBack, propsA);

    // Simulate review.lookBack invalidation returning refreshed rows with persisted errorReason on row 1.
    const refreshedRows = [
      { ...baseRows[0], errorReason: 'condition' },
      { ...baseRows[1] },
    ];
    uiMod.setQueryData('review.lookBack', { runId: runA.id }, { rows: refreshedRows });
    tree = app.render(uiMod.RoundLookBack, propsA);
    // Render one more tick so state updates flushed by the reasons sync effect are reflected.
    tree = app.render(uiMod.RoundLookBack, propsA);

    const lookBacksAfter = [];
    walkTree(tree, (n) => { if (typeof n.type === 'function' && n.type.name === 'LookBack') lookBacksAfter.push(n); });
    assert.equal(lookBacksAfter.length, 2);
    assert.equal(lookBacksAfter[0].props.veiled, false, 'already revealed row must stay revealed after errorReason refresh');
    assert.equal(lookBacksAfter[0].props.reasonId, 'condition', 'refreshed errorReason must sync into reasonsByKey');
    assert.equal(lookBacksAfter[1].props.veiled, true, 'unrevealed row stays veiled');

    const htmlAfterRefresh = htmlOfElement(tree, services, onSettings);
    assert.match(htmlAfterRefresh, /Row1 explanation stays visible/);
    assert.doesNotMatch(htmlAfterRefresh, /Row2 explanation stays hidden until revealed/);

    // Toggle global veil off, then refresh rows again with another errorReason -> veil must stay off.
    let veilToggle = null;
    walkTree(tree, (n) => {
      if (!veilToggle && typeof n.type !== 'string' && typeof n.props?.onClick === 'function' && textOf(n).trim() === '先遮答案自测') veilToggle = n;
    });
    assert.ok(veilToggle);
    assert.equal(veilToggle.props['aria-pressed'], true);
    veilToggle.props.onClick();
    tree = app.render(uiMod.RoundLookBack, propsA);

    const refreshedAgain = [
      { ...baseRows[0], errorReason: 'concept' },
      { ...baseRows[1], errorReason: 'slip' },
    ];
    uiMod.setQueryData('review.lookBack', { runId: runA.id }, { rows: refreshedAgain });
    tree = app.render(uiMod.RoundLookBack, propsA);
    tree = app.render(uiMod.RoundLookBack, propsA);

    let veilToggleAfter = null;
    walkTree(tree, (n) => {
      if (!veilToggleAfter && typeof n.type !== 'string' && typeof n.props?.onClick === 'function' && textOf(n).trim() === '先遮答案自测') veilToggleAfter = n;
    });
    assert.equal(veilToggleAfter?.props['aria-pressed'], false, 'manually lifted veil must stay off after errorReason refresh');

    // Switching to a different run.id MUST reset veilActive back to recallEnabled and clear revealedRows.
    uiMod.setQueryData('review.lookBack', { runId: runB.id }, { rows: baseRows });
    const propsB = { run: runB, onPracticeWrong: noop, practiceSettings: { lookBackBlindRecall: true } };
    tree = app.render(uiMod.RoundLookBack, propsB);
    tree = app.render(uiMod.RoundLookBack, propsB);
    const lookBacksRunB = [];
    walkTree(tree, (n) => { if (typeof n.type === 'function' && n.type.name === 'LookBack') lookBacksRunB.push(n); });
    assert.equal(lookBacksRunB[0].props.veiled, true, 'switching to a new run re-enables the blind-recall veil');
    assert.equal(lookBacksRunB[0].props.reasonId, '', 'switching to a new run resets synced reasons');
  } finally {
    app.unmount();
    uiMod.setUiLanguage('zh');
  }
});
