import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createRuntimeWork } from '../lib/runtime/work.js';
import { createAudioWorker } from '../lib/contexts/audio/worker.js';
import { createJobLifecycle } from '../lib/jobs/lifecycle.js';
import { dshJobExecutor } from '../lib/jobs/executor.js';
import { admitSlot, pumpSlots, createPool } from '../lib/jobs/scheduler.js';
import { createPool as legacyPool } from '../lib/audio-pool.js';
import { until } from './helpers/wait.mjs';

test('S1-3 existing entry points delegate to the exact same implementations', () => {
  const old = createAudioWorker({ sessions: {}, uploads: {} }, createRuntimeWork(), {});
  assert.equal(old.admitAudio, admitSlot);
  assert.equal(old.pumpAudio, pumpSlots);
  assert.equal(createPool, legacyPool);
});

// Actual business lifecycle, controlled native executor double. This is not a DSH host probe.
test('S1-3 canonical cancellation retains the shared physical slot until its producer drains', async t => {
  const scope = new Context(), work = createRuntimeWork(), lifecycle = createJobLifecycle('/private', work);
  const old = createAudioWorker({ sessions: {}, uploads: {} }, work, {}), gate = work.audioGate;
  const agent = { id: 'test-agent' }, handles = new Map(); let count = 0, context, started = 0;
  const held = Promise.withResolvers(), legacyHeld = Promise.withResolvers();
  const host = { get: key => key === 'agents' ? { get: () => agent } : {
    start(spec) { const id = `native-${++count}`; handles.set(id, spec.run()); return id; },
    kill(id) { handles.get(id).cancel('cancel'); },
  } };
  const port = lifecycle.scoped({ owner: Symbol('owner'), domain: 'probe', executor: dshJobExecutor(host, agent) });
  lifecycle.register(scope, 'probe', { kind: 'slot-probe', version: 1, run: ctx => admitSlot(gate, ctx.attemptId, ctx.signal, async () => {
    ctx.signal.throwIfAborted(); context = ctx; started++; await held.promise; return { refs: [] };
  }) });
  t.after(async () => { held.resolve(); legacyHeld.resolve(); await lifecycle.dispose(); await scope.fiber.dispose(); });
  const first = await port.submit('slot-probe', {});
  await until(() => context, 'canonical occupied slot');
  let legacyStarted = false;
  const legacy = old.admitAudio(gate, 'legacy', new AbortController().signal, async () => { legacyStarted = true; await legacyHeld.promise; });
  const queued = await port.submit('slot-probe', {});
  await until(() => gate.waiting.length === 2, 'mixed queued work');
  await port.control(queued.jobId, 'cancel');
  assert.equal((await port.wait(queued.jobId)).status, 'cancelled');
  assert.equal(started, 1); assert.equal(gate.waiting.length, 1);
  await port.control(first.jobId, 'cancel');
  assert.equal(context.signal.aborted, true);
  assert.equal(port.status(first.jobId).status, 'cancelling');
  assert.equal(gate.active.size, 1); assert.equal(legacyStarted, false);
  held.resolve(); assert.equal((await port.wait(first.jobId)).status, 'cancelled');
  await until(() => legacyStarted, 'legacy after physical drain');
  assert.deepEqual([...gate.active], ['legacy']);
  legacyHeld.resolve(); await legacy; assert.equal(gate.active.size, 0);
});

test('S1-3 text callers sharing a pool share reduction, while backoff releases occupancy', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [], pool = createPool({ limit: 2, backoff: () => 100, probeAfter: 10, onWait: event => events.push(event) });
  const held = Promise.withResolvers(); let attempts = 0, peerStarted = false;
  const refused = pool.run(async () => { if (++attempts === 1) throw Object.assign(new Error('limited'), { status: 429 }); return 'retried'; });
  // Drain microtasks deterministically without moving the fake backoff clock.
  const peer = pool.run(async () => { peerStarted = true; await held.promise; return 'peer'; });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(peerStarted, true); assert.equal(pool.state.effective, 1);
  assert.equal(events.filter(e => e.phase === 'start').length, 1);
  assert.equal(attempts, 1);
  held.resolve(); assert.equal(await peer, 'peer');
  let newcomer = false;
  await pool.run(async () => { newcomer = true; });
  assert.equal(newcomer, true, 'baseline backoff is per refused work, not shared cooldown');
  t.mock.timers.tick(100);
  assert.equal(await refused, 'retried'); assert.equal(attempts, 2);
  assert.deepEqual(events.map(e => e.phase), ['start', 'end']);
});
