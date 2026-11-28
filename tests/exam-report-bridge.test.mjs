import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  PRACTICE_DEFAULTS,
  examPostmortemBridge,
  mergePracticeSettings,
  resolvePracticeSettings,
  validatePracticePatch,
} from '../lib/practice-settings.js';
import { examReport } from '../lib/study-state.js';
import { buildExamPostmortem } from '../ui/exam/exam-postmortem.js';
import { nativeSelects } from './helpers/native-selects.mjs';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `export { default as PracticePane } from './ui/settings/PracticePane.jsx';
      export { FINDER_ENTRIES } from './ui/finder/entries.js';
      export { default as WrittenReport } from './ui/exam/WrittenReport.jsx';
      export { ENGLISH_SOURCES, mergeCatalogues, setUiLanguage, ui, uiCatalogue, uiFormat } from './ui/i18n.js';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@base-ui/*'],
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
const textOf = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const english = (fn) => {
  ssr.setUiLanguage('en');
  try { return fn(); } finally { ssr.setUiLanguage('zh'); }
};

function collectNodes(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => collectNodes(n, pred, out)); return out; }
  if (pred(node)) out.push(node);
  collectNodes(node.props?.children, pred, out);
  if (typeof node.type === 'function') {
    try { collectNodes(node.type(node.props), pred, out); } catch { /* ignore hooks/context components */ }
  }
  return out;
}

test('examPostmortemBridge setting defaults off, round-trips through mergePracticeSettings/validatePracticePatch, and leaves PRACTICE_DEFAULTS keys unchanged', () => {
  const baselineKeys = ['autopilot', 'roundSize', 'newCardOrder', 'debrief', 'rereadMarks', 'leechFailures', 'leechWindow', 'leechRate'];
  assert.deepEqual(Object.keys(PRACTICE_DEFAULTS), baselineKeys);
  assert.deepEqual(Object.keys(resolvePracticeSettings(undefined)), baselineKeys);
  assert.equal(examPostmortemBridge(undefined), false);

  const enabled = mergePracticeSettings(undefined, { examPostmortemBridge: true });
  assert.equal(enabled.examPostmortemBridge, true);
  assert.equal(examPostmortemBridge(enabled), true);

  const cleared = mergePracticeSettings(enabled, { examPostmortemBridge: null });
  assert.equal('examPostmortemBridge' in cleared, false);
  assert.equal(examPostmortemBridge(cleared), false);

  assert.deepEqual(validatePracticePatch({ examPostmortemBridge: true }), { examPostmortemBridge: true });
  assert.throws(() => mergePracticeSettings(undefined, { examPostmortemBridge: 'on' }), /examPostmortemBridge/);
});

test('PracticePane and Finder expose opt-in examPostmortemBridge toggle cleanly in Chinese and English', async () => {
  ssr.setUiLanguage('zh');
  const input = (html, name) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? '';
  const offHtml = renderToStaticMarkup(h(ssr.PracticePane, { data: { settings: {} }, busy: false, act: noop }));
  assert.doesNotMatch(input(offHtml, 'examPostmortemBridge'), /checked/);

  const onHtml = renderToStaticMarkup(h(ssr.PracticePane, {
    data: { settings: { practice: { examPostmortemBridge: true } } },
    busy: false,
    act: noop,
  }));
  assert.match(input(onHtml, 'examPostmortemBridge'), /checked/);

  const entry = ssr.FINDER_ENTRIES.find((item) => item.id === 'exam-report-bridge');
  assert.ok(entry);
  assert.equal(entry.area, 'practice');

  const interactive = await loadInteractiveUi(`
    export { default as PracticePane } from './ui/settings/PracticePane.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
  `);
  const actions = [];
  const recordAct = async (action, args) => {
    actions.push({ action, args });
    return { ok: true };
  };
  const paneProps = { data: { settings: {} }, busy: false, act: recordAct };
  const mounted = interactive.mount(() => interactive.React.createElement(
    interactive.exports.StudyServicesContext.Provider,
    { value: { openSettings: noop, host: {} } },
    interactive.React.createElement(interactive.exports.PracticePane, paneProps),
  ));
  try {
    const toggleInput = () => mounted.find((n) => n.type === 'input' && n.props?.name === 'examPostmortemBridge');
    assert.equal(toggleInput()?.props?.checked, false);
    await mounted.act(() => toggleInput().props.onChange({ target: { checked: true } }));
    assert.deepEqual(actions[0], { action: 'settings.practice.set', args: { patch: { examPostmortemBridge: true } } });

    paneProps.data = { settings: { practice: { examPostmortemBridge: true } } };
    mounted.rerender();
    assert.equal(toggleInput()?.props?.checked, true);
    await mounted.act(() => toggleInput().props.onChange({ target: { checked: false } }));
    assert.deepEqual(actions[1], { action: 'settings.practice.set', args: { patch: { examPostmortemBridge: null } } });
  } finally {
    mounted.unmount();
  }

  english(() => {
    const enHtml = renderToStaticMarkup(h(ssr.PracticePane, { data: { settings: {} }, busy: false, act: noop }));
    assert.doesNotMatch(textOf(enHtml), han);
    assert.match(enHtml, /Split wrong &amp; skipped in written exam report with source links/);
    assert.doesNotMatch(textOf(ssr.ui(entry.title)), han);
    assert.doesNotMatch(textOf(ssr.ui(entry.what)), han);
  });
});

test('buildExamPostmortem separates attempted accuracy, deduplicates wrong vs skipped scopes, and filters live sources', () => {
  const report = {
    total: 6,
    answered: 4,
    correct: 3,
    wrong: [
      { deckId: 'd1', cardId: 'c1', topic: 'Locks', prompt: 'Mutex vs Spinlock?', kind: 'quiz' },
      { deckId: 'd1', cardId: 'c1', topic: 'Locks', prompt: 'Mutex vs Spinlock?', kind: 'quiz' },
    ],
    skipped: [
      { deckId: 'd1', cardId: 'c2', topic: 'Paging', prompt: 'TLB shootdown?', kind: 'quiz' },
      { deckId: 'd1', cardId: 'c3', topic: 'Deadlock', prompt: 'Banker safety?', kind: 'truefalse' },
    ],
  };
  const decks = [{
    id: 'd1',
    cards: [
      { id: 'c1', citations: [{ sourceId: 'src-deleted', quote: 'Old quote' }, { sourceId: 'src-live', quote: 'Mutex sleeps when contented.' }] },
      { id: 'c2', citations: [{ sourceId: 'src-arch', quote: 'Archived quote' }] },
      { id: 'c3', citations: [{ sourceId: 'src-missing', quote: 'Gone quote' }] },
    ],
  }];
  const sources = [
    { id: 'src-deleted', deleted: true },
    { id: 'src-arch', archived: true },
    { id: 'src-live', title: 'OS Ch5' },
  ];

  const out = buildExamPostmortem(report, { decks, sources });
  assert.equal(out.answeredAccuracyPct, 75);
  assert.deepEqual(out.wrongScope, [{ deckId: 'd1', cardId: 'c1' }]);
  assert.deepEqual(out.skippedScope, [{ deckId: 'd1', cardId: 'c2' }, { deckId: 'd1', cardId: 'c3' }]);
  assert.deepEqual(out.citationsByCard.get('d1:c1'), { sourceId: 'src-live', quote: 'Mutex sleeps when contented.' });
  assert.equal(out.citationsByCard.has('d1:c2'), false);
  assert.equal(out.citationsByCard.has('d1:c3'), false);

  assert.equal(buildExamPostmortem({ answered: 0, correct: 0 }).answeredAccuracyPct, null);
});

test('WrittenReport keeps default-off parity and enables split remediation + source links in Chinese and English', () => {
  const report = {
    runId: 'exam-1',
    total: 6,
    answered: 4,
    unanswered: 2,
    correct: 3,
    scorePct: 50,
    durationMs: 120000,
    byTopic: [{ deckId: 'd1', deckTitle: 'OS', topic: 'Locks', correct: 3, total: 6 }],
    wrong: [{ deckId: 'd1', cardId: 'c1', topic: 'Locks', prompt: 'Mutex vs Spinlock?', kind: 'quiz' }],
    skipped: [
      { deckId: 'd1', cardId: 'c2', topic: 'Locks', prompt: 'TLB shootdown?', kind: 'quiz' },
      { deckId: 'd1', cardId: 'c3', topic: 'Locks', prompt: 'Banker safety?', kind: 'truefalse' },
    ],
    weakScope: [{ deckId: 'd1', cardId: 'c1' }, { deckId: 'd1', cardId: 'c2' }, { deckId: 'd1', cardId: 'c3' }],
  };
  const decks = [{
    id: 'd1',
    cards: [
      { id: 'c1', citations: [{ sourceId: 's1', quote: 'Mutex sleeps on contention.' }] },
      { id: 'c2', citations: [] },
    ],
  }];
  const sources = [{ id: 's1', title: 'OS Ch5' }];

  ssr.setUiLanguage('zh');
  const offHtml = renderToStaticMarkup(h(ssr.WrittenReport, {
    report,
    busy: false,
    pathNote: '',
    decks,
    sources,
    onQueueWeak: noop,
    onPracticeTopic: noop,
    onPracticeScope: noop,
    onOpenSource: noop,
    onExit: noop,
    onAgain: noop,
  }));
  assert.doesNotMatch(offHtml, /data-exam-postmortem-pacing|data-exam-weak-split|打开出处|去练这道题/);

  const practiced = [];
  const opened = [];
  const onProps = {
    report,
    busy: false,
    pathNote: '',
    practiceSettings: { examPostmortemBridge: true },
    decks,
    sources,
    onQueueWeak: noop,
    onPracticeTopic: noop,
    onPracticeScope: (scope) => practiced.push(scope),
    onOpenSource: (sourceId, quote) => opened.push({ sourceId, quote }),
    onExit: noop,
    onAgain: noop,
  };
  const onHtml = renderToStaticMarkup(h(ssr.WrittenReport, onProps));
  assert.match(onHtml, /data-exam-postmortem-pacing/);
  assert.match(textOf(onHtml), /已作答部分正确率 75%（3\/4）· 未作答 2 题/);
  assert.match(textOf(onHtml), /只练答错（1）/);
  assert.match(textOf(onHtml), /补做未答（2）/);
  assert.match(textOf(onHtml), /打开出处/);
  assert.match(textOf(onHtml), /去练这道题/);

  const tree = hooklessSsr.WrittenReport(onProps);
  const wrongBtn = collectNodes(tree, (n) => String(n.props?.children) === '只练答错（1）')[0];
  const skippedBtn = collectNodes(tree, (n) => String(n.props?.children) === '补做未答（2）')[0];
  const srcBtn = collectNodes(tree, (n) => String(n.props?.children) === '打开出处')[0];
  const itemBtn = collectNodes(tree, (n) => String(n.props?.children) === '去练这道题')[0];
  wrongBtn.props.onClick();
  skippedBtn.props.onClick();
  srcBtn.props.onClick();
  itemBtn.props.onClick();
  assert.deepEqual(practiced, [
    [{ deckId: 'd1', cardId: 'c1' }],
    [{ deckId: 'd1', cardId: 'c2' }, { deckId: 'd1', cardId: 'c3' }],
    [{ deckId: 'd1', cardId: 'c1' }],
  ]);
  assert.deepEqual(opened, [{ sourceId: 's1', quote: 'Mutex sleeps on contention.' }]);

  english(() => {
    const enHtml = renderToStaticMarkup(h(ssr.WrittenReport, onProps));
    assert.doesNotMatch(textOf(enHtml), han);
    assert.match(textOf(enHtml), /Answered accuracy 75% \(3\/4\) · 2 unanswered/);
    assert.match(textOf(enHtml), /Practise wrong \(1\)/);
    assert.match(textOf(enHtml), /Practise unanswered \(2\)/);
    assert.match(textOf(enHtml), /Open source/);
    assert.match(textOf(enHtml), /Practise this question/);
  });
});

test('examReport + snapshot-shaped decks (without cards) still resolve usable citations & selections while excluding JSON-card sources', async () => {
  const wrongCard = {
    id: 'c-wrong',
    topic: 'Scheduling',
    prompt: 'Why use CFS?',
    kind: 'quiz',
    citations: [
      { sourceId: 'src-json', quote: 'Imported JSON self-cite' },
      { sourceId: 'src-live', quote: 'CFS tracks virtual runtime.' },
    ],
  };
  const skippedCard = {
    id: 'c-skip',
    topic: 'Memory',
    prompt: 'What is thrashing?',
    kind: 'quiz',
    citations: [],
    selections: [{ sourceId: 'src-arch', quote: 'Archived selection' }, { sourceId: 'src-live', quote: 'Working set exceeds frames.' }],
  };
  const run = {
    id: 'exam-snap',
    mode: 'exam',
    deckId: 'd1',
    startedAt: '2026-11-17T00:00:00Z',
    submittedAt: '2026-11-17T00:05:00Z',
    closedAt: '2026-11-17T00:05:00Z',
    entries: [
      { deckId: 'd1', card: wrongCard, feedback: { correct: false } },
      { deckId: 'd1', card: skippedCard },
    ],
  };
  const state = {
    decks: [{ id: 'd1', title: 'OS', cards: [wrongCard, skippedCard] }],
    runs: [run],
  };
  const report = examReport(state, run);
  // Real runtime snapshot.decks uses deckRow(d) without .cards.
  const snapshotDecks = [{ id: 'd1', title: 'OS', count: 2, available: 2 }];
  const sources = [
    { id: 'src-json', title: 'Imported', provenance: 'json-card-self-reference' },
    { id: 'src-arch', title: 'Old handout', archived: true },
    { id: 'src-live', title: 'OS Textbook' },
  ];

  const postmortem = buildExamPostmortem(report, { decks: snapshotDecks, sources });
  assert.deepEqual(postmortem.citationsByCard.get('d1:c-wrong'), { sourceId: 'src-live', quote: 'CFS tracks virtual runtime.' });
  assert.deepEqual(postmortem.citationsByCard.get('d1:c-skip'), { sourceId: 'src-live', quote: 'Working set exceeds frames.' });

  ssr.setUiLanguage('zh');
  const html = renderToStaticMarkup(h(ssr.WrittenReport, {
    report,
    busy: false,
    pathNote: '',
    practiceSettings: { examPostmortemBridge: true },
    decks: snapshotDecks,
    sources,
    onQueueWeak: noop,
    onPracticeTopic: noop,
    onPracticeScope: noop,
    onOpenSource: noop,
    onExit: noop,
    onAgain: noop,
  }));
  assert.equal((html.match(/打开出处/g) || []).length, 2);

  // Interactive Exam mount: verify pathNote & missing-deckId guard, onAgain returning to setup (exam.leave), and onStart entering a fresh exam (exam.enter).
  const examMod = await loadInteractiveUi(`
    export { default as Exam } from './ui/Exam.jsx';
    export { default as WrittenReport } from './ui/exam/WrittenReport.jsx';
    export { default as WrittenSetup } from './ui/exam/WrittenSetup.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
  `);
  const { Exam, WrittenReport, WrittenSetup, StudyServicesContext } = examMod.exports;
  const startCalls = [];
  const fakeCall = async (action, args) => {
    if (action === 'review.get') return { ...run, complete: true };
    if (action === 'exam.report') return report;
    if (action === 'exam.submit') return { ...report, runId: args.runId };
    if (action === 'review.start') {
      startCalls.push(args);
      if (args.mode === 'exam') {
        return {
          id: 'exam-next',
          mode: 'exam',
          deckId: 'd1',
          index: 0,
          total: 1,
          startedAt: new Date().toISOString(),
          card: wrongCard,
          picks: [],
        };
      }
      return { id: 'path-1', mode: 'path', deckId: 'd1', index: 0, total: 1, card: wrongCard };
    }
    return {};
  };
  const examData = {
    root: '/tmp/exam-report-bridge',
    decks: [{ id: 'd1', title: 'OS', count: 2, available: 2, examCount: 2, examQuizCount: 2 }],
    sources,
    runs: [],
    settings: { practice: { examPostmortemBridge: true } },
    focus: { course: '*', courses: [] },
  };
  await withBrowserGlobals(async () => {
    const mounted = examMod.mount(() => examMod.React.createElement(
      StudyServicesContext.Provider,
      { value: { call: fakeCall, act: async () => ({}), busy: false, host: {} } },
      examMod.React.createElement(Exam, {
        data: examData,
        initialRunId: 'exam-snap',
        onExit: noop,
        onCreate: noop,
        onOpenSource: noop,
      }),
    ));
    try {
      await mounted.flush(6);
      const reportNode = () => mounted.find((n) => n.type === WrittenReport);
      assert.ok(reportNode(), 'Exam restores saved report when mounted with initialRunId');
      assert.equal(reportNode().props.pathNote, '');

      // Missing deckId must be ignored by practiceTopic
      await mounted.act(() => reportNode().props.onPracticeTopic({ topic: 'MissingDeck' }));
      assert.equal(startCalls.length, 0, 'practiceTopic ignores rows without deckId');
      assert.equal(reportNode().props.pathNote, '');

      // Valid topic queues path practice and sets pathNote (because onStartRun is omitted)
      await mounted.act(() => reportNode().props.onPracticeTopic({ deckId: 'd1', topic: 'Scheduling' }));
      assert.equal(startCalls.length, 1);
      assert.equal(startCalls[0].mode, 'path');
      assert.match(reportNode().props.pathNote, /Scheduling/, 'pathNote records queued topic');

      // While pathNote is active, further topic/weak/scope clicks must not queue duplicate runs
      await mounted.act(() => reportNode().props.onPracticeTopic({ deckId: 'd1', topic: 'Memory' }));
      await mounted.act(() => reportNode().props.onQueueWeak());
      await mounted.act(() => reportNode().props.onPracticeScope([{ deckId: 'd1', cardId: 'c-wrong' }]));
      assert.equal(startCalls.length, 1, 'active pathNote prevents duplicate review.start calls');

      // Clicking onAgain clears pathNote and leaves report phase back to setup (exam.leave({ clear: false }))
      await mounted.act(() => reportNode().props.onAgain());
      assert.equal(reportNode(), null, 'onAgain leaves report phase');
      const setupNode = mounted.find((n) => n.type === WrittenSetup);
      assert.ok(setupNode, 'onAgain returns Exam to WrittenSetup');

      // Starting a new exam enters running phase (exam.enter(r)) and renders the live question
      await mounted.act(() => setupNode.props.onStart());
      assert.equal(startCalls.length, 2);
      assert.equal(startCalls[1].mode, 'exam');
      assert.match(mounted.text(), /Why use CFS\?/, 'startExam enters running phase with the exam card');

      // A second completed exam must not inherit the first report's practice notice.
      const submit = mounted.find((n) => n.type === 'button' && examMod.textOf(n).trim() === '交卷');
      assert.ok(submit, 'the second exam is running and can be submitted');
      await mounted.act(() => click(submit));
      const confirm = mounted.find((n) => typeof n.props?.onConfirm === 'function' && n.props.onJumpFirstBlank);
      if (confirm) await mounted.act(() => confirm.props.onConfirm());
      await mounted.flush(12);
      assert.equal(reportNode().props.report.runId, 'exam-next', 'the second exam shows its own report');
      assert.equal(reportNode().props.pathNote, '', 'the second report must clear the first practice notice');
    } finally {
      mounted.unmount();
    }
  });
});

const missReport = { runId: 'exam-2', total: 3, answered: 1, unanswered: 2, correct: 0, scorePct: 0, durationMs: 1000,
  byTopic: [{ deckId: 'd1', deckTitle: 'OS', topic: 'Locks', correct: 0, total: 3 }],
  wrong: [{ deckId: 'd1', cardId: 'c1', topic: 'Locks', prompt: 'a?', kind: 'quiz' }],
  skipped: [{ deckId: 'd1', cardId: 'c2', topic: 'Locks', prompt: 'b?', kind: 'quiz' }, { deckId: 'd1', cardId: 'c3', topic: 'Locks', prompt: 'c?', kind: 'quiz' }],
  weakScope: [{ deckId: 'd1', cardId: 'c1' }, { deckId: 'd1', cardId: 'c2' }, { deckId: 'd1', cardId: 'c3' }] };
const missProps = { report: missReport, busy: false, pathNote: '', onQueueWeak: noop, onPracticeTopic: noop, onPracticeScope: noop, onTogglePostmortem: async () => true, onExit: noop, onAgain: noop };
const reportButtons = (html) => [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g)].map(([, cls, inner]) => ({ cls, text: textOf(inner) }));
const filledOf = (props) => reportButtons(renderToStaticMarkup(h(ssr.WrittenReport, props))).filter((button) => /sh-btn--primary/.test(button.cls)).map((button) => button.text);

test('#1687: with wrong or unanswered questions the one filled button practises them; going back is plain', () => {
  ssr.setUiLanguage('zh');
  assert.deepEqual(filledOf(missProps), ['练习答错与未答的 3 道'], 'one filled button, and it practises the misses');
  assert.match(reportButtons(renderToStaticMarkup(h(ssr.WrittenReport, missProps))).find((button) => button.text === '回学习库').cls, /sh-btn--secondary/);
  // All right: going back stays the filled button.
  const clean = { ...missReport, correct: 3, answered: 3, unanswered: 0, scorePct: 100, wrong: [], skipped: [], weakScope: [], byTopic: [{ ...missReport.byTopic[0], correct: 3 }] };
  assert.deepEqual(filledOf({ ...missProps, report: clean }), ['回学习库']);
  // A practice that cannot start now (pathNote) does not take the filled button either.
  assert.deepEqual(filledOf({ ...missProps, pathNote: '先完成学习路径' }), ['回学习库']);
});

test('#1707: the split of wrong and unanswered is a switch that shows on or off, with the same words either way', () => {
  ssr.setUiLanguage('zh');
  const row = (markup) => markup.match(/<label class="sh-check sh-switch[^"]*"[\s\S]*?<\/label>/)?.[0] || '';
  const off = renderToStaticMarkup(h(ssr.WrittenReport, missProps));
  assert.match(row(off), /role="switch"/);
  assert.match(textOf(row(off)), /拆分答错与未答/);
  assert.doesNotMatch(row(off), /\schecked=""/);
  const on = renderToStaticMarkup(h(ssr.WrittenReport, { ...missProps, practiceSettings: { examPostmortemBridge: true } }));
  assert.match(row(on), /\schecked=""/);
  assert.doesNotMatch(textOf(on), /收起错题拆分/, 'switched on, the same switch says so; no second label');
});
