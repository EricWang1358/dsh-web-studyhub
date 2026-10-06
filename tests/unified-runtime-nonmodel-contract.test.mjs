import test from 'node:test';
import assert from 'node:assert/strict';
import { admitSlot } from '../lib/jobs/scheduler.js';
import { durableFixture } from './fixtures/unified-runtime-durable.mjs';

// S5-1: what the published kernel already guarantees for non-model jobs (gaps G-1..G-11 of s5-0-nonmodel-baseline.md).
// The additions the kernel needed are tested in unified-runtime-nonmodel-kernel.test.mjs; nothing here changes the kernel.
const step = { purpose: 'install', feature: 'marker', budget: null };
const observed = (context, key, meta, operation, policy = step) => {
  const unit = context.gateway.step(key, policy);
  return unit.run(() => unit.observe({ boundary: 'local-process', kind: key, ...meta }, operation));
};

test('G-5/G-8: an unknown outcome of a declared side effect blocks a blind resend; a plain process failure stays retryable', async t => {
  for (const [sideEffect, retryable] of [[false, true], [true, false]]) {
    let attempts = 0;
    const f = await durableFixture(t, async context => { attempts++; await observed(context, 'pip', { sideEffect }, async () => { throw new Error('pip died'); }); });
    const job = await f.port.submit('persist', {});
    assert.equal((await f.port.wait(job.jobId)).status, 'failed');
    const intents = (await f.store.load()).requestIntents;
    assert.deepEqual(intents.map(intent => intent.status), [retryable ? 'completed' : 'pending']);
    if (retryable) { await f.port.control(job.jobId, 'retry'); assert.equal((await f.port.wait(job.jobId)).status, 'failed'); assert.equal(attempts, 2); }
    else {
      await assert.rejects(f.port.control(job.jobId, 'retry'), { code: 'remote-result-unknown' });
      assert.equal(attempts, 1, 'the refusal starts no Attempt and no process');
    }
  }
});

