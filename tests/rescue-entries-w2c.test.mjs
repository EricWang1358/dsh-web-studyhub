import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseSkill } from '../lib/study-skills.js';
import { StudyService } from '../lib/service.js';
import { companionCompilePanelIntent } from '../lib/index.js';

const compiled = await build({
  stdin: {
    contents: `
      export { WrongBookView } from './ui/WrongBook.jsx';
      export { buildWrongbookClinic } from './ui/wrongbook-clinic.js';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage, uiCatalogue } from './ui/i18n.js';
      export { gapHintLabel, resolveBookGapHint } from './ui/evidence-hint.js';
      export { findPointCompanion, openCompanionTarget } from './ui/companions/companion-ref.js';
      export { default as BookGapHint } from './ui/book/BookGapHint.jsx';
      export { default as BookStep } from './ui/book/BookStep.jsx';
      export { default as PointToolbar } from './ui/book/PointToolbar.jsx';
      export { useBookHandlers } from './ui/book/use-book-actions.js';
      export { handOffText } from './ui/agent-prompts/index.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom'],
  loader: { '.css': 'text' },
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), mod, mod.exports);
for (const name of readdirSync(new URL('../ui/locales', import.meta.url))) {
  if (/^en(\..+)?\.json$/.test(name)) {
    Object.assign(mod.exports.uiCatalogue(), JSON.parse(readFileSync(new URL(`../ui/locales/${name}`, import.meta.url), 'utf8')));
  }
}

const {
  WrongBookView,
  buildWrongbookClinic,
  StudyServicesContext,
  setUiLanguage,
  gapHintLabel,
  resolveBookGapHint,
  findPointCompanion,
  BookGapHint,
  BookStep,
  PointToolbar,
  useBookHandlers,
  handOffText,
} = mod.exports;

const HAN_RE = /\p{Script=Han}/u;
const noop = () => {};

function withFakeReactHooks(contextMap, fn) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = [];
  let cursor = 0;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const prev = internals.H;
  internals.H = {
    useContext: (ctx) => (contextMap.has(ctx) ? contextMap.get(ctx) : ctx._currentValue),
    useState: (init) => {
      const i = cursor++;
      if (!(i in hooks)) {
        const val = typeof init === 'function' ? init() : init;
        const setter = (next) => { hooks[i][0] = typeof next === 'function' ? next(hooks[i][0]) : next; };
        hooks[i] = [val, setter];
      }
      return hooks[i];
    },
    useRef: (init) => { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
    useMemo: (factory, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) hooks[i] = { deps, value: factory() }; return hooks[i].value; },
    useCallback: (cb, deps) => internals.H.useMemo(() => cb, deps),
    useEffect: () => { cursor++; },
    useLayoutEffect: () => { cursor++; },
    useInsertionEffect: () => { cursor++; },
    useId: () => { const i = cursor++; return `:w2c-${i}:`; },
    useDeferredValue: (v) => v,
  };
  const render = (cb) => { cursor = 0; return cb(); };
  try {
    return fn(render);
  } finally {
    internals.H = prev;
  }
}

function collectButtons(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => collectButtons(n, out)); return out; }
  if (typeof node.props?.onClick === 'function') out.push(node);
  collectButtons(node.props?.children, out);
  return out;
}

/* -------------------------------------------------------------------------
 * 1. WrongBook Targeted Clinic: cluster >= 2 cards -> rescue recommendation & jump
 * ------------------------------------------------------------------------- */

test('buildWrongbookClinic clusters >=2 cards by hid or source page for rescue when unlinked, and preserves companion #slide jump when linked', () => {
  const rows = [
    { deckId: 'd1', cardId: 'c1', hid: 'h-conv', pointTitle: 'Uniform Convergence', leech: false, wrongCount: 2, lastAt: '2026-11-20T08:00:00Z' },
    { deckId: 'd2', cardId: 'c2', hid: 'h-conv', pointTitle: 'Uniform Convergence', leech: false, wrongCount: 1, lastAt: '2026-11-20T07:00:00Z' },
  ];
  const hidLanes = buildWrongbookClinic({ rows });
  assert.equal(hidLanes[0].id, 'cluster');
  assert.equal(hidLanes[0].kind, 'hid');
  assert.equal(hidLanes[0].hid, 'h-conv');
  assert.equal(hidLanes[0].pointTitle, 'Uniform Convergence');
  assert.equal(hidLanes[0].recommendRescue, true);
  assert.deepEqual(hidLanes[0].cardIds, ['c1', 'c2']);
  assert.deepEqual(hidLanes[0].deckIds, ['d1', 'd2']);

  // Once linked to an existing companion, cluster stays `kind: 'companion'` with `#slide` anchor and recommendRescue=false
  const compLanes = buildWrongbookClinic({
    rows,
    companionTargetByCard: new Map([
      ['c1', { companionId: 'comp-conv', course: 'Analysis', slide: 3, anchor: '#3', companionTitle: 'Convergence Lab' }],
      ['c2', { companionId: 'comp-conv', course: 'Analysis', slide: 3, anchor: '#3', companionTitle: 'Convergence Lab' }],
    ]),
  });
  assert.equal(compLanes[0].kind, 'companion');
  assert.equal(compLanes[0].slide, 3);
  assert.equal(compLanes[0].recommendRescue, false);
});

test('WrongBookView clinic recommends 4-slide rescue for unlinked cluster, launches with cluster cardIds/hid, supports DSH & Desktop fallbacks, and keeps en/zh clean', () => {
  const srcPdf = {
    id: 'src-pdf',
    title: 'Real Analysis Ch 4',
    format: 'pdf',
    document: { id: 'doc-1', format: 'pdf', bookTitle: 'Real Analysis', page: 18 },
    text: 'Uniform convergence allows swapping limit and integral.',
  };
  const decks = [{
    id: 'd1',
    course: 'Analysis',
    title: 'Analysis｜Quiz',
    cards: [
      { id: 'c1', hid: 'h-41', citations: [{ sourceId: 'src-pdf', quote: 'swapping limit and integral', page: 18 }] },
      { id: 'c2', hid: 'h-41', citations: [{ sourceId: 'src-pdf', quote: 'Uniform convergence', page: 18 }] },
    ],
  }];
  const items = [
    { deckId: 'd1', deckTitle: decks[0].title, cardId: 'c1', hid: 'h-41', topic: 'Uniform Convergence', kind: 'quiz', assessment: 'graded', prompt: 'Q1?', lastGrade: 1, wrongCount: 2, lastAt: '2026-11-20T09:00:00Z', leech: false },
    { deckId: 'd1', deckTitle: decks[0].title, cardId: 'c2', hid: 'h-41', topic: 'Uniform Convergence', kind: 'quiz', assessment: 'graded', prompt: 'Q2?', lastGrade: 1, wrongCount: 2, lastAt: '2026-11-20T08:00:00Z', leech: false },
  ];
  const clusterStarts = [];
  const modals = [];

  const baseProps = {
    data: {
      root: 'r',
      decks,
      sources: [srcPdf],
      courses: [{ name: 'Analysis', companions: [] }],
      focus: { course: 'Analysis', courses: [{ name: 'Analysis' }] },
      model: { ready: true },
      settings: { practice: { wrongbookClinic: true } },
    },
    course: 'Analysis',
    onCourse: noop,
    items,
    counts: { total: 2, graded: 2, self: 0, oral: 0, rubric: 0 },
    view: 'weak',
    onView: noop,
    viewCounts: { weak: 2, history: 0 },
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
    onPractice: noop,
    onGenerate: async () => ({}),
    onOpenSettings: noop,
    onStartClusterExperiment: (lane, jobKey, clusterCourse) => { clusterStarts.push({ lane, jobKey, clusterCourse }); },
    busy: false,
    filterMin: 1,
  };

  setUiLanguage('zh');
  const zhHtml = renderToStaticMarkup(React.createElement(
    StudyServicesContext.Provider,
    { value: { openModal: (m) => modals.push(m), busy: false, host: { openAgent: noop } } },
    React.createElement(WrongBookView, baseProps),
  ));
  assert.match(zhHtml, /同知识点错题 · 「Uniform Convergence」/);
  assert.match(zhHtml, /data-clinic-rescue="start"/);
  assert.match(zhHtml, /做一个 4 页交互实验/);

  // Click the cluster rescue button directly
  withFakeReactHooks(new Map([[StudyServicesContext, { openModal: (m) => modals.push(m), busy: false, host: { openAgent: noop } }]]), (render) => {
    let clinicNode = null;
    const findClinic = (node) => {
      if (!node || typeof node !== 'object' || clinicNode) return;
      if (Array.isArray(node)) { node.forEach(findClinic); return; }
      if (typeof node.type === 'function' && node.props?.lanes) { clinicNode = node; return; }
      findClinic(node.props?.children);
    };
    findClinic(render(() => WrongBookView(baseProps)));
    assert.ok(clinicNode);
    const tree = clinicNode.type(clinicNode.props);
    const rescueBtn = collectButtons(tree).find((b) => b.props['data-clinic-rescue'] === 'start');
    assert.ok(rescueBtn, 'cluster rescue start button rendered');
    rescueBtn.props.onClick();
  });
  assert.equal(clusterStarts.length, 1);
  assert.deepEqual(clusterStarts[0].lane.cardIds, ['c1', 'c2']);
  assert.equal(clusterStarts[0].lane.hid, 'h-41');
  assert.equal(clusterStarts[0].clusterCourse, 'Analysis');

  // Ready state opens companion modal directly with return path
  const readyProps = {
    ...baseProps,
    experimentJobs: {
      'clinic:hid:h-41': { status: 'ready', companionId: 'rescue-41', course: 'Analysis', title: 'Convergence Rescue' },
    },
  };
  withFakeReactHooks(new Map([[StudyServicesContext, { openModal: (m) => modals.push(m), busy: false, host: { openAgent: noop } }]]), (render) => {
    let clinicNode = null;
    const findClinic = (node) => {
      if (!node || typeof node !== 'object' || clinicNode) return;
      if (Array.isArray(node)) { node.forEach(findClinic); return; }
      if (typeof node.type === 'function' && node.props?.lanes) { clinicNode = node; return; }
      findClinic(node.props?.children);
    };
    findClinic(render(() => WrongBookView(readyProps)));
    const tree = clinicNode.type(clinicNode.props);
    const openBtn = collectButtons(tree).find((b) => b.props['data-clinic-rescue'] === 'open');
    assert.ok(openBtn, 'cluster rescue open button rendered when ready');
    openBtn.props.onClick();
  });
  assert.equal(modals.at(-1)?.type, 'companion');
  assert.equal(modals.at(-1)?.id, 'rescue-41');
  assert.equal(modals.at(-1)?.anchor, '#1');
  assert.equal(modals.at(-1)?.from, 'wrongbook');

  // No-model fallback: DSH host mode shows Send to main chat hand-off; Desktop mode shows model setup notice
  const dshPromptHtml = renderToStaticMarkup(React.createElement(
    StudyServicesContext.Provider,
    { value: { openModal: noop, busy: false, host: { openAgent: noop } } },
    React.createElement(WrongBookView, {
      ...baseProps,
      data: { ...baseProps.data, model: { ready: false } },
      initial: { rescuePrompt: { cardId: 'clinic:hid:h-41', type: 'rescue-handoff', kind: 'experiment', course: 'Analysis' } },
    }),
  ));
  assert.match(dshPromptHtml, /未配置生成模型 · 可用主会话零密钥生成/);

  const desktopPromptHtml = renderToStaticMarkup(React.createElement(
    StudyServicesContext.Provider,
    { value: { openModal: noop, busy: false, host: {} } },
    React.createElement(WrongBookView, {
      ...baseProps,
      data: { ...baseProps.data, model: { ready: false } },
      initial: { rescuePrompt: { cardId: 'clinic:hid:h-41', type: 'no-model', kind: 'experiment', course: 'Analysis' } },
    }),
  ));
  assert.match(desktopPromptHtml, /打开模型设置/);
  assert.doesNotMatch(desktopPromptHtml, /发给主会话/);

  // English parity: zero Han characters
  setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(React.createElement(
      StudyServicesContext.Provider,
      { value: { openModal: noop, busy: false, host: { openAgent: noop } } },
      React.createElement(WrongBookView, readyProps),
    ));
    assert.doesNotMatch(enHtml, HAN_RE, 'English WrongBook clinic rescue must contain zero Chinese');
    assert.match(enHtml, /Open 4-slide interactive experiment/);
  } finally {
    setUiLanguage('zh');
  }
});

