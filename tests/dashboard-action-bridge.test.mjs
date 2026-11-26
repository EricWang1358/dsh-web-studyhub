import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';
import { studyStats } from '../lib/insights.js';

const m = await loadUi(`
  export { TrendPanel, ForecastPanel, MasteryPanel } from './ui/charts/DashboardCharts.jsx';
  export { StatsView } from './ui/Dashboard.jsx';
  export { default as Skeleton } from './ui/Skeleton.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const NOW = new Date(2026, 9, 2, 12, 0, 0);
const at = (days, hour = 9) => new Date(2026, 9, 2 + days, hour, 0, 0).toISOString();
const due = (days, hour = 9) => ({ repetitions: 2, interval_days: 6, ease: 2.5, due_at: at(days, hour) });
const card = (id, patch = {}) => ({ id, kind: 'flashcard', topic: 'T', prompt: `${id}?`, answer: 'a', review: due(1), ...patch });
const attempt = (deckId, quiz_id, grade, days = 0, extra = {}) => ({ deckId, quiz_id, grade, assessment: 'self', timestamp: at(days, 10), ...extra });
const library = (decks, attempts = []) => ({ decks, attempts, runs: [], sources: [], focus: {}, learner: undefined });

function renderTree(element, hookStore = new Map()) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const prev = internals.H;
  function walk(node, path = 'root') {
    if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) return node.map((child, idx) => walk(child, `${path}.${idx}`));
    if (typeof node === 'object' && node.type) {
      if (node.type?.$$typeof === Symbol.for('react.provider') || node.type?._context) {
        const ctx = node.type._context || node.type;
        const old = ctx._currentValue;
        ctx._currentValue = node.props.value;
        try { return walk(node.props.children, `${path}.ctx`); } finally { ctx._currentValue = old; }
      }
      if (typeof node.type === 'function') {
        let bucket = hookStore.get(path);
        if (!bucket) hookStore.set(path, bucket = { states: [], refs: [] });
        let sIdx = 0, rIdx = 0;
        internals.H = {
          useState(init) {
            const i = sIdx++;
            if (!(i in bucket.states)) bucket.states[i] = typeof init === 'function' ? init() : init;
            return [bucket.states[i], (next) => { bucket.states[i] = typeof next === 'function' ? next(bucket.states[i]) : next; }];
          },
          useRef(init) {
            const i = rIdx++;
            if (!(i in bucket.refs)) bucket.refs[i] = { current: init };
            return bucket.refs[i];
          },
          useMemo(fn) { return fn(); },
          useCallback(fn) { return fn; },
          useEffect() {},
          useLayoutEffect() {},
          useInsertionEffect() {},
          useContext(ctx) { return ctx._currentValue; },
          useSyncExternalStore(_sub, getSnap) { return getSnap(); },
          useId() { return 'u-id'; },
          useMemoCache(size) {
            const i = sIdx++;
            if (!(i in bucket.states)) bucket.states[i] = new Array(size);
            return bucket.states[i];
          },
        };
        const rendered = node.type(node.props);
        return { ...node, props: { ...node.props, children: walk(rendered, `${path}>fn`) } };
      }
      if (node.type?.$$typeof === Symbol.for('react.forward_ref') && typeof node.type.render === 'function') {
        const rendered = node.type.render(node.props, null);
        return { ...node, props: { ...node.props, children: walk(rendered, `${path}>fwd`) } };
      }
      if (node.props && 'children' in node.props) {
        return { ...node, props: { ...node.props, children: walk(node.props.children, `${path}.c`) } };
      }
    }
    return node;
  }
  try { return walk(element); } finally { internals.H = prev; }
}

function findAll(tree, pred, out = []) {
  if (tree == null || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) { for (const x of tree) findAll(x, pred, out); return out; }
  if (pred(tree)) out.push(tree);
  if (tree.props && 'children' in tree.props) findAll(tree.props.children, pred, out);
  return out;
}

const textOf = (node) => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
};

test('studyStats attaches weakScope, weakTopics.cards, and mastery.practiceCards (capped at 200)', () => {
  const manyWeak = Array.from({ length: 220 }, (_, i) => card(`w${i}`, { topic: 'OverflowTopic', kind: 'quiz', prompt: `为什么 ${i} 会出错？` }));
  const dueApply = card('d-apply', { topic: 'ApplyTopic', kind: 'open', prompt: '在某系统设计中，这个架构应当如何取舍？', review: due(-1) });
  const masteredApply = card('m-apply', { topic: 'ApplyTopic', kind: 'open', prompt: '在某生产环境中，容量应当如何规划？', review: due(10) });
  const decks = [{ id: 'd1', title: 'Deck 1', course: 'CS', cards: [...manyWeak, dueApply, masteredApply] }];
  const attempts = [
    ...manyWeak.map((c) => attempt('d1', c.id, 1, 0, { assessment: 'graded' })),
    attempt('d1', 'm-apply', 5, 0, { assessment: 'self' }),
  ];

  const stats = studyStats(library(decks, attempts), {}, NOW);
  assert.equal(stats.weakScope.length, 200, 'weakScope respects 200-card checkScope cap');
  assert.equal(stats.weakTopics[0].cards.length, 200, 'weakTopics.cards respects 200-card cap');
  assert.equal(stats.weakTopics[0].wrong, 220, 'wrong count stays exact');
  assert.deepEqual(stats.caseScope, [{ deckId: 'd1', cardId: 'd-apply' }, { deckId: 'd1', cardId: 'm-apply' }], 'caseScope prioritizes weak/due open or case cards and caps at 200');

  const quizKind = stats.mastery.kinds.find((k) => k.id === 'quiz');
  assert.equal(quizKind.practiceCards.length, 200);
  const applyLevel = stats.mastery.levels.find((l) => l.id === 'apply');
  assert.deepEqual(applyLevel.practiceCards, [{ deckId: 'd1', cardId: 'd-apply' }], 'includes due card and excludes healthy non-due mastered card');
});

test('ForecastPanel slices >200 cards cleanly, adds today review button when onStart is provided, and translates to English without Han', () => {
  const cards = Array.from({ length: 300 }, (_, i) => ({ deckId: 'd', cardId: `c${i}` }));
  const days = Array.from({ length: 14 }, (_, i) => ({
    date: `2026-10-${String(2 + i).padStart(2, '0')}`,
    count: i === 0 ? 450 : 0,
    ...(i === 0 ? { overdue: 100, truncated: true } : {}),
    cards: i === 0 ? cards : [],
  }));
  const forecast = { days, later: 0 };

  const noHandler = renderToStaticMarkup(React.createElement(m.ForecastPanel, { forecast }));
  assert.doesNotMatch(noHandler, /开始今日复习/);
  assert.doesNotMatch(noHandler, /<button/);

  let startedWith = null;
  const tree = renderTree(React.createElement(m.ForecastPanel, { forecast, onStart: (s) => { startedWith = s; } }));
  const bar = findAll(tree, (n) => n.type === 'g' && typeof n.props?.className === 'string' && n.props.className.includes('today'))[0];
  bar.props.onClick();
  assert.equal(startedWith.length, 200, 'bar click caps scope at 200 instead of passing 300');

  startedWith = null;
  const todayBtn = findAll(tree, (n) => typeof n.props?.onClick === 'function' && textOf(n).includes('开始今日复习'))[0];
  assert.ok(todayBtn, 'renders explicit today review button');
  todayBtn.props.onClick();
  assert.equal(startedWith.length, 200, 'button click caps scope at 200');

  const busyHtml = renderToStaticMarkup(
    React.createElement(m.StudyServicesContext.Provider, { value: { busy: true } },
      React.createElement(m.ForecastPanel, { forecast, onStart: () => {} }))
  );
  assert.doesNotMatch(busyHtml, /role="button"/, 'busy disables Forecast SVG bar buttons');
  assert.match(busyHtml, /<button[^>]*disabled=""[^>]*>[\s\S]*开始今日复习/, 'busy locks 开始今日复习 button');

  try {
    m.setUiLanguage('en');
    const enHtml = renderToStaticMarkup(React.createElement(m.ForecastPanel, { forecast, onStart: () => {} }));
    assert.match(enHtml, /Start today&#x27;s review|Start today's review/);
    assert.doesNotMatch(enHtml.replace(/<[^>]+>/g, ' '), /[一-鿿]/);
  } finally {
    m.setUiLanguage('zh');
  }
});

test('Dashboard StatsView wires RubricSkills, weakTopics merge & weak-only drill, and MasteryPanel weak drill', () => {
  const calls = [];
  const data = {
    decks: [
      { id: 'd1', title: 'Case Deck', course: 'CS', cards: [
        { id: 'case-1', kind: 'case', topic: 'Arch', prompt: 'Q1', rubricCriteria: [{ name: 'Clarity' }] },
        { id: 'w1', kind: 'quiz', topic: 'Locks', prompt: 'L1' },
        { id: 'w2', kind: 'quiz', topic: 'Cashes', prompt: 'C1' },
      ] },
    ],
    attempts: [
      { deckId: 'd1', quiz_id: 'case-1', assessment: 'rubric', grade: 2, timestamp: '2026-10-01T10:00:00Z',
        rubric: { criteria: [{ label: 'Case linkage', score: 1, max: 3 }] } },
    ],
    focus: { course: '*' },
  };
  const stats = {
    generatedAt: '2026-10-02T04:00:00Z',
    today: '2026-10-02',
    totals: { attempts: 10, activeDays: 2, streak: 2, due: 1, gradedRate: 40, gradedAttempts: 5, selfRate: 60, selfAttempts: 5, oralAttempts: 0, oralStrong: 0 },
    heatmap: [],
    trend: [],
    forecast: { days: [{ date: '2026-10-02', count: 1, overdue: 0, cards: [{ deckId: 'd1', cardId: 'w1' }] }], later: 0 },
    weakScope: [{ deckId: 'd1', cardId: 'w1' }, { deckId: 'd1', cardId: 'w2' }],
    weakTopics: [
      { deckId: 'd1', deckTitle: 'Case Deck', course: 'CS', topic: 'Locks', wrong: 1, cards: [{ deckId: 'd1', cardId: 'w1' }] },
      { deckId: 'd1', deckTitle: 'Case Deck', course: 'CS', topic: 'Cashes', wrong: 1, cards: [{ deckId: 'd1', cardId: 'w2' }] },
    ],
    mastery: {
      windowDays: 30,
      minAnswers: 3,
      levels: [
        { id: 'recall', n: 5, met: 4, rate: 80, enough: true, practiceCards: [{ deckId: 'd1', cardId: 'w1' }] },
        { id: 'apply', n: 4, met: 1, rate: 25, enough: true, practiceCards: [{ deckId: 'd1', cardId: 'case-1' }] },
      ],
      kinds: [],
    },
  };

  const tree = renderTree(React.createElement(m.StatsView, {
    stats, course: '*', data,
    onStartScope: (s) => calls.push(s), onLibrary: () => {}, onCreate: () => {}, onSources: () => {},
  }));

  const buttons = findAll(tree, (n) => typeof n.props?.onClick === 'function' && (n.type === 'button' || n.type?.render));
  const clickLabel = (needle) => {
    const btn = buttons.find((b) => textOf(b).includes(needle));
    assert.ok(btn, `expected button "${needle}"`);
    btn.props.onClick();
  };

  clickLabel('练案例题');
  clickLabel('合并练薄弱题');
  clickLabel('练这个主题');
  clickLabel('专练薄弱项');

  assert.deepEqual(calls[0], [{ deckId: 'd1', cardId: 'case-1' }], 'RubricSkills starts case card practice');
  assert.deepEqual(calls[1], [{ deckId: 'd1', cardId: 'w1' }, { deckId: 'd1', cardId: 'w2' }], 'merged weak drill starts all weak cards');
  assert.deepEqual(calls[2], [{ deckId: 'd1', cardId: 'w1' }], 'row button uses weak cards only');
  assert.deepEqual(calls[3], [{ deckId: 'd1', cardId: 'case-1' }], 'MasteryPanel shows drill only on below-threshold dimensions');

  try {
    m.setUiLanguage('en');
    const enHtml = renderToStaticMarkup(React.createElement(m.StatsView, {
      stats, course: '*', data,
      onStartScope: () => {}, onLibrary: () => {}, onCreate: () => {}, onSources: () => {},
    }));
    assert.match(enHtml, /Practise case questions/);
    assert.match(enHtml, /Practise all weak questions/);
    assert.match(enHtml, /Practise weak items/);
  } finally {
    m.setUiLanguage('zh');
  }

  // Live deckRow snapshots omit `.cards`: verify stats.caseScope and format==='case-study' fallback both power 练案例题, and busy locks all controls.
  const summaryOnlyData = {
    decks: [{ id: 'd1', title: 'Case Deck', course: 'CS', format: 'case-study' }],
    attempts: data.attempts,
    focus: { course: '*' },
  };
  const liveCalls = [];
  const treeWithCaseScope = renderTree(React.createElement(m.StatsView, {
    stats: { ...stats, caseScope: [{ deckId: 'd1', cardId: 'case-live' }] },
    course: '*', data: summaryOnlyData,
    onStartScope: (s) => liveCalls.push(s), onLibrary: () => {}, onCreate: () => {}, onSources: () => {},
  }));
  const liveCaseBtn = findAll(treeWithCaseScope, (n) => typeof n.props?.onClick === 'function' && textOf(n).includes('练案例题'))[0];
  assert.ok(liveCaseBtn);
  liveCaseBtn.props.onClick();
  assert.deepEqual(liveCalls[0], [{ deckId: 'd1', cardId: 'case-live' }], 'live deckRow snapshot uses stats.caseScope when cards array is absent');

  const treeFallbackDeck = renderTree(React.createElement(m.StatsView, {
    stats,
    course: '*', data: summaryOnlyData,
    onStartScope: (s) => liveCalls.push(s), onLibrary: () => {}, onCreate: () => {}, onSources: () => {},
  }));
  const fallbackCaseBtn = findAll(treeFallbackDeck, (n) => typeof n.props?.onClick === 'function' && textOf(n).includes('练案例题'))[0];
  assert.ok(fallbackCaseBtn);
  fallbackCaseBtn.props.onClick();
  assert.deepEqual(liveCalls[1], [{ deckId: 'd1' }], 'falls back to case-study deck scope when both deck.cards and stats.caseScope are absent');

  const busyStatsHtml = renderToStaticMarkup(
    React.createElement(m.StudyServicesContext.Provider, { value: { busy: true } },
      React.createElement(m.StatsView, {
        stats: { ...stats, caseScope: [{ deckId: 'd1', cardId: 'case-live' }] },
        course: '*', data: summaryOnlyData,
        onStartScope: () => {}, onLibrary: () => {}, onCreate: () => {}, onSources: () => {},
      }))
  );
  assert.match(busyStatsHtml, /<button[^>]*disabled=""[^>]*>[\s\S]*练案例题/);
  assert.match(busyStatsHtml, /<button[^>]*disabled=""[^>]*>[\s\S]*合并练薄弱题/);
  assert.match(busyStatsHtml, /<button[^>]*disabled=""[^>]*>[\s\S]*练这个主题/);
  assert.match(busyStatsHtml, /<button[^>]*disabled=""[^>]*>[\s\S]*专练薄弱项/);
});

test('Skeleton 只练这些题 honors issueFilter, 练整个骨架 deduplicates before slicing 200 and disables on empty cards', () => {
  const lintState = {
    total: 2,
    flagged: 2,
    counts: { 'echo-explanation': 1, 'thin-explanation': 1 },
    labels: { 'echo-explanation': '解释重复题干', 'thin-explanation': '解释偏短' },
    cards: [
      { cardId: 'c1', deckId: 'd1', deckTitle: 'D', topic: 'T', prompt: 'P1', issues: ['echo-explanation'] },
      { cardId: 'c2', deckId: 'd1', deckTitle: 'D', topic: 'T', prompt: 'P2', issues: ['thin-explanation'] },
    ],
  };
  const emptySkeleton = { id: 'sk1', title: 'Empty Sk', overview: '', nodes: [{ id: 'n1', term: 'N1', meaning: 'M', cards: [] }], relations: [], scope: [] };
  const study = {
    call: async () => ({}),
    act: async () => undefined,
    busy: false,
    notify: () => {},
    askInChat: () => {},
    host: {},
    openSettings: () => {},
    navigate: () => {},
    openModal: () => {},
  };
  const practised = [];
  // Pre-seed Skeleton component hooks: find lint & issueFilter & viewing by inspecting initial render and mutating states array.
  const hookStore = new Map();
  const prevStudyCtx = m.StudyServicesContext._currentValue;
  m.StudyServicesContext._currentValue = study;
  try {
    renderTree(React.createElement(m.Skeleton, { data: { root: 'r', focus: { course: '*' } }, focusId: 'sk1', onFocus: () => {}, onPractice: (cards) => practised.push(cards) }), hookStore);
    const rootStates = hookStore.get('root')?.states;
    assert.ok(rootStates, 'located Skeleton root hook bucket');
    const savedIdx = rootStates.findIndex((v, i) => v === null && rootStates[i + 1] === null && rootStates[i + 2] === null && rootStates[i + 3] === true);
    assert.ok(savedIdx >= 0, 'located Skeleton hook layout');
    rootStates[savedIdx] = { course: '*', skeletons: [{ id: 'sk1', title: 'Empty Sk', nodes: 1, relations: 0, cardIds: [], decks: 1, updatedAt: '2026-10-01T00:00:00Z' }] };
    rootStates[savedIdx + 1] = [];
    rootStates[savedIdx + 2] = { groups: [], ungrouped: [] };
    rootStates[savedIdx + 7] = lintState;
    rootStates[savedIdx + 8] = 'thin-explanation';
    rootStates[savedIdx + 10] = emptySkeleton;

    const tree2 = renderTree(React.createElement(m.Skeleton, { data: { root: 'r', focus: { course: '*' } }, focusId: 'sk1', onFocus: () => {}, onPractice: (cards) => practised.push(cards) }), hookStore);
    const lintBtn = findAll(tree2, (n) => typeof n.props?.onClick === 'function' && textOf(n).includes('只练这些题'))[0];
    assert.ok(lintBtn);
    lintBtn.props.onClick();
    assert.deepEqual(practised[0].map((c) => c.cardId), ['c2'], '只练这些题 passes only cards matching active issueFilter');

    const wholeBtn = findAll(tree2, (n) => textOf(n).includes('练整个骨架') && 'disabled' in (n.props || {}))[0];
    assert.equal(wholeBtn.props.disabled, true, '练整个骨架 disables when 0 cards attached');

    const dupNodes = Array.from({ length: 210 }, (_, i) => ({
      id: `n${i}`,
      term: `T${i}`,
      meaning: 'M',
      cards: [
        { deckId: 'd1', cardId: 'shared' },
        { deckId: 'd1', cardId: `u${i}` },
      ],
    }));
    rootStates[savedIdx + 10] = { id: 'sk2', title: 'Large Sk', overview: '', nodes: dupNodes, relations: [], scope: [] };
    const tree3 = renderTree(React.createElement(m.Skeleton, { data: { root: 'r', focus: { course: '*' } }, focusId: 'sk1', onFocus: () => {}, onPractice: (cards) => practised.push(cards) }), hookStore);
    const largeBtn = findAll(tree3, (n) => typeof n.props?.onClick === 'function' && textOf(n).includes('练整个骨架'))[0];
    largeBtn.props.onClick();
    assert.equal(practised[1].length, 200, '练整个骨架 deduplicates shared cardIds before slicing 200');
    assert.equal(new Set(practised[1].map((c) => c.cardId)).size, 200, 'all 200 cards are unique');
  } finally {
    m.StudyServicesContext._currentValue = prevStudyCtx;
  }
});

test('page-views remembers navigation context via practiseRound / deferred then and guards SkeletonView active run trail', async () => {
  await withBrowserGlobals(async () => {
    const ui = await loadInteractiveUi(`
      export { PAGE_VIEWS } from './ui/app/page-views.jsx';
      export { AppContext } from './ui/app/app-context.js';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `);
    const { PAGE_VIEWS, AppContext, StudyServicesContext, setUiLanguage } = ui.exports;
    const h = ui.React.createElement;
    setUiLanguage('zh');

    const makeHarness = ({ run = null, trailPage = null, statsPayload = null } = {}) => {
      const captured = [];
      const remembered = [];
      const entered = [];
      const practiceCalls = [];
      const noop = () => {};
      const data = {
        root: '/lib',
        decks: [{ id: 'd1', title: 'Deck 1', course: 'CS', cards: [] }],
        attempts: [],
        runs: [],
        sources: [],
        focus: { course: '*', courses: [{ name: 'CS', count: 1 }] },
      };
      const study = {
        call: async (action) => (action === 'stats' && statsPayload ? statsPayload : { status: 'ok', skeletons: [] }),
        act: async () => undefined,
        busy: false,
        notify: noop,
        askInChat: noop,
        host: {},
        openSettings: noop,
        navigate: noop,
        openModal: noop,
      };
      const app = {
        language: 'zh',
        host: {},
        data,
        canChat: false,
        core: { call: study.call, act: study.act, busy: false, notify: noop, setError: noop, toast: { show: noop, dismiss: noop } },
        nav: { page: 'skeleton', navigate: noop, show: { page: noop, workflow: noop } },
        lib: { skeletonFocus: 'sk1' },
        set: { setSkeletonFocus: noop, setBoardView: noop },
        session: { run, enterRun: (nextRun) => entered.push(nextRun) },
        learn: {
          trailPage,
          captureContext: () => {
            const origin = { page: 'origin', seq: captured.length + 1 };
            captured.push(origin);
            return origin;
          },
          rememberContext: (origin) => remembered.push(origin),
        },
        intents: {
          practice: (scope, opts) => practiceCalls.push({ scope, opts }),
          goGenerate: noop,
        },
        board: { state: { board: null, refresh: noop, mutate: async () => true } },
        dailyPlan: { refresh: noop },
      };
      return { study, app, captured, remembered, entered, practiceCalls };
    };

    // 1. SkeletonView outside an active review trail: captures context, deduplicates cards, defers rememberContext + enterRun to then.
    {
      const env = makeHarness({ run: null, trailPage: null });
      const mounted = ui.mount(() => h(
        StudyServicesContext.Provider,
        { value: env.study },
        h(AppContext.Provider, { value: env.app }, h(PAGE_VIEWS.skeleton)),
      ));
      try {
        const skeletonEl = mounted.find((n) => typeof n.props?.onPractice === 'function');
        assert.ok(skeletonEl, 'SkeletonView passes onPractice to Skeleton');
        skeletonEl.props.onPractice([
          { deckId: 'd1', cardId: 'c1' },
          { deckId: 'd1', cardId: 'c1' },
          { deckId: 'd1', cardId: 'c2' },
        ]);
        assert.equal(env.captured.length, 1, 'captures context outside active review run');
        assert.equal(env.practiceCalls.length, 1);
        assert.deepEqual(env.practiceCalls[0].scope, [{ deckId: 'd1', cardId: 'c1' }, { deckId: 'd1', cardId: 'c2' }]);
        assert.equal(env.practiceCalls[0].opts.returnTo, undefined);
        assert.equal(env.remembered.length, 0, 'rememberContext waits for deferred then');
        assert.equal(env.entered.length, 0, 'enterRun waits for deferred then');

        const nextRun = { id: 'run-from-skeleton' };
        env.practiceCalls[0].opts.then(nextRun);
        assert.deepEqual(env.remembered, [env.captured[0]], 'then remembers captured context');
        assert.deepEqual(env.entered, [nextRun], 'then enters the started run');
      } finally {
        mounted.unmount();
      }
    }

    // 2. SkeletonView during an active review run trail: skips captureContext/rememberContext and passes returnTo: run.id.
    {
      const env = makeHarness({ run: { id: 'run-active', complete: false }, trailPage: 'review' });
      const mounted = ui.mount(() => h(
        StudyServicesContext.Provider,
        { value: env.study },
        h(AppContext.Provider, { value: env.app }, h(PAGE_VIEWS.skeleton)),
      ));
      try {
        const skeletonEl = mounted.find((n) => typeof n.props?.onPractice === 'function');
        assert.ok(skeletonEl, 'SkeletonView passes onPractice during active review trail');
        skeletonEl.props.onPractice([{ deckId: 'd2', cardId: 'c9' }]);
        assert.equal(env.captured.length, 0, 'does not overwrite active review trail context');
        assert.equal(env.practiceCalls.length, 1);
        assert.deepEqual(env.practiceCalls[0].scope, [{ deckId: 'd2', cardId: 'c9' }]);
        assert.equal(env.practiceCalls[0].opts.returnTo, 'run-active');

        const detourRun = { id: 'run-detour' };
        env.practiceCalls[0].opts.then(detourRun);
        assert.equal(env.remembered.length, 0, 'does not remember context when launched from active review trail');
        assert.deepEqual(env.entered, [detourRun], 'still enters the started run');
      } finally {
        mounted.unmount();
      }
    }

    // 3. SkeletonView when the prior review run is already complete: behaves like a fresh launch (captures & remembers context).
    {
      const env = makeHarness({ run: { id: 'run-done', complete: true }, trailPage: 'review' });
      const mounted = ui.mount(() => h(
        StudyServicesContext.Provider,
        { value: env.study },
        h(AppContext.Provider, { value: env.app }, h(PAGE_VIEWS.skeleton)),
      ));
      try {
        const skeletonEl = mounted.find((n) => typeof n.props?.onPractice === 'function');
        skeletonEl.props.onPractice([{ deckId: 'd3', cardId: 'c7' }]);
        assert.equal(env.captured.length, 1, 'completed review run does not block capturing origin context');
        assert.equal(env.practiceCalls[0].opts.returnTo, undefined);
        env.practiceCalls[0].opts.then({ id: 'run-after-done' });
        assert.deepEqual(env.remembered, [env.captured[0]]);
        assert.deepEqual(env.entered, [{ id: 'run-after-done' }]);
      } finally {
        mounted.unmount();
      }
    }

    // 4. DashboardView routes onStartScope through practiseRound (captureContext -> intents.practice(scope, { fresh: false, then }) -> rememberContext + enterRun).
    {
      const statsPayload = {
        generatedAt: '2026-10-02T04:00:00Z',
        today: '2026-10-02',
        totals: { attempts: 4, activeDays: 1, streak: 1, due: 2, gradedRate: 50, gradedAttempts: 4, selfRate: null, selfAttempts: 0, oralAttempts: 0, oralStrong: 0 },
        heatmap: [],
        trend: [],
        forecast: { days: [{ date: '2026-10-02', count: 2, overdue: 0, cards: [{ deckId: 'd1', cardId: 'w1' }] }], later: 0 },
        weakScope: [{ deckId: 'd1', cardId: 'w1' }, { deckId: 'd1', cardId: 'w2' }],
        weakTopics: [
          { deckId: 'd1', deckTitle: 'Deck 1', course: 'CS', topic: 'Locks', wrong: 2, cards: [{ deckId: 'd1', cardId: 'w1' }] },
          { deckId: 'd1', deckTitle: 'Deck 1', course: 'CS', topic: 'Caches', wrong: 1, cards: [{ deckId: 'd1', cardId: 'w2' }] },
        ],
        mastery: { windowDays: 30, minAnswers: 3, levels: [], kinds: [] },
      };
      const env = makeHarness({ statsPayload });
      const mounted = ui.mount(() => h(
        StudyServicesContext.Provider,
        { value: env.study },
        h(AppContext.Provider, { value: env.app }, h(PAGE_VIEWS.dashboard)),
      ));
      try {
        await mounted.flush(5);
        const mergeWeakBtn = mounted.find((n) => n.type === 'button' && ui.textOf(n).includes('合并练薄弱题'));
        assert.ok(mergeWeakBtn, 'DashboardView renders StatsView with 合并练薄弱题 button');
        await mounted.act(() => click(mergeWeakBtn));
        assert.equal(env.captured.length, 1, 'practiseRound captures navigation context');
        assert.equal(env.practiceCalls.length, 1);
        assert.deepEqual(env.practiceCalls[0].scope, [{ deckId: 'd1', cardId: 'w1' }, { deckId: 'd1', cardId: 'w2' }]);
        assert.equal(env.practiceCalls[0].opts.fresh, false, 'practiseRound starts with fresh: false');
        assert.equal(env.remembered.length, 0, 'rememberContext is deferred until practice starts');
        assert.equal(env.entered.length, 0, 'enterRun is deferred until practice starts');

        const dashRun = { id: 'run-from-dashboard' };
        env.practiceCalls[0].opts.then(dashRun);
        assert.deepEqual(env.remembered, [env.captured[0]], 'deferred then remembers Dashboard origin');
        assert.deepEqual(env.entered, [dashRun], 'deferred then enters started run');
      } finally {
        mounted.unmount();
        setUiLanguage('zh');
      }
    }
  });
});
