import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { KEY, batchLibrary, hostModel, letters, wav } from './helpers/audio-family.mjs';
import { settleJob } from './helpers/wait.mjs';

/* S2-0 characterization of the batch entry `audio.import { files }` and its retry (lib/contexts/audio/operations.js, lib/audio-batch.js) on the code as it is.
   Already covered elsewhere: order, frozen course, no partial sources, one slot shared with singles, cancel/resume (audio-batch), orphan results and manifest
   write faults (audio-batch), the control actions of a batch (job-control-audio), skip-number validation (wp6-preflight), preflight blocking (wp6-preflight). */

const untouched = async lib => [lib.calls, (await lib.service.call('snapshot')).jobs, (await lib.state()).inbox, await lib.folders(), lib.notices];

test('an unusable batch request is refused before any job record, manifest folder, model request or inbox letter, and releases its uploads', async t => {
  const lib = await batchLibrary(t);
  const empty = join(lib.dir, 'empty.wav'), upload = await lib.service.call('audio.upload.start', { name: 'U.wav', size: wav(1).length });
  await writeFile(empty, '');
  await lib.service.call('audio.upload.chunk', { uploadId: upload.uploadId, offset: 0, data: wav(1).toString('base64') });
  await lib.service.call('audio.upload.finish', { uploadId: upload.uploadId });
  const { a } = lib, big = 'x'.repeat(201);
  const bad = [
    [{ files: [{ path: a }, { path: a, uploadId: upload.uploadId }] }, /每段音频必须提供 path 或 uploadId，且只能给一个/],
    [{ files: [{ path: a }, {}] }, /每段音频必须提供 path 或 uploadId，且只能给一个/],
    [{ files: [{ path: a }, 'A.wav'] }, /每段音频必须提供 path 或 uploadId/],
    [{ files: [{ path: a }, { path: 'relative/B.wav' }] }, /音频文件路径必须是绝对路径/],
    [{ files: [{ path: a }, { path: join(lib.dir, 'notes.txt') }] }, /不支持的音频格式/],
    [{ files: [{ path: a }, { path: empty }] }, /音频文件是空的或不是文件/],
    [{ files: [{ path: a }, { path: join(lib.dir, 'missing.wav') }] }, /ENOENT/],
    [{ files: [{ uploadId: upload.uploadId }, { path: 'relative.wav' }] }, /音频文件路径必须是绝对路径/],
    [{ files: [{ path: a }], title: big }, /title 必须是不超过 200 字/],
    [{ files: [{ path: a }], terms: 5 }, /terms 必须是字符串或字符串数组/],
  ];
  for (const [args, message] of bad) await assert.rejects(lib.service.call('audio.import', args), message, JSON.stringify(args));
  assert.deepEqual(await untouched(lib), [[], [], [], [], []]);
  // The claimed upload went back to the learner: it can still be submitted.
  const retry = await settleJob(lib.service, (await lib.service.call('audio.import', { files: [{ uploadId: upload.uploadId }] })).jobId);
  assert.equal(retry.status, 'complete', retry.stage);
});

for (const [name, setup, message] of [['no transcription key', { keys: {} }, /转写/], ['paidOnly without a paid key', { keys: { freeKey: KEY } }, /付费/],
  ['the DSH text model chosen but not connected', { keys: { paidKey: KEY, textProvider: 'host' } }, /当前没有可用的对话模型/]])
  test(`a batch with ${name} is refused before any job record, manifest folder, model request or inbox letter`, async t => {
    const lib = await batchLibrary(t, { keys: setup.keys });
    await assert.rejects(lib.service.call('audio.import', { files: [{ path: lib.a }], ...(name.startsWith('paidOnly') ? { paidOnly: true } : {}) }), message);
    assert.deepEqual(await untouched(lib), [[], [], [], [], []]);
  });

