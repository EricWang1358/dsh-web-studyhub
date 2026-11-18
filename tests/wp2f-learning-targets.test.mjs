import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ABORT, LEARNING_TARGETS, REFERENCE_ORDER, practiceArgs, RETURN_PAGES, captureContext, currentStudyReference, loadLearningTarget, openLearningTarget,
  returnTargetFor, openReturnTarget, loadReturnTarget, readExamTarget,
} from '../ui/learning-navigation.js';
import { loadUi } from './helpers/ui-module.mjs';

// UI wave 2 · WP-F (#110): one table per learning object instead of four if-chains.

const recorder = () => {
  const calls = [];
  const call = async (action, args) => { calls.push([action, args]); return { id: `${action}-result`, action, args, folder: 'F' }; };
  return { calls, call };
};
const nav = () => {
  const log = [];
  const record = (name) => (...args) => log.push([name, ...args]);
  return { log, enterRun: record('enterRun'), enterMovedRun: record('enterMovedRun'), showSource: record('showSource'), showNote: record('showNote'), showSkeleton: record('showSkeleton'),
    showDeck: record('showDeck'), showWorkflow: record('showWorkflow'), showExam: record('showExam'), showLibrary: record('showLibrary'),
    showPage: record('showPage'), showManagedDeck: record('showManagedDeck') };
};
const env = (extra = {}) => ({ live: () => true, data: () => ({ sources: [{ id: 's1', title: 'known' }], focus: { courses: [{ name: 'OS' }] } }), refresh: async () => {}, ...extra });

test('every kind the app can open has load and open, and exactly the documented ones can be referenced', () => {
  assert.deepEqual(Object.keys(LEARNING_TARGETS).sort(), ['card', 'cards', 'course', 'deck', 'exam', 'note', 'oral', 'skeleton', 'source', 'workflow']);
  for (const [kind, entry] of Object.entries(LEARNING_TARGETS)) {
    assert.equal(typeof entry.load, 'function', `${kind}.load`);
    assert.equal(typeof entry.open, 'function', `${kind}.open`);
  }
  assert.deepEqual(REFERENCE_ORDER, ['source', 'card', 'note', 'skeleton', 'deck', 'workflow', 'exam', 'course']);
  for (const kind of REFERENCE_ORDER) assert.equal(typeof LEARNING_TARGETS[kind].reference, 'function', `${kind}.reference`);
});

test('load: each kind asks the host for exactly what the old chain asked for', async () => {
  const expected = [
    [{ kind: 'card', deckId: 'd', cardId: 'c' }, [['card.get', { deckId: 'd', cardId: 'c' }], ['review.start', { mode: 'path', scope: [{ deckId: 'd', cardId: 'c' }], fresh: true }]]],
    [{ kind: 'cards', deckId: 'd', cardIds: ['a', 'b'] }, [['review.start', { mode: 'path', scope: [{ deckId: 'd', cardId: 'a' }, { deckId: 'd', cardId: 'b' }], fresh: true }]]],
    [{ kind: 'source', id: 's1' }, [['source.get', { id: 's1' }]]],
    [{ kind: 'note', id: 'n' }, [['note.get', { id: 'n' }]]],
    [{ kind: 'skeleton', id: 'k' }, [['skeleton.get', { id: 'k' }]]],
    [{ kind: 'deck', id: 'd' }, [['deck.get', { id: 'd' }]]],
    [{ kind: 'exam', runId: 'r' }, [['review.get', { runId: 'r' }]]],
    [{ kind: 'oral', runId: 'r' }, [['oral.get', { runId: 'r' }]]],
    [{ kind: 'workflow', sessionId: 'w' }, [['workflow.session.get', { id: 'w' }]]],
    [{ kind: 'course', course: 'OS' }, [['focus.set', { course: 'OS' }]]],
  ];
  for (const [target, calls] of expected) {
    const { call, calls: seen } = recorder();
    const result = await loadLearningTarget(target, call, env());
    assert.deepEqual(seen, calls, target.kind);
    assert.notEqual(result, ABORT, target.kind);
  }
});

