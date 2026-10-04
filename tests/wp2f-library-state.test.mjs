import test from 'node:test';
import assert from 'node:assert/strict';
import { LIBRARY_KEYS, initialLibraryState, libraryReducer, libraryActions, createLibraryReset } from '../ui/app/library-state.js';

// UI wave 2 · WP-F (#111): everything that belongs to one library lives in one state, reset by one entry.

const gen0 = { kind: 'quiz', count: 10, title: '', course: undefined, referenceSourceIds: [] };
const dirty = () => {
  let state = initialLibraryState({ gen: gen0 });
  const act = (action) => { state = libraryReducer(state, action); };
  const set = (key, value) => act({ type: 'set', key, value });
  set('gen', { ...gen0, title: 'Old', course: 'OS', referenceSourceIds: ['src-old'] });
  set('legacyAudioJobId', 'job-old');
  set('graphScope', { deckId: 'd' });
  set('graphCanvas', true);
  set('examKind', 'oral'); set('examRunId', 'run-old');
  set('caseInitial', { nonce: 1 }); set('sourceHighlight', { ids: ['s'] });
  set('recovery', { draft: {} }); set('draft', { id: 'd' });
  set('modal', { type: 'flag' }); set('notebooks', [{}]); set('notebookError', 'x');
  set('selectedSources', ['a']); set('contextTrail', [{}]); set('detour', {}); set('workflowReturn', {});
  set('skeletonFocus', 'k'); set('noteInitialId', 'n'); set('managedDeck', { id: 'd' }); set('removingDeck', { id: 'd' });
  set('boardStudyRef', {}); set('focusRequest', {}); set('settings', { old: true });
  return state;
};

test('the initial state has one fresh value per key, and nothing outside the key list', () => {
  const a = initialLibraryState({ gen: gen0 }), b = initialLibraryState({ gen: gen0 });
  assert.deepEqual(Object.keys(a).sort(), [...LIBRARY_KEYS].sort());
  assert.notEqual(a.selectedSources, b.selectedSources, 'arrays are not shared between libraries');
  assert.notEqual(a.contextTrail, b.contextTrail);
  assert.deepEqual([a.examKind, a.examRunId, a.graphScope, a.graphCanvas, a.legacyAudioJobId, a.modal, a.draft, a.recovery], ['exam', null, null, false, '', null, null, null]);
  assert.deepEqual(a.gen, gen0);
  assert.deepEqual(initialLibraryState({ gen: gen0, settings: { a: 1 } }).settings, { a: 1 });
  assert.deepEqual(initialLibraryState().settings, {});
});

test('set takes a value or an updater and keeps the state object when nothing changed', () => {
  const state = initialLibraryState({ gen: gen0 });
  const next = libraryReducer(state, { type: 'set', key: 'selectedSources', value: (current) => [...current, 'x'] });
  assert.deepEqual(next.selectedSources, ['x']);
  assert.notEqual(next, state);
  assert.equal(libraryReducer(state, { type: 'set', key: 'modal', value: null }), state);
  assert.equal(libraryReducer(next, { type: 'set', key: 'selectedSources', value: (current) => current }), next);
  assert.equal(libraryReducer(state, { type: 'set', key: 'notAKey', value: 1 }), state, 'an unknown key is ignored');
  assert.equal(libraryReducer(state, { type: 'other' }), state);
});

test('setters are generated from the key list, one per key', () => {
  const log = [];
  const actions = libraryActions((action) => log.push(action));
  assert.equal(Object.keys(actions).length, LIBRARY_KEYS.length);
  actions.setNoteInitialId('n');
  actions.setGen((g) => g);
  assert.deepEqual(log[0], { type: 'set', key: 'noteInitialId', value: 'n' });
  assert.equal(log[1].key, 'gen');
});

test('a reset gives every key its initial value: restore leaves nothing of the old library behind', () => {
  const state = libraryReducer(dirty(), { type: 'reset', initial: { gen: gen0, settings: { fresh: 1 } } });
  assert.deepEqual(state, initialLibraryState({ gen: gen0, settings: { fresh: 1 } }));
  assert.deepEqual(state.gen.referenceSourceIds, [], 'the generate form no longer points at materials of the old library');
  assert.equal(state.legacyAudioJobId, '');
  assert.equal(state.graphScope, null);
  assert.equal(state.examKind, 'exam');
  assert.equal(state.caseInitial, null);
  assert.equal(state.sourceHighlight, null);
  assert.equal(state.modal, null);
  assert.equal(state.recovery, null);
  assert.equal(state.notebooks, null);
});

const fakeDeps = (log) => {
  const refs = { epoch: { current: 4 }, navigation: { current: 9 }, leaveTimer: { current: 'timer' }, examLocation: { current: { runId: 'r' } }, actRunner: { current: { reset: () => log.push('act.reset') } } };
  return {
    refs,
    quick: { reset: () => log.push('quick.reset') },
    resetLibrary: (initial) => log.push(['library.reset', initial]),
    session: { reset: () => log.push('session.reset') },
    clearTimer: (timer) => log.push(`clearTimer:${timer}`),
    setPageTarget: (value) => log.push(['pageTarget', value]),
    setBusy: (value) => log.push(['busy', value]),
    setNotice: (value) => log.push(['notice', value]),
    setError: (value) => log.push(['error', value]),
    setPage: (value) => log.push(['page', value]),
  };
};

test('resetLibraryState: one list for switching library, restoring a backup and moving the binding', () => {
  for (const reason of ['switch', 'restore', 'binding']) {
    const log = [], deps = fakeDeps(log);
    const reset = createLibraryReset(deps);
    reset(reason, { gen: gen0, settings: { s: 1 } });
    assert.equal(deps.refs.epoch.current, 5, `${reason}: the library epoch moves, so late answers are dropped`);
    assert.equal(deps.refs.navigation.current, 10, `${reason}: pending navigations are dropped`);
    assert.equal(deps.refs.examLocation.current, null, `${reason}: the exam location is forgotten`);
    for (const entry of ['quick.reset', 'act.reset', 'session.reset', 'clearTimer:timer']) assert.ok(log.includes(entry), `${reason}: ${entry}`);
    assert.deepEqual(log.find((entry) => entry[0] === 'library.reset'), ['library.reset', { gen: gen0, settings: { s: 1 } }], reason);
    assert.deepEqual(log.filter((entry) => Array.isArray(entry) && entry[0] !== 'library.reset'),
      [['pageTarget', null], ['busy', false], ['notice', ''], ['error', ''], ['page', 'library']], `${reason}: the shell starts clean on the library page`);
  }
});

test('resetLibraryState without a running action runner or settings still resets', () => {
  const log = [], deps = fakeDeps(log);
  deps.refs.actRunner.current = null;
  createLibraryReset(deps)('restore', { gen: gen0 });
  assert.deepEqual(log.find((entry) => entry[0] === 'library.reset')[1], { gen: gen0, settings: {} });
});

test('the reset is the only place that lists what a library owns: the reducer keys are the contract', () => {
  for (const key of ['gen', 'legacyAudioJobId', 'graphScope', 'examKind', 'caseInitial', 'sourceHighlight', 'recovery', 'modal', 'notebooks', 'selectedSources', 'draft', 'managedDeck'])
    assert.ok(LIBRARY_KEYS.includes(key), key);
});
