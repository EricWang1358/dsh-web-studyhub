import test from 'node:test';
import assert from 'node:assert/strict';
import { hostModel, letters, library, subtitleText } from './helpers/audio-family.mjs';
import { AUDIO_SWITCHES } from './helpers/audio-switch.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { settleJob } from './helpers/wait.mjs';
import { taskKindOf } from '../ui/tasks/task-model.js';

// S2-4: a subtitle import as a job of the unified runtime, whatever the suite's own switch side is.
// The baseline suite (audio-family-baseline-subtitles) runs the same expectations on both sides; this file covers what only the runtime has.

const RUNTIME = complete => switchOptions('runtime', { complete, paths: [...AUDIO_SWITCHES] });
const rowOf = async (lib, id) => (await lib.service.call('snapshot')).jobs.find(job => job.id === id);

test('a subtitle import is a job of its own kind: honest capabilities, the audio family in the console, every request a call of the gateway', async t => {
  const log = [], complete = hostModel(log), lib = await library(t, { settings: { textProvider: 'host' }, complete, ...RUNTIME(complete) });
  const done = await settleJob(lib.service, (await lib.service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText })).jobId);
  assert.equal(done.status, 'complete', done.stage);
  const row = await rowOf(lib, done.id), { contract } = row;
  assert.deepEqual([contract.kind, row.type, taskKindOf(row), row.subtitle], ['audio-subtitles', 'audio-subtitles', 'audio', true]);
  assert.deepEqual(contract.capabilities, { cancel: true, pauseMode: 'unsupported', recoveryMode: 'none', retry: true, set: false, executionModes: ['direct', 'subagent'] });
  assert.deepEqual(contract.calls.map(call => [call.kind, call.status]), [['proofread', 'ok'], ['translate', 'ok'], ['title', 'ok']]);
  assert.deepEqual(done.parallel.text.limit, 3, 'the text pool is on the card like any audio job');
});

test('a failed import is mailed and announced as a subtitle import, and the retry withdraws the failure letter and is a text job again', async t => {
  const log = [], notices = [], complete = hostModel(log, { failOn: (kind, n) => kind === 'translate' && n === 1 });
  const lib = await library(t, { settings: { textProvider: 'host' }, complete, notify: notice => notices.push(notice), ...RUNTIME(complete) });
  const failed = await settleJob(lib.service, (await lib.service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText })).jobId);
  assert.equal(failed.status, 'failed');
  assert.match(notices[0].summary, /^字幕「pricing\.txt」导入未完成$/);
  assert.deepEqual(letters(await lib.state(), failed.id), ['audio-failed']);
  // audio.retry names a job by its card id or by the contract the console shows; both reach the same job.
  const contractId = (await rowOf(lib, failed.id)).contract.jobId;
  const retried = await lib.service.call('audio.retry', { jobId: contractId });
  const done = await settleJob(lib.service, retried.jobId);
  assert.deepEqual([done.status, done.subtitle, retried.jobId === failed.id], ['complete', true, false]);
  assert.deepEqual([letters(await lib.state(), failed.id), letters(await lib.state(), done.id)], [[], ['audio-result']]);
  assert.deepEqual(log, ['proofread', 'translate', 'translate', 'title'], 'the proofread checkpoint is reused');
});

test('with the switch off a subtitle import stays on the old path', async t => {
  const complete = hostModel([]), lib = await library(t, { settings: { textProvider: 'host' }, complete, ...switchOptions('runtime', { complete, paths: ['audioSingle'] }) });
  const done = await settleJob(lib.service, (await lib.service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText })).jobId);
  assert.equal((await rowOf(lib, done.id)).contract.contractVersion, 1);
});
