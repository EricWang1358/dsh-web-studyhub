import test from 'node:test';
import assert from 'node:assert/strict';
import { durableFixture } from './fixtures/unified-runtime-durable.mjs';
import { until } from './helpers/wait.mjs';

// A retry right after an Attempt settles goes through restore-with-bindings (as audio.retry does), which rebinds the job
// to a fresh persistence instance. The settled-event deliveries of the old instance are still being recorded on the same
// manifest; the rebinding must wait for them, or the new instance starts from a stale revision (revision-conflict).
test('restore and retry while settlement deliveries are still being recorded starts a new Attempt', async t => {
  let attempts = 0, release;
  const slow = new Promise(resolve => { release = resolve; });
  const notifications = [{ channel: 'inbox', idempotent: true, deliver: () => slow }];
  const f = await durableFixture(t, async () => { attempts++; if (attempts === 1) throw new Error('first attempt fails'); return { refs: [] }; },
    { notifications, waitForDelivery: false });
  const job = await f.port.submit('persist', {});
  assert.equal((await f.port.wait(job.jobId)).status, 'failed');
  setTimeout(release, 50);
  await f.port.restore('persist', {}, { rebound: true });
  await f.port.recover(job.jobId, 'retry');
  assert.equal((await f.port.wait(job.jobId)).status, 'complete');
  assert.equal(attempts, 2);
  // Deliveries do not hold `wait` here (waitForDelivery: false); both settlements end up recorded.
  await until(async () => (await f.store.load()).deliveries.every(item => item.status === 'delivered'), 'both settlements to be recorded');
  assert.equal((await f.store.load()).deliveries.length, 2);
});