test('load: a card that stopped being current between its two calls aborts before starting the run', async () => {
  const { call, calls } = recorder();
  let live = true;
  const wrapped = async (action, args) => { const out = await call(action, args); if (action === 'card.get') live = false; return out; };
  const result = await loadLearningTarget({ kind: 'card', deckId: 'd', cardId: 'c' }, wrapped, env({ live: () => live }));
  assert.equal(result, ABORT);
  assert.deepEqual(calls.map(([action]) => action), ['card.get']);
});

test('load: a course the library no longer has is an error, a known one refreshes the snapshot', async () => {
  const { call, calls } = recorder();
  await assert.rejects(loadLearningTarget({ kind: 'course', course: 'Gone' }, call, env()), /关联课程已不存在/);
  assert.deepEqual(calls, []);
  let refreshed = 0;
  await loadLearningTarget({ kind: 'course', course: 'OS' }, call, env({ refresh: async () => { refreshed++; } }));
  assert.equal(refreshed, 1);
});

test('an unknown kind loads nothing', async () => {
  const { call, calls } = recorder();
  assert.equal(await loadLearningTarget({ kind: 'mystery' }, call, env()), ABORT);
  assert.equal(await loadLearningTarget(null, call, env()), ABORT);
  assert.deepEqual(calls, []);
});

test('open: each kind lands where the old chain sent it', () => {
  const cases = [
    [{ kind: 'card' }, { id: 'run' }, [['enterRun', { id: 'run' }]]],
    [{ kind: 'cards' }, { id: 'run' }, [['enterRun', { id: 'run' }]]],
    [{ kind: 'source', id: 's1', quote: 'q' }, { id: 's1' }, [['showSource', { id: 's1', title: 'known' }, 'q']]],
    [{ kind: 'source', id: 'missing', quote: 'q' }, { id: 'missing', title: 'fresh' }, [['showSource', { id: 'missing', title: 'fresh' }, 'q']]],
    [{ kind: 'note', id: 'n' }, { id: 'n2' }, [['showNote', 'n2']]],
    [{ kind: 'skeleton', id: 'k' }, { id: 'k2' }, [['showSkeleton', 'k2']]],
    [{ kind: 'deck', id: 'd' }, { id: 'd', folder: 'F' }, [['showDeck', { id: 'd', folder: 'F' }]]],
    [{ kind: 'workflow', sessionId: 'w' }, {}, [['showWorkflow', 'w']]],
    [{ kind: 'course', course: 'OS' }, {}, [['showLibrary']]],
    [{ kind: 'exam', runId: 'r' }, {}, [['showExam', 'exam', 'r']]],
    [{ kind: 'oral', runId: 'r' }, {}, [['showExam', 'oral', 'r']]],
  ];
  for (const [target, result, log] of cases) {
    const sink = nav();
    openLearningTarget(target, result, sink, env());
    assert.deepEqual(sink.log, log, `${target.kind} ${target.id || ''}`);
  }
});

test('trail: opening a source does not add a way back; everything else does', () => {
  for (const [kind, entry] of Object.entries(LEARNING_TARGETS)) assert.equal(entry.trail !== false, kind !== 'source', kind);
});

const base = { root: '/lib', page: 'library', run: null, entry: {}, noteInitialId: '', skeletonFocus: null, managedDeck: null, workflowReturn: null, exam: null, modal: null, focus: {} };

