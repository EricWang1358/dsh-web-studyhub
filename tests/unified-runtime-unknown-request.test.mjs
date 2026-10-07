import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createJobLifecycle } from '../lib/jobs/lifecycle.js';
import { createRuntimeWork } from '../lib/runtime/work.js';
import { durableFixture } from './fixtures/unified-runtime-durable.mjs';

// A process that died inside a request leaves its intent pending. What that means depends on the request: one that changes nothing remote
// (a model call) is safe to ask again; one declared as having a side effect keeps blocking recovery until it is reconciled.
const policy = { purpose: 'author', feature: 'generate', requestedEffort: 'default', executionMode: 'direct', budget: null };
// `sideEffect` is what the caller declares; a request that does not say is treated as having one.
const asking = sideEffect => async context => {
  const step = context.gateway.step('author:1', policy);
  await step.run(() => step.observe({ boundary: 'external-request', kind: 'author', sideEffect }, async () => ({ value: 'text', status: 200 })));
  return { refs: [], completeness: 'complete' };
};

/** A job that ended after one request, rewritten as the disk of a process that died while that request was in flight. */
async function diedInsideRequest(t, sideEffect) {
  let runs = 0;
  const f = await durableFixture(t, async context => { runs++; return asking(sideEffect)(context); });
  const submitted = await f.port.submit('persist', {}); await f.port.wait(submitted.jobId);
  const saved = await f.store.load();
  saved.contract.status = 'running'; saved.contract.error = null; delete saved.contract.finishedAt; saved.contract.events = [];
  saved.contract.runtime.activeAttemptId = saved.contract.attemptId;
  const attempt = saved.contract.runtime.attempts.at(-1); attempt.status = 'running'; delete attempt.finishedAt; delete attempt.endReason;
  saved.contract.calls = []; saved.contract.runtime.steps.at(-1).status = 'running';
  // Only a request with a side effect leaves an intent behind; a side-effect-free one leaves nothing to reconcile.
  if (saved.requestIntents[0]) saved.requestIntents[0].status = 'pending';
  await f.store.save(saved, { expectedRevision: saved.revision });
  const next = createJobLifecycle(f.root, createRuntimeWork()), ctx = new Context();
  next.register(ctx, 'persist.v1', f.definition);
  t.after(async () => { await next.dispose(); await ctx.fiber.dispose(); });
  const port = next.scoped({ owner: Symbol('restored'), domain: 'persist.v1', executor: f.executor });
  return { f, port, restored: await port.restore('persist', {}), runs: () => runs };
}

test('a request that changes nothing remote and was in flight when the process died is asked again on recovery', async t => {
  const { f, port, restored, runs } = await diedInsideRequest(t, false);
  assert.equal(restored.status, 'interrupted');
  await port.recover(restored.jobId);
  assert.equal((await port.wait(restored.jobId)).status, 'complete');
  assert.equal(runs(), 2); assert.equal(f.starts(), 2);
  assert.deepEqual((await f.store.load()).requestIntents, [], 'a request that changes nothing remote never needed an intent');
});

test('a request declared as having a side effect stays unknown and blocks recovery', async t => {
  const { f, port, restored } = await diedInsideRequest(t, true);
  assert.equal(restored.status, 'interrupted');
  await assert.rejects(port.recover(restored.jobId), { code: 'remote-result-unknown' });
  assert.equal(f.starts(), 1);
});