test('G-6: the cancel receipt is "cancelling"; the Attempt only settles after the observed process cleanup finished', async t => {
  let started, cleaned = false, release;
  const running = new Promise(resolve => { started = resolve; }), held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const f = await durableFixture(t, async context => {
    await observed(context, 'pip', {}, async signal => {
      started(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      await held; cleaned = true; // the process tree is killed and awaited here, inside the observed operation
    });
    return { refs: [] };
  });
  const job = await f.port.submit('persist', {}); await running;
  const receipt = await f.port.control(job.jobId, 'cancel');
  assert.equal(receipt.status, 'cancelling'); assert.equal(cleaned, false);
  assert.equal(f.port.status(job.jobId).actions.cancel.reason.code, 'already-cancelling');
  release();
  const end = await f.port.wait(job.jobId);
  assert.equal(end.status, 'cancelled'); assert.equal(cleaned, true, 'terminal state is never published before cleanup ended');
  assert.equal(end.calls[0].status, 'cancelled');
});

test('G-10: a step budget is the per-operation timeout of a non-model task; no job-level policy key is needed', async t => {
  const alive = setInterval(() => {}, 1000); t.after(() => clearInterval(alive)); // AbortSignal.timeout does not keep the process alive
  const f = await durableFixture(t, async context => {
    await observed(context, 'download', { sideEffect: false }, signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      // Long enough that the budget never expires before the request is dispatched, even on a loaded machine.
      { ...step, budget: { timeoutMs: 1000 } });
    return { refs: [] };
  });
  const job = await f.port.submit('persist', {}), end = await f.port.wait(job.jobId);
  assert.equal(end.status, 'failed'); assert.equal(end.calls[0].status, 'cancelled'); assert.equal(end.calls[0].reason, 'aborted');
  assert.equal((await f.store.load()).requestIntents[0].status, 'completed', 'an observed end is a known outcome');
});

test('G-9: a job without model calls keeps usage unknown instead of inventing tokens or cost', async t => {
  const f = await durableFixture(t, async context => { await observed(context, 'venv', {}, async () => ({ value: 1 })); return { refs: [] }; });
  const job = await f.port.submit('persist', {}), end = await f.port.wait(job.jobId);
  assert.deepEqual(end.usage, { tokens: null, tokenUsage: null, calls: 0 });
  assert.equal(end.calls[0].tokens, null); assert.equal(end.calls[0].tokenUsage, null);
});

test('G-11: admission re-runs on retry, so a revoked ownership refuses before any process', async t => {
  let owned = true, ran = 0;
  const f = await durableFixture(t, async () => { ran++; throw new Error('first run fails'); },
    { admit: async () => { if (!owned) throw Object.assign(new Error('not ours'), { code: 'directory-not-owned' }); } });
  const job = await f.port.submit('persist', {});
  assert.equal((await f.port.wait(job.jobId)).status, 'failed');
  owned = false;
  await f.port.control(job.jobId, 'retry');
  const end = await f.port.wait(job.jobId);
  assert.equal(end.status, 'failed'); assert.equal(end.error.code, 'directory-not-owned'); assert.equal(ran, 1, 'run() never started for the refused attempt');
});

test('G-11: a Settings-only definition declares no retry/pause/recovery, so generic control cannot start it again', async t => {
  let ran = 0;
  const f = await durableFixture(t, async () => ({ refs: [] }));
  f.lifecycle.register(f.ctx, 'settings.v1', { kind: 'install', version: 1, capabilities: { cancel: true, retry: false, pauseMode: 'unsupported', recoveryMode: 'none' },
    admit: async (_context, input) => { if (input.confirm !== true) throw Object.assign(new Error('confirm required'), { code: 'confirm-required' }); },
    run: async () => { ran++; throw new Error('install failed'); } });
  const port = f.lifecycle.scoped({ owner: Symbol('panel'), domain: 'settings.v1', executor: f.executor });
  const unconfirmed = await port.submit('install', {});
  assert.equal((await port.wait(unconfirmed.jobId)).error.code, 'confirm-required'); assert.equal(ran, 0);
  const job = await port.submit('install', { confirm: true });
  assert.equal((await port.wait(job.jobId)).status, 'failed'); assert.equal(ran, 1);
  const starts = f.starts();
  for (const [action, code] of [['retry', 'capability-unsupported'], ['resume', 'not-paused'], ['pause', 'job-ended']]) {
    await assert.rejects(port.control(job.jobId, action), { code });
  }
  await assert.rejects(port.recover(job.jobId), { code: 'recovery-unsupported' });
  assert.equal(f.starts(), starts, 'no executor start'); assert.equal(ran, 1, 'no process');
});

test('G-4: exclusive local resources are admission leases; a queued sibling can be cancelled while the holder continues', async t => {
  const gate = { limit: 1, active: new Set(), waiting: [] };
  let releaseHolder, holderRunning;
  const holding = new Promise(resolve => { holderRunning = resolve; }), freed = new Promise(resolve => { releaseHolder = resolve; });
  t.after(() => releaseHolder());
  const f = await durableFixture(t, async () => ({ refs: [] }));
  f.lifecycle.register(f.ctx, 'gated.v1', { kind: 'index', version: 1, capabilities: { cancel: true },
    async admit(context) {
      let start, finish, release; const admitted = new Promise(resolve => { start = resolve; }), held = new Promise(resolve => { finish = resolve; });
      const drained = admitSlot(gate, context.attemptId, context.signal, free => { release = free; start(); return held; });
      await admitted; return { release: () => release?.(), async finish() { finish(); await drained; } };
    },
    async run(_context, input) { if (input.holder) { holderRunning(); await freed; } return { refs: [] }; } });
  const port = f.lifecycle.scoped({ owner: Symbol('panel'), domain: 'gated.v1', executor: f.executor });
  const holder = await port.submit('index', { holder: true }); await holding;
  const sibling = await port.submit('index', {});
  assert.equal(port.status(sibling.jobId).status, 'queued');
  await port.control(sibling.jobId, 'cancel');
  assert.equal((await port.wait(sibling.jobId)).status, 'cancelled'); assert.equal(gate.waiting.length, 0, 'removed from the waiting queue');
  assert.equal(port.status(holder.jobId).status, 'running');
  releaseHolder(); assert.equal((await port.wait(holder.jobId)).status, 'complete');
  assert.equal(gate.active.size, 0);
});
