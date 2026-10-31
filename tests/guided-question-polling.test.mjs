import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

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

// The hook with usePolling swapped for a probe that records what it is asked: the options are read during render, so a server render shows them.
const polled = [];
globalThis.__guidedPollProbe = polled;
const probe = { name: 'polling-probe', setup(build) {
  build.onResolve({ filter: /use-polling\.js$/ }, () => ({ path: 'probe', namespace: 'probe' }));
  build.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({ contents: 'export function usePolling(fn, options) { globalThis.__guidedPollProbe.push(options); return { refresh() {} }; }' }));
} };
const compiled = await build({ entryPoints: ['ui/guided-study/use-guided-question.js'], bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['react', 'react-dom'], plugins: [probe], logLevel: 'silent' });
const hooked = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), hooked, hooked.exports);

test('the hook polls through usePolling: every 3 s at once, backed off, and not at all for a paused or ended session', async () => {
  const Probe = ({ session, call }) => { hooked.exports.useGuidedQuestion({ session, call }); return null; };
  const reads = async () => null;
  const options = (session, call = reads) => { polled.length = 0; renderToStaticMarkup(React.createElement(Probe, { session, call })); return polled.at(-1); };
  const running = options(active());
  assert.equal(running.enabled, true);
  assert.equal(running.intervalMs, m.POLL_MS);
  assert.equal(running.immediate, true, 'the workbench reads at once when it opens');
  for (const state of [{ unchanged: 0 }, { unchanged: 12 }, { unchanged: 48 }, { unchanged: 48, running: true }])
    assert.equal(running.backoff(m.POLL_MS, state), m.backoffDelay(m.POLL_MS, state), `the standard table, scaled to 3 s: ${JSON.stringify(state)}`);
  assert.notEqual(running.pauseWhenHidden, false, 'paused while the page is hidden (the usePolling default)');
  assert.equal(options({ ...active(), status: 'paused' }).enabled, false);
  assert.equal(options({ ...active(), status: 'ended' }).enabled, false);
  assert.equal(options(null).enabled, false);
  assert.equal(options(active(), null).enabled, false, 'nothing to call with');
  const source = await readFile(new URL('../ui/guided-study/use-guided-question.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /setTimeout\(|setInterval\(/, 'no timer of its own');
});
