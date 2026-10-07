/* S6-1 gap A: a Job of the unified runtime has two names, its list id and the contract's own `jobId` (the logical name). `job.status`, `job.wait`, `job.control` and `job.output`
   always answered to both; `job.cancel`, `job.dismiss`, `job.archive`, `job.delete` and `job.message` answered only to the list id, so a caller that read `contract.jobId` (the chat
   agent does) got "not found". All of them resolve a name the same way now (jobs context `named`/`matching`). Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { library, subtitleText } from './helpers/audio-family.mjs';
import { withQualityStages } from './helpers/assessment.mjs';
import { privateRoot, gate } from './helpers/model-family-baseline.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { until } from './helpers/wait.mjs';

async function subtitleJob(t) {
  let entered; const reached = new Promise(resolve => { entered = resolve; });
  const held = gate();
  t.after(() => held.release());
  const blocked = async (_system, _prompt, { signal } = {}) => { entered(); await Promise.race([held.promise, new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))]); throw new Error('stopped'); };
  const { starts: _starts, ...managed } = managedRuntimeOptions({ complete: blocked, paths: ['audioSubtitles'] });
  const lib = await library(t, { settings: { textProvider: 'host' }, complete: blocked, ...managed });
  const started = await lib.service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText });
  await reached;
  const job = [...lib.service.runtime.work.jobs.values()].find(item => item.id === started.jobId);
  assert.notEqual(job.contract.jobId, job.id, 'the logical name is not the list id of a Job that names nothing itself');
  return { lib, job, logical: job.contract.jobId };
}
const ended = async (lib, id) => {
  const row = await until(async () => { const found = (await lib.service.call('snapshot')).jobs.find(item => item.id === id); return found && !['queued', 'running', 'cancelling'].includes(found.status) && found; }, 'the job to end');
  await lib.service.call('job.wait', { jobId: id, timeoutSeconds: 5 }); // the last bookkeeping (the letter, the notice) is written before the library goes
  return row;
};

test('job.cancel names the Job by its logical jobId as well as by its list id', async t => {
  const { lib, job, logical } = await subtitleJob(t);
  const reply = await lib.service.call('job.cancel', { jobId: logical });
  assert.deepEqual(reply.jobs.map(item => item.id), [job.id]);
  assert.equal((await ended(lib, job.id)).status, 'cancelled');
});

test('job.archive, job.dismiss and job.delete take the logical jobId of a finished Job', async t => {
  for (const [action, result] of [['job.archive', 'archived'], ['job.dismiss', 'dismissed'], ['job.delete', 'deleted']]) {
    const { lib, job, logical } = await subtitleJob(t);
    await lib.service.call('job.cancel', { jobId: job.id });
    await ended(lib, job.id);
    const reply = await lib.service.call(action, action === 'job.delete' ? { jobIds: [logical] } : { jobId: logical });
    assert.ok(reply[result].length === 1, `${action} by logical id: ${JSON.stringify(reply)}`);
    assert.deepEqual((await lib.service.call('snapshot')).jobs.filter(item => item.id === job.id), [], `${action} took the Job off the list`);
  }
});

test('an unknown name is still not found, by every door', async t => {
  const { lib } = await subtitleJob(t);
  for (const [action, args] of [['job.cancel', { jobId: 'nobody' }], ['job.dismiss', { jobId: 'nobody' }], ['job.archive', { jobId: 'nobody' }]])
    await assert.rejects(lib.service.call(action, args), /not found|找不到/i, action);
});

test('job.message names a running generation Job by its logical jobId', async t => {
  const source = { id: 's', title: 'Bridge', text: 'Bridge separates an abstraction from its implementation so the two can vary independently.' };
  const card = { id: 'q', kind: 'flashcard', topic: 'Bridge', objective: 'Identify independent variation', prompt: 'Why use Bridge?', answer: 'Separate independent dimensions.', hint: 'Think.',
    explanation: 'They vary independently.', misconception: 'A subclass for every combination.', citations: [{ sourceId: 's', quote: source.text }] };
  const held = gate();
  t.after(() => held.release());
  let started; const beginning = new Promise(resolve => { started = resolve; });
  const complete = withQualityStages(async (system, prompt) => {
    if (system.startsWith('You author')) { started(); await held.promise; return JSON.stringify({ id: 'd', title: 'Deck', cards: [structuredClone(card)] }); }
    return JSON.stringify({ issues: [], summary: 'Checked' });
  });
  const { starts: _starts, ...managed } = managedRuntimeOptions({ complete, paths: ['generation'] });
  const root = await privateRoot(t, 'job-logical-id-');
  const service = new StudyService(root, { complete, ...managed });
  t.after(() => service.dispose());
  await service.call('source.add', source);
  const run = await service.call('generate', { sourceIds: ['s'], count: 1, kind: 'flashcard' });
  await beginning;
  const job = [...service.runtime.work.jobs.values()].find(item => item.id === run.jobId);
  const reply = await service.call('job.message', { jobId: job.contract.jobId, message: 'Use concise questions' });
  assert.equal(reply.jobId, job.id);
  held.release();
  assert.ok(['complete', 'failed'].includes((await service.call('job.wait', { jobId: run.jobId })).status), 'the run ends; what the stand-in model made of it is not the point here');
});
