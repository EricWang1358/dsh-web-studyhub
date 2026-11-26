import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeaveGate } from '../ui/app/navigator.js';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

/* #489 item 1: the one gate every page change passes. While a page holds it (unsaved edits in the book's editor), leaving asks that page and nothing happens until it says go.
   The real clicks (the sidebar, 回到总纲, a task link) are in tests/course-book-frame-browser.test.mjs. */

test('nothing held goes at once; held, another page asks and goes only on the answer', () => {
  const gate = createLeaveGate(() => 'book'), went = [], asked = [];
  gate.leave('notes', () => went.push('free'));
  assert.deepEqual(went, ['free'], 'nothing holds it: at once');
  gate.hold(go => asked.push(go));
  gate.leave('notes', () => went.push('notes'));
  assert.equal(asked.length, 1, 'the page that holds it is asked');
  assert.deepEqual(went, ['free'], 'nothing happened yet');
  gate.leave('book', () => went.push('same page'));
  assert.deepEqual(went, ['free', 'same page'], 'staying on the page leaves nothing behind');
  gate.leave(null, () => went.push('another course'));
  assert.equal(asked.length, 2, 'a change that is not a page (another course) asks too');
  asked[0]();
  assert.equal(went.at(-1), 'notes');
  // The answer released it: what the go does next (a verb that navigates again, later) is not asked a second time.
  gate.leave('tasks', () => went.push('tasks'));
  assert.equal(went.at(-1), 'tasks');
});

test('the release of an older holder does not free a newer one', () => {
  const gate = createLeaveGate(() => 'book'), asked = [];
  const first = gate.hold(() => asked.push('first'));
  gate.hold(() => asked.push('second'));
  first();
  gate.leave('notes', () => asked.push('went'));
  assert.deepEqual(asked, ['second']);
});

function createNavDeps() {
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); };
  const core = {
    setError: record('setError'),
    setBusy: record('setBusy'),
    notify: record('notify'),
    act: record('act'),
    quick: { reset: record('quick.reset') },
    refresh: async () => {},
    refs: {
      epoch: { current: 0 },
      navigation: { current: 0 },
      leaveTimer: { current: null },
      examLocation: { current: null },
      actRunner: { current: { reset: record('actRunner.reset') } },
      dataRef: { current: null },
    },
  };
  const lib = {
    set: {
      setContextTrail: record('setContextTrail'),
      setExamRunId: record('setExamRunId'),
      setExamKind: record('setExamKind'),
      setBoardStudyRef: record('setBoardStudyRef'),
      setBoardCompose: record('setBoardCompose'),
      setNoteInitialId: record('setNoteInitialId'),
      setGraphScope: record('setGraphScope'),
      setGraphMode: record('setGraphMode'),
      setSkeletonFocus: record('setSkeletonFocus'),
      setManagedDeck: record('setManagedDeck'),
      setFolderDraft: record('setFolderDraft'),
      setWorkflowReturn: record('setWorkflowReturn'),
      setTaskFocus: record('setTaskFocus'),
      setSelectedSources: record('setSelectedSources'),
      setGen: record('setGen'),
      setCaseInitial: record('setCaseInitial'),
      setModal: record('setModal'),
      setFocusRequest: record('setFocusRequest'),
      setDetour: record('setDetour'),
    },
  };
  return { core, lib, calls, rootRef: { current: { scrollTo: record('scrollTo') } } };
}

