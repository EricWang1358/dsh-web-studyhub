import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, batchLibrary } from './helpers/audio-family.mjs';
import { until } from './helpers/wait.mjs';

/* A job is named by the id of its card, or by the id its contract carries (what survives a retry: the id of a single import or of a batch). The 任务 console and the tools
   take either; job.status and job.wait must too, for the jobs of the original path as well as the runtime's (S6-5, gap A). */

for (const shape of ['single', 'batch']) test(`${shape}: job.status and job.wait take the card id and the contract id of a running import of the original path`, async t => {
  const lib = await batchLibrary(t, { keys: { paidKey: KEY }, hold: true });
  const started = await lib.service.call('audio.import', shape === 'batch' ? { files: [{ path: lib.a }, { path: lib.b }], title: 'Week 3' } : { path: lib.a });
  await until(() => lib.held.size > 0, 'the transcription to start');
  const row = (await lib.service.call('snapshot')).jobs.find(job => job.id === started.jobId), contractId = row.contract.jobId;
  assert.notEqual(contractId, row.id, 'the two names differ for a single import and for a batch of the original path');
  for (const id of [row.id, contractId]) {
    const status = await lib.service.call('job.status', { jobId: id }), waited = await lib.service.call('job.wait', { jobId: id, timeoutSeconds: 1 });
    assert.deepEqual([status.id, status.finished, ['queued', 'running'].includes(waited.status)], [row.id, false, true], `named by ${id === row.id ? 'the card' : 'the contract'} id`);
  }
  await lib.service.call('job.control', { jobId: row.id, action: 'cancel' });
  await lib.service.call('job.wait', { jobId: contractId, timeoutSeconds: 30 });
});
