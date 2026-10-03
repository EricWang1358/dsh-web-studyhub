import test from "node:test";
import assert from "node:assert/strict";
import { pollDelay, POLL_FAST_MS } from "../ui/poll-schedule.js";
import { readFile } from 'node:fs/promises';
import { sameExceptFingerprint } from '../ui/snapshot-share.js';

test("the panel polls quickly until the host has answered unchanged for a while", () => {
  assert.equal(pollDelay({ unchanged: 0 }), POLL_FAST_MS);
  assert.equal(pollDelay({ unchanged: 11 }), POLL_FAST_MS);
  assert.equal(pollDelay({ unchanged: 12 }), 5000);
  assert.equal(pollDelay({ unchanged: 47 }), 5000);
  assert.equal(pollDelay({ unchanged: 48 }), 10000);
  assert.equal(pollDelay({ unchanged: 5000 }), 10000, "never slower than ten seconds, so another writer's change shows within one poll");
});

test("a running job keeps the quick rhythm whatever the streak", () => {
  assert.equal(pollDelay({ unchanged: 500, running: true }), POLL_FAST_MS);
});

test("defaults are the quick rhythm", () => {
  assert.equal(pollDelay(), POLL_FAST_MS);
});

// Exercise App's real effect with browser events and a deterministic clock.
// The public preview also reproduces this with a delayed snapshot response.
const app = (await readFile(new URL('../ui/App.jsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const effectStart = app.indexOf('useEffect(() => {\n    if (!binding.root) return;');
const effectEnd = app.indexOf('}, [binding.root, refresh]);', effectStart) + '}, [binding.root, refresh]);'.length;
assert.ok(effectStart >= 0 && effectEnd > effectStart, 'the snapshot polling effect is available');
const mountEffect = new Function('useEffect', 'binding', 'refresh', 'dataRef', 'workingRef', 'setSyncIssue',
  'pollDelay', 'sameExceptFingerprint', 'POLL_FAST_MS', 'window', 'document', 'setTimeout', 'clearTimeout', app.slice(effectStart, effectEnd));

class PollEvents {
  listeners = new Map();
  hidden = false;
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  send(type) { for (const callback of this.listeners.get(type) || []) callback(); }
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function panelPoll() {
  let now = 0, sequence = 0, stop, resolve, reject;
  const timers = new Map(), calls = [], issues = [], window = new PollEvents(), document = new PollEvents();
  const snapshot = { fingerprint: 'same', jobs: [{ id: 'job', status: 'running' }] };
  const setTimer = (work, delay) => { const id = ++sequence; timers.set(id, { at: now + delay, work }); return id; };
  const advance = async target => {
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at);
      if (!due.length) break;
      const [id, timer] = due[0]; timers.delete(id); now = timer.at; void timer.work(); await settle();
    }
    now = target; await settle();
  };
  const refresh = () => {
    calls.push(now);
    return calls.length === 1 ? new Promise((yes, no) => { resolve = yes; reject = no; }) : Promise.resolve(snapshot);
  };
  mountEffect(effect => { stop = effect(); }, { root: '/temporary-test-library' }, refresh, { current: snapshot },
    { current: true }, issue => issues.push(issue), pollDelay, sameExceptFingerprint, POLL_FAST_MS, window, document, setTimer, id => timers.delete(id));
  return { timers, calls, issues, window, document, advance, stop,
    complete: async () => { resolve(snapshot); await settle(); },
    fail: async () => { reject(new Error('temporarily offline')); await settle(); } };
}

test('returning during an in-flight snapshot keeps one poll chain and refreshes immediately afterwards', async () => {
  const panel = panelPoll();
  await panel.advance(2500);
  panel.document.send('visibilitychange'); await panel.advance(2500);
  assert.equal(panel.calls.length, 1, 'the wake must not overlap the pending snapshot');
  await panel.advance(3000); await panel.complete();
  assert.equal(panel.timers.size, 1, 'a wake during the request must leave exactly one timer');
  await panel.advance(3000);
  assert.deepEqual(panel.calls, [2500, 3000], 'coalesced wake intent runs after the pending request');
  await panel.advance(20000);
  assert.equal(panel.timers.size, 1);
  assert.equal(panel.calls.length, 8, 'one wake adds one refresh, not a permanent second cadence');
  panel.stop(); await panel.advance(30000); assert.equal(panel.timers.size, 0);
});

test('multiple wake events coalesce, and a failed pending request still schedules recovery', async () => {
  const panel = panelPoll(); await panel.advance(2500);
  for (let i = 0; i < 4; i++) { panel.document.send('visibilitychange'); await panel.advance(2500); }
  assert.equal(panel.calls.length, 1);
  await panel.advance(3000); await panel.fail(); await panel.advance(3000);
  assert.deepEqual(panel.calls, [2500, 3000]);
  assert.deepEqual(panel.issues, ['temporarily offline', '']);
  assert.equal(panel.timers.size, 1); panel.stop();
});

test('a queued wake does no work while hidden, then returning replaces the sleeping timer', async () => {
  const panel = panelPoll(); await panel.advance(2500);
  panel.document.send('visibilitychange');
  panel.document.hidden = true;
  await panel.complete(); await panel.advance(10000);
  assert.deepEqual(panel.calls, [2500], 'the completed request cannot trigger work in a hidden panel');
  assert.equal(panel.timers.size, 1);
  panel.document.hidden = false; panel.document.send('visibilitychange'); await panel.advance(10000);
  assert.deepEqual(panel.calls, [2500, 10000], 'returning refreshes at once without waiting for the hidden timer');
  assert.equal(panel.timers.size, 1); panel.stop();
});

test('hidden panels skip work, and teardown prevents old request completion from updating or rescheduling', async () => {
  const panel = panelPoll(); panel.document.hidden = true;
  await panel.advance(7500); assert.equal(panel.calls.length, 0);
  panel.document.hidden = false; panel.document.send('visibilitychange'); await panel.advance(7500);
  assert.equal(panel.calls.length, 1);
  panel.document.send('visibilitychange'); panel.stop();
  await panel.complete(); await panel.advance(30000);
  assert.deepEqual(panel.issues, [], 'a disposed library/panel cannot receive late sync state');
  assert.equal(panel.timers.size, 0);
  assert.equal([...panel.document.listeners.values()].reduce((count, listeners) => count + listeners.size, 0), 0);
  assert.equal([...panel.window.listeners.values()].reduce((count, listeners) => count + listeners.size, 0), 0);
});

test('a failed request from the previous library cannot set the new panel sync issue', async () => {
  const previous = panelPoll(); await previous.advance(2500);
  previous.document.send('visibilitychange'); previous.stop();
  const current = panelPoll(); await current.advance(2500); await current.complete();
  await previous.fail(); await previous.advance(30000);
  assert.deepEqual(previous.issues, []);
  assert.deepEqual(current.issues, ['']);
  assert.equal(previous.timers.size, 0);
  assert.equal(current.timers.size, 1); current.stop();
});
