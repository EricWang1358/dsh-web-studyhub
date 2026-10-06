import test from 'node:test';
import assert from 'node:assert/strict';
import { hostModel, library, seedReview } from './helpers/audio-family.mjs';
import { AUDIO_SWITCHES } from './helpers/audio-switch.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { settleJob, until } from './helpers/wait.mjs';
import { taskKindOf } from '../ui/tasks/task-model.js';

// S2-5: the review of a transcript's unsure fixes as a job of the unified runtime, whatever the suite's own switch side is.
// audio-family-baseline-review runs the same expectations on both sides; this file covers what only the runtime has.

test('a review is a job of its own kind with honest capabilities; the same transcript is not reviewed twice at once, a stop keeps the finished batch', async t => {
  let held; const arrived = new Promise(resolve => { held = resolve; }), seen = [];
  const answer = hostModel([]), complete = (system, prompt, options) => {
    seen.push(1);
    if (seen.length < 2) return answer(system, prompt, options);
    held();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  };
  const lib = await library(t, { settings: { textProvider: 'host' }, complete, ...switchOptions('runtime', { complete, paths: [...AUDIO_SWITCHES] }) });
  await seedReview(lib.service, 16);
  const started = await lib.service.call('audio.corrections.review', { sourceId: 'talk-1' });
  await arrived;
  const row = (await lib.service.call('snapshot')).jobs.find(job => job.id === started.jobId);
  assert.deepEqual([row.contract.kind, taskKindOf(row), row.contract.capabilities], ['audio-review', 'audio',
    { cancel: true, pauseMode: 'unsupported', recoveryMode: 'none', retry: true, set: false, executionModes: ['direct', 'subagent'] }]);
  await assert.rejects(lib.service.call('audio.corrections.review', { sourceId: 'talk-1' }), /这份逐字稿正在复核/);
  await lib.service.call('job.cancel', { jobId: started.jobId });
  const stopped = await settleJob(lib.service, started.jobId);
  assert.deepEqual([stopped.status, stopped.done], ['cancelled', 1]);
  await until(async () => (await lib.state()).sources[0].audio.corrections.skipped.filter(item => !item.review).length === 1, 'the first batch to stay committed');
});
