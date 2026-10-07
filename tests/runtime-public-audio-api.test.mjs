/* S6-1: the audio context's own public API (audio.v1: jobs, job.wait, job.cancel; the chat tool `study_audio` calls it) is a published door that does not go through the 任务
   jobs context. A Job of the unified runtime (runtime.pilot.audioSubtitles here, the smallest audio kind) must answer to it the way an original job did: listed, waitable,
   and cancellable by either of its names. Before this step `job.cancel` only tried the original controller, which a Job does not have: it answered and stopped nothing. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostModel, library, subtitleText } from './helpers/audio-family.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { until } from './helpers/wait.mjs';

async function running(t, mode) {
  let entered; const reached = new Promise(resolve => { entered = resolve; });
  let aborted = false;
  const blocked = (_system, _prompt, { signal }) => { entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true })); };
  const { starts: _starts, ...managed } = managedRuntimeOptions({ complete: blocked, paths: ['audioSubtitles'] });
  const options = { settings: { textProvider: 'host' }, complete: blocked, ...(mode === 'runtime' ? managed : {}) };
  const lib = await library(t, options);
  // What the door is handed when the host calls it: the same services the library was opened with (its owner among them).
  const door = (operation, args) => lib.service.runtime.invoke('audio.v1', operation, args, mode === 'runtime' ? options : undefined);
  const started = await lib.service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText });
  await reached;
  return { lib, started, door, stopped: () => aborted };
}

for (const mode of ['legacy', 'runtime']) {
  test(`${mode}: audio.v1 lists a running audio job and job.cancel stops its request`, async t => {
    const { started, door, stopped } = await running(t, mode);
    assert.deepEqual((await door('jobs', {})).jobs.map(job => job.id), [started.jobId]);
    const reply = await door('job.cancel', { jobId: started.jobId });
    assert.deepEqual(reply.jobs.map(job => job.id), [started.jobId]);
    await until(() => stopped(), 'the stop to reach the model request');
    await until(async () => ['cancelled', 'failed'].includes((await door('job.wait', { jobId: started.jobId, timeoutSeconds: 1 })).status), 'the job to end');
  });
}

test('runtime: the contract\'s own jobId names the Job to job.wait and job.cancel too', async t => {
  const { lib, started, door, stopped } = await running(t, 'runtime');
  const [job] = [...lib.service.runtime.work.jobs.values()].filter(item => item.id === started.jobId);
  assert.notEqual(job.contract.jobId, job.id, 'the runtime\'s logical name is not the list id');
  assert.equal((await door('job.wait', { jobId: job.contract.jobId, timeoutSeconds: 1 })).id, job.id);
  await door('job.cancel', { jobId: job.contract.jobId });
  await until(() => stopped(), 'the stop to reach the model request');
});
