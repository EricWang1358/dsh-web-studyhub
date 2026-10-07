import test from 'node:test';
import assert from 'node:assert/strict';
import { durableFixture } from './fixtures/unified-runtime-durable.mjs';

/* Closing the runtime (a restart, a reload, a test handing the library to the next process) must leave nothing on its way to a manifest: a settlement delivery that
   is still being recorded lands before dispose() resolves. Otherwise the next process reads revision N and this one writes N+1 behind it (#343: "manifest at 43,
   this instance at 42" on Windows). */

test('dispose waits for a settlement delivery that is still being recorded: the manifest does not move after the runtime is closed', async t => {
  let release; const slow = new Promise(resolve => { release = resolve; });
  const f = await durableFixture(t, async () => { throw new Error('the attempt fails'); },
    { notifications: [{ channel: 'inbox', idempotent: true, deliver: () => slow }], waitForDelivery: false });
  const job = await f.port.submit('persist', {});
  assert.equal((await f.port.wait(job.jobId)).status, 'failed');
  let closed = false;
  const disposing = f.lifecycle.dispose().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(closed, false, 'the delivery is still being recorded: the runtime is not closed yet');
  release();
  await disposing;
  const atClose = await f.store.load();
  assert.ok(atClose.deliveries.every(item => item.status === 'delivered'), 'the delivery was recorded before dispose resolved');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await f.store.load()).revision, atClose.revision, 'nothing is written after the runtime is closed');
});
