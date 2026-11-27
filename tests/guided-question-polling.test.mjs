import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

/* #564: the guided workbench reads its session through the shared poller. The read itself is readGuidedSession; here it runs inside
   createPoller with the same options useGuidedQuestion gives usePolling (POLL_MS, immediate, backoffDelay), driven by fake timers. */
const m = await loadUi(`export * from './ui/guided-study/use-guided-question.js'; export { createPoller } from './ui/use-polling.js'; export { backoffDelay } from './ui/poll-schedule.js';`);

function fakeEnv({ hidden = false } = {}) {
  const timers = new Map();
  let next = 1, listener = null;
  const env = {
    isHidden: hidden,
    hidden: () => env.isHidden,
    onVisibility: callback => { listener = callback; return () => { listener = null; }; },
    setTimer: (callback, ms) => { const id = next++; timers.set(id, { callback, ms }); return id; },
    clearTimer: id => timers.delete(id),
    pending: () => [...timers.values()],
    async fire() { const [id, timer] = [...timers.entries()][0]; timers.delete(id); await timer.callback(); await settle(); },
    async setHidden(value) { env.isHidden = value; listener?.(); await settle(); },
  };
  return env;
}
const settle = () => new Promise(resolve => setImmediate(resolve));

/** A host whose session and question result the test changes; it records every call. */
function fakeHost(session) {
  const host = { session, result: null, calls: [] };
  host.call = async (action, args) => {
    host.calls.push([action, args]);
    if (action === 'study.session.get') return structuredClone(host.session);
    // As the host does: a published question settles the wait and the session's focus moves on.
    if (action === 'study.question.result') {
      if (host.result?.status === 'ready') host.session = { ...host.session, focus: null, version: host.session.version + 1 };
      return host.result;
    }
    throw new Error(`unexpected ${action}`);
  };
  return host;
}

function workbench(host, { hidden = false } = {}) {
  const env = fakeEnv({ hidden }), seen = { current: '' }, shown = { sessions: [], prep: [], ready: [] };
  const poller = m.createPoller({
    run: () => readGuidedSession(host, seen, shown), intervalMs: m.POLL_MS, immediate: true, backoff: m.backoffDelay, env,
  });
  return { env, shown, poller };
}
const readGuidedSession = (host, seen, shown) => m.readGuidedSession({ call: host.call, sessionId: host.session.id, seen,
  setSession: session => shown.sessions.push(session), setPrepState: state => shown.prep.push(state), onReady: result => shown.ready.push(result) });

const active = () => ({ id: 's1', status: 'active', focus: null, version: 1 });

test('no read while the page is hidden; the read comes at once when the page is back', async () => {
  const host = fakeHost(active());
  const { env, poller } = workbench(host, { hidden: true });
  poller.start(); await settle();
  assert.equal(host.calls.length, 0, 'not even the first read');
  assert.equal(env.pending().length, 0, 'and no timer waits');
  await env.setHidden(false);
  assert.deepEqual(host.calls.map(([action]) => action), ['study.session.get']);
  await env.setHidden(true);
  assert.equal(env.pending().length, 0, 'hiding again stops the timer');
  poller.stop();
});

test('a session that reads the same slows down past 10 s, and the first change brings the 3 s rhythm back', async () => {
  const host = fakeHost(active());
  const { env, shown, poller } = workbench(host);
  poller.start(); await settle();
  assert.equal(env.pending()[0].ms, m.POLL_MS);
  assert.equal(shown.sessions.length, 1, 'the first read is shown');
  for (let i = 0; i < 12; i += 1) await env.fire();
  assert.ok(env.pending()[0].ms > m.POLL_MS, `12 unchanged reads slow down (${env.pending()[0].ms} ms)`);
  for (let i = 0; i < 36; i += 1) await env.fire();
  assert.ok(env.pending()[0].ms >= 10000, `48 unchanged reads: at least 10 s (${env.pending()[0].ms} ms)`);
  assert.equal(shown.sessions.length, 1, 'a session that reads the same is not set again');
  host.session = { ...host.session, version: 2 };
  await env.fire();
  assert.equal(env.pending()[0].ms, m.POLL_MS);
  assert.equal(shown.sessions.length, 2);
  poller.stop();
});

test('while a question is being prepared the 3 s rhythm stays, and the published question opens once', async () => {
  const host = fakeHost({ ...active(), focus: { kind: 'preparing-card' } });
  host.result = { status: 'running', stage: 'review' };
  const { env, shown, poller } = workbench(host);
  poller.start(); await settle();
  for (let i = 0; i < 60; i += 1) {
    assert.equal(env.pending()[0].ms, m.POLL_MS, `read ${i + 1}: still quick`);
    await env.fire();
  }
  assert.deepEqual(shown.prep.at(-1), { status: 'running', stage: 'review' });
  assert.deepEqual(host.calls.slice(0, 2).map(([action]) => action), ['study.session.get', 'study.question.result']);
  host.result = { status: 'ready', cardId: 'c9', runId: 'r9' };
  host.calls.length = 0;
  await env.fire();
  assert.deepEqual(host.calls.map(([action]) => action), ['study.session.get', 'study.question.result', 'study.session.get']);
  assert.deepEqual(shown.ready, [host.result]);
  assert.equal(shown.prep.at(-1), null);
  assert.equal(shown.sessions.at(-1).focus, null, 'the session after the result is shown');
  host.calls.length = 0;
  await env.fire();
  assert.deepEqual(host.calls.map(([action]) => action), ['study.session.get'], 'once the focus moves on the result is not asked again');
  assert.equal(shown.ready.length, 1);
  poller.stop();
});

