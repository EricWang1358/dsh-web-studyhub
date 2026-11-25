import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const h = React.createElement;
const noop = () => {};

const m = await loadUi(`
  export { setUiLanguage } from './ui/i18n.js';
  export { resultOpener } from './ui/tasks/task-actions.js';
  export { keptBook } from './ui/book/model.js';
  export { default as AnswerCardSection } from './ui/AnswerCard.jsx';
  export { default as TeachingPanel } from './ui/review/TeachingPanel.jsx';
  export { default as LearningActions } from './ui/review/LearningActions.jsx';
  export { default as DeskPlayStrip } from './ui/desk-play/DeskPlayStrip.jsx';
  export { extractSlipCard } from './ui/desk-play/lucky-card.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
`);

const withServices = (node, services = {}) => h(m.StudyServicesContext.Provider, {
  value: {
    call: async () => ({}),
    act: async () => undefined,
    busy: false,
    notify: noop,
    askInChat: noop,
    host: {},
    openSettings: noop,
    navigate: noop,
    openModal: noop,
    ...services,
  },
}, node);

/* ---------- W1-17: BookStep keys PointBody by step.hid & preserves session retold per hid ---------- */

test('W1-17: BookStep passes key={step.hid} to PointBody and useBookHandlers stores retold per hid', async () => {
  const ui = await loadInteractiveUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { default as BookStep } from './ui/book/BookStep.jsx';
    export { default as PointBody } from './ui/book/PointBody.jsx';
    export { useBookHandlers } from './ui/book/use-book-actions.js';
    export { StudyServicesContext } from './ui/study-context.jsx';
  `);
  ui.exports.setUiLanguage('zh');
  const hI = ui.React.createElement;
  const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };

  // 1. useBookHandlers tracks session retold records per hid and scopes them by course
  const baseBookArgs = {
    call: async () => ({}),
    act: async () => undefined,
    course: 'OS',
    notify: noop,
    book: { status: 'ok', missing: [] },
    setBook: noop,
    rows: [],
    reload: noop,
    remember: noop,
    ai: { cancel: noop },
  };
  const hook = ui.mountHook(ui.exports.useBookHandlers, baseBookArgs);
  const recH1 = { score: 4, verdict: 'solid', summary: '讲清了核心机制' };
  await hook.act(() => hook.current.onRetold('H1', recH1));
  assert.deepEqual(hook.current.retoldOf('H1'), recH1, 'retoldOf returns saved record for H1');
  assert.equal(hook.current.retoldOf('H2'), null, 'retoldOf does not leak H1 record to H2');

  // Switching course scopes out previous course retold records
  hook.rerender({ ...baseBookArgs, course: 'DB' });
  assert.equal(hook.current.retoldOf('H1'), null, 'retoldOf resets when course changes');
  hook.unmount();

  // 2. BookStep keys PointBody by step.hid and PointBody reads handlers.retoldOf(node.hid)
  const makeNode = (hid, title) => ({
    hid,
    title,
    number: hid === 'H1' ? '1.1' : '1.2',
    gen: '核心概念正文',
    cites: '',
    questions: [],
    retold: null,
  });
  const steps = [
    { hid: 'H1', path: [], node: makeNode('H1', '页表') },
    { hid: 'H2', path: [], node: makeNode('H2', '快表') },
  ];
  const handlers = {
    gone: new Set(),
    qaOpen: () => false,
    toggleQa: noop,
    retellOpen: () => false,
    toggleRetell: noop,
    retoldOf: (hid) => (hid === 'H1' ? { ok: true, at: '2026-11-24T00:00:00Z', verdict: 'good' } : null),
    onRetold: noop,
    busy: false,
    model: { ready: true },
  };
  let at = 0;
  const view = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, { value: services },
    hI(ui.exports.BookStep, { steps, at, onGo: noop, course: 'OS', handlers })));
  try {
    const body0 = view.find((n) => n.type === ui.exports.PointBody);
    assert.ok(body0, 'BookStep renders PointBody');
    assert.equal(body0.key, 'H1', 'BookStep keys PointBody by step.hid H1');
    const toolbar0 = view.find((n) => typeof n.type === 'function' && n.type.name === 'PointToolbar');
    assert.ok(toolbar0?.props?.retold, 'PointBody passes handlers.retoldOf(H1) into PointToolbar');

    at = 1;
    view.rerender();
    const body1 = view.find((n) => n.type === ui.exports.PointBody);
    assert.equal(body1.key, 'H2', 'BookStep updates PointBody key to H2');
    const toolbar1 = view.find((n) => typeof n.type === 'function' && n.type.name === 'PointToolbar');
    assert.equal(toolbar1?.props?.retold, null, 'PointBody does not carry H1 retold state onto H2');
  } finally {
    view.unmount();
  }
});

/* ---------- W1-34: Task center 打开复习全书 routes to book with heading & aborts on focus.set failure ---------- */

test('W1-34: resultOpener routes course-book jobs to book page with keepBook target and aborts when focus.set fails', async () => {
  m.setUiLanguage('zh');
  const went = [];
  const root = '/tmp/w1-34-root';
  const job = {
    id: 'job-book-ai',
    type: 'course-book-ai',
    status: 'complete',
    contract: {
      kind: 'course-book-ai',
      status: 'complete',
      result: { refs: [{ kind: 'course-book', id: 'b1', course: 'OS', heading: 'H4' }] },
    },
  };
  const appOk = {
    data: { root, focus: { course: 'DB' }, sources: [] },
    nav: { navigate: (page) => went.push(page) },
    core: { act: async (action, args) => { went.push(`${action}:${args.course}`); return true; } },
  };
  const opener = m.resultOpener(job, appOk);
  assert.equal(opener.label, '打开复习全书');
  await opener.run();
  assert.deepEqual(went, ['focus.set:OS', 'book']);
  const kept = m.keptBook(root, 'OS');
  assert.equal(kept?.target, 'H4');
  assert.equal(kept?.switched, true);

  // When focus.set fails (returns false / undefined), navigation must abort
  const wentFail = [];
  const appFail = {
    data: { root, focus: { course: 'DB' }, sources: [] },
    nav: { navigate: (page) => wentFail.push(page) },
    core: { act: async () => undefined },
  };
  const openerFail = m.resultOpener(job, appFail);
  await openerFail.run();
  assert.deepEqual(wentFail, [], 'must NOT navigate to book when course switch fails');

  // course-outline still routes to outline
  const outlineJob = {
    id: 'job-outline',
    type: 'course-outline',
    status: 'complete',
    contract: {
      kind: 'course-outline',
      status: 'complete',
      result: { refs: [{ kind: 'course-outline', id: 'o1', course: 'OS' }] },
    },
  };
  const wentOutline = [];
  const openerOutline = m.resultOpener(outlineJob, {
    data: { root, focus: { course: 'OS' }, sources: [] },
    nav: { navigate: (page) => wentOutline.push(page) },
    core: { act: async () => true },
  });
  assert.equal(openerOutline.label, '打开总纲');
  await openerOutline.run();
  assert.deepEqual(wentOutline, ['outline']);
});

/* ---------- W1-11: AnswerCard refreshes run immediately & scopes BookButton to card course ---------- */

test('W1-11: AnswerCardSection awaits onRefreshRun on complete and BookButton checks current course in book.courses', async () => {
  const ui = await loadInteractiveUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { default as AnswerCardSection } from './ui/AnswerCard.jsx';
    export { RubricAnswer } from './ui/CaseWorkspace.jsx';
    export { default as QuestionRun } from './ui/review/QuestionRun.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
  `);
  ui.exports.setUiLanguage('zh');
  const hI = ui.React.createElement;

  const baseAnswerCard = { state: 'verified', conclusion: '选择方案 A。', steps: ['第一步'] };
  const baseRun = {
    id: 'run-ac',
    deckId: 'd1',
    index: 0,
    total: 1,
    card: { id: 'c1', kind: 'open', prompt: '案例分析' },
    feedback: { rubric: { total: 8, max: 10, items: [] }, answer: '我的回答' },
    solution: { answer: '参考答案', answerCard: baseAnswerCard },
  };
  const baseData = { decks: [{ id: 'd1', title: 'OS', course: 'OS' }], sources: [], modelReady: true, settings: {} };

  // 1. BookButton hidden when only another course has a book; shown and uses qaAddFailureText when card's course has a book
  const makeServices = (call) => ({ call, act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop });
  const otherCourseView = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, {
    value: makeServices(async (action) => (action === 'book.qa.list' ? { followupIds: [], answerCardIds: [], courses: ['Math'] } : {})),
  }, hI(ui.exports.AnswerCardSection, { run: baseRun, data: baseData, onSetupModel: noop })));
  await otherCourseView.flush(4);
  assert.equal(otherCourseView.find((n) => n.props?.['data-answer-card-book']), null, 'BookButton hidden when card course has no book');
  otherCourseView.unmount();

  const matchingCourseView = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, {
    value: makeServices(async (action) => {
      if (action === 'book.qa.list') return { followupIds: [], answerCardIds: [], courses: ['OS'] };
      if (action === 'book.qa.add') throw Object.assign(new Error('raw error'), { code: 'course-book-rebuild-pending' });
      return {};
    }),
  }, hI(ui.exports.AnswerCardSection, { run: baseRun, data: baseData, onSetupModel: noop })));
  await matchingCourseView.flush(4);
  const bookBtn = matchingCourseView.find((n) => n.type === 'button' && n.props?.['data-answer-card-book'] === 'add');
  assert.ok(bookBtn, 'BookButton rendered when current course is in book.courses');
  await matchingCourseView.act(() => click(bookBtn));
  await matchingCourseView.flush(3);
  assert.ok(matchingCourseView.text().includes('总纲刚重新整理好'), 'BookButton formats failure via qaAddFailureText');
  matchingCourseView.unmount();

  // 2. AnswerCardSection awaits onRefreshRun before clearing busy state on job completion
  const prevSetTimeout = globalThis.setTimeout;
  const prevClearTimeout = globalThis.clearTimeout;
  const prevDocument = globalThis.document;
  const pollCallbacks = [];
  globalThis.setTimeout = (fn) => { pollCallbacks.push(fn); return { unref: noop }; };
  globalThis.clearTimeout = noop;
  globalThis.document = { hidden: false, visibilityState: 'visible', addEventListener: noop, removeEventListener: noop };
  try {
    let resolveRefresh;
    let refreshCalls = 0;
    const onRefreshRun = () => {
      refreshCalls += 1;
      return new Promise((resolve) => { resolveRefresh = resolve; });
    };
    const noCardRun = { ...baseRun, solution: { answer: '参考答案' } };
    const genView = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, {
      value: makeServices(async (action) => {
        if (action === 'book.qa.list') return { followupIds: [], answerCardIds: [], courses: [] };
        if (action === 'generation.answerCard.build') return { jobId: 'job-ac-1' };
        if (action === 'job.status') return { status: 'complete' };
        return {};
      }),
    }, hI(ui.exports.AnswerCardSection, { run: noCardRun, data: baseData, onSetupModel: noop, onRefreshRun })));
    await genView.flush(3);
    const genBtn = genView.find((n) => n.type === 'button' && n.props?.['data-answer-card-generate'] === 'new');
    assert.ok(genBtn, 'generate answer-card button rendered');
    await genView.act(() => click(genBtn));
    await genView.flush(3);
    assert.ok(pollCallbacks.length > 0, 'polling started for answer-card job');
    const pollPromise = pollCallbacks.at(-1)();
    await genView.flush(3);
    assert.equal(refreshCalls, 1, 'onRefreshRun called when job completes');
    assert.ok(genView.text().includes('正在生成答题卡'), 'busy status stays visible while awaiting onRefreshRun');
    resolveRefresh();
    await pollPromise;
    await genView.flush(3);
    assert.equal(genView.text().includes('正在生成答题卡'), false, 'busy status clears after onRefreshRun resolves');
    genView.unmount();
  } finally {
    globalThis.setTimeout = prevSetTimeout;
    globalThis.clearTimeout = prevClearTimeout;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }

  // 3. CaseWorkspace.RubricAnswer forwards onRefreshRun to AnswerCardSection, and QuestionRun passes session.pollNow
  const spyRefresh = () => Promise.resolve();
  await withBrowserGlobals(async () => {
    const rubricView = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, {
      value: makeServices(async () => ({ followupIds: [], answerCardIds: [], courses: [] })),
    }, hI(ui.exports.RubricAnswer, { run: baseRun, data: baseData, value: '', onChange: noop, onSubmit: noop, onSetupModel: noop, onRefreshRun: spyRefresh })));
    const acNode = rubricView.find((n) => n.type === ui.exports.AnswerCardSection);
    assert.equal(acNode?.props?.onRefreshRun, spyRefresh, 'RubricAnswer forwards onRefreshRun to AnswerCardSection');
    rubricView.unmount();

    const spyPollNow = () => Promise.resolve();
    const qRunSession = {
      run: {
        ...baseRun,
        mode: 'path',
        card: { ...baseRun.card, rubricCriteria: [{ point: '核心论证', marks: 10 }] },
        navigation: [{ index: 0, cardId: 'c1' }],
      },
      entry: { selected: [], hint: false, explain: false, response: '', clozeValues: {}, teaching: null, teachAnswer: '' },
      showBack: false,
      showEn: false,
      enBusyKey: '',
      teachingBusy: false,
      choice: false,
      isCloze: false,
      rubricCard: true,
      pollNow: spyPollNow,
      actions: { reviewAct: noop, choose: noop, flipCard: noop, assistCard: noop, slayCard: noop, studyPrerequisites: noop, teachingAct: noop, toggleEn: noop, toggleHelp: noop, setResponse: noop, setClozeValue: noop, setTeachAnswer: noop, closeShortcutHelp: noop, showExplanation: noop, askAboutCard: noop, improveCard: noop, toggleAutopilot: noop },
    };
    const qRunView = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, {
      value: makeServices(async () => ({ followupIds: [], answerCardIds: [], courses: [] })),
    }, hI(ui.exports.QuestionRun, { session: qRunSession, data: baseData, links: {}, context: {} })));
    const rubricInQRun = qRunView.find((n) => n.type === ui.exports.RubricAnswer);
    assert.equal(rubricInQRun?.props?.onRefreshRun, spyPollNow, 'QuestionRun passes session.pollNow as onRefreshRun to RubricAnswer');
    qRunView.unmount();
  });
});

