import test from 'node:test';
import assert from 'node:assert/strict';
import { durableFixture } from './fixtures/unified-runtime-durable.mjs';

// An observed failure ends a request: only a declared side-effecting operation keeps
// its remote outcome unknown. A crash mid-request (no observed end) stays unknown.
const policy = { purpose: 'proofread', feature: 'audio', requestedEffort: 'default', executionMode: 'direct', budget: null };
const failing = meta => async context => {
  const step = context.gateway.step('proofread:1', policy);
  await step.run(() => step.observe(meta, async () => { throw new Error('provider refused'); }));
  return { refs: [] };
};

for (const [name, meta, outcome] of [
  ['a host model call that throws', { boundary: 'host-attempt', kind: 'proofread' }, 'retryable'],
  ['a transport failure without side effects', { boundary: 'external-request', kind: 'transcribe' }, 'retryable'],
  ['a side-effecting remote operation that throws', { boundary: 'external-request', kind: 'create', sideEffect: true }, 'refused'],
]) test(`${name} is ${outcome} after it fails`, async t => {
  let attempts = 0;
  const f = await durableFixture(t, async context => { attempts++; return failing(meta)(context); });
  const job = await f.port.submit('persist', {}), failed = await f.port.wait(job.jobId);
  assert.equal(failed.status, 'failed');
  const intents = (await f.store.load()).requestIntents.map(intent => intent.status);
  if (outcome === 'retryable') {
    assert.deepEqual(intents, ['completed']);
    await f.port.control(job.jobId, 'retry');
    assert.equal((await f.port.wait(job.jobId)).status, 'failed');
    assert.equal(attempts, 2, 'the explicit retry ran a new Attempt');
  } else {
    assert.deepEqual(intents, ['pending']);
    await assert.rejects(f.port.control(job.jobId, 'retry'), { code: 'remote-result-unknown' });
    assert.equal(attempts, 1);
  }
});

test('a local wait is recorded as side-effect free, and declaring one with a side effect is refused', async t => {
  let release, entered;
  const inWait = new Promise(resolve => { entered = resolve; });
  const f = await durableFixture(t, async context => {
    const step = context.gateway.step('proofread:1', policy);
    await assert.rejects(step.run(() => step.observe({ boundary: 'local-wait', kind: 'wait', sideEffect: true }, async () => {})),
      { code: 'invalid-observation-boundary' });
    const wait = context.gateway.step('proofread:2', policy);
    await wait.run(() => wait.observe({ boundary: 'local-wait', kind: 'wait', reason: 'rate-limit' },
      () => new Promise(resolve => { release = resolve; entered(); })));
    return { refs: [] };
  });
  const job = await f.port.submit('persist', {});
  await inWait;
  // A crash now would leave nothing whose remote outcome is unknown: the wait asked nothing of anyone, so it leaves no intent.
  assert.deepEqual((await f.store.load()).requestIntents, []);
  release();
  assert.equal((await f.port.wait(job.jobId)).status, 'complete');
});