test('reference: the first matching view wins, in the documented order', () => {
  assert.equal(currentStudyReference({ ...base, root: '' }), null);
  assert.deepEqual(currentStudyReference({ ...base, modal: { type: 'source', source: { id: 's' } }, page: 'review', run: { card: { id: 'c' } } }), { root: '/lib', kind: 'source', id: 's' });
  assert.deepEqual(currentStudyReference({ ...base, page: 'review', run: { deckId: 'd', card: { id: 'c', deckId: 'x' } } }), { root: '/lib', kind: 'card', deckId: 'd', cardId: 'c' });
  assert.deepEqual(currentStudyReference({ ...base, page: 'review', run: { card: { id: 'c', deckId: 'x' } } }), { root: '/lib', kind: 'card', deckId: 'x', cardId: 'c' });
  assert.deepEqual(currentStudyReference({ ...base, page: 'notes', noteInitialId: 'n' }), { root: '/lib', kind: 'note', id: 'n' });
  assert.deepEqual(currentStudyReference({ ...base, page: 'skeleton', skeletonFocus: 'k' }), { root: '/lib', kind: 'skeleton', id: 'k' });
  assert.deepEqual(currentStudyReference({ ...base, page: 'manage', managedDeck: { id: 'd' } }), { root: '/lib', kind: 'deck', id: 'd' });
  assert.deepEqual(currentStudyReference({ ...base, page: 'workflows', workflowReturn: { sessionId: 'w' } }), { root: '/lib', kind: 'workflow', sessionId: 'w' });
  assert.deepEqual(currentStudyReference({ ...base, page: 'exam', exam: { runId: 'r', kind: 'oral' } }), { root: '/lib', kind: 'oral', runId: 'r' });
  assert.deepEqual(currentStudyReference({ ...base, page: 'exam', exam: { runId: 'r', kind: 'written' } }), { root: '/lib', kind: 'exam', runId: 'r' });
  assert.deepEqual(currentStudyReference({ ...base, focus: { course: 'OS' } }), { root: '/lib', kind: 'course', course: 'OS' });
  assert.deepEqual(currentStudyReference({ ...base, focus: { course: '' } }), { root: '/lib', kind: 'course', course: '' }, 'an empty course is still a course');
  assert.equal(currentStudyReference({ ...base, page: 'notes', noteInitialId: '' }), null);
});

test('every referenceable kind can be opened again by the table (no way there without a way back)', () => {
  for (const state of [
    { ...base, modal: { type: 'source', source: { id: 's' } } }, { ...base, page: 'review', run: { deckId: 'd', card: { id: 'c' } } },
    { ...base, page: 'notes', noteInitialId: 'n' }, { ...base, page: 'skeleton', skeletonFocus: 'k' }, { ...base, page: 'manage', managedDeck: { id: 'd' } },
    { ...base, page: 'workflows', workflowReturn: { sessionId: 'w' } }, { ...base, page: 'exam', exam: { runId: 'r', kind: 'oral' } }, { ...base, focus: { course: 'OS' } },
  ]) {
    const reference = currentStudyReference(state);
    assert.ok(LEARNING_TARGETS[reference.kind], reference.kind);
  }
});

test('captureContext keeps where the learner is, including what they typed on a practice page', () => {
  const entry = { selected: ['a'], response: 'r', clozeValues: { x: '1' }, hint: true, explain: false, teachAnswer: 't' };
  const run = { id: 'run', index: 2, complete: false, card: { id: 'c' }, queueVersion: 1, revision: 0 };
  const context = captureContext({ ...base, page: 'review', run, entry, noteInitialId: 'n', skeletonFocus: 'k', managedDeck: { id: 'd' }, exam: { runId: 'e' },
    workflowReturn: { sessionId: 'w' }, modal: { type: 'source', source: { id: 's' }, quote: 'q' } }, { invoker: 'el' });
  assert.equal(context.root, '/lib');
  assert.equal(context.runId, 'run');
  assert.equal(context.index, 2);
  assert.equal(context.runComplete, false);
  assert.deepEqual([context.noteId, context.skeletonId, context.deckId, context.workflow], ['n', 'k', 'd', 'w']);
  assert.deepEqual(context.modal, { sourceId: 's', quote: 'q' });
  assert.deepEqual(context.exam, { runId: 'e' });
  assert.deepEqual(context.input, { key: JSON.stringify(['run', 2, 'c', 1, 0]), selected: ['a'], response: 'r', clozeValues: { x: '1' }, hint: true, explain: false, teachAnswer: 't' });
  assert.equal(context.invoker, 'el');
  const away = captureContext({ ...base, page: 'library', run, modal: { type: 'add' } });
  assert.equal(away.runId, undefined, 'only the practice page keeps its run');
  assert.equal(away.input, null);
  assert.equal(away.modal, null);
  assert.equal(captureContext({ ...base, page: 'exam' }, { page: 'exam', exam: { runId: 'x' } }).exam.runId, 'x', 'overrides win');
});