/* ---------- W1-16: TeachingPanel shows busy state & TeachingStatus outside collapsible details ---------- */

test('W1-16: TeachingPanel renders busy submit button and inline TeachingStatus; LearningActions hides duplicate when teaching open', () => {
  m.setUiLanguage('zh');
  const session = {
    run: { deckId: 'd1', card: { id: 'c1' }, feedback: { passed: true }, solution: { citations: [] }, mode: 'path' },
    entry: {
      teaching: { id: 't1', mode: 'understanding', index: 0, total: 3, lesson: 'Step 1', check: 'Why?', complete: false },
      teachAnswer: 'Because of invariants',
    },
    teachingBusy: true,
    teachingError: '模型超时',
    actions: { setTeachAnswer: noop, teachingAct: noop, cancelTeaching: noop, retryTeaching: noop },
  };
  const busyHtml = renderToStaticMarkup(withServices(h(m.TeachingPanel, {
    session,
    data: { sources: [], decks: [] },
    model: { ready: true },
    onModelSettings: noop,
  })));
  assert.doesNotMatch(busyHtml, /sh-btn--primary/, 'TeachingPanel submit button must not use primary CTA style');
  assert.match(busyHtml, /正在检查…/, 'TeachingPanel submit button must show busy label while checking');
  assert.match(busyHtml, /teaching-status/, 'TeachingPanel must show TeachingStatus spinner while busy');

  const errorSession = { ...session, teachingBusy: false };
  const errHtml = renderToStaticMarkup(withServices(h(m.TeachingPanel, {
    session: errorSession,
    data: { sources: [], decks: [] },
    model: { ready: true },
    onModelSettings: noop,
  })));
  assert.match(errHtml, /模型超时/, 'TeachingPanel must show TeachingStatus error even when PostAnswerDetails is collapsed');

  const actionsHtml = renderToStaticMarkup(withServices(h(m.LearningActions, {
    session: errorSession,
    data: { sources: [], decks: [] },
    model: { ready: true },
    onModelSettings: noop,
    openModal: noop,
  })));
  assert.doesNotMatch(actionsHtml, /模型超时/, 'LearningActions should not duplicate TeachingStatus while TeachingPanel is open');
});