test('one batch of [B, A]: per-file request order, one combined source id, usage on the job and contract, one letter and one notice', async t => {
  const lib = await batchLibrary(t);
  const started = await lib.service.call('audio.import', { files: [{ path: lib.b }, { path: lib.a }], title: 'Week 3', courses: ['Course A'] });
  assert.deepEqual(Object.keys(started).sort(), ['batchId', 'jobId', 'next', 'queuedBehind', 'status']);
  const done = await settleJob(lib.service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  for (const name of ['A', 'B']) assert.deepEqual(lib.calls.filter(call => call.endsWith(`:${name}`)).map(call => call.split(':')[0]), ['transcribe', 'proofread', 'translate', 'title']);
  assert.ok(lib.calls.indexOf('transcribe:A') > lib.calls.indexOf('transcribe:B'), 'transcriptions follow the submitted order');
  assert.equal(lib.calls.length, 8);
  assert.deepEqual(done.sourceIds, [`audio-batch-${started.batchId}`]);
  assert.deepEqual([done.id, done.batchId, done.filename, done.total, done.done], [started.jobId, started.batchId, 'Week 3', 2, 2]);
  assert.deepEqual(done.members.map(member => [member.filename, member.status]), [['B.wav', 'complete'], ['A.wav', 'complete']]);
  // The Gemini tally counts every request (transcription and text); the host tally and the daily ledger stay empty on this route.
  const sent = request => request.requests;
  assert.deepEqual([sent(done.usage.paid), sent(done.usageRun.paid), sent(done.usage.free)], [lib.calls.length, lib.calls.length, 0]);
  const view = (await lib.service.call('snapshot')).jobs.find(job => job.id === done.id);
  assert.deepEqual([view.contract.detail.usage.gemini, view.contract.detail.textProvider, view.contract.usage.tokens], [{ free: 0, paid: lib.calls.length }, 'gemini', null]);
  assert.equal(done.tokenUsage, undefined);
  assert.equal(await lib.ledger(), null);
  const state = await lib.state();
  assert.deepEqual(letters(state, done.id), ['audio-result'], 'a batch sends no per-stage letters');
  assert.deepEqual(state.inbox[0].sourceIds, done.sourceIds);
  assert.equal(lib.notices.length, 1);
  assert.match(lib.notices[0].summary, /^音频「Week 3」已转写成中英对照逐字稿$/);
  assert.deepEqual(state.sources.map(source => source.courses), [['Course A']]);
  assert.deepEqual((await lib.folders()), [started.batchId], 'the manifest folder is the only durable job record');
  const manifest = JSON.parse(await readFile(join(lib.root, 'audio-batches', started.batchId, 'manifest.json'), 'utf8'));
  assert.deepEqual([manifest.job.id, manifest.job.status, manifest.members.map(member => member.status)], [started.jobId, 'complete', ['complete', 'complete']]);
});

test('a batch retry with skip: the new attempt keeps the batch id, drops the failed file from the combined source and asks the model for nothing', async t => {
  let broken = true;
  const lib = await batchLibrary(t, { failTranslate: name => broken && name === 'B' });
  const first = await lib.service.call('audio.import', { files: [{ path: lib.a }, { path: lib.b }] });
  const failed = await settleJob(lib.service, first.jobId);
  assert.deepEqual([failed.status, failed.retryable, failed.members.map(member => member.status)], ['failed', true, ['complete', 'failed']]);
  assert.deepEqual(letters(await lib.state(), failed.id), ['audio-failed']);
  const before = lib.calls.length;
  for (const skip of [[0, 1], [5], 'x']) await assert.rejects(lib.service.call('audio.retry', { jobId: failed.id, skip }), /跳过的文件编号无效|没有可以导入的文件/);
  assert.deepEqual([(await lib.service.call('snapshot')).jobs.map(job => job.id), lib.calls.length], [[failed.id], before], 'a refused retry changes nothing');

  // job.control accepts the batch id as the public id; the reply names the failed attempt in attemptId and the new one in jobId.
  const retried = await lib.service.call('audio.retry', { jobId: failed.id, skip: [1] });
  assert.deepEqual([retried.batchId, retried.jobId === failed.id], [first.batchId, false]);
  const done = await settleJob(lib.service, retried.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual([done.batchId, done.members.map(member => member.status)], [first.batchId, ['complete', 'skipped']]);
  assert.deepEqual(lib.calls.slice(before), [], 'the finished member is reused and the skipped one is not asked');
  assert.deepEqual(done.sourceIds, [`audio-batch-${first.batchId}`]);
  const source = (await lib.state()).sources[0];
  assert.deepEqual([source.audio.batch.members.map(member => member.filename), source.text.includes('B.wav')], [['A.wav'], false]);
  assert.deepEqual(letters(await lib.state(), failed.id), [], 'the letter about the failure is withdrawn');
  assert.deepEqual(letters(await lib.state(), done.id), ['audio-result']);
  assert.equal((await lib.service.call('snapshot')).jobs.some(job => job.id === failed.id), false);
  await assert.rejects(lib.service.call('audio.retry', { jobId: done.id }), /这个任务不能重试/);
});

test('a batch on the DSH text model: Gemini only transcribes, the text requests are booked on each member and the daily ledger, never summed on the batch job', async t => {
  const log = [], lib = await batchLibrary(t, { keys: { paidKey: KEY, textProvider: 'host' }, complete: hostModel(log) });
  const started = await lib.service.call('audio.import', { files: [{ path: lib.b }, { path: lib.a }] });
  const done = await settleJob(lib.service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(lib.calls, ['transcribe:B', 'transcribe:A']);
  assert.deepEqual(log.sort(), ['proofread', 'proofread', 'title', 'title', 'translate', 'translate']);
  assert.deepEqual([done.usage.paid.requests, done.usageRun.paid.requests], [2, 2], 'the Gemini tally counts the transcriptions only');
  const member = { uncachedInputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 3 };
  assert.deepEqual(done.members.map(item => item.tokenUsage), [member, member]);
  assert.deepEqual(await lib.ledger(), { uncachedInputTokens: 600, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 6 });
  assert.equal(done.tokenUsage, undefined, 'no total on the batch job itself');
  const view = (await lib.service.call('snapshot')).jobs.find(job => job.id === done.id);
  assert.equal(view.contract.usage.tokens, null);
});
