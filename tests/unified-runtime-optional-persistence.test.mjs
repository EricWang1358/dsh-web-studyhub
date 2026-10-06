import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createJobLifecycle } from '../lib/jobs/lifecycle.js';
import { createRuntimeWork } from '../lib/runtime/work.js';

// A family whose durability is a switch of its own declares its persistence once; for a submission that is not durable its adapter says so
// (open returns null) and the job is an ordinary in-process job: it can still be retried in this process, it just cannot be restored.
const executor = { assertAvailable() {}, witness: () => ({}), inspect: () => ({ state: 'lost' }), start({ run, cancel }) { void run(); return { id: 'h', ownerAgentId: 'o', stop: cancel }; } };

async function lifecycleWith(t) {
  let runs = 0;
  const lifecycle = createJobLifecycle('root', createRuntimeWork()), ctx = new Context();
  lifecycle.register(ctx, 'family.v1', { kind: 'job', version: 1, capabilities: { cancel: true, retry: true, recoveryMode: 'retry-from-start' },
    persistence: { open: async () => null }, run: async () => { if (++runs === 1) throw new Error('first attempt'); return { refs: [], completeness: 'complete' }; } });
  t.after(async () => { await lifecycle.dispose(); await ctx.fiber.dispose(); });
  return { port: lifecycle.scoped({ owner: Symbol('owner'), domain: 'family.v1', executor }), runs: () => runs };
}

test('a submission whose persistence adapter declines is an in-process job that can be retried but not recovered', async t => {
  const { port, runs } = await lifecycleWith(t);
  const submitted = await port.submit('job', {});
  assert.equal((await port.wait(submitted.jobId)).status, 'failed');
  assert.equal(port.status(submitted.jobId).actions.retry.available, true);
  await assert.rejects(port.recover(submitted.jobId), { code: 'recovery-unsupported' });
  await port.control(submitted.jobId, 'retry');
  const again = await port.wait(submitted.jobId);
  assert.equal(again.status, 'complete'); assert.equal(runs(), 2);
  assert.equal(again.runtime.attempts.length, 2, 'the same logical job, a new Attempt');
  await assert.rejects(port.restore('job', {}), { code: 'recovery-unsupported' });
});
