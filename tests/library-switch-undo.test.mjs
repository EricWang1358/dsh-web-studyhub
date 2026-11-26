import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryReset } from '../ui/app/library-state.js';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

/* The library tie of 删除 with 撤销 (ui/undoable.js), at the two places the app changes library: a switch that already happened drops what was waiting and
   says so (createLibraryReset → abandonPending, unsentText → setError), and a move the learner makes sends what was waiting first (updateBinding awaits
   flushUndoable before binding.set). Review of #506, round 2: without these checks the wiring could go and every test stayed green. */

const deps = (log, extra = {}) => ({
  refs: { epoch: { current: 1 }, navigation: { current: 1 }, leaveTimer: { current: 0 }, examLocation: { current: null }, actRunner: { current: null } },
  quick: { reset() {} }, resetLibrary() {}, session: { reset() {} }, clearTimer() {}, setPageTarget() {}, setBusy() {}, setNotice() {}, setPage() {},
  setError: (value) => log.push(['error', value]),
  ...extra,
});

test('a library that changed by itself: the waiting deletions are abandoned before the epoch moves, and the learner is told how many', () => {
  const log = [];
  let epochWhenAbandoned = null;
  const fake = deps(log, {
    abandonPending: () => { epochWhenAbandoned = fake.refs.epoch.current; return 3; },
    unsentText: (count) => `学习库已更换：刚才的 ${count} 项删除没有执行，它们还在原来的学习库里。`,
  });
  createLibraryReset(fake)('switch');
  assert.equal(epochWhenAbandoned, 1, 'abandoned while the old epoch still stands');
  assert.equal(fake.refs.epoch.current, 2);
  assert.deepEqual(log.at(-1), ['error', '学习库已更换：刚才的 3 项删除没有执行，它们还在原来的学习库里。']);
});

test('nothing waiting: the error slot is simply cleared', () => {
  const log = [];
  createLibraryReset(deps(log, { abandonPending: () => 0, unsentText: () => 'never' }))('switch');
  assert.deepEqual(log.at(-1), ['error', '']);
});