test('a question the review did not pass is shown as failed, with its reason and fallback', async () => {
  const host = fakeHost({ ...active(), focus: { kind: 'preparing-card' } });
  host.result = { status: 'failed', reason: 'quote not found', fallback: 'reuse_existing' };
  const { shown, poller } = workbench(host);
  poller.start(); await settle();
  assert.deepEqual(shown.prep, [{ status: 'failed', reason: 'quote not found', fallback: 'reuse_existing' }]);
  assert.deepEqual(shown.ready, []);
  poller.stop();
});

test('guidedSessionPolls: a paused or ended session is not read again', () => {
  assert.equal(m.guidedSessionPolls(active()), true);
  assert.equal(m.guidedSessionPolls({ ...active(), status: 'paused' }), false);
  assert.equal(m.guidedSessionPolls({ ...active(), status: 'ended' }), false);
  assert.equal(m.guidedSessionPolls(null), false);
  assert.equal(m.guidedSessionPolls({ status: 'active' }), false, 'no session id, nothing to read');
});

test('the hook renders without reading anything on the server', () => {
  const calls = [];
  const Probe = ({ session }) => {
    const { session: shown } = m.useGuidedQuestion({ session, call: async (...args) => { calls.push(args); } });
    return React.createElement('i', null, shown?.status || 'none');
  };
  for (const status of ['active', 'paused', 'ended']) assert.match(renderToStaticMarkup(React.createElement(Probe, { session: { ...active(), status } })), new RegExp(status));
  assert.equal(calls.length, 0);
});

// The hook with usePolling swapped for a probe that records options & refresh calls: verified interactively with real React lifecycles and timer spies.
const probeState = { options: [], refreshes: 0 };
globalThis.__guidedPollProbe = probeState;
const probePlugin = {
  name: 'polling-probe',
  setup(builder) {
    builder.onResolve({ filter: /use-polling\.js$/ }, () => ({ path: 'probe', namespace: 'probe' }));
    builder.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({
      contents: `
        const stableHandle = { refresh() { globalThis.__guidedPollProbe.refreshes += 1; } };
        export function usePolling(fn, options) {
          globalThis.__guidedPollProbe.options.push(options);
          return stableHandle;
        }
      `,
    }));
  },
};
const probed = await loadInteractiveUi(`export { useGuidedQuestion } from './ui/guided-study/use-guided-question.js';`, { plugins: [probePlugin] });

test('the hook polls through usePolling: every 3 s at once, backed off, not for paused/ended, and registers zero timers of its own', async () => {
  const reads = async () => null;
  await withBrowserGlobals(async () => {
    const origSetTimeout = globalThis.setTimeout;
    const origSetInterval = globalThis.setInterval;
    const timeoutCalls = [];
    const intervalCalls = [];
    globalThis.setTimeout = (...args) => {
      timeoutCalls.push(args);
      return origSetTimeout(...args);
    };
    globalThis.setInterval = (...args) => {
      intervalCalls.push(args);
      return origSetInterval(...args);
    };
    let hook;
    try {
      probeState.options.length = 0;
      probeState.refreshes = 0;

      // Mount active session -> polls through usePolling with expected schedule and backoff
      hook = probed.mountHook(probed.exports.useGuidedQuestion, { session: active(), call: reads });
      const running = probeState.options.at(-1);
      assert.equal(running.enabled, true);
      assert.equal(running.intervalMs, m.POLL_MS);
      assert.equal(running.immediate, true, 'the workbench reads at once when it opens');
      for (const state of [{ unchanged: 0 }, { unchanged: 12 }, { unchanged: 48 }, { unchanged: 48, running: true }]) {
        assert.equal(running.backoff(m.POLL_MS, state), m.backoffDelay(m.POLL_MS, state), `the standard table, scaled to 3 s: ${JSON.stringify(state)}`);
      }
      assert.notEqual(running.pauseWhenHidden, false, 'paused while the page is hidden (the usePolling default)');
      assert.equal(probeState.refreshes, 0);

      // Switching session id triggers an immediate refresh through usePolling (never a private timer)
      hook.rerender({ session: { ...active(), id: 's2' }, call: reads });
      assert.equal(probeState.options.at(-1).enabled, true);
      assert.equal(probeState.refreshes, 1, 'switching to another active session refreshes through usePolling');

      // Transitioning to paused, ended, null session, or missing call disables polling
      hook.rerender({ session: { ...active(), id: 's2', status: 'paused' }, call: reads });
      assert.equal(probeState.options.at(-1).enabled, false);
      hook.rerender({ session: { ...active(), id: 's2', status: 'ended' }, call: reads });
      assert.equal(probeState.options.at(-1).enabled, false);
      hook.rerender({ session: null, call: reads });
      assert.equal(probeState.options.at(-1).enabled, false);
      hook.rerender({ session: active(), call: null });
      assert.equal(probeState.options.at(-1).enabled, false, 'nothing to call with');

      hook.unmount();
      hook = null;

      assert.equal(timeoutCalls.length, 0, 'useGuidedQuestion must not schedule setTimeout of its own');
      assert.equal(intervalCalls.length, 0, 'useGuidedQuestion must not schedule setInterval of its own');
    } finally {
      hook?.unmount();
      globalThis.setTimeout = origSetTimeout;
      globalThis.setInterval = origSetInterval;
    }
  });
});