/* -------------------------------------------------------------------------
 * 2. Review Book 「还差：……」 -> Linked companion #slide / Rescue companion launch
 * ------------------------------------------------------------------------- */

test('Review Book PointToolbar adds zero buttons and BookGapHint routes linked hid companions (#slide) and shaky rescue launches', async () => {
  // §2.1 Control Budget check: PointToolbar keeps its exact original buttons and adds zero rescue/companion buttons
  const toolbarHtml = renderToStaticMarkup(React.createElement(PointToolbar, {
    node: { hid: 'h-1', key: 'bk:n1', title: 'Bayes Rule', questionTotal: 3 },
    course: 'Stats',
    handlers: { qaOpen: () => false, toggleQa: noop, retellOpen: () => false, toggleRetell: noop, practice: noop },
    cites: null,
  }));
  assert.doesNotMatch(toolbarHtml, /交互实验|交互伴学|rescue|companion/i, 'PointToolbar must have zero new buttons (§2.1)');

  const shakyEvidence = {
    hid: 'h-1',
    nodeId: 'n1',
    overall: 'shaky',
    facets: { retention: 'weak', comprehension: 'unverified', transfer: 'unverified' },
    gapHint: { kind: 'weak_cards', hid: 'h-1' },
  };
  const prereqEvidence = {
    hid: 'h-2',
    nodeId: 'n2',
    overall: 'shaky',
    facets: { retention: 'weak', comprehension: 'unverified', transfer: 'unverified' },
    gapHint: { kind: 'prereq', hid: 'h-2', targetHid: 'h-1', targetTitle: 'Bayes Rule' },
  };
  const solidEvidence = {
    hid: 'h-3',
    overall: 'solid',
    facets: { retention: 'solid', comprehension: 'verified', transfer: 'verified' },
  };

  // Solid point stays quiet
  assert.equal(resolveBookGapHint(solidEvidence), null);

  // Prereq hint is never hijacked by linked companions or rescue
  const prereqHint = resolveBookGapHint(prereqEvidence, {
    linkedCompanion: { companionId: 'comp-2', course: 'Stats', slide: 2, anchor: '#2' },
  });
  assert.equal(prereqHint.kind, 'prereq');
  assert.equal(prereqHint.targetHid, 'h-1');

  // Linked companion on hid resolves with exact #slide anchor
  const linkedComp = findPointCompanion({
    hid: 'h-1',
    nodeId: 'n1',
    questions: [{ deckId: 'd1', cardId: 'c1' }],
    course: 'Stats',
    courses: [{
      name: 'Stats',
      companions: [
        { id: 'comp-full', title: 'Bayes Lab', hid: 'h-1', slideCount: 16, progress: { slide: 4, completed: false } },
      ],
    }],
    decks: [{ id: 'd1', cards: [{ id: 'c1', companionRef: { companionId: 'comp-full', slide: 6, anchor: '#6' } }] }],
    sources: [],
  });
  assert.equal(linkedComp.companionId, 'comp-full');
  assert.equal(linkedComp.slide, 6);
  assert.equal(linkedComp.anchor, '#6');

  const openHint = resolveBookGapHint(shakyEvidence, { linkedCompanion: linkedComp });
  assert.equal(openHint.kind, 'companion_open');
  assert.equal(openHint.slide, 6);

  // Shaky point with no companion upgrades to rescue_experiment
  const rescueHint = resolveBookGapHint(shakyEvidence, { linkedCompanion: null });
  assert.equal(rescueHint.kind, 'rescue_experiment');

  // Test useBookHandlers wiring: linked companion click -> openModal with #slide & returnLabel; unlinked shaky click -> startRescue / fallback
  const openedModals = [];
  const startedRescues = [];
  const evidenceByHid = new Map([['h-1', shakyEvidence]]);
  const pointNode = { hid: 'h-1', key: 'bk:n1', number: '1.1', title: 'Bayes Rule', leaf: true, questions: [{ deckId: 'd1', cardId: 'c1' }] };

  await withFakeReactHooks(new Map(), async (render) => {
    const handlersWithComp = render(() => useBookHandlers({
      call: async () => ({}),
      act: async () => ({}),
      course: 'Stats',
      notify: noop,
      book: { missing: [], files: {} },
      setBook: noop,
      rows: [{ hid: 'h-1', key: 'bk:n1' }],
      reload: noop,
      remember: () => '',
      onPractice: noop,
      onCreate: noop,
      onOpenSource: noop,
      modelReady: true,
      ai: { openAsk: noop, start: noop, remove: noop, cancel: noop, retry: noop, dismiss: noop, restore: noop, forget: noop },
      evidenceByHid,
      courses: [{ name: 'Stats', companions: [{ id: 'comp-full', title: 'Bayes Lab', hid: 'h-1', slideCount: 16 }] }],
      decks: [{ id: 'd1', cards: [{ id: 'c1', companionRef: { companionId: 'comp-full', slide: 6, anchor: '#6' } }] }],
      sources: [],
      openModal: (m) => openedModals.push(m),
      canChat: true,
    }));
    const h = handlersWithComp.gapHintOf(pointNode);
    assert.equal(h.kind, 'companion_open');
    await handlersWithComp.actGapHint(pointNode, h);
  });
  assert.equal(openedModals.length, 1);
  assert.equal(openedModals[0].type, 'companion');
  assert.equal(openedModals[0].id, 'comp-full');
  assert.equal(openedModals[0].slide, 6);
  assert.equal(openedModals[0].anchor, '#6');
  assert.equal(openedModals[0].from, 'book');
  assert.equal(openedModals[0].returnLabel, '返回复习全书');

  await withFakeReactHooks(new Map(), async (render) => {
    const handlersNoComp = render(() => useBookHandlers({
      call: async () => ({}),
      act: async () => ({}),
      course: 'Stats',
      notify: noop,
      book: { missing: [], files: {} },
      setBook: noop,
      rows: [{ hid: 'h-1', key: 'bk:n1' }],
      reload: noop,
      remember: () => '',
      onPractice: noop,
      onCreate: noop,
      onOpenSource: noop,
      modelReady: true,
      ai: { openAsk: noop, start: noop, remove: noop, cancel: noop, retry: noop, dismiss: noop, restore: noop, forget: noop },
      evidenceByHid,
      courses: [{ name: 'Stats', companions: [] }],
      decks: [{ id: 'd1', cards: [{ id: 'c1' }] }],
      sources: [],
      openModal: noop,
      canChat: true,
      onStartRescue: (key, payload) => { startedRescues.push({ key, payload }); },
    }));
    const h = handlersNoComp.gapHintOf(pointNode);
    assert.equal(h.kind, 'rescue_experiment');
    await handlersNoComp.actGapHint(pointNode, h);
  });
  assert.equal(startedRescues.length, 1);
  assert.equal(startedRescues[0].key, 'h-1');
  assert.equal(startedRescues[0].payload.hid, 'h-1');
  assert.deepEqual(startedRescues[0].payload.cardIds, ['c1']);

  // Render BookGapHint + BookStep in zh and en (including hand-off and ready states)
  setUiLanguage('zh');
  const zhStepHtml = renderToStaticMarkup(React.createElement(
    StudyServicesContext.Provider,
    { value: { host: { openAgent: noop }, busy: false } },
    React.createElement(BookStep, {
      steps: [{ hid: 'h-1', path: [], node: { ...pointNode, gen: 'Takeaway.', files: { gen: 'h-1.gen', mine: 'h-1.mine' } } }],
      at: 0,
      onGo: noop,
      course: 'Stats',
      handlers: {
        gone: new Set(),
        qaOpen: () => false,
        toggleQa: noop,
        retellOpen: () => false,
        toggleRetell: noop,
        gapHintOf: () => ({ kind: 'rescue_experiment', hid: 'h-1' }),
        rescueStateOf: () => ({ status: 'running', stage: 'rescue-author' }),
        rescuePromptOf: () => null,
      },
    }),
  ));
  assert.match(zhStepHtml, /还差：做一个 4 页交互实验/);
  assert.match(zhStepHtml, /data-book-rescue-status="running"/);

  setUiLanguage('en');
  try {
    const enGapHtml = renderToStaticMarkup(React.createElement(
      StudyServicesContext.Provider,
      { value: { host: { openAgent: noop }, busy: false } },
      React.createElement(BookGapHint, {
        node: pointNode,
        course: 'Stats',
        handlers: {
          gapHintOf: () => ({ kind: 'companion_open', hid: 'h-1', slide: 6, companionId: 'comp-full' }),
          rescueStateOf: () => ({ status: 'ready', companionId: 'rescue-1' }),
          rescuePromptOf: () => ({ type: 'rescue-handoff', hid: 'h-1' }),
          openModel: noop,
          dismissRescuePrompt: noop,
        },
      }),
    ));
    assert.doesNotMatch(enGapHtml, HAN_RE, 'English BookGapHint must contain zero Chinese');
    assert.match(enGapHtml, /Still needed: open slide 6 in interactive companion/);
    assert.match(gapHintLabel({ kind: 'rescue_experiment' }), /4-slide interactive experiment/);
    assert.match(gapHintLabel({ kind: 'companion_open', lessonMode: 'rescue' }), /open 4-slide interactive experiment/);
    assert.doesNotMatch(
      handOffText('companion.rescue', { course: 'Stats', deckId: 'd1', cardIds: ['c1', 'c2'], hid: 'h-1', topic: 'Bayes' }, 'en'),
      HAN_RE,
      'English multi-card companion.rescue hand-off must contain zero Chinese',
    );
  } finally {
    setUiLanguage('zh');
  }
});

