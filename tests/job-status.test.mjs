import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { importExample } from '../ui/json-prompts.js';

/* job.status: the read-only way for the chat agent to see a background job (a step of the generation path) without waiting for it. job.wait waits (up to a
   minute) and is discouraged for polling; this answers at once with the state, stage and result of one job, or lists the jobs of the library. */

async function running(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-job-status-'));
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reviewing = new Promise(resolve => { entered = resolve; });
  const runtime = createStudyRuntime(root, { complete: async () => { entered(); await gate; throw new Error('review unavailable'); } });
  t.after(async () => { release(); runtime.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const draft = await runtime.call('draft.import', { text: importExample('flashcard') });
  const job = await runtime.call('draft.publish.start', { id: draft.id, draftVersion: draft.draftVersion });
  await reviewing;
  return { runtime, job, release };
}

test('job.status answers at once with the state of a running job and never waits', async t => {
  const { runtime, job } = await running(t);
  const started = Date.now();
  const status = await runtime.call('job.status', { jobId: job.jobId });
  assert.ok(Date.now() - started < 1500, 'it does not wait for the job');
  assert.equal(status.id, job.jobId);
  assert.ok(['running', 'queued'].includes(status.status), status.status);
  assert.ok(status.stageCode, 'the stage word the panel uses');
  assert.equal(status.finished, false, 'a plain yes/no the agent can act on');
});

test('once the job ended, job.status says so, with the result the agent reports back', async t => {
  const { runtime, job, release } = await running(t);
  release();
  await runtime.call('job.wait', { jobId: job.jobId, timeoutSeconds: 5 });
  const status = await runtime.call('job.status', { jobId: job.jobId });
  assert.equal(status.finished, true);
  assert.ok(['complete', 'failed', 'partial'].includes(status.status));
  assert.ok(status.finishedAt);
});

test('without a jobId it lists the jobs of this library compactly; an unknown id is an error; nothing is changed', async t => {
  const { runtime, job } = await running(t);
  const before = JSON.stringify(await runtime.call('job.status', { jobId: job.jobId }));
  const list = await runtime.call('job.status', {});
  assert.ok(Array.isArray(list.jobs) && list.jobs.some(item => item.id === job.jobId));
  const entry = list.jobs.find(item => item.id === job.jobId);
  assert.deepEqual(Object.keys(entry).filter(key => ['id', 'status', 'finished'].includes(key)).sort(), ['finished', 'id', 'status']);
  assert.ok(!('members' in entry) && !('messages' in entry), 'compact: no per-member or message detail');
  await assert.rejects(runtime.call('job.status', { jobId: 'nope' }), /not found|Job/i);
  assert.equal(JSON.stringify(await runtime.call('job.status', { jobId: job.jobId })), before, 'reading twice changes nothing');
});

test('the assistant is told about it: the contract names job.status and keeps job.wait for one bounded wait', async () => {
  const { libraryContracts } = await import('../lib/study-contracts.js');
  assert.match(libraryContracts.generation, /job\.status/);
});