test('returning: one entry per page that needs more than going back to it', () => {
  assert.deepEqual(Object.keys(RETURN_PAGES).sort(), ['exam', 'manage', 'notes', 'review', 'skeleton']);
  assert.equal(returnTargetFor({ page: 'library' }).plain, true);
  assert.equal(returnTargetFor({ page: 'manage' }).plain, true, 'a deck page without its deck is just a page');
  assert.equal(returnTargetFor({ page: 'manage', deckId: 'd' }), RETURN_PAGES.manage);
});

test('returning: a finished round reloads the run, an open one moves to where the learner was', async () => {
  const sink = nav(), { call, calls } = recorder();
  const done = { page: 'review', runId: 'r', runComplete: true, input: { key: 'k' } };
  const loaded = await loadReturnTarget(returnTargetFor(done), done, call);
  assert.deepEqual(calls.at(-1), ['review.get', { runId: 'r' }]);
  openReturnTarget(returnTargetFor(done), loaded, done, sink);
  assert.deepEqual(sink.log.at(-1), ['enterMovedRun', loaded, { key: 'k' }]);
  const open = { page: 'review', runId: 'r', index: 3, runComplete: false };
  await loadReturnTarget(returnTargetFor(open), open, call);
  assert.deepEqual(calls.at(-1), ['review.move', { runId: 'r', index: 3 }]);
});

test('returning: notes, skeleton and manage check their object first, exam and everything else just go back', async () => {
  const { call, calls } = recorder(), sink = nav();
  const notes = { page: 'notes', noteId: 'n' };
  await loadReturnTarget(returnTargetFor(notes), notes, call);
  assert.deepEqual(calls.at(-1), ['note.get', { id: 'n' }]);
  openReturnTarget(returnTargetFor(notes), undefined, notes, sink);
  assert.deepEqual(sink.log.at(-1), ['showNote', 'n']);
  calls.length = 0;
  await loadReturnTarget(returnTargetFor({ page: 'notes' }), { page: 'notes' }, call);
  assert.deepEqual(calls, [], 'no note was open: nothing to check');
  const skeleton = { page: 'skeleton', skeletonId: 'k' };
  await loadReturnTarget(returnTargetFor(skeleton), skeleton, call);
  assert.deepEqual(calls.at(-1), ['skeleton.get', { id: 'k' }]);
  openReturnTarget(returnTargetFor(skeleton), undefined, skeleton, sink);
  assert.deepEqual(sink.log.at(-1), ['showSkeleton', 'k']);
  const manage = { page: 'manage', deckId: 'd' };
  const deck = await loadReturnTarget(returnTargetFor(manage), manage, call);
  assert.deepEqual(calls.at(-1), ['deck.get', { id: 'd' }]);
  openReturnTarget(returnTargetFor(manage), deck, manage, sink);
  assert.deepEqual(sink.log.at(-1), ['showManagedDeck', deck]);
  const exam = { page: 'exam', exam: { kind: 'oral', runId: 'r' } };
  openReturnTarget(returnTargetFor(exam), undefined, exam, sink);
  assert.deepEqual(sink.log.at(-1), ['showExam', 'oral', 'r']);
  openReturnTarget(returnTargetFor({ page: 'exam' }), undefined, { page: 'exam' }, sink);
  assert.deepEqual(sink.log.at(-1), ['showExam', 'exam', null]);
  for (const origin of [{ page: 'library' }, { page: 'manage' }, { page: 'settings' }]) {
    calls.length = 0;
    const entry = returnTargetFor(origin);
    assert.equal(await loadReturnTarget(entry, origin, call), undefined, origin.page);
    assert.deepEqual(calls, []);
    openReturnTarget(entry, undefined, origin, sink);
    assert.deepEqual(sink.log.at(-1), ['showPage', origin.page]);
  }
});

