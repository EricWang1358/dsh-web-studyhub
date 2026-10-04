import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

// #125: one polling loop that stays quiet in a hidden tab, comes back at once when the tab does, and backs off when
// nothing changes. The loop is a plain object driven by fake timers; the hook only wires it to a component.
const m = await loadUi(`export * from './ui/use-polling.js'; export { POLL_FAST_MS, pollDelay, backoffDelay } from './ui/poll-schedule.js';`);

function fakeEnv({ hidden = false } = {}) {
  const timers = new Map();
  let next = 1, listener = null;
  const env = {
    hidden: () => env.isHidden,
    isHidden: hidden,
    onVisibility: callback => { listener = callback; return () => { listener = null; }; },
    setTimer: (callback, ms) => { const id = next++; timers.set(id, { callback, ms }); return id; },
    clearTimer: id => timers.delete(id),
    timers,
    pending: () => [...timers.values()],
    async fire() { const [id, timer] = [...timers.entries()][0]; timers.delete(id); await timer.callback(); await Promise.resolve(); },
    async setHidden(value) { env.isHidden = value; listener?.(); await Promise.resolve(); },
    listening: () => !!listener,
  };
  return env;
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('a visible poller calls on every interval and one call at a time', async () => {
  const env = fakeEnv(), calls = [];
  const poller = m.createPoller({ run: () => { calls.push(1); return Promise.resolve(); }, intervalMs: 1500, env });
  poller.start();
  assert.equal(calls.length, 0, 'no immediate call unless asked for');
  assert.equal(env.pending()[0].ms, 1500);
  await env.fire(); await settle();
  assert.equal(calls.length, 1);
  assert.equal(env.pending().length, 1, 'the next call is scheduled after the last one finished');
  await env.fire(); await settle();
  assert.equal(calls.length, 2);
  poller.stop();
  assert.equal(env.pending().length, 0);
  assert.equal(env.listening(), false);
});

test('immediate: true asks once on start', async () => {
  const env = fakeEnv(), calls = [];
  m.createPoller({ run: () => calls.push(1), intervalMs: 1000, immediate: true, env }).start();
  await settle();
  assert.equal(calls.length, 1);
});

test('no call is made while the page is hidden', async () => {
  const env = fakeEnv({ hidden: true }), calls = [];
  const poller = m.createPoller({ run: () => calls.push(1), intervalMs: 1000, immediate: true, env });
  poller.start();
  await settle();
  assert.equal(calls.length, 0, 'not even the immediate one');
  assert.equal(env.pending().length, 0, 'and no timer is left running');
});

test('hiding stops the timer; becoming visible catches up at once and resumes the rhythm', async () => {
  const env = fakeEnv(), calls = [];
  const poller = m.createPoller({ run: () => calls.push(1), intervalMs: 3000, env });
  poller.start();
  await env.setHidden(true);
  assert.equal(env.pending().length, 0);
  await env.setHidden(false); await settle();
  assert.equal(calls.length, 1, 'catch-up call');
  assert.equal(env.pending()[0].ms, 3000, 'the rhythm resumes');
});

test('a timer that fires after the page was hidden does not call', async () => {
  const env = fakeEnv(), calls = [];
  m.createPoller({ run: () => calls.push(1), intervalMs: 1000, env }).start();
  const [stale] = env.pending();
  env.isHidden = true;
  await stale.callback(); await settle();
  assert.equal(calls.length, 0);
  assert.equal(env.pending().filter(timer => timer !== stale).length, 0, 'and nothing new is scheduled');
});

test('pauseWhenHidden: false keeps polling in a hidden tab', async () => {
  const env = fakeEnv({ hidden: true }), calls = [];
  m.createPoller({ run: () => calls.push(1), intervalMs: 1000, pauseWhenHidden: false, env }).start();
  await env.fire(); await settle();
  assert.equal(calls.length, 1);
  assert.equal(env.listening(), false, 'no visibility listener is needed');
});

test('a failing call does not stop the loop and is reported', async () => {
  const env = fakeEnv(), failures = [];
  const poller = m.createPoller({ run: () => { throw new Error('host busy'); }, onError: error => failures.push(error.message), intervalMs: 500, env });
  poller.start();
  await env.fire(); await settle();
  assert.deepEqual(failures, ['host busy']);
  assert.equal(env.pending().length, 1);
});

test('backoff stretches the delay while answers stay unchanged and snaps back on a change', async () => {
  const env = fakeEnv();
  let answer = { unchanged: true };
  const poller = m.createPoller({ run: () => answer, intervalMs: m.POLL_FAST_MS, backoff: m.backoffDelay, env });
  poller.start();
  for (let i = 0; i < 12; i += 1) { await env.fire(); await settle(); }
  assert.equal(env.pending()[0].ms, 5000, '12 unchanged answers: 2x');
  for (let i = 0; i < 36; i += 1) { await env.fire(); await settle(); }
  assert.equal(env.pending()[0].ms, 10000, '48 unchanged answers: 4x');
  answer = { unchanged: false };
  await env.fire(); await settle();
  assert.equal(env.pending()[0].ms, m.POLL_FAST_MS);
  answer = { unchanged: true, running: true };
  await env.fire(); await settle();
  assert.equal(env.pending()[0].ms, m.POLL_FAST_MS, 'a running job keeps the quick rhythm');
});

test('backoffDelay scales the poll-schedule table to any base interval', () => {
  assert.equal(m.backoffDelay(m.POLL_FAST_MS, { unchanged: 0 }), m.POLL_FAST_MS);
  for (const unchanged of [0, 11, 12, 47, 48, 200]) assert.equal(m.backoffDelay(m.POLL_FAST_MS, { unchanged }), m.pollDelay({ unchanged }));
  assert.equal(m.backoffDelay(1000, { unchanged: 48 }), 4000);
  assert.equal(m.backoffDelay(1000, { unchanged: 48, running: true }), 1000);
});

test('refresh asks now without waiting for the timer and restarts the wait', async () => {
  const env = fakeEnv(), calls = [];
  const poller = m.createPoller({ run: () => calls.push(1), intervalMs: 2000, env });
  poller.start();
  await poller.refresh(); await settle();
  assert.equal(calls.length, 1);
  assert.equal(env.pending().length, 1);
});

test('the hook renders without starting anything on the server', () => {
  const Probe = () => { m.usePolling(() => { throw new Error('must not run'); }, { intervalMs: 1000, immediate: true }); return React.createElement('i', null, 'ok'); };
  assert.match(renderToStaticMarkup(React.createElement(Probe)), /ok/);
});
