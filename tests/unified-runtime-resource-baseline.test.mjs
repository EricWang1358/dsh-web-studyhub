import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioWorker } from '../lib/contexts/audio/worker.js';
import { createRuntimeWork } from '../lib/runtime/work.js';
import { createPool } from '../lib/audio-pool.js';
import { until } from './helpers/wait.mjs';

// Characterize the published worker seam before extracting it. No provider I/O.
export function legacyResources() {
  return createAudioWorker({ sessions: {}, uploads: {} }, createRuntimeWork(), {});
}
const held = () => Promise.withResolvers();

test('S1-3 baseline: one gate shares FIFO admission and early release across consumers', async () => {
  const { admitAudio } = legacyResources(), gate = { limit: 1, active: new Set(), waiting: [] };
  const first = held(), last = held(), started = [], signal = new AbortController().signal;
  let release;
  const a = admitAudio(gate, 'a', signal, async done => { release = done; started.push('a'); await first.promise; });
  const b = admitAudio(gate, 'b', signal, async () => { started.push('b'); await last.promise; });
  await until(() => release, 'first admission');
  assert.deepEqual(started, ['a']); assert.deepEqual([...gate.active], ['a']);
  release(); release();
  await until(() => started.length === 2, 'early transcription release');
  assert.deepEqual([...gate.active], ['b']);
  first.resolve(); await a;
  assert.deepEqual([...gate.active], ['b'], 'late finally cannot release the next consumer');
  last.resolve(); await b;
  assert.equal(gate.active.size, 0); assert.equal(gate.waiting.length, 0);
});

test('S1-3 baseline: queued abort removes its waiter but still invokes domain cleanup', async () => {
  const { admitAudio } = legacyResources(), gate = { limit: 1, active: new Set(), waiting: [] };
  const running = held(), abort = new AbortController(); let callbacks = 0, dispatched = 0;
  const a = admitAudio(gate, 'a', new AbortController().signal, () => running.promise);
  const b = admitAudio(gate, 'b', abort.signal, () => { callbacks++; if (!abort.signal.aborted) dispatched++; });
  assert.equal(gate.waiting.length, 1); abort.abort(); await b;
  assert.equal(callbacks, 1, 'legacy callback owns cancellation settlement');
  assert.equal(dispatched, 0); assert.equal(gate.waiting.length, 0);
  assert.deepEqual([...gate.active], ['a']); running.resolve(); await a;
});

test('S1-3 baseline: lowering preserves actual occupancy and a raise resumes FIFO', async () => {
  const { admitAudio, pumpAudio } = legacyResources(), gate = { limit: 2, active: new Set(), waiting: [] };
  const releases = [held(), held(), held(), held()], started = [];
  const runs = releases.map((item, i) => admitAudio(gate, String(i), new AbortController().signal, async () => { started.push(i); await item.promise; }));
  await until(() => started.length === 2, 'two occupied slots');
  gate.limit = 1; pumpAudio(gate);
  assert.equal(gate.active.size, 2);
  releases[0].resolve(); await runs[0]; assert.deepEqual(started, [0, 1]);
  gate.limit = 2; pumpAudio(gate);
  await until(() => started.length === 3, 'raised capacity'); assert.deepEqual(started, [0, 1, 2]);
  releases[1].resolve(); await runs[1];
  await until(() => started.length === 4, 'last waiter');
  releases[2].resolve(); releases[3].resolve(); await Promise.all(runs);
  assert.equal(gate.active.size, 0);
});

test('S1-3 baseline: text limits are per pool, not a host/provider quota', async () => {
  const one = createPool({ limit: 1 }), two = createPool({ limit: 1 });
  const release = held(), started = []; let active = 0, peak = 0;
  const run = (pool, id) => pool.run(async () => { started.push(id); peak = Math.max(peak, ++active); await release.promise; active--; });
  const runs = [run(one, 'one-a'), run(one, 'one-b'), run(two, 'two-a')];
  await until(() => started.length === 2, 'independent pool admissions');
  assert.deepEqual(started, ['one-a', 'two-a']); assert.equal(peak, 2);
  release.resolve(); await Promise.all(runs); assert.equal(active, 0);
});
