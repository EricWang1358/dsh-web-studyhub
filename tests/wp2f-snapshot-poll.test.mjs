import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPoller } from '../ui/use-polling.js';
import { backoffDelay, POLL_FAST_MS } from '../ui/poll-schedule.js';
import { sameExceptFingerprint } from '../ui/snapshot-share.js';
import { createSnapshotPoll, attachWake } from '../ui/app/snapshot-poll.js';

// UI wave 2 · WP-F (#125): the library snapshot poll runs on the shared polling loop. These are the scenarios that
// tests/poll-schedule.test.mjs used to run against App's hand-written effect: browser events and a deterministic clock.

class PollEvents {
  listeners = new Map();
  hidden = false;
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  send(type) { for (const callback of [...(this.listeners.get(type) || [])]) callback(); }
  count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function panelPoll() {
  let now = 0, sequence = 0, token = { library: 1 }, resolve, reject;
  const timers = new Map(), calls = [], issues = [], window = new PollEvents(), document = new PollEvents();
  const snapshot = { fingerprint: 'same', jobs: [{ id: 'job', status: 'running' }] };
  const setTimer = (work, delay) => { const id = ++sequence; timers.set(id, { at: now + delay, work }); return id; };
  const advance = async (target) => {
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
  const poll = createSnapshotPoll({ refresh, readData: () => snapshot, readToken: () => token, setSyncIssue: (issue) => issues.push(issue),
    same: sameExceptFingerprint, isWorking: () => true });
  const poller = createPoller({ run: poll.run, intervalMs: POLL_FAST_MS, backoff: backoffDelay,
    env: { hidden: () => document.hidden, onVisibility: (callback) => { document.addEventListener('visibilitychange', callback); return () => document.removeEventListener('visibilitychange', callback); },
      setTimer, clearTimer: (id) => timers.delete(id) } });
  const detach = attachWake(poll, { win: window, doc: document });
  poller.start();
  return { timers, calls, issues, window, document, advance, poll,
    stop() { token = { library: 2 }; poller.stop(); detach(); },
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

test('a queued wake does no work while hidden, and returning refreshes at once', async () => {
  const panel = panelPoll(); await panel.advance(2500);
  panel.document.send('visibilitychange');
  panel.document.hidden = true;
  await panel.complete(); await panel.advance(10000);
  assert.deepEqual(panel.calls, [2500], 'the completed request cannot trigger work in a hidden panel');
  assert.equal(panel.timers.size, 0, 'a hidden panel keeps no timer at all');
  panel.document.hidden = false; panel.document.send('visibilitychange'); await panel.advance(10000);
  assert.deepEqual(panel.calls, [2500, 10000], 'returning refreshes at once');
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
  assert.equal(panel.document.count(), 0);
  assert.equal(panel.window.count(), 0);
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

test('activity in the panel brings the quick rhythm back after a long quiet spell', async () => {
  const panel = panelPoll(); await panel.advance(2500); await panel.complete();
  // Shrink "working" so the table applies: unchanged answers slow the poll down.
  const held = { fingerprint: 'same', jobs: [] };
  const quiet = createSnapshotPoll({ refresh: async () => ({ ...held, fingerprint: 'rolled over' }), readData: () => held,
    readToken: () => 1, setSyncIssue() {}, same: sameExceptFingerprint, isWorking: () => false });
  for (let i = 0; i < 14; i++) assert.deepEqual(await quiet.run(), { unchanged: true, running: false });
  quiet.wake();
  assert.deepEqual(await quiet.run(), { unchanged: false, running: false }, 'a pointer press or key resets the streak');
  assert.deepEqual(await quiet.run(), { unchanged: true, running: false }, 'and counting starts over');
  panel.stop();
});

test('wake listeners are the pointer, the keyboard and the tab coming back, and they come off together', () => {
  const window = new PollEvents(), document = new PollEvents();
  let wakes = 0;
  const detach = attachWake({ wake: () => { wakes++; } }, { win: window, doc: document });
  window.send('pointerdown'); window.send('keydown'); document.send('visibilitychange');
  assert.equal(wakes, 3);
  detach();
  assert.equal(window.count() + document.count(), 0);
});

test('App no longer carries its own polling loop', async () => {
  const app = (await readFile('ui/App.jsx', 'utf8')).replace(/\r\n/g, '\n');
  assert.doesNotMatch(app, /setTimeout\(tick/);
  const connection = (await readFile('ui/app/use-library-connection.js', 'utf8')).replace(/\r\n/g, '\n');
  assert.match(connection, /usePolling\(/);
  assert.match(connection, /backoff: true/);
});