test('practiceArgs: one shape for every practice request', () => {
  assert.deepEqual(practiceArgs([{ deckId: 'd', cardId: 'c' }]), { mode: 'path', scope: [{ deckId: 'd', cardId: 'c' }], fresh: true });
  assert.deepEqual(practiceArgs(undefined, { fresh: false }), { mode: 'path' }, 'continue today\'s path');
  assert.deepEqual(practiceArgs([1], { fresh: false }), { mode: 'path', scope: [1] });
  assert.deepEqual(practiceArgs([1], { returnTo: 'run-1' }), { mode: 'path', scope: [1], fresh: true, returnTo: 'run-1' });
  assert.deepEqual(practiceArgs([1], { reading: { sourceId: 's' } }), { mode: 'path', scope: [1], fresh: true, reading: { sourceId: 's' } }, 'extra fields pass through');
  assert.deepEqual(practiceArgs([]), { mode: 'path', scope: [], fresh: true }, 'an empty scope is still a scope (the coach continue)');
});

test('readExamTarget still reads a finished exam with its report', async () => {
  const call = async (action) => (action === 'review.get' ? { mode: 'exam', complete: true } : { score: 1 });
  assert.deepEqual(await readExamTarget(call, 'r'), { run: { mode: 'exam', complete: true }, report: { score: 1 } });
  await assert.rejects(readExamTarget(async () => ({ mode: 'path' }), 'r'), /找不到这场笔试/);
});

test('openReviewCoursePage records previous course only when switching courses and stops if focus.set fails (#1223)', async () => {
  const { openReviewCoursePage } = await loadUi("export { openReviewCoursePage } from './ui/app/page-views.jsx';");
  const makeHarness = ({ focusCourse = 'Course A', actResult = { course: 'Course B' } } = {}) => {
    const remembered = [], prepared = [], navigated = [], acted = [];
    const data = { root: '/lib', focus: { course: focusCourse } };
    const core = { act: async (action, args) => { acted.push([action, args]); return actResult; } };
    const session = { flushDraft: async () => true };
    const learn = {
      captureContext: (overrides = {}) => captureContext({ ...base, page: 'review', run: { id: 'r1', index: 0, card: { id: 'c1' } } }, overrides),
      rememberContext: (origin) => remembered.push(origin),
    };
    const nav = { navigate: (page) => navigated.push(page) };
    return { data, core, session, learn, nav, remembered, prepared, navigated, acted };
  };

  // Single-course: no focus.set, no courseSwitched metadata.
  {
    const h = makeHarness({ focusCourse: 'Course A' });
    await openReviewCoursePage({ place: { course: 'Course A' }, ...h, targetPage: 'outline', prepare: (c) => h.prepared.push(c) });
    assert.deepEqual(h.acted, []);
    assert.equal(h.remembered.length, 1);
    assert.equal(Object.hasOwn(h.remembered[0], 'courseSwitched'), false);
    assert.deepEqual(h.prepared, ['Course A']);
    assert.deepEqual(h.navigated, ['outline']);
  }

  // Cross-course (including null and '' previousCourse): captures previousCourse BEFORE focus.set.
  for (const prev of ['Course A', '', null]) {
    const h = makeHarness({ focusCourse: prev });
    await openReviewCoursePage({ place: { course: 'Course B' }, ...h, targetPage: 'book', prepare: (c) => h.prepared.push(c) });
    assert.deepEqual(h.acted, [['focus.set', { course: 'Course B' }]]);
    assert.equal(h.remembered.length, 1);
    assert.equal(h.remembered[0].courseSwitched, true);
    assert.equal(h.remembered[0].course, prev);
    assert.deepEqual(h.prepared, ['Course B']);
    assert.deepEqual(h.navigated, ['book']);
  }

  // Failed focus.set aborts navigation without remembering trail.
  {
    const h = makeHarness({ focusCourse: 'Course A', actResult: null });
    await openReviewCoursePage({ place: { course: 'Course B' }, ...h, targetPage: 'outline', prepare: (c) => h.prepared.push(c) });
    assert.deepEqual(h.acted, [['focus.set', { course: 'Course B' }]]);
    assert.deepEqual(h.remembered, []);
    assert.deepEqual(h.prepared, []);
    assert.deepEqual(h.navigated, []);
  }
});

