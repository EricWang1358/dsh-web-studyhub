import test from 'node:test';
import assert from 'node:assert/strict';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';
import { validateRuntimeContract } from '../lib/jobs/contract.js';

// Synthetic proposed observations, not provider execution or implementation evidence.
const vector = boundary => {
  const job = structuredClone(goldenRuntimeContracts.running);
  job.calls = [ { ...job.calls[0], status: 'ok', purpose: 'proofread', feature: 'audio',
    requestedEffort: 'medium', appliedEffort: null, fallbackReason: null,
    executionMode: 'direct', budget: null, tokenUsage: null,
    observation: { boundary, requestCount: boundary === 'external-request' ? 1 : null } } ];
  return job;
};
test('gateway observations preserve Step identity and unknown host effort/usage', () => {
  for (const boundary of ['external-request', 'host-attempt']) {
    const expected = vector(boundary), actual = validateRuntimeContract(expected);
    assert.deepEqual(actual.calls, expected.calls);
    assert.equal(actual.calls[0].stepRunId, actual.runtime.steps[0].stepRunId);
    assert.equal(actual.calls[0].tokenUsage, null);
    assert.equal(actual.calls[0].appliedEffort, null);
  }
});
test('each observable retry has a distinct Call; replay preserves identity', () => {
  const job = vector('external-request'), first = job.calls[0];
  first.status = 'failed'; job.calls.push({ ...first, callId: 'second-wire-request', status: 'ok' });
  assert.equal(validateRuntimeContract(job).calls.length, 2);
  assert.deepEqual(validateRuntimeContract(structuredClone(job)).calls, job.calls);
  job.calls.push({ ...first });
  assert.throws(() => validateRuntimeContract(job), { code: 'invalid-contract-reference' });
});
test('host request count and foreign physical Step identity cannot be fabricated', () => {
  const job = vector('host-attempt'); job.calls[0].observation.requestCount = 1;
  assert.throws(() => validateRuntimeContract(job), { code: 'invalid-call-observation' });
  job.calls[0].observation.requestCount = null; job.calls[0].stepRunId = 'foreign-run';
  assert.throws(() => validateRuntimeContract(job), { code: 'invalid-contract-reference' });
});
