import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

/* Going back to the original round (继续学习 after a prerequisite round, or 回到原练习) only reads that round with review.get: it changes nothing,
   so it must not hold the button behind a full library snapshot (ui/act-runner.js holds up to REFRESH_HOLD_MS for one). */

test('returning to the original round reads it without a library refresh, from both 继续学习 and 回到原练习', async () => {
  const interactive = await loadInteractiveUi(`
    export { useReviewSession } from './ui/review/useReviewSession.js';
    export { createActRunner } from './ui/act-runner.js';
  `);
  const { useReviewSession, createActRunner } = interactive.exports;
  const noop = () => {};
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = noop;
  try {
    await withBrowserGlobals(async () => {
      const original = { id: 'orig', mode: 'path', deckId: 'd1', index: 1, total: 3, card: { id: 'c-2', kind: 'open', prompt: 'Original Q' } };
      const prerequisite = { id: 'pre', mode: 'path', deckId: 'd1', index: 0, total: 1, returnTo: 'orig', card: { id: 'p-1', kind: 'open', prompt: 'Prereq Q' } };
      const dataRef = { current: { root: '/lib-origin', settings: {}, focus: { course: null }, sources: [], runs: [original, prerequisite], progress: {} } };
      const calls = [];
      let refreshes = 0;
      const runner = createActRunner(() => ({
        call: async (action, args) => { calls.push([action, args]); return action === 'review.get' ? original : {}; },
        refresh: () => { refreshes += 1; return new Promise(noop); },
        epoch: () => 0,
        setBusy: noop,
        setError: noop,
        holdMs: 3_000,
      }));
      const core = { call: async () => ({}), act: runner.act, notify: noop, setError: noop, refresh: async () => dataRef.current,
        refs: { dataRef, bindingRoot: { current: null } } };
      const hook = interactive.mountHook(() => useReviewSession({ core, nav: { page: 'review', setPage: noop, show: { exam: noop } },
        modalOpen: false, host: {}, rootRef: { current: null }, late: {} }));
      const settle = (promise) => Promise.race([promise.then(() => 'done'), new Promise((done) => setTimeout(() => done('held'), 500))]);
      try {
        await hook.act(() => hook.current.enterRun(prerequisite));
        const destination = hook.current.continueTo(null);
        assert.equal(destination.kind, 'original');
        let outcome;
        await hook.act(async () => { outcome = await settle(destination.go()); });
        assert.equal(outcome, 'done', '继续学习 back to the original round must not wait for a snapshot');
        assert.equal(hook.current.run.id, 'orig');

        await hook.act(() => hook.current.enterRun(prerequisite));
        await hook.act(async () => { outcome = await settle(hook.current.actions.returnToOrigin()); });
        assert.equal(outcome, 'done', '回到原练习 must not wait for a snapshot');
        assert.equal(hook.current.run.id, 'orig');
        assert.deepEqual(calls.map(([action, args]) => [action, args.runId]), [['review.get', 'orig'], ['review.get', 'orig']]);
        assert.equal(refreshes, 0, 'a read-only return asks for no library refresh');
      } finally {
        hook.unmount();
      }
    });
  } finally {
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCancel;
  }
});