test('executeContextReturn restores previous focus course, refreshes, and still returns when restore fails (#1223)', async () => {
  const { executeContextReturn, setUiLanguage } = await loadUi("export { executeContextReturn } from './ui/app/use-learning-navigation.js'; export { setUiLanguage } from './ui/i18n.js';");

  const runHarness = async ({ origin, currentCourse = 'Course B', focusSetImpl, refreshImpl }) => {
    const calls = [], errors = [], trailOps = [], focusReqs = [], modals = [], sink = nav();
    let refreshed = 0;
    const call = async (action, args) => {
      calls.push([action, args]);
      if (action === 'focus.set') {
        if (focusSetImpl) return focusSetImpl(args);
        return { mode: 'class', course: args.course };
      }
      if (action === 'review.move') return { id: args.runId, index: args.index, card: { id: 'c1' } };
      return {};
    };
    const refresh = async () => {
      refreshed++;
      if (refreshImpl) return refreshImpl();
    };
    const ok = await executeContextReturn({
      origin,
      currentCourse,
      getSources: () => [],
      call,
      refresh,
      verbs: sink,
      setModal: (m) => modals.push(m),
      setContextTrail: (fn) => trailOps.push(fn([origin])),
      setFocusRequest: (req) => focusReqs.push(req),
      setError: (msg) => errors.push(msg),
      live: () => true,
    });
    return { ok, calls, errors, refreshed, trailOps, focusReqs, modals, sink };
  };

  // 1. Cross-course restore (string, '', and null).
  for (const prev of ['Course A', '', null]) {
    const r = await runHarness({
      origin: { page: 'review', runId: 'r1', index: 1, runComplete: false, input: { key: 'k' }, course: prev, courseSwitched: true, invoker: 'btn' },
      currentCourse: 'Course B',
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.calls, [['focus.set', { course: prev }], ['review.move', { runId: 'r1', index: 1 }]]);
    assert.equal(r.refreshed, 1);
    assert.equal(r.sink.log[0][0], 'enterMovedRun');
    assert.deepEqual(r.trailOps, [[]]);
    assert.deepEqual(r.errors, ['']);
  }

  // 2. Skips redundant focus.set if already back on origin.course.
  {
    const r = await runHarness({
      origin: { page: 'review', runId: 'r1', index: 0, runComplete: false, course: 'Course A', courseSwitched: true },
      currentCourse: 'Course A',
    });
    assert.deepEqual(r.calls, [['review.move', { runId: 'r1', index: 0 }]]);
    assert.equal(r.refreshed, 0);
  }

  // 3. Single-course (no courseSwitched) does not touch focus.set or refresh.
  {
    const r = await runHarness({
      origin: { page: 'review', runId: 'r1', index: 0, runComplete: false },
      currentCourse: 'Course A',
    });
    assert.deepEqual(r.calls, [['review.move', { runId: 'r1', index: 0 }]]);
    assert.equal(r.refreshed, 0);
  }

  // 4. focus.set throws -> still returns to review run and surfaces localized error.
  setUiLanguage('zh');
  {
    const r = await runHarness({
      origin: { page: 'review', runId: 'r1', index: 2, runComplete: false, course: 'Deleted Course', courseSwitched: true },
      currentCourse: 'Course B',
      focusSetImpl: async () => { throw new Error('请选择已有课程'); },
    });
    assert.equal(r.ok, true);
    assert.equal(r.refreshed, 0);
    assert.equal(r.sink.log[0][0], 'enterMovedRun');
    assert.deepEqual(r.trailOps, [[]]);
    assert.match(r.errors.at(-1), /已回到原位置，但没能切回之前的课程：请选择已有课程/);
  }

  // 5. focus.set returns falsy -> still returns to review run and surfaces fallback error (also checks English).
  setUiLanguage('en');
  try {
    const r = await runHarness({
      origin: { page: 'review', runId: 'r1', index: 2, runComplete: false, course: 'Course A', courseSwitched: true },
      currentCourse: 'Course B',
      focusSetImpl: async () => null,
    });
    assert.equal(r.ok, true);
    assert.equal(r.refreshed, 0);
    assert.equal(r.sink.log[0][0], 'enterMovedRun');
    assert.deepEqual(r.trailOps, [[]]);
    assert.match(r.errors.at(-1), /could not switch back to the previous course/i);
  } finally {
    setUiLanguage('zh');
  }
});

test('ContextReturn hides duplicate banner on book/outline from review while keeping non-review trails and consistent BookView/OutlineView headers (#1225)', async () => {
  const ui = await loadUi(`
    export { ContextReturn } from './ui/app/AppBanners.jsx';
    export { PAGE_VIEWS } from './ui/app/page-views.jsx';
    export { default as BookPage } from './ui/book/BookPage.jsx';
    export { default as CourseOutline } from './ui/outline/CourseOutline.jsx';
    export { AppContext } from './ui/app/app-context.js';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage, ui, uiFormat } from './ui/i18n.js';
  `);
  const noop = () => {};
  const studyServices = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
  const inspectViewProps = (View, appValue) => {
    const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prev = internals.H;
    internals.H = {
      useContext: (ctx) => (ctx === ui.AppContext ? appValue : ctx._currentValue),
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
    };
    try {
      return View().props;
    } finally {
      internals.H = prev;
    }
  };
  const renderApp = ({ page, learn }) => {
    const appValue = {
      data: { root: '/lib', focus: { course: 'Arch', courses: [] }, sources: [], jobs: [], settings: {} },
      core: { busy: false },
      nav: { page, navigate: noop, show: { task: noop }, holdLeave: noop },
      learn: {
        captureContext: noop,
        rememberContext: noop,
        openLearningTarget: noop,
        returnFromContext: noop,
        ...learn,
      },
      intents: { goGenerate: noop, practice: noop },
      session: {},
      shell: { resolvedTheme: 'light' },
      settingsEntry: { setCourseSettings: noop, openSettings: noop },
    };
    const renderNode = (node) => renderToStaticMarkup(
      React.createElement(ui.StudyServicesContext.Provider, { value: studyServices },
        React.createElement(ui.AppContext.Provider, { value: appValue }, node)),
    );
    let viewProps = null;
    let pageHtml = '';
    if (page === 'book' || page === 'outline') {
      viewProps = inspectViewProps(ui.PAGE_VIEWS[page], appValue);
      const PageComp = page === 'book' ? ui.BookPage : ui.CourseOutline;
      pageHtml = renderNode(React.createElement(PageComp, viewProps));
    }
    return {
      bannerHtml: renderNode(React.createElement(ui.ContextReturn)),
      pageHtml,
      viewProps,
    };
  };

  ui.setUiLanguage('zh');
  try {
    // 1. book & outline from review: ContextReturn is suppressed, and both headers show learn.trailLabel and wire returnFromContext.
    const returnFn = () => 'returned';
    for (const [page, label] of [['book', '回到之前的第 2 题'], ['outline', '回到之前的第 2 题']]) {
      const { bannerHtml, pageHtml, viewProps } = renderApp({
        page,
        learn: { hasTrail: true, trailPage: 'review', trailLabel: label, returnFromContext: returnFn },
      });
      assert.equal(bannerHtml, '', `${page} from review renders no .context-return banner`);
      assert.equal(viewProps.backLabel, label);
      assert.equal(page === 'book' ? viewProps.onReturnBack : viewProps.onBack, returnFn);
      assert.match(pageHtml, /回到之前的第 2 题/);
      assert.doesNotMatch(pageHtml, /回到这道题/);
      assert.doesNotMatch(pageHtml, /回到总纲|返回学习库/);
    }

    // 2. book & outline with non-review trail (e.g. from notes or source modal): ContextReturn stays visible and headers show normal back links (no duplicate).
    for (const [page, defaultBack] of [['book', '回到总纲'], ['outline', '返回学习库']]) {
      const { bannerHtml, pageHtml, viewProps } = renderApp({
        page,
        learn: { hasTrail: true, trailPage: 'notes', trailLabel: '回到学习笔记', returnFromContext: returnFn },
      });
      assert.match(bannerHtml, /class="context-return"/, `${page} with non-review trail keeps .context-return banner`);
      assert.match(bannerHtml, /回到学习笔记/);
      if (page === 'book') assert.equal(viewProps.onReturnBack, undefined);
      else assert.notEqual(viewProps.onBack, returnFn);
      assert.match(pageHtml, new RegExp(defaultBack));
      assert.doesNotMatch(pageHtml, /回到学习笔记/);
    }

    // 3. book & outline with no trail: no ContextReturn, normal header back links.
    for (const [page, defaultBack] of [['book', '回到总纲'], ['outline', '返回学习库']]) {
      const { bannerHtml, pageHtml } = renderApp({
        page,
        learn: { hasTrail: false, trailPage: '', trailLabel: '' },
      });
      assert.equal(bannerHtml, '');
      assert.match(pageHtml, new RegExp(defaultBack));
    }

    // 4. Other pages (e.g. settings) keep ContextReturn even when trailPage === 'review'; review & notes still suppress ContextReturn.
    assert.match(renderApp({ page: 'settings', learn: { hasTrail: true, trailPage: 'review', trailLabel: '回到之前的第 2 题' } }).bannerHtml, /class="context-return"/);
    assert.equal(renderApp({ page: 'review', learn: { hasTrail: true, trailPage: 'book', trailLabel: '回到复习全书' } }).bannerHtml, '');
    assert.equal(renderApp({ page: 'notes', learn: { hasTrail: true, trailPage: 'review', trailLabel: '回到之前的第 2 题' } }).bannerHtml, '');

    // 5. English wording on book & outline from review.
    ui.setUiLanguage('en');
    const enLabel = ui.uiFormat('回到之前的第 {0} 题', [2]);
    assert.equal(enLabel, 'Return to previous question (2)');
    for (const page of ['book', 'outline']) {
      const { bannerHtml, pageHtml } = renderApp({
        page,
        learn: { hasTrail: true, trailPage: 'review', trailLabel: enLabel },
      });
      assert.equal(bannerHtml, '');
      assert.match(pageHtml, /Return to previous question \(2\)/);
      assert.doesNotMatch(pageHtml, /Back to this question/);
    }
  } finally {
    ui.setUiLanguage('zh');
  }
});
