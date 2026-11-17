import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { wrongBook } from '../lib/insights.js';

const compiled = await build({
  stdin: {
    contents: `export { WrongBookView } from './ui/WrongBook.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { buildWrongbookClinic } from './ui/wrongbook-clinic.js';
      export { setUiLanguage, uiCatalogue } from './ui/i18n.js';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
  loader: { '.css': 'text' },
});
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
for (const name of readdirSync(new URL('../ui/locales', import.meta.url))) {
  if (/^en(\..+)?\.json$/.test(name)) {
    Object.assign(module.exports.uiCatalogue(), JSON.parse(readFileSync(new URL(`../ui/locales/${name}`, import.meta.url), 'utf8')));
  }
}
const { WrongBookView, StudyServicesContext, buildWrongbookClinic, setUiLanguage } = module.exports;
const noop = () => {};
const han = /\p{Script=Han}/u;

test('wrongBook weak rows expose full-history wrongCount and lastWrongAt', () => {
  const fillers = Array.from({ length: 105 }, (_, i) => ({
    deckId: 'd1',
    quiz_id: `ok-${i}`,
    grade: 4,
    timestamp: `2026-10-02T00:${String(i % 60).padStart(2, '0')}:00Z`,
  }));
  const state = {
    decks: [{
      id: 'd1',
      title: 'Deck 1',
      cards: [
        { id: 'slip', kind: 'quiz', topic: 'A', prompt: 'Slip?' },
        { id: 'repeat', kind: 'quiz', topic: 'A', prompt: 'Repeat?' },
        ...Array.from({ length: 105 }, (_, i) => ({ id: `ok-${i}`, kind: 'quiz', topic: 'A', prompt: `OK ${i}` })),
      ],
    }],
    attempts: [
      { deckId: 'd1', quiz_id: 'repeat', grade: 1, timestamp: '2026-10-01T01:00:00Z' },
      ...fillers,
      { deckId: 'd1', quiz_id: 'repeat', grade: 1, timestamp: '2026-10-03T01:00:00Z' },
      { deckId: 'd1', quiz_id: 'slip', grade: 1, timestamp: '2026-10-03T02:00:00Z' },
    ],
    sources: [],
    runs: [],
  };
  const weak = wrongBook(state);
  const byId = Object.fromEntries(weak.items.map((item) => [item.cardId, item]));
  assert.equal(byId.slip.wrongCount, 1);
  assert.equal(byId.slip.lastWrongAt, '2026-10-03T02:00:00Z');
  assert.equal(byId.repeat.wrongCount, 2, 'early miss beyond 100-attempt snapshot window is counted');
  assert.equal(byId.repeat.lastWrongAt, '2026-10-03T01:00:00Z');
});

test('buildWrongbookClinic deterministically clusters source pages, companion slides, leeches, and single slips with full refs & 200-card cap', () => {
  assert.deepEqual(buildWrongbookClinic({ rows: [] }), []);
  assert.deepEqual(buildWrongbookClinic({
    rows: [{ deckId: 'd1', cardId: 'solo', leech: true, wrongCount: 4, lastAt: '2026-10-03T04:00:00Z' }],
  }), [], 'single mistake stays quiet per single-mistake restraint (#674)');

  const rows = [
    { deckId: 'd1', cardId: 'c1', leech: false, wrongCount: 1, lastAt: '2026-10-03T04:00:00Z' },
    { deckId: 'd1', cardId: 'c2', leech: false, wrongCount: 1, lastAt: '2026-10-03T03:00:00Z' },
    { deckId: 'd1', cardId: 'c3', leech: true, wrongCount: 4, lastAt: '2026-10-03T02:00:00Z' },
    { deckId: 'd1', cardId: 'c4', leech: false, wrongCount: 2, lastAt: '2026-10-03T01:00:00Z' },
  ];
  const srcA = { id: 'src-a', title: 'OS Lecture 03' };
  const sourceTargetByCard = new Map([
    ['c1', { source: srcA, quote: 'q1', peekPage: 7 }],
    ['c2', { source: srcA, quote: 'q2', peekPage: 7 }],
  ]);
  const companionTargetByCard = new Map([
    ['c3', { companionId: 'comp-1', course: 'OS', slide: 5, anchor: '#5', companionTitle: 'Scheduling Sandbox' }],
    ['c4', { companionId: 'comp-1', course: 'OS', slide: 5, anchor: '#5', companionTitle: 'Scheduling Sandbox' }],
  ]);

  const lanes = buildWrongbookClinic({ rows, sourceTargetByCard, companionTargetByCard });
  assert.deepEqual(lanes.map((lane) => lane.id), ['cluster', 'leech', 'singleSlip']);
  assert.equal(lanes[0].kind, 'source');
  assert.equal(lanes[0].page, 7);
  assert.deepEqual(lanes[0].scope.scope, [{ deckId: 'd1', cardId: 'c1' }, { deckId: 'd1', cardId: 'c2' }]);
  assert.equal(lanes[1].count, 1);
  assert.equal(lanes[1].partial, true);
  assert.deepEqual(lanes[1].scope.scope, [{ deckId: 'd1', cardId: 'c3' }]);
  assert.equal(lanes[2].count, 2);
  assert.deepEqual(lanes[2].scope.scope, [{ deckId: 'd1', cardId: 'c1' }, { deckId: 'd1', cardId: 'c2' }]);

  const compPriority = buildWrongbookClinic({
    rows: [
      ...rows,
      { deckId: 'd1', cardId: 'c5', leech: false, wrongCount: 2, lastAt: '2026-10-03T05:00:00Z' },
    ],
    sourceTargetByCard,
    companionTargetByCard: new Map([
      ...companionTargetByCard,
      ['c5', { companionId: 'comp-1', course: 'OS', slide: 5, anchor: '#5', companionTitle: 'Scheduling Sandbox' }],
    ]),
  });
  assert.equal(compPriority[0].id, 'cluster');
  assert.equal(compPriority[0].kind, 'companion');
  assert.equal(compPriority[0].slide, 5);
  assert.equal(compPriority[0].count, 3);

  const many = Array.from({ length: 210 }, (_, i) => ({
    deckId: 'd1',
    cardId: `m-${i}`,
    leech: true,
    wrongCount: 1,
    lastAt: '2026-10-03T01:00:00Z',
  }));
  const capped = buildWrongbookClinic({ rows: many });
  assert.equal(capped[0].id, 'leech');
  assert.equal(capped[0].partial, false);
  assert.equal(capped[0].refs.length, 210);
  assert.equal(capped[0].scope.total, 210);
  assert.equal(capped[0].scope.capped, true);
  assert.equal(capped[0].scope.scope.length, 200);
});

test('WrongBookView renders 靶向清零处方 only when settings.practice.wrongbookClinic is enabled, wires actions, excludes JSON citations, and handles >200 cap & English', () => {
  const srcPdf = {
    id: 'src-pdf',
    title: 'OS Notes · p. 12',
    format: 'pdf',
    document: { id: 'doc-1', format: 'pdf', bookTitle: 'OS Notes', page: 12 },
    text: 'Kernel schedules threads in round-robin order.',
  };
  const srcJson = {
    id: 'src-json',
    title: 'Imported JSON Deck',
    kind: 'deck-json',
    format: 'json',
  };
  const decks = [{
    id: 'd1',
    course: 'OS',
    title: 'OS｜Quiz 1',
    cards: [
      { id: 'c1', citations: [{ sourceId: 'src-pdf', quote: 'round-robin order', page: 12 }] },
      { id: 'c2', citations: [{ sourceId: 'src-pdf', quote: 'Kernel schedules threads', page: 12 }] },
      { id: 'c3', citations: [{ sourceId: 'src-json', quote: 'Imported stem', page: 1 }] },
      { id: 'c4', citations: [{ sourceId: 'src-json', quote: 'Imported stem 2', page: 1 }] },
    ],
  }];
  const items = [
    { deckId: 'd1', deckTitle: decks[0].title, cardId: 'c1', topic: 'Scheduling', kind: 'quiz', assessment: 'graded', prompt: 'Q1?', lastGrade: 1, wrongCount: 1, lastAt: '2026-10-03T04:00:00Z', leech: false },
    { deckId: 'd1', deckTitle: decks[0].title, cardId: 'c2', topic: 'Scheduling', kind: 'quiz', assessment: 'graded', prompt: 'Q2?', lastGrade: 1, wrongCount: 1, lastAt: '2026-10-03T03:00:00Z', leech: false },
    { deckId: 'd1', deckTitle: decks[0].title, cardId: 'c3', topic: 'Locks', kind: 'quiz', assessment: 'graded', prompt: 'Q3?', lastGrade: 1, wrongCount: 4, lastAt: '2026-10-03T02:00:00Z', leech: true },
    { deckId: 'd1', deckTitle: decks[0].title, cardId: 'c4', topic: 'Locks', kind: 'quiz', assessment: 'graded', prompt: 'Q4?', lastGrade: 1, wrongCount: 2, lastAt: '2026-10-03T01:00:00Z', leech: false },
  ];
  const practiceCalls = [];
  const notifications = [];
  const modals = [];
  const baseProps = {
    data: {
      root: 'r',
      decks,
      sources: [srcPdf, srcJson],
      focus: { course: 'OS', courses: [{ name: 'OS' }] },
      model: { ready: true },
      settings: { practice: { wrongbookClinic: false } },
    },
    course: 'OS',
    onCourse: noop,
    items,
    counts: { total: 4, graded: 4, self: 0, oral: 0, rubric: 0 },
    view: 'weak',
    onView: noop,
    viewCounts: { weak: 4, history: 1 },
    loading: false,
    err: '',
    page: 0,
    pageSize: 100,
    hasMore: false,
    onReload: noop,
    onPage: noop,
    recs: { items: [] },
    coach: { enabled: true, consent: true, ready: 0, preparing: false, preparingCards: [], readyCards: [], failedCards: [], tasks: [] },
    details: {},
    onLoadDetail: noop,
    onPractice: (scope) => { practiceCalls.push(scope); return true; },
    onNotify: (msg) => notifications.push(msg),
    onGenerate: async () => ({}),
    onOpenSettings: noop,
    busy: false,
    filterMin: 1,
  };

  setUiLanguage('zh');
  const offHtml = renderToStaticMarkup(React.createElement(
    StudyServicesContext.Provider,
    { value: { openModal: (m) => modals.push(m), busy: false } },
    React.createElement(WrongBookView, baseProps),
  ));
  assert.doesNotMatch(offHtml, /wb-clinic|靶向清零处方/);

  const onProps = {
    ...baseProps,
    data: { ...baseProps.data, settings: { practice: { wrongbookClinic: true } } },
  };
  const onHtml = renderToStaticMarkup(React.createElement(
    StudyServicesContext.Provider,
    { value: { openModal: (m) => modals.push(m), busy: false } },
    React.createElement(WrongBookView, onProps),
  ));
  assert.match(onHtml, /wb-clinic/);
  assert.match(onHtml, /靶向清零处方/);
  assert.match(onHtml, /同页错题 · 《OS Notes · p\. 12》第 12 页/);
  assert.doesNotMatch(onHtml, /Imported JSON Deck/, 'JSON deck citations are never clustered as PDF materials');
  assert.match(onHtml, /顽固题专项/);
  assert.match(onHtml, /单次失误速清/);

  // Single-mistake list never shows clinic
  const singleHtml = renderToStaticMarkup(React.createElement(
    StudyServicesContext.Provider,
    { value: { openModal: () => {}, busy: false } },
    React.createElement(WrongBookView, { ...onProps, items: [items[2]], counts: { total: 1, graded: 1, self: 0, oral: 0, rubric: 0 } }),
  ));
  assert.doesNotMatch(singleHtml, /wb-clinic|靶向清零处方/);

  // All-leech list hides redundant 只看顽固题 button
  const allLeechHtml = renderToStaticMarkup(React.createElement(
    StudyServicesContext.Provider,
    { value: { openModal: () => {}, busy: false } },
    React.createElement(WrongBookView, {
      ...onProps,
      items: items.slice(0, 2).map((item) => ({ ...item, leech: true })),
      counts: { total: 2, graded: 2, self: 0, oral: 0, rubric: 0 },
    }),
  ));
  assert.doesNotMatch(allLeechHtml, /只看顽固题/);

  const historyHtml = renderToStaticMarkup(React.createElement(
    StudyServicesContext.Provider,
    { value: { openModal: (m) => modals.push(m), busy: false } },
    React.createElement(WrongBookView, { ...onProps, view: 'history' }),
  ));
  assert.doesNotMatch(historyHtml, /wb-clinic|靶向清零处方/);

  // Inspect React tree to invoke clinic buttons directly without changing component state
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = [];
  let cursor = 0;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const prev = internals.H;
  internals.H = {
    useContext: (ctx) => (ctx === StudyServicesContext ? { openModal: (m) => modals.push(m), busy: false } : ctx._currentValue),
    useState: (init) => { const i = cursor++; if (!(i in hooks)) hooks[i] = [typeof init === 'function' ? init() : init, () => {}]; return hooks[i]; },
    useRef: (init) => { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
    useMemo: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
    useCallback: (fn, deps) => internals.H.useMemo(() => fn, deps),
    useEffect: () => { cursor++; },
    useLayoutEffect: () => { cursor++; },
    useInsertionEffect: () => { cursor++; },
    useId: () => { const i = cursor++; return `:wbc-${i}:`; },
    useDeferredValue: (v) => v,
  };
  let clinicNode = null;
  let clinicTree = null;
  const findClinic = (node) => {
    if (!node || typeof node !== 'object' || clinicNode) return;
    if (Array.isArray(node)) { node.forEach(findClinic); return; }
    if (typeof node.type === 'function' && node.props?.lanes) { clinicNode = node; return; }
    findClinic(node.props?.children);
  };
  try {
    findClinic(WrongBookView(onProps));
    assert.ok(clinicNode, 'WrongBookClinic element exists');
    clinicTree = clinicNode.type(clinicNode.props);
  } finally {
    internals.H = prev;
  }
  const collectButtons = (node, out = []) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { node.forEach((n) => collectButtons(n, out)); return out; }
    if (typeof node.props?.onClick === 'function') out.push(node);
    collectButtons(node.props?.children, out);
    return out;
  };
  const buttons = collectButtons(clinicTree);
  const byLabel = (text) => buttons.find((btn) => String(btn.props.children).includes(text));
  byLabel('先看原文').props.onClick();
  assert.equal(modals.length, 1);
  assert.equal(modals[0].type, 'source');
  assert.equal(modals[0].peekPage, 12);
  assert.equal(modals[0].back, true);

  byLabel('练这 2 题').props.onClick();
  assert.deepEqual(practiceCalls[0], [{ deckId: 'd1', cardId: 'c1' }, { deckId: 'd1', cardId: 'c2' }]);

  byLabel('练顽固题 (1)').props.onClick();
  assert.deepEqual(practiceCalls[1], [{ deckId: 'd1', cardId: 'c3' }]);

  byLabel('速清 2 题').props.onClick();
  assert.deepEqual(practiceCalls[2], [{ deckId: 'd1', cardId: 'c1' }, { deckId: 'd1', cardId: 'c2' }]);

  // Verify >200 cards in clinic fires cap notification via practiceScope
  const manyItems = Array.from({ length: 205 }, (_, i) => ({
    deckId: 'd1',
    deckTitle: 'OS',
    cardId: `bulk-${i}`,
    topic: 'Bulk',
    kind: 'quiz',
    assessment: 'graded',
    prompt: `Bulk ${i}`,
    lastGrade: 1,
    wrongCount: 4,
    lastAt: '2026-10-03T01:00:00Z',
    leech: true,
  }));
  const capHooks = [];
  let capCursor = 0;
  let capClinic = null;
  let capClinicTree = null;
  const findCapClinic = (node) => {
    if (!node || typeof node !== 'object' || capClinic) return;
    if (Array.isArray(node)) { node.forEach(findCapClinic); return; }
    if (typeof node.type === 'function' && node.props?.lanes) { capClinic = node; return; }
    findCapClinic(node.props?.children);
  };
  const prev2 = internals.H;
  internals.H = {
    useContext: (ctx) => (ctx === StudyServicesContext ? { openModal: () => {}, busy: false } : ctx._currentValue),
    useState: (init) => { const i = capCursor++; if (!(i in capHooks)) capHooks[i] = [typeof init === 'function' ? init() : init, () => {}]; return capHooks[i]; },
    useRef: (init) => { const i = capCursor++; if (!(i in capHooks)) capHooks[i] = { current: init }; return capHooks[i]; },
    useMemo: (fn, deps) => { const i = capCursor++; if (!(i in capHooks) || !sameDeps(capHooks[i].deps, deps)) capHooks[i] = { deps, value: fn() }; return capHooks[i].value; },
    useCallback: (fn, deps) => internals.H.useMemo(() => fn, deps),
    useEffect: () => { capCursor++; },
    useLayoutEffect: () => { capCursor++; },
    useInsertionEffect: () => { capCursor++; },
    useId: () => { const i = capCursor++; return `:wbc2-${i}:`; },
    useDeferredValue: (v) => v,
  };
  try {
    findCapClinic(WrongBookView({
      ...onProps,
      items: manyItems,
      counts: { total: 205, graded: 205, self: 0, oral: 0, rubric: 0 },
    }));
    capClinicTree = capClinic.type(capClinic.props);
  } finally {
    internals.H = prev2;
  }
  const capBtn = collectButtons(capClinicTree).find((btn) => String(btn.props.children).includes('练顽固题 (200)'));
  assert.ok(capBtn);
  capBtn.props.onClick();
  assert.equal(practiceCalls.at(-1).length, 200);
  assert.match(notifications.at(-1) || '', /205.*200|共选了 205 道题/);

  setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(React.createElement(
      StudyServicesContext.Provider,
      { value: { openModal: () => {}, busy: false } },
      React.createElement(WrongBookView, onProps),
    ));
    assert.doesNotMatch(enHtml, han);
    assert.match(enHtml, /Targeted clear-out plan/);
    assert.match(enHtml, /Single-slip quick sweep/);
  } finally {
    setUiLanguage('zh');
  }
});
