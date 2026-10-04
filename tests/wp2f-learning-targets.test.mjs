import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABORT, LEARNING_TARGETS, REFERENCE_ORDER, RETURN_PAGES, captureContext, currentStudyReference, loadLearningTarget, openLearningTarget,
  returnTargetFor, openReturnTarget, loadReturnTarget, readExamTarget,
} from '../ui/learning-navigation.js';

// UI wave 2 · WP-F (#110): one table per learning object instead of four if-chains.

const recorder = () => {
  const calls = [];
  const call = async (action, args) => { calls.push([action, args]); return { id: `${action}-result`, action, args, folder: 'F' }; };
  return { calls, call };
};
const nav = () => {
  const log = [];
  const record = (name) => (...args) => log.push([name, ...args]);
  return { log, enterRun: record('enterRun'), showSource: record('showSource'), showNote: record('showNote'), showSkeleton: record('showSkeleton'),
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
  assert.deepEqual(sink.log.at(-1), ['enterRun', loaded, { key: 'k' }]);
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

test('readExamTarget still reads a finished exam with its report', async () => {
  const call = async (action) => (action === 'review.get' ? { mode: 'exam', complete: true } : { score: 1 });
  assert.deepEqual(await readExamTarget(call, 'r'), { run: { mode: 'exam', complete: true }, report: { score: 1 } });
  await assert.rejects(readExamTarget(async () => ({ mode: 'path' }), 'r'), /找不到这场笔试/);
});
