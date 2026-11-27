// The "continue where you left off" chip (`lastPractice`) must always show what storage holds for the CURRENT library root.
// A copy kept in React state goes stale when another library (or another tab) changes storage while it is not current.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const { mountHook, exports: { useLearningNavigation, clearLastPracticePosition } } = await loadInteractiveUi(`
  export { useLearningNavigation } from './ui/app/use-learning-navigation.js';
  export { clearLastPracticePosition } from './ui/practice-context-stack.js';
`);

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

const noop = () => {};
const RUN = { id: 'run-1', index: 2, total: 5, card: { id: 'card-9', prompt: 'What is a mutex?' } };

function hookArgs({ root, run }) {
  const dataRef = { current: { root, focus: { course: null } } };
  return {
    core: {
      call: async () => ({}), setError: noop, notify: noop, refresh: async () => {},
      refs: { dataRef, epoch: { current: 0 }, navigation: { current: 0 }, examLocation: { current: null } },
    },
    lib: {
      set: { setModal: noop, setContextTrail: noop, setPracticeStack: noop, setPracticeEnded: noop, setFocusRequest: noop, setDetour: noop },
      state: { contextTrail: [], practiceStack: [], practiceEnded: null, focusRequest: null, modal: null },
    },
    nav: { page: 'review', show: {}, leaving: (go) => go(), referenceRef: { current: null }, navigate: noop },
    session: { run, entry: null, getLive: () => null, flushDraft: async () => true, enterRun: noop, enterMovedRun: noop },
    rootRef: { current: null },
  };
}

test('lastPractice follows storage for the current root across A -> B -> (A cleared elsewhere) -> A', async () => {
  const storage = memoryStorage();
  await withBrowserGlobals(async () => {
    globalThis.localStorage = storage;
    try {
      const hook = mountHook((props) => useLearningNavigation(props), hookArgs({ root: 'C:/lib-A', run: RUN }));
      await hook.flush();
      assert.equal(hook.current.lastPractice?.cardId, 'card-9', 'practising in A saves a position that A then shows');

      // Switch to library B with no run: B has no position of its own.
      hook.rerender(hookArgs({ root: 'C:/lib-B', run: null }));
      await hook.flush();
      assert.equal(hook.current.lastPractice, null, 'B has nothing to continue');

      // While B is current, A's saved position is cleared (another tab, or a run that ended there).
      clearLastPracticePosition(storage, 'C:/lib-A');

      hook.rerender(hookArgs({ root: 'C:/lib-A', run: null }));
      await hook.flush();
      assert.equal(hook.current.lastPractice, null, 'back in A the chip reflects storage (cleared), not a copy cached while A was current');
      hook.unmount();
    } finally {
      delete globalThis.localStorage;
    }
  });
});

test('lastPractice shows a position that appears in storage for the current root after a bump', async () => {
  const storage = memoryStorage();
  await withBrowserGlobals(async () => {
    globalThis.localStorage = storage;
    try {
      const hook = mountHook((props) => useLearningNavigation(props), hookArgs({ root: 'C:/lib-A', run: RUN }));
      await hook.flush();
      const first = hook.current.lastPractice;
      assert.equal(first?.index, 2);

      // The run moves to the next card: the save + bump must refresh what is shown.
      hook.rerender(hookArgs({ root: 'C:/lib-A', run: { ...RUN, index: 3, card: { id: 'card-10', prompt: 'next' } } }));
      await hook.flush();
      assert.equal(hook.current.lastPractice?.cardId, 'card-10');
      assert.equal(hook.current.lastPractice?.index, 3);
      hook.unmount();
    } finally {
      delete globalThis.localStorage;
    }
  });
});
