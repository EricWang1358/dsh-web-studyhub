import test from 'node:test';
import assert from 'node:assert/strict';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';
import { validateRuntimeContract } from '../lib/jobs/contract.js';

// Published shape fixtures only. Actual pilot routing and controls come later.
test('v2 audio Call keeps window labels and unknown native request counts', () => {
  const job = structuredClone(goldenRuntimeContracts.running);
  Object.assign(job.calls[0], { stage: '校对 2/4', part: 2, parts: 4, file: 'lecture.wav', slot: 1 });
  const read = validateRuntimeContract(job);
  assert.equal(read.calls[0].part, 2);
  assert.equal(read.calls[0].parts, 4);
  assert.equal(read.calls[0].file, 'lecture.wav');
  assert.equal(read.calls[0].observation.requestCount, null);
  assert.equal(read.calls[0].tokens, null);
});
test('saved audio work is an explicitly local skipped observation with no model charge', () => {
  const job = structuredClone(goldenRuntimeContracts.running);
  Object.assign(job.calls[0], { runner: 'saved', status: 'skipped', reason: 'same-audio-and-settings',
    modelRequest: false, observation: { boundary: 'legacy', requestCount: null } });
  const read = validateRuntimeContract(job);
  assert.equal(read.calls[0].observation.requestCount, null);
  assert.equal(read.calls[0].status, 'skipped');
  assert.equal(read.calls[0].modelRequest, false);
});
test('a checkpoint-paused public view exposes resume without an active physical Attempt', () => {
  const job = structuredClone(goldenRuntimeContracts.paused);
  job.detail = { files: [{ filename: 'lecture.wav' }], warnings: [], legacy: { filename: 'lecture.wav', phase: 'proofread' } };
  const read = validateRuntimeContract(JSON.parse(JSON.stringify(job)));
  assert.equal(read.runtime.activeAttemptId, null);
  assert.equal(read.actions.resume.available, true);
  assert.equal(read.runtime.attempts[0].endReason, 'checkpoint-pause');
  assert.equal(read.detail.files[0].filename, 'lecture.wav');
});
