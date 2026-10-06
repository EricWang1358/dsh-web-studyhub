import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../lib/jobs/scheduler.js';

const options = { queueTimeoutMs: 1000 };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('S1-3 permit mode requires bounded waiting and never retries a physical request', async () => {
  const pool = createPool({ mode: 'permit', limit: 1 });
  for (const queueTimeoutMs of [undefined, null, Infinity, -1, NaN])
    await assert.rejects(pool.run(() => assert.fail('invalid deadline admitted'), { queueTimeoutMs }), { code: 'queue-timeout-invalid' });
  let calls = 0;
  const refusal = Object.assign(new Error('429'), { status: 429 });
  await assert.rejects(pool.run(() => { calls++; throw refusal; }, options), error => error === refusal);
  assert.equal(calls, 1); assert.equal(pool.state.effective, 1);
});

test('S1-3 permit queue timeout and cancellation remove waiters before I/O', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const pool = createPool({ mode: 'permit', limit: 1 }), held = Promise.withResolvers();
  const first = pool.run(() => held.promise, options);
  await flush();
  const controller = new AbortController();
  const cancelled = assert.rejects(pool.run(() => assert.fail('cancelled request ran'), { ...options, signal: controller.signal }), { name: 'AbortError' });
  const expired = assert.rejects(pool.run(() => assert.fail('expired request ran'), { queueTimeoutMs: 50 }), { code: 'queue-timeout' });
  controller.abort(); t.mock.timers.tick(50);
  await Promise.all([cancelled, expired]);
  held.resolve(); await first;
  assert.equal(await pool.run(() => 'free', { queueTimeoutMs: 0 }), 'free');
});

test('S1-3 abort after admission retains capacity until physical cleanup settles', async () => {
  const pool = createPool({ mode: 'permit', limit: 1 }), cleanup = Promise.withResolvers(), controller = new AbortController();
  let started = false;
  const first = pool.run(() => cleanup.promise, { ...options, signal: controller.signal });
  await flush(); controller.abort();
  const next = pool.run(() => { started = true; }, options);
  await flush(); assert.equal(started, false);
  cleanup.resolve(); await first; await next;
  assert.equal(started, true);
});

test('S1-3 cancellation between admission and invocation prevents physical I/O', async () => {
  const pool = createPool({ mode: 'permit', limit: 1 }), controller = new AbortController();
  const result = pool.run(() => assert.fail('aborted before invocation'), { ...options, signal: controller.signal });
  controller.abort(); await assert.rejects(result, { name: 'AbortError' });
  assert.equal(await pool.run(() => 'released', options), 'released');
});

test('S1-3 both caller directions share cooldown; unrelated domains continue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const shared = createPool({ mode: 'permit', limit: 2 }), unrelated = createPool({ mode: 'permit', limit: 1 });
  const old = work => shared.run(work, options), next = work => shared.run(work, options);
  for (const [source, peer] of [[old, next], [next, old]]) {
    let started = false, requests = 0;
    await source(() => { requests++; shared.cooldown(100); });
    const waiting = peer(() => { started = true; });
    assert.equal(await unrelated.run(() => 'other', options), 'other');
    t.mock.timers.tick(99); await flush(); assert.equal(started, false);
    t.mock.timers.tick(1); await waiting; assert.equal(started, true); assert.equal(requests, 1);
  }
});

test('S1-3 cooldown only extends and queue deadlines still apply while cooling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const pool = createPool({ mode: 'permit', limit: 1 });
  pool.cooldown(100); t.mock.timers.tick(20); pool.cooldown(10);
  let ran = false;
  const expired = assert.rejects(pool.run(() => assert.fail('timed out in cooldown'), { queueTimeoutMs: 30 }), { code: 'queue-timeout' });
  const waiting = pool.run(() => { ran = true; }, options);
  t.mock.timers.tick(30); await expired;
  t.mock.timers.tick(49); await flush(); assert.equal(ran, false);
  t.mock.timers.tick(1); await waiting; assert.equal(ran, true);
});

test('S1-3 live limits preserve occupied permits and FIFO future admissions', async () => {
  const pool = createPool({ mode: 'permit', limit: 2 }), a = Promise.withResolvers(), b = Promise.withResolvers(), order = [];
  const first = pool.run(() => a.promise, options), second = pool.run(() => b.promise, options);
  await flush(); pool.setLimit(1);
  const third = pool.run(() => { order.push(3); }, options), fourth = pool.run(() => { order.push(4); }, options);
  a.resolve(); await first; await flush(); assert.deepEqual(order, []);
  pool.setLimit(2); await third; await fourth; assert.deepEqual(order, [3, 4]);
  b.resolve(); await second;
});

test('S1-3 close rejects waiting/new admissions and drain waits for physical cleanup', async () => {
  const pool = createPool({ mode: 'permit', limit: 1 }), held = Promise.withResolvers();
  const first = pool.run(() => held.promise, options); await flush();
  const queued = assert.rejects(pool.run(() => assert.fail('closed waiter ran'), options), { code: 'scope-unloaded' });
  let drained = false;
  const drain = pool.closeAndDrain().then(() => { drained = true; });
  assert.equal(pool.closeAndDrain(), pool.closeAndDrain());
  await queued; await flush(); assert.equal(drained, false);
  await assert.rejects(pool.run(() => assert.fail('closed admission ran'), options), { code: 'scope-unloaded' });
  held.resolve(); await first; await drain; assert.equal(drained, true);
});

test('S1-3 nested same-resource requests reject before deadlock', async () => {
  const pool = createPool({ mode: 'permit', limit: 1 });
  await assert.rejects(pool.run(() => pool.run(() => assert.fail('nested request ran'), options), options), { code: 'resource-reentrant' });
  assert.equal(await pool.run(() => 'released once', options), 'released once');
});

test('S1-3 baseline window pools do not expose provider-policy controls', () => {
  const pool = createPool();
  assert.equal(pool.cooldown, undefined); assert.equal(pool.closeAndDrain, undefined);
});

test('S1-3 dispatch rechecks the deadline even when release wins the timer race', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const pool = createPool({ mode: 'permit', limit: 1 }), held = Promise.withResolvers();
  const first = pool.run(() => held.promise, options); await flush();
  const result = assert.rejects(pool.run(() => assert.fail('expired admission won timer race'), { queueTimeoutMs: 50 }), { code: 'queue-timeout' });
  t.mock.timers.setTime(1050); held.resolve(); await first; await result;
});

test('S1-3 long waits are not truncated by native timer overflow', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const pool = createPool({ mode: 'permit', limit: 1 });
  pool.cooldown(2 ** 31 + 100);
  let ran = false;
  const request = pool.run(() => { ran = true; }, { queueTimeoutMs: 2 ** 31 + 200 });
  t.mock.timers.tick(2 ** 31 - 1); await flush(); assert.equal(ran, false);
  t.mock.timers.tick(101); await request; assert.equal(ran, true);
});

test('S1-3 invalid controls cannot poison permit admission', async () => {
  for (const limit of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => createPool({ mode: 'permit', limit }), TypeError);
  const pool = createPool({ mode: 'permit', limit: 1 });
  for (const limit of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => pool.setLimit(limit), TypeError);
  for (const ms of [-1, NaN, Infinity, null]) assert.throws(() => pool.cooldown(ms), TypeError);
  assert.equal(await pool.run(() => 'valid', options), 'valid');
});
