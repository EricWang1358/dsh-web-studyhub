import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeContract } from '../lib/jobs/contract.js';
import { durableFixture } from './fixtures/unified-runtime-durable.mjs';

// Kernel additions for non-model jobs (S5-1). Each test names the gap of s5-0-nonmodel-baseline.md it closes.
const nonModel = { purpose: 'install', feature: 'marker', budget: null };
const finished = async (t, run) => {
  const f = await durableFixture(t, run), job = await f.port.submit('persist', {});
  return { f, job, end: await f.port.wait(job.jobId) };
};

test('G-3: a local child process is observed without claiming a request count', async t => {
  const { f, end } = await finished(t, async context => {
    const step = context.gateway.step('venv:1', nonModel);
    await step.run(() => step.observe({ boundary: 'local-process', kind: 'venv' }, async () => ({ value: 'created' })));
    return { refs: [] };
  });
  assert.equal(end.status, 'complete', end.error?.message);
  assert.deepEqual(end.calls[0].observation, { boundary: 'local-process', requestCount: null });
  assert.equal(end.calls[0].modelRequest, false);
  assert.deepEqual(end.usage, { tokens: null, tokenUsage: null, calls: 0 }, 'a process is not a model request and invents no usage');
  const stored = (await f.store.load()).contract;
  assert.deepEqual(stored.calls[0].observation, { boundary: 'local-process', requestCount: null }, 'the stored record validates and round-trips');
  const forged = structuredClone(stored); forged.calls[0].observation.requestCount = 1;
  assert.throws(() => validateRuntimeContract(forged), { code: 'invalid-call-observation' });
});

test('G-2/G-7: a non-model step carries no model policy and cannot start a model call', async t => {
  const refused = [];
  const { end } = await finished(t, async context => {
    const step = context.gateway.step('venv:1', nonModel);
    await step.run(() => step.observe({ boundary: 'local-process', kind: 'venv' }, async () => ({ value: 'created' })));
    await context.gateway.step('ask:1', nonModel).complete('system', 'prompt').catch(error => refused.push(error.code));
    for (const partial of [{ requestedEffort: 'default' }, { executionMode: 'direct' }]) {
      try { context.gateway.step('partial', { ...nonModel, ...partial }); } catch (error) { refused.push(error.code); }
    }
    return { refs: [] };
  });
  assert.equal(end.status, 'complete', end.error?.message);
  assert.deepEqual(refused, ['model-policy-required', 'invalid-gateway-policy', 'invalid-gateway-policy']);
  for (const field of ['requestedEffort', 'executionMode']) assert.equal(Object.hasOwn(end.calls[0], field), false, `${field} would be invented data on a process Call`);
  assert.equal(end.calls[0].purpose, 'install');
});

test('G-7: execution mode describes model calls only, so a process never makes a job "direct"', async t => {
  const observe = (context, meta) => { const step = context.gateway.step(`s:${meta.kind}`, nonModel); return step.run(() => step.observe(meta, async () => ({ value: 1 }))); };
  const onlyProcess = await finished(t, async context => { await observe(context, { boundary: 'local-process', kind: 'venv' }); return { refs: [] }; });
  assert.equal(onlyProcess.end.execution.mode, null);
  const mixed = await finished(t, async context => {
    await observe(context, { boundary: 'local-process', kind: 'venv' });
    await observe(context, { boundary: 'external-request', kind: 'ask', modelRequest: true, runner: 'subagent' });
    return { refs: [] };
  });
  assert.equal(mixed.end.execution.mode, 'subagent', 'the one model call decides; the process Call does not make it mixed');
});