const interactiveApp = await loadInteractiveUi(`
  export { default as App } from './ui/App.jsx';
  export { performBindingUpdate } from './ui/app/use-library-connection.js';
  export { createUndoable, registerUndoable } from './ui/undoable.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

test('App abandons pending undoable deletions when the library changes underneath and shows the learner how many were not sent', async () => {
  const { React, mount, exports: { App, createUndoable, registerUndoable, setUiLanguage } } = interactiveApp;
  setUiLanguage('zh');
  await withBrowserGlobals(async () => {
    let libraryListener = null;
    let currentRoot = '/lib-a';
    let snapshotRevision = 1;
    let snapshotFingerprint = 'fp-a';
    const snapshotCalls = [];
    const call = async (action, args) => {
      if (action === 'binding.get') return { root: currentRoot, provider: '', model: '' };
      if (action === 'snapshot') {
        snapshotCalls.push({ root: currentRoot, args });
        return {
          root: currentRoot,
          fingerprint: snapshotFingerprint,
          revision: snapshotRevision,
          courses: [],
          sources: [],
          decks: [],
          drafts: [],
          runs: [],
          jobs: [],
          settings: {},
          model: { ready: true },
        };
      }
      if (action === 'board.get') return { revision: 1, columns: [], cards: {} };
      if (action === 'dailyPlan.get') return { date: '2026-11-26', tasks: [], budgetMinutes: 30 };
      if (action === 'runtime.capabilities') return [];
      return {};
    };
    const host = {
      subscribeLibraryEvents: (fn) => {
        libraryListener = fn;
        return () => { libraryListener = null; };
      },
    };
    const mounted = mount(() => React.createElement(App, { call, host }));
    let unregister = null;
    try {
      await mounted.flush(10);
      assert.equal(typeof libraryListener, 'function', 'App subscribes to library events once connected');
      assert.ok(!mounted.text().includes('正在打开学习工作区'), 'App finished initial loading');

      const committed = [];
      let restored = 0;
      const unit = createUndoable({
        scope: () => '/lib-a',
        toast: { show() {}, error() {}, dismiss() {} },
      });
      unregister = registerUndoable(unit);
      unit.commitLater({
        keys: ['note-1', 'note-2'],
        message: '已删除 2 条笔记',
        commit: async () => {
          committed.push('note-1', 'note-2');
          return { ok: true };
        },
        onRestore: () => { restored += 1; },
      });
      assert.equal(unit.pending(), 1);
      assert.equal(unit.hidden('note-1'), true);

      // The library switches underneath: next snapshot comes from /lib-b.
      currentRoot = '/lib-b';
      snapshotRevision = 2;
      snapshotFingerprint = 'fp-b';
      await mounted.act(async () => {
        libraryListener({ root: '/lib-a', revision: 2 });
        await Promise.resolve();
      });
      await mounted.flush(10);

      assert.equal(unit.pending(), 0, 'pending deletions were abandoned on library switch');
      assert.equal(unit.hidden('note-1'), false);
      assert.equal(restored, 1, 'abandoned entry restores its items');
      assert.deepEqual(committed, [], 'pending deletions from /lib-a are never committed to /lib-b');
      assert.ok(
        mounted.text().includes('学习库已更换：刚才的 2 项删除没有执行，它们还在原来的学习库里。'),
        `expected abandoned deletion notice in App, got: ${mounted.text()}`,
      );
      assert.ok(snapshotCalls.some((entry) => entry.root === '/lib-b'), 'App loaded the new library snapshot');
    } finally {
      unregister?.();
      mounted.unmount();
    }
  });
});

test('a library move the learner makes sends what is waiting first: performBindingUpdate awaits flushUndoable before binding.set and resets only after move', async () => {
  const { exports: { performBindingUpdate, createUndoable, registerUndoable } } = interactiveApp;
  const events = [];
  const unit = createUndoable({
    scope: () => '/lib-a',
    toast: { show() {}, error() {}, dismiss() {} },
  });
  const unregister = registerUndoable(unit);
  try {
    unit.commitLater({
      keys: ['note-1'],
      message: '已删除笔记',
      commit: async () => {
        events.push('flush-start');
        await Promise.resolve();
        events.push('flush-done');
        return { ok: true };
      },
    });
    const bindingRef = { current: { root: '/lib-a', provider: '', model: '' } };
    const refs = { dataRef: { current: { root: '/lib-a' } }, snapshotKey: { current: { k: 'v' } } };
    const ok = await performBindingUpdate({
      patch: { root: '/lib-b' },
      bindingRef,
      refs,
      host: { warmKey: 'test' },
      language: 'zh',
      call: async (method, payload) => {
        events.push(['call', method, payload.root]);
        return { root: payload.root, provider: '', model: '' };
      },
      refresh: async () => { events.push('refresh'); },
      resetLibraryState: (reason) => { events.push(['reset', reason]); },
      setBinding() {},
      setData() {},
      setLoading() {},
      setBusy() {},
      setError() {},
      notify() {},
      writeWarmBinding() {},
      clearWarmSession() {},
      customBinding: (patch) => ({ root: '/lib-a', provider: '', model: '', ...patch }),
    });
    assert.equal(ok, true);
    assert.deepEqual(events, [
      'flush-start',
      'flush-done',
      ['call', 'binding.set', '/lib-b'],
      ['reset', 'binding'],
      'refresh',
    ]);

    // Updating a non-root setting (or binding.set returning the same root) neither flushes early nor resets the library.
    const sameRootEvents = [];
    unit.commitLater({
      keys: ['note-2'],
      message: '已删除第二条笔记',
      commit: async () => {
        sameRootEvents.push('unexpected-flush');
        return { ok: true };
      },
    });
    const sameOk = await performBindingUpdate({
      patch: { model: 'gpt-5' },
      bindingRef,
      refs,
      host: { warmKey: 'test' },
      language: 'zh',
      call: async (method) => {
        sameRootEvents.push(['call', method]);
        return { root: '/lib-b', provider: '', model: 'gpt-5' };
      },
      refresh: async () => { sameRootEvents.push('refresh'); },
      resetLibraryState: (reason) => { sameRootEvents.push(['reset', reason]); },
      setBinding() {},
      setData() {},
      setLoading() {},
      setBusy() {},
      setError() {},
      notify() {},
      writeWarmBinding() {},
      clearWarmSession() {},
      customBinding: (patch) => ({ root: '/lib-b', provider: '', model: '', ...patch }),
    });
    assert.equal(sameOk, true);
    assert.deepEqual(sameRootEvents, [['call', 'binding.set'], 'refresh']);
    assert.equal(unit.pending(), 1, 'pending deletion stays waiting when root did not change');
  } finally {
    unregister();
  }
});