/* -------------------------------------------------------------------------
 * 3. Main-Chat AI Tutor (`skills/study-tutor/SKILL.md`) contract test
 * ------------------------------------------------------------------------- */

test('study-tutor SKILL.md authorizes zero-key rescue companion.compile after 2 consecutive failed checks and names only registered actions', async (t) => {
  const raw = await readFile(new URL('../skills/study-tutor/SKILL.md', import.meta.url), 'utf8');
  const skill = parseSkill(raw);
  assert.equal(skill.name, 'study-tutor');
  assert.ok(skill.description.length <= 500, 'description fits catalog limit');
  assert.match(skill.content, /2 consecutive checks/i, 'specifies 2-consecutive-failure rescue trigger');
  assert.match(skill.content, /companion\.compile/, 'authorizes zero-key companion.compile');
  assert.match(skill.content, /mode:\s*"rescue"|"mode":\s*"rescue"/, 'specifies rescue mode');
  assert.match(skill.content, /targetCardIds/, 'anchors targetCardIds');
  assert.match(skill.content, /hid/, 'anchors hid');
  assert.match(skill.content, /queued_for_sidebar/, 'preserves honest sidebar receipt wording');
  assert.match(skill.content, /zero Chinese text/i, 'enforces strict en/zh separation');

  const root = await mkdtemp(join(tmpdir(), 'study-tutor-w2c-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  t.after(() => study.dispose?.());

  const named = [...new Set([...raw.matchAll(/`((?:library|course|source|card|study|companion|review|panel|job|case)\.[a-z]+(?:\.[a-z]+)*)\b/g)].map((m) => m[1]))];
  assert.ok(named.includes('companion.compile'), 'study-tutor names companion.compile');
  for (const action of named) {
    if (action === 'panel.open') continue; // panel.open is handled by the host bridge in lib/index.js
    assert.ok(study.runtime.hasAction(action), `study-tutor action ${action} must be registered`);
  }
});

test('companion.compile return shape queues studyRef kind:companion workbench intent in rescue mode only', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-rescue-intent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  t.after(() => study.dispose?.());

  await study.call('course.save', { name: 'Analysis' });
  const rescueLesson = {
    schema: 'studyhub-lesson/1',
    id: 'rescue-uniform-conv',
    mode: 'rescue',
    hid: 'h-41',
    targetCardIds: ['c1'],
    title: 'Why Pointwise Convergence Fails the Integral Swap',
    lead: 'Pointwise limits can lose mass even when every function vanishes at every point.',
    course: 'Analysis',
    language: 'en',
    minutes: 4,
    needs: ['Pointwise convergence'],
    after: ['Check uniform convergence before swapping limit and integral'],
    terms: { 'Uniform convergence': 'Supremum distance shrinks to zero across the whole domain.' },
    slides: [
      {
        id: 's1',
        title: 'Predict Before Checking',
        blocks: [
          {
            t: 'predict',
            id: 'pred-swap',
            q: 'For tall narrow spikes with area 1 shrinking toward 0, does the limit of integrals equal the integral of the pointwise limit?',
            options: ['Yes, pointwise convergence is enough', 'No, the integrals stay 1 while the pointwise limit is 0'],
            answer: 1,
            say: 'Commit to your prediction before testing the parameter.',
          },
        ],
      },
      {
        id: 's2',
        title: 'Watch the Spike Mass',
        blocks: [
          {
            t: 'sandbox',
            knobs: [{ id: 'n', label: 'Index $n$', min: 1, max: 20, step: 1, default: 2 }],
            domain: { variable: 'x', min: 0, max: 1, steps: 60, label: '$x$' },
            series: [{ id: 'f', label: '$f_n(x)$', expr: 'n * exp(-n * x)' }],
            say: 'Drag $n$ upward and watch the peak grow while the tail flattens.',
          },
          {
            t: 'reveal',
            of: 'pred-swap',
            say: 'The peak concentrates area near zero so the limit of integrals does not drop to zero.',
          },
        ],
      },
      {
        id: 's3',
        title: 'Unseen Boundary Check',
        blocks: [
          {
            t: 'quiz',
            q: 'Which condition guarantees swapping limit and Riemann integral on $[0, 1]$?',
            options: [
              { label: 'Pointwise convergence alone', correct: false, why: 'Moving spikes converge pointwise to 0 while keeping area 1.' },
              { label: 'Uniform convergence on $[0, 1]$', correct: true, why: 'Uniform convergence bounds the supremum error across the entire interval.' },
              { label: 'Convergence at rational points only', correct: false, why: 'Values on rationals do not control the integral.' },
              { label: 'Every $f_n$ is nonnegative', correct: false, why: 'Nonnegative spikes still keep area 1.' },
            ],
            say: 'Check the boundary condition on a fresh statement.',
          },
        ],
      },
    ],
  };

  const compiledRes = await study.call('companion.compile', {
    course: 'Analysis',
    attach: true,
    mode: 'rescue',
    hid: 'h-41',
    targetCardIds: ['c1'],
    mountMode: 'companion-only',
    grounded: false,
    lesson: rescueLesson,
  });
  assert.equal(compiledRes.attached, true);
  assert.match(compiledRes.companion.id, /^comp-/);
  assert.equal(compiledRes.companion.lessonMode, 'rescue');

  const intent = companionCompilePanelIntent(
    { course: 'Analysis', attach: true, mode: 'rescue', lesson: rescueLesson },
    compiledRes,
    root,
  );
  assert.deepEqual(intent, {
    type: 'studyRef',
    studyRef: {
      root,
      kind: 'companion',
      id: compiledRes.companion.id,
      course: 'Analysis',
      slide: 1,
      title: 'Why Pointwise Convergence Fails the Integral Swap',
    },
  });

  // Detached or non-rescue compiles do not auto-queue unless openInWorkbench is explicit
  assert.equal(companionCompilePanelIntent({ attach: false, mode: 'rescue' }, compiledRes, root), null);
  assert.equal(
    companionCompilePanelIntent(
      { attach: true, mode: 'full' },
      { attached: true, companion: { id: 'full-1', course: 'Analysis', title: 'Full Lesson', lessonMode: 'full' } },
      root,
    ),
    null,
  );
});