test('useNavigation gates navigate, setPage, every show.* verb, and leaving; only forcePage bypasses the gate', async () => {
  await withBrowserGlobals(async () => {
    const ui = await loadInteractiveUi("export { useNavigation } from './ui/app/use-navigation.js';");
    const { core, lib, calls, rootRef } = createNavDeps();
    const hook = ui.mountHook((props) => ui.exports.useNavigation(props), {
      core, lib, motion: 'reduced', rootRef, initialPage: 'book',
    });
    try {
      const asked = [];
      const holdOnBook = async () => {
        if (hook.current.page !== 'book') {
          await hook.act(() => { hook.current.forcePage('book'); });
        }
        asked.length = 0;
        calls.length = 0;
        hook.current.holdLeave((go) => asked.push(go));
      };

      // navigate() is gated
      await holdOnBook();
      await hook.act(() => { hook.current.navigate('notes'); });
      assert.equal(hook.current.page, 'book', 'navigate stays on book while held');
      assert.equal(asked.length, 1);
      await hook.act(() => { asked[0](); });
      assert.equal(hook.current.page, 'notes', 'navigate moves once released');

      // setPage() is gated
      await holdOnBook();
      await hook.act(() => { hook.current.setPage('tasks'); });
      assert.equal(hook.current.page, 'book', 'setPage stays on book while held');
      assert.equal(asked.length, 1);
      await hook.act(() => { asked[0](); });
      assert.equal(hook.current.page, 'tasks');

      // Every verb on show.* is gated and runs its page-state setter only after release
      const showCases = [
        ['note', () => hook.current.show.note('note-1'), 'notes', 'setNoteInitialId'],
        ['skeleton', () => hook.current.show.skeleton('skel-1'), 'skeleton', 'setSkeletonFocus'],
        ['deck', () => hook.current.show.deck({ id: 'd1', course: 'CS' }), 'manage', 'setManagedDeck'],
        ['managedDeck', () => hook.current.show.managedDeck({ id: 'd2', course: 'Math' }), 'manage', 'setFolderDraft'],
        ['task', () => hook.current.show.task('job-1'), 'tasks', 'setTaskFocus'],
        ['workflow', () => hook.current.show.workflow('wf-1'), 'workflows', 'setWorkflowReturn'],
        ['exam', () => hook.current.show.exam('mock', 'run-1'), 'exam', 'setExamRunId'],
        ['library', () => hook.current.show.library(), 'library', null],
        ['page', () => hook.current.show.page('graph'), 'graph', null],
      ];
      assert.deepEqual(
        showCases.map(([name]) => name).sort(),
        Object.keys(hook.current.show).sort(),
        'every exported show.* verb is verified against the leave gate',
      );
      for (const [name, invoke, expectedPage, expectedSetter] of showCases) {
        await holdOnBook();
        await hook.act(invoke);
        assert.equal(hook.current.page, 'book', `show.${name} stays on book while held`);
        assert.equal(asked.length, 1, `show.${name} asks the leave gate`);
        if (expectedSetter) {
          assert.equal(calls.some(([fn]) => fn === expectedSetter), false, `show.${name} defers ${expectedSetter} until release`);
        }
        await hook.act(() => { asked[0](); });
        assert.equal(hook.current.page, expectedPage, `show.${name} arrives at ${expectedPage} on release`);
        if (expectedSetter) {
          assert.equal(calls.some(([fn]) => fn === expectedSetter), true, `show.${name} runs ${expectedSetter} on release`);
        }
      }

      // leaving() is gated
      await holdOnBook();
      const leftEvents = [];
      await hook.act(() => { hook.current.leaving(() => leftEvents.push('switched-course')); });
      assert.deepEqual(leftEvents, [], 'leaving callback waits for release');
      assert.equal(asked.length, 1);
      await hook.act(() => { asked[0](); });
      assert.deepEqual(leftEvents, ['switched-course']);

      // forcePage() bypasses the gate immediately (used only when the library is already gone)
      await holdOnBook();
      await hook.act(() => { hook.current.forcePage('library'); });
      assert.equal(asked.length, 0, 'forcePage does not ask the leave gate');
      assert.equal(hook.current.page, 'library');
    } finally {
      hook.unmount();
    }
  });
});

test('useLibraryReset bypasses the gate via forcePage, while useIntents.resumeOrStart and useInbox.openInboxItem ask before acting', async () => {
  await withBrowserGlobals(async () => {
    const ui = await loadInteractiveUi(`
      export { useNavigation } from './ui/app/use-navigation.js';
      export { useLibraryReset } from './ui/app/library-state.js';
      export { useIntents } from './ui/app/use-intents.js';
      export { useInbox } from './ui/app/use-inbox.js';
    `);
    const { core, lib, calls, rootRef } = createNavDeps();
    core.refs.dataRef.current = { lastRun: { id: 'run-42' }, decks: [] };
    const session = { run: null, entry: null, reset() {}, enterRun() {}, actions: { showExplanation() {} } };
    const learn = { rememberContext() {}, captureContext: () => ({ runId: null }), openAudioSources() {} };
    const libApi = { reset() {} };
    const hook = ui.mountHook(() => {
      const nav = ui.exports.useNavigation({ core, lib, motion: 'reduced', rootRef, initialPage: 'book' });
      const resetLibrary = ui.exports.useLibraryReset({ core, libApi, nav, session });
      const intents = ui.exports.useIntents({ core, lib, nav, session, learn });
      const inbox = ui.exports.useInbox({ core, lib, nav, session, learn, data: { inbox: { items: [] } } });
      return { nav, resetLibrary, intents, inbox };
    });
    try {
      const asked = [];
      const holdOnBook = async () => {
        if (hook.current.nav.page !== 'book') {
          await hook.act(() => { hook.current.nav.forcePage('book'); });
        }
        asked.length = 0;
        calls.length = 0;
        hook.current.nav.holdLeave((go) => asked.push(go));
      };

      // resumeOrStart asks before calling review.get for lastRun
      await holdOnBook();
      await hook.act(() => { hook.current.intents.resumeOrStart(); });
      assert.equal(asked.length, 1);
      assert.equal(calls.some(([fn]) => fn === 'act'), false, 'resumeOrStart waits before opening lastRun');
      await hook.act(() => { asked[0](); });
      const resumeCall = calls.find(([fn]) => fn === 'act');
      assert.equal(resumeCall?.[1], 'review.get');
      assert.deepEqual(resumeCall?.[2], { runId: 'run-42' });

      // openInboxItem asks before calling inbox.open
      await holdOnBook();
      await hook.act(() => { hook.current.inbox.openInboxItem({ id: 'letter-7' }); });
      assert.equal(asked.length, 1);
      assert.equal(calls.some(([fn]) => fn === 'act'), false, 'openInboxItem waits before marking/opening letter');
      await hook.act(() => { asked[0](); });
      const inboxCall = calls.find(([fn]) => fn === 'act');
      assert.equal(inboxCall?.[1], 'inbox.open');
      assert.deepEqual(inboxCall?.[2], { id: 'letter-7' });

      // library reset bypasses the gate via forcePage
      await holdOnBook();
      await hook.act(() => { hook.current.resetLibrary('switch'); });
      assert.equal(asked.length, 0, 'library reset does not ask the leave gate');
      assert.equal(hook.current.nav.page, 'library');
    } finally {
      hook.unmount();
    }
  });
});
