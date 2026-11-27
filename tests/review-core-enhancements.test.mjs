/*
 * Why static CSS inspection remains for the 2 Recall Veil `:has()` rules in `ui/review/question.css`:
 * Node's test runner has no browser CSSOM/selector engine to evaluate CSS `:has()` / `:not(:hover, :focus-within)`
 * cascade matching, so verifying that the live `.question-area:has([data-retell-drafting])` rule exists and the
 * dead `.review-body > .explanation:has(~ [data-retell-drafting])` selector stays removed must remain a static guard.
 * All JS/JSX behavior (operations, hooks, memoization, busy context isolation, and rendered review components)
 * is verified via real execution below.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projection } from '../lib/study-state.js';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';
import { click, loadInteractiveUi, textOf, withBrowserGlobals } from './helpers/react-harness.mjs';

async function loadOperations(t) {
  try {
    return await import('../lib/contexts/study/operations.js');
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      t.skip(`npm dependency unavailable in workspace: ${err.message.split('\n')[0]}`);
      return null;
    }
    throw err;
  }
}

function makeStudyHarness(createOperations, cards) {
  const state = {
    settings: {},
    decks: [{ id: 'd1', title: 'Systems', course: 'CS', cards: structuredClone(cards) }],
    sources: [],
    runs: [],
    attempts: [],
    teaching: [],
    inbox: [],
  };
  const ports = {
    state: {
      read: async () => state,
      update: async (fn) => fn(state),
    },
    work: { translateInflight: new Map() },
  };
  const { mutations } = createOperations(ports);
  return { state, mutations };
}

test('Batch 2.2: low self-grades (0, 1, 2) never auto-advance with advanceOnSelfGrade, while passing grades (3–5) do', async (t) => {
  const mod = await loadOperations(t);
  if (!mod) return;
  for (const grade of [0, 1, 2]) {
    const { state, mutations } = makeStudyHarness(mod.createOperations, [
      { id: 'f1', kind: 'flashcard', topic: 'T', prompt: 'Q1?', answer: 'A1', explanation: 'E1' },
      { id: 'f2', kind: 'flashcard', topic: 'T', prompt: 'Q2?', answer: 'A2', explanation: 'E2' },
    ]);
    const started = mutations['review.start'](state, { deckId: 'd1', mode: 'flashcard', fresh: true });
    const firstId = started.card.id;
    mutations['review.reveal'](state, { runId: started.id, cardId: firstId });
    const res = mutations['review.answer'](state, { runId: started.id, cardId: firstId, grade, advanceOnSelfGrade: true });
    assert.equal(res.card.id, firstId, `grade ${grade} stays on ${firstId}`);
    assert.equal(res.selfGradeAdvanced, undefined, `grade ${grade} does not set selfGradeAdvanced`);
    assert.equal(res.feedback?.grade, grade);
    assert.equal(res.feedback?.correct, false);
    assert.equal(!!res.feedback?.retryQueued, grade <= 1, `grade ${grade} retryQueued matches <= 1 threshold`);
  }

  for (const grade of [3, 4, 5]) {
    const { state, mutations } = makeStudyHarness(mod.createOperations, [
      { id: 'f1', kind: 'flashcard', topic: 'T', prompt: 'Q1?', answer: 'A1', explanation: 'E1' },
      { id: 'f2', kind: 'flashcard', topic: 'T', prompt: 'Q2?', answer: 'A2', explanation: 'E2' },
    ]);
    const started = mutations['review.start'](state, { deckId: 'd1', mode: 'flashcard', fresh: true });
    const firstId = started.card.id;
    const secondId = firstId === 'f1' ? 'f2' : 'f1';
    mutations['review.reveal'](state, { runId: started.id, cardId: firstId });
    const res = mutations['review.answer'](state, { runId: started.id, cardId: firstId, grade, advanceOnSelfGrade: true });
    assert.equal(res.card.id, secondId, `grade ${grade} auto-advances to ${secondId}`);
    assert.equal(res.selfGradeAdvanced, true);
    assert.equal(res.gradedFeedback?.grade, grade);
    assert.ok(res.gradedFeedback?.nextDue, 'gradedFeedback carries nextDue for brief status cue');
  }

  // Exam mode never auto-advances even when advanceOnSelfGrade: true is passed.
  {
    const { state, mutations } = makeStudyHarness(mod.createOperations, [
      { id: 'q1', kind: 'quiz', topic: 'T', prompt: 'Q1?', options: [{ id: 'a', text: 'A', correct: true }, { id: 'b', text: 'B', correct: false }] },
      { id: 'q2', kind: 'quiz', topic: 'T', prompt: 'Q2?', options: [{ id: 'a', text: 'A', correct: true }, { id: 'b', text: 'B', correct: false }] },
    ]);
    const started = mutations['review.start'](state, { deckId: 'd1', mode: 'exam', fresh: true });
    const firstId = started.card.id;
    const res = mutations['review.answer'](state, { runId: started.id, cardId: firstId, selected: ['a'], advanceOnSelfGrade: true });
    assert.equal(res.card.id, firstId, 'exam mode stays on current question');
    assert.equal(res.selfGradeAdvanced, undefined, 'exam mode never sets selfGradeAdvanced');
  }
});

test('Batch 4.2: review.answer accepts inline assistance and draft directly without requiring prior review.draft.save', async (t) => {
  const mod = await loadOperations(t);
  if (!mod) return;
  const { state, mutations } = makeStudyHarness(mod.createOperations, [
    {
      id: 'q1',
      kind: 'quiz',
      topic: 'T',
      prompt: 'Pick A',
      options: [
        { id: 'a', text: 'A', correct: true, explanation: 'Right' },
        { id: 'b', text: 'B', correct: false, explanation: 'Wrong' },
      ],
    },
    { id: 'f1', kind: 'flashcard', topic: 'T', prompt: 'Explain?', answer: 'Because' },
  ]);
  const run = mutations['review.start'](state, { deckId: 'd1', mode: 'path', fresh: true, ordered: true });
  const answered = mutations['review.answer'](state, {
    runId: run.id,
    cardId: 'q1',
    selected: ['a'],
    assistance: { hintUsed: true },
  });
  assert.equal(answered.feedback.correct, true);
  assert.equal(answered.feedback.grade, 3, 'hintUsed caps correct auto-grade to 3');
  assert.equal(answered.feedback.hintGraded, true);
  assert.equal(state.attempts.at(-1).assistance.hintUsed, true);

  // Open/flashcard scratchpad draft piggybacked on review.answer survives review.undo
  mutations['review.move'](state, { runId: run.id, direction: 1 });
  mutations['review.reveal'](state, { runId: run.id, cardId: 'f1' });
  mutations['review.answer'](state, {
    runId: run.id,
    cardId: 'f1',
    grade: 2,
    draft: { text: 'Inline scratchpad without prior draft.save' },
  });
  const undone = mutations['review.undo'](state, { runId: run.id });
  assert.equal(undone.card.id, 'f1');
  assert.equal(undone.draft?.text, 'Inline scratchpad without prior draft.save');
});

test('Batch 2.5: review.grade.adjust { clozeEquivalent: true } overrides failed cloze, updates SRS, removes tail retry, and supports saveAccept', async (t) => {
  const mod = await loadOperations(t);
  if (!mod) return;
  const { state, mutations } = makeStudyHarness(mod.createOperations, [
    {
      id: 'c1',
      kind: 'cloze',
      topic: 'Consensus',
      prompt: '',
      requires: [{ deckId: 'd2', cardId: 'p1' }],
      cloze: {
        text: 'Raft elects a {{role}} per term.',
        blanks: [{ id: 'role' }],
        answers: [{ id: 'role', value: 'leader', accept: [] }],
      },
      explanation: 'A single leader handles log replication.',
    },
    { id: 'f2', kind: 'flashcard', topic: 'Consensus', prompt: 'Next?', answer: 'Yes' },
  ]);
  state.decks.push({
    id: 'd2',
    title: 'Prereqs',
    course: 'CS',
    cards: [{ id: 'p1', kind: 'flashcard', topic: 'Consensus', prompt: 'Prereq?', answer: 'Term' }],
  });
  const run = mutations['review.start'](state, { deckId: 'd1', mode: 'path', fresh: true, ordered: true });
  const c1Idx = state.runs[0].entries.findIndex((e) => e.card.id === 'c1');
  if (run.index !== c1Idx) mutations['review.move'](state, { runId: run.id, index: c1Idx });
  const wrong = mutations['review.answer'](state, {
    runId: run.id,
    cardId: 'c1',
    answers: { role: 'primary node' },
  });
  assert.equal(wrong.feedback.correct, false);
  assert.equal(wrong.feedback.grade, 1);
  assert.equal(wrong.feedback.retryQueued, true);
  assert.equal(wrong.feedback.credited, 0, 'failed cloze does not credit prerequisites');
  assert.equal(state.decks[1].cards[0].review, undefined, 'prerequisite p1 stays unreviewed before override');
  const entriesWithRetry = wrong.navigation.length;
  assert.ok(entriesWithRetry >= 3, 'tail retry queued on miss');

  const adjusted = mutations['review.grade.adjust'](state, {
    runId: run.id,
    entryIndex: c1Idx,
    cardId: 'c1',
    clozeEquivalent: true,
    saveAccept: true,
  });
  assert.equal(adjusted.feedback.correct, true);
  assert.equal(adjusted.feedback.grade, 4);
  assert.equal(adjusted.feedback.gradeOriginal, 1);
  assert.equal(adjusted.feedback.clozeEquivalent, true);
  assert.equal(adjusted.feedback.retryQueued, false);
  assert.equal(adjusted.feedback.credited, 1, 'cloze equivalence override re-settles prerequisite credit');
  assert.equal(adjusted.feedback.details[0].correct, true);
  assert.equal(adjusted.feedback.details[0].equivalent, true);
  assert.equal(adjusted.navigation.length, entriesWithRetry - 1, 'unpractised tail retry removed');
  assert.ok(state.decks[1].cards[0].review, 'prerequisite p1 received implicit SRS credit');
  assert.ok(state.attempts.some((a) => a.implicit && a.quiz_id === 'p1'), 'implicit attempt recorded for prerequisite p1');
  assert.equal(state.decks[0].cards[0].review.repetitions, 1, 'SRS updated to passing repetition');
  assert.deepEqual(state.decks[0].cards[0].cloze.answers[0].accept, ['primary node'], 'optional saveAccept stored synonym');
  const directAttempt = state.attempts.findLast((a) => !a.implicit && a.quiz_id === 'c1');
  assert.equal(directAttempt.grade, 4);
  assert.equal(directAttempt.clozeEquivalent, true);

  // Stubborn metadata projection stays coherent after adjustment
  const proj = projection(state, state.runs[0]);
  assert.equal(proj.stubborn, undefined, 'passed card after equivalence override has 0 misses');
});

test('Batch 1.1 (static CSS guard): Recall Veil :has() selector targets .question-area and dead .review-body selector is removed', () => {
  const { declarations, blocks } = parseCss(readFileSync('ui/review/question.css', 'utf8'));
  const splitSelectors = (sel) => sel.split(/,(?![^(]*\))/).map((s) => s.trim());
  const veilDecls = declarations.filter((d) =>
    !d.ctx.some((c) => /^@(?:media|container)\b/.test(c))
    && splitSelectors(d.ctx.at(-1) || '').includes('.question-area:has([data-retell-drafting]) > .explanation:not(:hover, :focus-within)'));
  assert.equal(
    veilDecls.some((d) => d.prop === 'filter' && d.value === 'blur(5px)'),
    true,
    'Recall Veil blurs .explanation under .question-area:has([data-retell-drafting])',
  );
  assert.equal(
    veilDecls.some((d) => d.prop === 'opacity' && parseFloat(d.value) < 1),
    true,
    'Recall Veil dims .explanation under .question-area:has([data-retell-drafting])',
  );

  const deadSelectorRe = /\.review-body\s*>\s*\.explanation:has\(~\s*\[data-retell-drafting\]\)/;
  assert.deepEqual(
    declarations.filter((d) => d.ctx.some((c) => deadSelectorRe.test(c))),
    [],
    'dead selector removed from declarations',
  );
  assert.deepEqual(
    blocks.filter((b) => deadSelectorRe.test(b.prelude) || b.ctx.some((c) => deadSelectorRe.test(c))),
    [],
    'dead selector removed from blocks',
  );
});

const reviewUiBundle = await loadInteractiveUi(`
  export { default as usePinQuestion } from './ui/review/usePinQuestion.js';
  export { useAutopilotPause, useAssistWatch } from './ui/review/use-review-run-sync.js';
  export { createBusyStore, StudyBusyProvider, StudyServicesContext, useStudyBusy, useStudyServices } from './ui/study-context.jsx';
  export { default as AppSidebar } from './ui/app/AppSidebar.jsx';
  export { default as AppTopbar } from './ui/app/AppTopbar.jsx';
  export { default as AppModalHost } from './ui/app/AppModalHost.jsx';
  export { useReviewSession, useLiveSession } from './ui/review/useReviewSession.js';
  export { default as QuestionRun } from './ui/review/QuestionRun.jsx';
  export { ClozeQuestion } from './ui/review/QuestionParts.jsx';
  export { default as CoachDebrief } from './ui/CoachDebrief.jsx';
  export { ToastContext } from './ui/components/Feedback.jsx';
  export { reviewEntryKey } from './ui/async.js';
`);

test('Batch 4.3 + 4.4: usePinQuestion batches reads before minHeight write, sync hooks ignore session wrapper churn, shell parts are memoized, busy context is split, and review.answer skips serial draft.save', async () => {
  const {
    React,
    mount,
    mountHook,
    exports: {
      usePinQuestion,
      useAutopilotPause,
      useAssistWatch,
      createBusyStore,
      StudyBusyProvider,
      useStudyBusy,
      useStudyServices,
      AppSidebar,
      AppTopbar,
      AppModalHost,
      useReviewSession,
      useLiveSession,
    },
  } = reviewUiBundle;

  // 1. Shell components are wrapped with React.memo.
  for (const [name, Component] of [['AppSidebar', AppSidebar], ['AppTopbar', AppTopbar], ['AppModalHost', AppModalHost]]) {
    assert.equal(Component.$$typeof, Symbol.for('react.memo'), `${name} is wrapped with React.memo`);
  }

  await withBrowserGlobals(async () => {
    // 2. usePinQuestion batches all getBoundingClientRect reads strictly before writing area.style.minHeight.
    const ops = [];
    let minHeightValue = '';
    const area = {
      style: {
        get minHeight() { return minHeightValue; },
        set minHeight(v) { ops.push('write:minHeight'); minHeightValue = v; },
      },
      getBoundingClientRect() { ops.push('read:area'); return { top: 100 }; },
    };
    const card = {
      closest(sel) { return sel === '.review-body' ? area : null; },
      getBoundingClientRect() { ops.push('read:card'); return { top: 140 }; },
      querySelector: () => null,
    };
    const meta = { closest(sel) { return sel === '.question-card' ? card : null; } };
    const scrollCalls = [];
    const scroller = {
      clientHeight: 800,
      scrollTop: 50,
      getBoundingClientRect() { ops.push('read:scroller'); return { top: 20 }; },
      scrollTo(arg) { ops.push('write:scrollTo'); scrollCalls.push(arg); },
    };
    const page = {
      closest: () => ({ querySelector: () => ({ offsetHeight: 40 }) }),
      querySelector(sel) { return sel === '.question-meta' ? meta : null; },
      getBoundingClientRect() { ops.push('read:page'); return { top: 100 }; },
    };
    const pageRef = { current: page };
    const pinHook = mountHook(({ run }) => usePinQuestion(pageRef, run, { scroller }), {
      run: { id: 'r1', index: 0, card: { id: 'c1' }, complete: false },
    });
    try {
      assert.equal(scrollCalls.length, 1, 'the first question is pinned like the next ones (#1678)');
      scrollCalls.length = 0;
      ops.length = 0;
      minHeightValue = '';
      pinHook.rerender({ run: { id: 'r1', index: 1, card: { id: 'c2' }, complete: false } });
      const writeIdx = ops.indexOf('write:minHeight');
      const readIndices = ops.map((op, i) => (op.startsWith('read:') ? i : -1)).filter((i) => i >= 0);
      assert.ok(writeIdx > 0, 'minHeight write occurred');
      assert.ok(readIndices.length >= 3, 'card/area/scroller layout reads occurred');
      assert.ok(readIndices.every((i) => i < writeIdx), `all reads must precede minHeight write, got ${ops.join(', ')}`);
      assert.equal(minHeightValue, '784px');
      assert.equal(scrollCalls.length, 1, 'second question scrolls to pinned card offset');
    } finally {
      pinHook.unmount();
    }

    // 3. useAutopilotPause & useAssistWatch do not re-run effects when session wrapper identity changes.
    let pauseCalls = 0;
    const setAutoAdvancePaused = () => { pauseCalls += 1; };
    const reviewBodyRef = { current: { contains: () => false } };
    const basePauseSession = { autoAdvanceActive: true, autoAdvancePaused: false, markingTerms: false, advanceKey: 'k1', setAutoAdvancePaused };
    const pauseHook = mountHook(({ session }) => useAutopilotPause({ session, coachProps: null, reviewBodyRef }), {
      session: { ...basePauseSession },
    });
    try {
      assert.equal(pauseCalls, 1, 'initial effect syncs autopilot pause once');
      pauseHook.rerender({ session: { ...basePauseSession } });
      pauseHook.rerender({ session: { ...basePauseSession } });
      assert.equal(pauseCalls, 1, 'new session wrapper with stable setAutoAdvancePaused does not re-trigger effect');
    } finally {
      pauseHook.unmount();
    }

    let pollCalls = 0;
    const pollNow = () => { pollCalls += 1; };
    const watchHook = mountHook(({ session, assistTasks }) => useAssistWatch({ session, assistTasks, cardId: 'c1' }), {
      session: { pollNow },
      assistTasks: [{ id: 't1', cardId: 'c1', status: 'running' }],
    });
    try {
      watchHook.rerender({ session: { pollNow }, assistTasks: [{ id: 't1', cardId: 'c1', status: 'running' }] });
      assert.equal(pollCalls, 0, 'running task does not poll on session identity churn');
      watchHook.rerender({ session: { pollNow }, assistTasks: [{ id: 't1', cardId: 'c1', status: 'done' }] });
      assert.equal(pollCalls, 1, 'completed task triggers pollNow once');
      watchHook.rerender({ session: { pollNow }, assistTasks: [{ id: 't1', cardId: 'c1', status: 'done' }] });
      assert.equal(pollCalls, 1, 'subsequent session wrapper churn does not re-poll');
    } finally {
      watchHook.unmount();
    }

    // 4. StudyBusyProvider isolates busyStore updates from parent & notifies useStudyBusy subscribers.
    const busyStore = createBusyStore(false);
    const stableStudy = { call: async () => ({}), act: async () => undefined, busy: false, notify: () => {} };
    let outerRenders = 0;
    let seenBusy = null;
    let seenServiceCall = null;
    const Reader = () => {
      seenBusy = useStudyBusy();
      seenServiceCall = useStudyServices().call;
      return React.createElement('span', null, String(seenBusy));
    };
    const Outer = () => {
      outerRenders += 1;
      return React.createElement(StudyBusyProvider, { store: busyStore, study: stableStudy }, React.createElement(Reader));
    };
    const busyMounted = mount(() => React.createElement(Outer));
    try {
      assert.equal(outerRenders, 1);
      assert.equal(seenBusy, false);
      assert.equal(seenServiceCall, stableStudy.call);
      busyStore.set(true);
      busyMounted.rerender();
      assert.equal(seenBusy, true, 'StudyBusyProvider reflects busyStore=true');
      busyStore.set(false);
      busyMounted.rerender();
      assert.equal(seenBusy, false, 'StudyBusyProvider reflects busyStore=false');
    } finally {
      busyMounted.unmount();
    }

    // 5. useReviewSession: review.answer carries inline draft without calling review.draft.save first,
    //    whereas review.move flushes pending draft via review.draft.save before moving; useLiveSession reads liveStore.
    const rpcLog = [];
    const dataObj = { root: 'lib-1', settings: {} };
    const core = {
      busyStore: createBusyStore(false),
      call: async (action, args) => {
        rpcLog.push({ via: 'call', action, args });
        return { ok: true };
      },
      act: async (action, args, after) => {
        rpcLog.push({ via: 'act', action, args });
        const result = { id: args.runId, index: args.index ?? 0, card: { id: 'f2', kind: 'flashcard', prompt: 'Q2', answer: 'A2' }, queueVersion: 0 };
        after?.(result);
        return result;
      },
      notify: () => {},
      setError: () => {},
      refresh: async () => {},
      refs: { dataRef: { current: dataObj }, bindingRoot: { current: 'lib-1' } },
    };
    const nav = { page: 'review', setPage: () => {}, show: { exam: () => {} } };
    const sessionHook = mountHook(() => {
      const s = useReviewSession({ core, nav, modalOpen: false, host: {}, rootRef: { current: null }, late: { current: {} } });
      const live = useLiveSession(s);
      return { session: s, live };
    }, {});
    try {
      const openRun1 = {
        id: 'run-1',
        index: 0,
        queueVersion: 0,
        mode: 'flashcard',
        revealed: false,
        card: { id: 'f1', kind: 'open', prompt: 'Explain?', answer: 'Because' },
      };
      sessionHook.current.session.enterRun(openRun1);
      sessionHook.rerender({});
      sessionHook.current.session.actions.setResponse('inline draft answer');
      sessionHook.rerender({});
      assert.equal(sessionHook.current.live.entry.response, 'inline draft answer', 'useLiveSession receives live response updates');

      await sessionHook.current.session.actions.reviewAct('review.answer', { grade: 2 });
      assert.equal(rpcLog.filter((r) => r.action === 'review.draft.save').length, 0, 'review.answer does not serially call review.draft.save first');
      const answerRpc = rpcLog.find((r) => r.action === 'review.answer');
      assert.ok(answerRpc, 'review.answer was called');
      assert.equal(answerRpc.args.draft?.text, 'inline draft answer', 'review.answer carries dirty draft inline');

      // Now verify review.move DOES flush dirty draft via review.draft.save first.
      rpcLog.length = 0;
      const openRun2 = {
        id: 'run-2',
        index: 0,
        queueVersion: 0,
        mode: 'flashcard',
        revealed: false,
        card: { id: 'f2', kind: 'open', prompt: 'Explain 2?', answer: 'Because 2' },
      };
      sessionHook.current.session.enterRun(openRun2);
      sessionHook.rerender({});
      sessionHook.current.session.actions.setResponse('move flush draft');
      sessionHook.rerender({});
      await sessionHook.current.session.actions.reviewAct('review.move', { direction: 1 });
      const saveIdx = rpcLog.findIndex((r) => r.action === 'review.draft.save');
      const moveIdx = rpcLog.findIndex((r) => r.action === 'review.move');
      assert.ok(saveIdx >= 0 && moveIdx > saveIdx, `review.move flushes draft before moving (${rpcLog.map((r) => r.action).join(' -> ')})`);
    } finally {
      sessionHook.unmount();
    }
  });
});

test('Batch 1.1 + 2.5 + 4.4 UI: QuestionRun grade groups/pending option/verdict/stubborn/SimilarTry/inline-ask/race guard, ClozeQuestion equivalence, and CoachDebrief ctaMode', async () => {
  const {
    React,
    mount,
    exports: {
      QuestionRun,
      ClozeQuestion,
      CoachDebrief,
      createBusyStore,
      StudyBusyProvider,
      ToastContext,
      reviewEntryKey,
    },
  } = reviewUiBundle;

  await withBrowserGlobals(async () => {
    const busyStore = createBusyStore(false);
    const toast = { show: () => {}, dismiss: () => {} };
    const study = { call: async () => ({}), act: async () => undefined, busy: false, notify: () => {}, openModal: () => {}, openSettings: () => {}, host: {} };
    const baseActions = {
      reviewAct: () => {},
      choose: () => {},
      flipCard: () => {},
      assistCard: async () => true,
      slayCard: () => {},
      studyPrerequisites: () => {},
      toggleEn: () => {},
      toggleAutoTerms: () => {},
      toggleHelp: () => {},
      toggleAutopilot: () => {},
      toggleSelfGradeAdvance: () => {},
      undoAnswer: () => {},
      setResponse: () => {},
      setClozeValue: () => {},
    };
    const baseData = { decks: [{ id: 'd1', title: 'Systems', course: 'CS' }], sources: [], assist: [], model: { ready: true }, settings: {} };
    const wrap = (element) => React.createElement(
      ToastContext.Provider,
      { value: toast },
      React.createElement(StudyBusyProvider, { store: busyStore, study }, element),
    );

    // 1. Revealed flashcard renders fail/pass grade groups and .grade.warn for grade 3.
    const flashRun = {
      id: 'r1',
      deckId: 'd1',
      index: 0,
      mode: 'flashcard',
      revealed: true,
      card: { id: 'f1', kind: 'flashcard', topic: 'Systems', prompt: 'Q?', answer: 'A' },
      solution: { answer: 'A', explanation: 'Because' },
      intervals: { 0: 0, 1: 0, 2: 1, 3: 3, 4: 6, 5: 10 },
    };
    const flashView = mount(() => wrap(React.createElement(QuestionRun, {
      session: { run: flashRun, entry: { selected: [], hint: false, explain: false, response: '', clozeValues: {} }, showBack: true, choice: false, isCloze: false, actions: baseActions },
      data: baseData,
      place: null,
    })));
    try {
      assert.ok(flashView.find((n) => String(n.props?.className || '').includes('grade-group--fail')), 'renders fail grade group');
      assert.ok(flashView.find((n) => String(n.props?.className || '').includes('grade-group--pass')), 'renders pass grade group');
      const warnBtn = flashView.find((n) => n.type === 'button' && String(n.props?.className || '').includes('grade') && String(n.props?.className || '').includes('warn'));
      assert.ok(warnBtn, 'renders .grade.warn for grade 3');
      assert.equal(warnBtn.props['data-grade'], 3);
    } finally {
      flashView.unmount();
    }

    // 2. Choice card with optimistic pendingAnswer marks the option with .option--pending.
    const quizRun = {
      id: 'r2',
      deckId: 'd1',
      index: 0,
      mode: 'path',
      card: { id: 'q1', kind: 'quiz', topic: 'Systems', prompt: 'Pick A', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
    };
    const quizView = mount(() => wrap(React.createElement(QuestionRun, {
      session: {
        run: quizRun,
        entry: { selected: [], hint: false, explain: false, response: '', clozeValues: {} },
        pendingAnswer: { key: reviewEntryKey(quizRun), kind: 'choice', selected: ['a'] },
        choice: true,
        isCloze: false,
        actions: baseActions,
      },
      data: baseData,
      place: null,
    })));
    try {
      const pendingOpt = quizView.find((n) => n.type === 'button' && String(n.props?.className || '').includes('option--pending'));
      assert.ok(pendingOpt, 'optimistic pending choice option carries .option--pending');
    } finally {
      quizView.unmount();
    }

    // 3. Answered wrong stubborn card renders .next-due--verdict (hideWhy), .stubborn-cue, SimilarTry, .explanation-inline-ask,
    //    and AssistFormPanel async race guard ignores stale resolution after card switch.
    let resolveAssist;
    const prereqCalls = [];
    const raceActions = {
      ...baseActions,
      assistCard: () => new Promise((resolve) => { resolveAssist = resolve; }),
      studyPrerequisites: (reqs) => { prereqCalls.push(reqs); },
    };
    const wrongCard1 = {
      id: 'r3',
      deckId: 'd1',
      index: 0,
      mode: 'path',
      revealed: true,
      card: { id: 'q1', kind: 'quiz', topic: 'Systems', prompt: 'Pick A', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
      solution: { options: [{ id: 'a', correct: true, explanation: 'Right' }, { id: 'b', correct: false, explanation: 'Wrong' }], explanation: 'Detailed explanation' },
      feedback: { correct: false, grade: 1, selected: ['b'], nextDue: new Date(Date.now() + 86400000).toISOString(), why: 'FSRS detail hidden in verdict' },
      stubborn: { isLeech: true, missCount: 3 },
      prerequisites: [{ deckId: 'd1', cardId: 'p1', prompt: 'Prereq', level: 'new' }],
    };
    const wrongCard2 = {
      ...wrongCard1,
      index: 1,
      card: { id: 'q2', kind: 'quiz', topic: 'Systems', prompt: 'Card 2', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] },
    };
    let activeWrongRun = wrongCard1;
    const wrongView = mount(() => wrap(React.createElement(QuestionRun, {
      session: { run: activeWrongRun, entry: { selected: ['b'], hint: false, explain: true, response: '', clozeValues: {} }, choice: true, isCloze: false, actions: raceActions },
      data: baseData,
      place: null,
    })));
    try {
      const verdictNode = wrongView.find((n) => String(n.props?.className || '').includes('next-due--verdict'));
      assert.ok(verdictNode, 'renders NextDue verdict badge');
      assert.doesNotMatch(textOf(verdictNode), /FSRS detail hidden in verdict/, 'verdict hides deep telemetry why');
      assert.ok(wrongView.find((n) => String(n.props?.className || '').includes('stubborn-cue')), 'renders StubbornCue for leech/stubborn card');
      assert.ok(wrongView.find((n) => String(n.props?.className || '').includes('post-answer-wrong-try')), 'renders SimilarTry container on wrong answer');
      assert.ok(wrongView.find((n) => String(n.props?.className || '').includes('explanation-inline-ask')), 'renders InlineExplanationAsk in explanation');

      // Open assist form from StubbornCue, select prerequisite chip inside the form, submit, then switch card before promise resolves.
      const askStubbornBtn = wrongView.find((n) => n.type === 'button' && textOf(n).includes('拆解这道题'));
      assert.ok(askStubbornBtn, 'StubbornCue opens assist form');
      click(askStubbornBtn);
      wrongView.rerender();
      const assistFormOpen = wrongView.find((n) => n.type === 'form' && String(n.props?.className || '').includes('assist-form'));
      assert.ok(assistFormOpen, 'AssistFormPanel is open');
      const prereqChip = wrongView.find((n) => n.type === 'button' && textOf(n).includes('前置'), assistFormOpen);
      assert.ok(prereqChip, 'AssistFormPanel renders prerequisite help chip');
      click(prereqChip);
      wrongView.rerender();
      const assistForm = wrongView.find((n) => n.type === 'form' && String(n.props?.className || '').includes('assist-form'));
      const submitPromise = assistForm.props.onSubmit({ preventDefault() {} });
      // Switch to card 2 while assistCard is still in flight.
      activeWrongRun = wrongCard2;
      wrongView.rerender();
      resolveAssist(true);
      await submitPromise;
      assert.equal(prereqCalls.length, 0, 'async race guard prevents stale assist completion from triggering studyPrerequisites on the new card');
    } finally {
      wrongView.unmount();
    }

    // 4. ClozeQuestion renders equivalence override button on failed cloze and sends review.grade.adjust { clozeEquivalent: true }.
    const clozeActs = [];
    const clozeRun = {
      id: 'r4',
      index: 2,
      mode: 'path',
      card: { id: 'c1', kind: 'cloze', cloze: { text: 'Raft elects a {{role}}.' } },
      feedback: {
        correct: false,
        grade: 1,
        answers: { role: 'primary' },
        details: [{ id: 'role', correct: false, expected: 'leader' }],
      },
      solution: { blanks: [{ id: 'role', value: 'leader' }] },
    };
    const clozeView = mount(() => wrap(React.createElement(ClozeQuestion, {
      run: clozeRun,
      clozeValues: { role: 'primary' },
      clozeFocusTick: 0,
      actions: { reviewAct: (action, args) => clozeActs.push({ action, args }), setClozeValue: () => {} },
    })));
    try {
      const eqBtn = clozeView.find((n) => n.type === 'button' && String(n.props?.className || '').includes('cloze-equivalent-btn'));
      assert.ok(eqBtn, 'failed cloze renders equivalence override button');
      click(eqBtn);
      assert.deepEqual(clozeActs, [{ action: 'review.grade.adjust', args: { entryIndex: 2, clozeEquivalent: true } }]);
    } finally {
      clozeView.unmount();
    }

    // 5. CoachDebrief respects explicit ctaMode ('none' vs 'primary' vs 'secondary').
    const debriefRun = { id: 'r5', answered: 2 };
    const initialDebrief = { headline: '状态不错', next: 'continue_path', metrics: { answered: 2, gradedAnswered: 2, gradedCorrect: 2, levels: {} }, status: {} };
    let activeCtaMode = 'none';
    const debriefView = mount(() => wrap(React.createElement(CoachDebrief, {
      run: debriefRun,
      initial: initialDebrief,
      ctaMode: activeCtaMode,
      onContinue: () => {},
    })));
    try {
      assert.equal(debriefView.find((n) => n.type === 'button' && textOf(n).includes('继续学习')), null, 'ctaMode="none" hides action button');
      activeCtaMode = 'primary';
      debriefView.rerender();
      const primaryBtn = debriefView.find((n) => n.type === 'button' && textOf(n).includes('继续学习'));
      assert.ok(primaryBtn, 'ctaMode="primary" renders action button');
      assert.match(String(primaryBtn.props.className || ''), /sh-btn--primary/, 'ctaMode="primary" uses primary button variant');
      activeCtaMode = 'secondary';
      debriefView.rerender();
      const secondaryBtn = debriefView.find((n) => n.type === 'button' && textOf(n).includes('继续学习'));
      assert.ok(secondaryBtn, 'ctaMode="secondary" renders action button');
      assert.doesNotMatch(String(secondaryBtn.props.className || ''), /sh-btn--primary/, 'ctaMode="secondary" uses secondary button variant');
    } finally {
      debriefView.unmount();
    }
  });
});

test('Locale integrity: all ui/uiFormat strings in edited review components have English translations and zero key conflicts across en*.json', () => {
  const localesDir = 'ui/locales';
  const files = readdirSync(localesDir).filter((f) => f.startsWith('en') && f.endsWith('.json')).sort();
  const merged = new Map();
  const conflicts = [];
  for (const file of files) {
    const json = JSON.parse(readFileSync(join(localesDir, file), 'utf8'));
    for (const [k, v] of Object.entries(json)) {
      if (merged.has(k) && merged.get(k).value !== v) {
        conflicts.push({ key: k, a: merged.get(k).file, b: file });
      }
      merged.set(k, { file, value: v });
    }
  }
  assert.deepEqual(conflicts, [], `Conflicting English locale keys: ${JSON.stringify(conflicts)}`);

  const han = /[\u3400-\u9fff]/;
  const polishReview = JSON.parse(readFileSync('ui/locales/en.polish-review.json', 'utf8'));
  for (const [k, v] of Object.entries(polishReview)) {
    assert.doesNotMatch(v, han, `English translation for "${k}" must not contain Han characters: "${v}"`);
  }

  // Check every literal ui("...") / uiFormat("...") call in our edited review UI files resolves in merged en*.json.
  const missing = [];
  const checkFiles = [
    'ui/review/QuestionRun.jsx',
    'ui/review/QuestionParts.jsx',
    'ui/NextDue.jsx',
    'ui/ReviewToolbar.jsx',
    'ui/CoachDebrief.jsx',
    'ui/review/useReviewSession.js',
  ];
  const callRe = /\bui(?:Format)?\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const file of checkFiles) {
    const src = readFileSync(file, 'utf8');
    let m;
    while ((m = callRe.exec(src))) {
      const key = m[2];
      if (!han.test(key)) continue;
      if (!merged.has(key)) missing.push({ file, key });
    }
  }
  assert.deepEqual(missing, [], `Missing English locale keys: ${JSON.stringify(missing)}`);
});
