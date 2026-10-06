import test from 'node:test';
import assert from 'node:assert/strict';
import { startGeneration } from '../lib/contexts/generation/jobs/submit-generation.js';
import { libraryQueue } from '../lib/contexts/generation/jobs/library-queue.js';

// The entry that queues a prepared run: refusals say what happened in the learner's terms and nothing is registered when the runtime cannot take the run.
const queue = libraryQueue({ queues: new Map(), settled: new Map() });
const task = { kind: 'generation', args: {}, root: 'root', seed: { id: 'card' }, makeControl() {}, execute() {}, models: {} };

for (const [code, expected] of [['executor-unavailable', /background task service is not available/], ['scope-unloaded', /shutting down/]]) {
  test(`a runtime that refuses a run (${code}) is reported in words, with its code`, async () => {
    const jobs = { submit: async () => { throw Object.assign(new Error(code), { code }); } };
    await assert.rejects(startGeneration({ managed: true, jobs, queue, work: {} }, task), error => expected.test(error.message) && error.code === code);
  });
}

test('shared provider quota is refused before anything is submitted: its calls are not observed yet', async () => {
  let submitted = 0;
  const jobs = { submit: async () => { submitted++; } };
  await assert.rejects(startGeneration({ managed: true, sharedQuota: true, jobs, queue, work: {} }, task), { code: 'capability-unverified' });
  assert.equal(submitted, 0);
});

test('an error that is not a refusal passes through unchanged', async () => {
  const failure = new Error('disk full');
  await assert.rejects(startGeneration({ managed: true, jobs: { submit: async () => { throw failure; } }, queue, work: {} }, task), failure);
});

test('the library queue lets a waiting entry go when it is stopped, without blocking the ones behind it', async () => {
  const chain = libraryQueue({ queues: new Map(), settled: new Map() });
  const first = chain.enter('root', new AbortController().signal), controller = new AbortController();
  const stopped = chain.enter('root', controller.signal), third = chain.enter('root', new AbortController().signal);
  await first.admitted;
  controller.abort(new Error('stopped'));
  await assert.rejects(stopped.admitted, /stopped/);
  first.leave();
  await third.admitted;
  third.leave(); third.leave();
});