/* ---------- W1-24: OralExam action-scoped busy states and consistent answered count ---------- */

test('W1-24: OralExam separates pendingAction for followup/next/submit and displays effectiveAnswered', async () => {
  const ui = await loadInteractiveUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { default as OralExam } from './ui/OralExam.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
  `);
  ui.exports.setUiLanguage('zh');
  const hI = ui.React.createElement;

  const activeRun = {
    id: 'oral-1',
    index: 0,
    total: 3,
    answered: 0,
    entry: { cardId: 'c1', topic: 'Virtual Memory', prompt: 'Explain page faults', answer: '', followup: '', followupAnswer: '' },
  };
  let resolveFollowup;
  let resolveSubmit;
  const call = (action) => {
    if (action === 'oral.active') return Promise.resolve(activeRun);
    if (action === 'oral.answer') return Promise.resolve({ ...activeRun, answered: 1, entry: { ...activeRun.entry, answer: 'Page fault traps to OS' } });
    if (action === 'oral.followup') return new Promise((resolve) => { resolveFollowup = resolve; });
    if (action === 'oral.submit') return new Promise((resolve) => { resolveSubmit = resolve; });
    return Promise.resolve({});
  };
  const services = { call, act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
  const data = { root: '/tmp/oral-lib', decks: [{ id: 'd1', title: 'OS', course: 'OS', count: 3, available: 3 }], focus: { course: 'OS' }, modelReady: true };

  await withBrowserGlobals(async () => {
    const view = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, { value: services },
      hI(ui.exports.OralExam, { data, onExit: noop })));
    try {
      await view.flush(6);
      assert.ok(view.text().includes('本轮已回答 0 题'), 'starts at 0 answered');

      // Typing an answer updates effectiveAnswered immediately in top progress
      const textarea = view.find((n) => n.type === 'textarea');
      assert.ok(textarea, 'answer textarea rendered');
      await view.act(() => textarea.props.onChange({ target: { value: 'Page fault traps to OS' } }));
      assert.ok(view.text().includes('本轮已回答 1 题'), 'top progress immediately reflects unsaved draft via effectiveAnswered');

      // Trigger followup -> only followup button enters busy state (early-submit button stays non-busy)
      const followupBtn = view.find((n) => n.type === 'button' && ui.textOf(n).includes('追问一次'));
      assert.ok(followupBtn, 'followup button rendered');
      const followupTask = view.act(() => click(followupBtn));
      await view.flush(4);
      assert.ok(view.text().includes('正在生成追问…'), 'followup button shows followup busy label');
      assert.equal(view.text().includes('正在集中评估…'), false, 'submit button does not show submit busy label during followup');
      resolveFollowup({ ...activeRun, answered: 1, entry: { ...activeRun.entry, answer: 'Page fault traps to OS', followup: 'What about TLB?' } });
      await followupTask;
      await view.flush(4);

      // Trigger early submit -> dialog confirms consistent unansweredCount (3 - 1 = 2) -> submit button shows submit busy label
      const earlyBtn = view.find((n) => n.type === 'button' && ui.textOf(n).includes('提前结束'));
      assert.ok(earlyBtn, 'early submit button rendered');
      await view.act(() => click(earlyBtn));
      assert.ok(view.text().includes('还有 2 题未作答'), 'early submit dialog count matches top progress effectiveAnswered');
      const confirmDialog = view.find((n) => typeof n.type === 'function' && n.type.name === 'SubmitBlanksDialog');
      assert.ok(confirmDialog?.props?.onConfirm, 'SubmitBlanksDialog exposes onConfirm');
      const submitTask = view.act(() => confirmDialog.props.onConfirm());
      await view.flush(4);
      assert.ok(view.text().includes('正在集中评估…'), 'early-submit button enters submit busy state during oral.submit');
      resolveSubmit({ runId: 'oral-1', total: 3, answered: 1, assessed: 1, strong: 1, developing: 0, weak: 0, feedbackStatus: 'assessed', entries: [] });
      await submitTask;
      await view.flush(4);
    } finally {
      view.unmount();
    }
  });
});

/* ---------- W1-31: DeskPlayStrip shows options, renders Markdown/LaTeX, and clears on deck removal / library switch ---------- */

test('W1-31: extractSlipCard keeps quiz options and formulas without truncation; DeskPlayStrip renders options, Markdown/math, and resets cleanly', async () => {
  m.setUiLanguage('zh');
  const card = {
    id: 'c-math',
    kind: 'quiz',
    topic: 'Calculus',
    prompt: '计算定积分 $\\int_0^1 x^2 \\, dx$ 的值：',
    answer: 'b',
    options: [
      { id: 'a', text: '$\\frac{1}{2}$', correct: false },
      { id: 'b', text: '$\\frac{1}{3}$', correct: true },
    ],
    explanation: '由牛顿-莱布尼茨公式，$\\left.\\frac{x^3}{3}\\right|_0^1 = \\frac{1}{3}$。',
  };
  const deck = { id: 'd1', title: '高数', course: 'Math', cards: [card], available: 1, count: 1 };
  const slip = m.extractSlipCard(card, deck);
  assert.equal(slip.options.length, 2);
  assert.equal(slip.options[0].label, 'A');
  assert.equal(slip.options[1].label, 'B');
  assert.equal(slip.options[1].correct, true);

  const html = renderToStaticMarkup(withServices(h(m.DeskPlayStrip, {
    data: { root: '/lib-a', revision: 1, decks: [deck], attempts: [] },
    onPracticeDeck: noop,
    initialSlip: slip,
    initialRevealed: true,
  })));
  assert.match(html, /desk-play-slip__options/, 'renders quiz options list on slip');
  assert.match(html, /data-correct="true"/, 'highlights correct option when revealed');
  assert.match(html, /katex|md-compact/, 'renders prompt/options/explanation via Markdown/KaTeX');

  // Interactive behavior: revision invalidates deck cache, deck removal clears slip, and StudyMap keys LazyDeskPlayStrip by data.root
  const ui = await loadInteractiveUi(`
    export { setUiLanguage } from './ui/i18n.js';
    export { default as DeskPlayStrip } from './ui/desk-play/DeskPlayStrip.jsx';
    export { default as LazyDeskPlayStrip } from './ui/desk-play/LazyDeskPlayStrip.jsx';
    export { default as StudyMap } from './ui/StudyMap.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { AppContext } from './ui/app/app-context.js';
  `);
  ui.exports.setUiLanguage('zh');
  const hI = ui.React.createElement;

  let deckGetCalls = 0;
  const services = {
    call: async (action) => {
      if (action === 'deck.get') {
        deckGetCalls += 1;
        return { ...deck, cards: [{ ...card, prompt: `第 ${deckGetCalls} 版题目` }] };
      }
      return {};
    },
    act: async () => undefined,
    busy: false,
    notify: noop,
    askInChat: noop,
    host: {},
    openSettings: noop,
    navigate: noop,
    openModal: noop,
  };

  let stripData = { root: '/lib-a', revision: 1, decks: [deck], attempts: [] };
  const stripView = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, { value: services },
    hI(ui.exports.DeskPlayStrip, { data: stripData, onPracticeDeck: noop })));
  try {
    const drawBtn = () => stripView.find((n) => n.type === 'button' && (ui.textOf(n).includes('抽一签') || ui.textOf(n).includes('换一签')));
    await stripView.act(() => click(drawBtn()));
    await stripView.flush(4);
    assert.equal(deckGetCalls, 1, 'initial draw fetches deck once');
    assert.ok(stripView.text().includes('第 1 版题目'), 'renders drawn card');

    // Drawing again at same revision reuses cached deck
    await stripView.act(() => click(drawBtn()));
    await stripView.flush(4);
    assert.equal(deckGetCalls, 1, 'same revision reuses cached deck');

    // Incrementing data.revision invalidates deck cache so next draw refetches
    stripData = { ...stripData, revision: 2 };
    stripView.rerender();
    await stripView.act(() => click(drawBtn()));
    await stripView.flush(4);
    assert.equal(deckGetCalls, 2, 'revision change invalidates deckCacheRef');
    assert.ok(stripView.text().includes('第 2 版题目'), 'renders refreshed card after revision bump');

    // Removing the slip's deck from active decks clears the slip
    stripData = { ...stripData, decks: [] };
    stripView.rerender();
    assert.equal(stripView.text().includes('第 2 版题目'), false, 'clears slip when its deck leaves active decks');
  } finally {
    stripView.unmount();
  }

  // StudyMap keys LazyDeskPlayStrip by data.root
  let mapRoot = '/lib-a';
  const appCtx = { language: 'zh', host: {}, data: { root: mapRoot, decks: [deck], courses: [], sources: [], attempts: [], focus: {} }, canChat: false, core: { call: services.call, act: noop, busy: false, notify: noop } };
  const mapView = ui.mount(() => hI(ui.exports.StudyServicesContext.Provider, { value: services },
    hI(ui.exports.AppContext.Provider, { value: { ...appCtx, data: { ...appCtx.data, root: mapRoot } } },
      hI(ui.exports.StudyMap, { data: { ...appCtx.data, root: mapRoot }, onPracticeDeck: noop, onOpenCourse: noop, onNewDeck: noop }))));
  try {
    const lazy0 = mapView.find((n) => n.type === ui.exports.LazyDeskPlayStrip);
    assert.equal(lazy0?.key, '/lib-a', 'StudyMap keys LazyDeskPlayStrip by data.root (/lib-a)');
    mapRoot = '/lib-b';
    mapView.rerender();
    const lazy1 = mapView.find((n) => n.type === ui.exports.LazyDeskPlayStrip);
    assert.equal(lazy1?.key, '/lib-b', 'StudyMap updates LazyDeskPlayStrip key on library switch (/lib-b)');
  } finally {
    mapView.unmount();
  }
});
