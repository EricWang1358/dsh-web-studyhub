import test from 'node:test';
import assert from 'node:assert/strict';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';
import { validateRuntimeContract } from '../lib/jobs/contract.js';

// Synthetic durable premises only; not a store implementation or crash test.
test('durable interruption uses explicit executor-loss evidence without inventing observations', () => {
  const job = structuredClone(goldenRuntimeContracts.running);
  job.status = 'interrupted'; job.runtime.activeAttemptId = null;
  Object.assign(job.runtime.attempts[0], { status: 'interrupted', endReason: 'executor-lost',
    executor: { service: 'dsh-jobs', handleId: 'synthetic-native-1', ownerAgentId: 'synthetic-real-owner' } });
  job.runtime.steps[0].status = 'interrupted'; job.calls[0].status = 'failed';
  job.actions.retry = { available: true };
  const restored = validateRuntimeContract(JSON.parse(JSON.stringify(job)));
  assert.equal(restored.runtime.attempts[0].endReason, 'executor-lost');
  assert.equal(restored.calls[0].observation.requestCount, null);
  assert.equal(restored.calls[0].tokens, null);
  assert.equal(restored.runtime.legacyId, job.runtime.legacyId);
});
test('request intents stay outside public Calls and checkpoint resume retains physical history', () => {
  const contract = structuredClone(goldenRuntimeContracts.paused);
  const manifest = { kind: 'single', id: 'synthetic-single', runtimeJob: {
    schemaVersion: 1, revision: 3, contract, inputRef: { id: 'synthetic-single', hash: 'synthetic-hash', size: 42 },
    checkpoint: { version: 1, ref: 'synthetic-checkpoint-1', digest: 'synthetic-digest', stepKey: 'proofread:1' },
    requestIntents: [], commits: [], deliveries: [], executorWitness: null,
  } };
  const read = validateRuntimeContract(JSON.parse(JSON.stringify(manifest)).runtimeJob.contract);
  assert.equal(read.calls.length, 0);
  assert.equal(read.runtime.attempts.length, 1);
  assert.equal(read.runtime.attempts[0].endReason, 'checkpoint-pause');
  assert.equal(read.runtime.activeAttemptId, null);
  assert.equal(read.actions.resume.available, true);
  assert.equal(read.runtime.legacyId, 'legacy-facade-1');
});
test('executor-lost cannot disguise an active physical Attempt as recovered', () => {
  const job = structuredClone(goldenRuntimeContracts.running);
  job.runtime.attempts[0].endReason = 'executor-lost';
  assert.throws(() => validateRuntimeContract(job), { code: 'invalid-contract-reference' });
});
