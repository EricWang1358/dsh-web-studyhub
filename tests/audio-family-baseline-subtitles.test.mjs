import test from 'node:test';
import assert from 'node:assert/strict';
import { admitSlot } from '../lib/jobs/scheduler.js';
import { KEY, REPORTED, geminiTextFake, hostModel, letters, library, subtitleText } from './helpers/audio-family.mjs';
import { settleJob, until } from './helpers/wait.mjs';
import { SWITCH_MODE } from './helpers/audio-switch.mjs';

// On the runtime (S2-4) a subtitle import is its own kind of job and the defects this suite records on the old path are gone: D-1 (a retry
// keeps the subtitle flag and never waits for a transcription slot), D-2 (its own wording), D-6/D-7 (usage and provider on the card), D-8 (a file
// is refused only when the same cues are already being imported).
const RUNTIME = SWITCH_MODE === 'runtime';

/* S2-0 characterization of `audio.subtitles.import` (lib/contexts/audio/operations.js, lib/subtitle-job.js) on the code as it is.
   Already covered elsewhere: the happy path with corrections and review (subtitle-review-flow), cue parsing (subtitles). */

const SOURCE_ID = 'subtitle-2d6df86b';
const calls = (n, sum = REPORTED) => ({ uncachedInputTokens: n * sum.uncachedInputTokens, outputTokens: n * sum.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, calls: n });
const withoutCount = ({ calls: _count, ...buckets }) => buckets;
const jobOf = async (service, id) => (await service.call('snapshot')).jobs.find(job => job.id === id);

test('invalid subtitle input is refused before any job record, model request, inbox letter or ledger row', async t => {
  const log = [];
  const lib = await library(t, { settings: { textProvider: 'host' }, complete: hostModel(log) });
  const bad = [
    [{ filename: 'notes.docx', text: subtitleText }, /不支持的字幕格式/],
    [{ text: subtitleText }, /不支持的字幕格式/],
    [{ filename: 'a.srt', text: 42 }, /text 必须是字幕文件的文字内容/],
    [{ filename: 'a.txt', text: 'no timestamps here' }, /没有找到带时间戳的字幕/],
    [{ filename: 'a.txt', text: subtitleText, title: 'x'.repeat(201) }, /title 必须是不超过 200 字/],
    [{ filename: `${'n'.repeat(300)}.txt`, text: subtitleText }, /filename 必须是不超过 300 字/],
    [{ filename: 'a.txt', text: subtitleText, terms: 5 }, /terms 必须是字符串或字符串数组/],
  ];
  for (const [args, message] of bad) await assert.rejects(lib.service.call('audio.subtitles.import', args), message);
  const noHost = await lib.open({ complete: undefined });
  await assert.rejects(noHost.call('audio.subtitles.import', { filename: 'a.txt', text: subtitleText }), /当前没有可用的对话模型/);
  await noHost.call('audio.settings.set', { textProvider: 'gemini' });
  await assert.rejects(noHost.call('audio.subtitles.import', { filename: 'a.txt', text: subtitleText }), /还没有配置 Gemini API 密钥/);
  assert.deepEqual([log, (await lib.service.call('snapshot')).jobs, (await lib.state()).inbox, await lib.ledger()], [[], [], [], null]);
});

test('one subtitle file: three requests in order, one source id, usage on the task, the daily ledger and nothing in the audio tally, one letter', async t => {
  const log = [], notices = [];
  const lib = await library(t, { settings: { textProvider: 'host' }, complete: hostModel(log), notify: notice => notices.push(notice) });
  const started = await lib.service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText, title: '订阅涨价', course: 'Pricing' });
  assert.deepEqual(Object.keys(started).sort(), ['jobId', 'next', 'queuedBehind', 'status']);
  const done = await settleJob(lib.service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(log, ['proofread', 'translate', 'title']);
  assert.deepEqual(done.sourceIds, [SOURCE_ID]);
  assert.deepEqual([done.type, done.filename, done.subtitle, done.titleEn], [RUNTIME ? 'audio-subtitles' : 'audio-import', 'pricing.txt', true, 'Coding Plans Get Pricier']);
  // Three booking points: the task's own tally, the daily ledger and (for Gemini requests only) the audio quota tally.
  if (!RUNTIME) assert.deepEqual(done.tokenUsage, calls(3));
  assert.deepEqual(await lib.ledger(), calls(3));
  const view = await jobOf(lib.service, done.id);
  // The runtime's tally of model calls does not repeat their count inside the token buckets.
  assert.deepEqual(view.contract.usage, { tokens: 330, tokenUsage: RUNTIME ? withoutCount(calls(3)) : calls(3), calls: 3 });
  assert.deepEqual(view.contract.calls.map(call => call.stepKey), ['proofread:1', 'translate:1', RUNTIME ? 'title:0' : 'title']);
  assert.equal(view.usage.free.requests + view.usage.paid.requests, 0, 'a host text model makes no Gemini request');
  assert.equal(view.textProvider, RUNTIME ? 'host' : undefined, 'the old path never records the provider of a subtitle job (D-7)');
  assert.equal(view.contract.detail.textProvider, RUNTIME ? 'host' : null);
  // Notification: one inbox letter and one session notice, worded as an audio transcription.
  const state = await lib.state();
  assert.deepEqual(letters(state, done.id), ['audio-result']);
  assert.deepEqual(state.inbox[0].sourceIds, [SOURCE_ID]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].wakeup, false);
  assert.match(notices[0].summary, RUNTIME ? /^字幕「pricing\.txt」已校对并译成中英对照逐字稿$/ : /^音频「pricing\.txt」已转写成中英对照逐字稿$/);
  const source = state.sources.find(item => item.id === SOURCE_ID);
  for (const record of [source, state.audioResults.find(item => item.id === SOURCE_ID)]) {
    assert.equal(record.audio.textProvider, 'host');
    assert.equal(record.audio.textModel, null, 'the unused Gemini setting is not the host model that produced this source');
  }
  assert.deepEqual([source.courses, source.audio.subtitle, source.audio.sourceIds, source.title], [['Pricing'], true, [SOURCE_ID], '订阅涨价 · 中英对照逐字稿']);

  // The same text again: the saved source is found by content and settings, no request, no booking, a second letter for the new job.
  const again = await settleJob(lib.service, (await lib.service.call('audio.subtitles.import', { filename: 'copy-of-pricing.txt', text: subtitleText, title: '订阅涨价' })).jobId);
  assert.deepEqual([again.status, again.reused, again.sourceIds, log.length], ['complete', true, [SOURCE_ID], 3]);
  assert.deepEqual(await lib.ledger(), calls(3));
  assert.deepEqual(letters(await lib.state(), again.id), ['audio-result']);
  assert.equal((await lib.state()).sources.length, 1);
});

test('a subtitle file on the Gemini text route: the same three requests are counted in the job\'s audio tally, not as tokens, and not in the daily ledger', async t => {
  const log = [], lib = await library(t, { fetch: geminiTextFake(log), settings: { paidKey: KEY, textProvider: 'gemini' } });
  const done = await settleJob(lib.service, (await lib.service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText })).jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(log, ['proofread', 'translate', 'title']);
  assert.deepEqual([done.usage.paid.requests, done.usage.free.requests, done.usageRun?.paid.requests, done.tokenUsage, done.textProvider], RUNTIME ? [3, 0, 3, undefined, 'gemini'] : [3, 0, undefined, undefined, undefined]);
  assert.match(done.sourceIds[0], /^subtitle-[0-9a-f]{8}$/);
  assert.equal(await lib.ledger(), null);
  const source = (await lib.state()).sources.find(item => item.id === done.sourceIds[0]);
  const settings = await lib.service.call('audio.settings.get');
  assert.equal(source.audio.textModel, settings.textModel, 'the configured Gemini model remains recorded on the Gemini route');
});

test('a failed subtitle job retries from its checkpoints through the retained closure, which loses the subtitle flag and the gate bypass', async t => {
  const log = [], gate = { limit: 1, active: new Set(), waiting: [] };
  const lib = await library(t, { settings: { textProvider: 'host' }, complete: hostModel(log, { failOn: (kind, n) => kind === 'translate' && n === 1 }), audioGate: gate });
  const failed = await settleJob(lib.service, (await lib.service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText })).jobId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.retryable, true);
  assert.deepEqual(log, ['proofread', 'translate']);
  assert.deepEqual(letters(await lib.state(), failed.id), ['audio-failed']);
  assert.equal((await jobOf(lib.service, failed.id)).contract.actions.retry.available, true);

  if (RUNTIME) {
    // D-1 fixed: the retry is a text-only job again, so it neither waits for the transcription slot nor loses its subtitle flag.
    const retried = await lib.service.call('job.control', { jobId: failed.id, action: 'retry' });
    assert.notEqual(retried.attemptId, failed.id, 'a retry is a new attempt with a new job id');
    const done = await settleJob(lib.service, retried.attemptId);
    assert.deepEqual([done.status, done.subtitle, done.sourceIds], ['complete', true, [SOURCE_ID]]);
    assert.deepEqual(log, ['proofread', 'translate', 'translate', 'title'], 'the proofread checkpoint is reused');
    assert.deepEqual([letters(await lib.state(), failed.id), letters(await lib.state(), done.id)], [[], ['audio-result']]);
    return;
  }
  // Hold the host's transcription slot: a subtitle job is text-only and starts at once, but its RETRY waits behind the audio gate.
  let free; const held = admitSlot(gate, 'other-recording', new AbortController().signal, release => new Promise(resolve => { free = () => { release(); resolve(); }; }));
  await until(() => gate.active.has('other-recording'));
  const retried = await lib.service.call('job.control', { jobId: failed.id, action: 'retry' });
  // job.control names the new attempt in both `attemptId` and `jobId` (S2-1 fixed D-3, which named the failed one).
  assert.equal(retried.attemptId, retried.jobId);
  assert.notEqual(retried.jobId, failed.id, 'a retry is a new attempt with a new job id');
  assert.equal((await lib.service.call('snapshot')).jobs.some(job => job.id === failed.id), false, 'the failed attempt leaves the list');
  const queued = await jobOf(lib.service, retried.jobId);
  assert.deepEqual([queued.status, queued.subtitle], ['queued', undefined]);
  assert.deepEqual(log, ['proofread', 'translate']);
  free(); await held;
  const done = await settleJob(lib.service, retried.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(log, ['proofread', 'translate', 'translate', 'title'], 'the proofread checkpoint is reused');
  assert.deepEqual(done.sourceIds, [SOURCE_ID]);
  assert.equal(done.subtitle, undefined);
  assert.deepEqual(letters(await lib.state(), failed.id), [], 'the failure letter is withdrawn by the retry');
  assert.deepEqual(letters(await lib.state(), done.id), ['audio-result']);
});

test('a subtitle job cannot be recovered after a restart: no card, no retry, only its inbox letter and saved checkpoints remain', async t => {
  const log2 = [];
  const second = await library(t, { settings: { textProvider: 'host' }, complete: hostModel(log2, { failOn: (kind, n) => kind === 'translate' && n === 1 }) });
  const broken = await settleJob(second.service, (await second.service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText })).jobId);
  assert.equal(broken.status, 'failed');
  const restarted = await second.open();
  assert.deepEqual((await restarted.call('snapshot')).jobs, []);
  await assert.rejects(restarted.call('audio.retry', { jobId: broken.id }), /这个任务不能重试/);
  await assert.rejects(restarted.call('job.control', { jobId: broken.id, action: 'retry' }), /Study job not found/);
  assert.deepEqual(letters(await second.state(), broken.id), ['audio-failed'], 'only the inbox letter outlives the process');
  const again = await settleJob(restarted, (await restarted.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText })).jobId);
  assert.equal(again.status, 'complete', again.stage);
  assert.deepEqual(log2, ['proofread', 'translate', 'translate', 'title'], 'resubmitting the same text reuses the saved proofreading');
});

test('cancelling a running subtitle job stops its request, keeps it retryable and files the notice under the failure kinds', async t => {
  let entered; const reached = new Promise(resolve => { entered = resolve; });
  const notices = [], blocked = (_system, _prompt, { signal }) => { entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const lib = await library(t, { settings: { textProvider: 'host' }, complete: blocked, notify: notice => notices.push(notice) });
  const started = await lib.service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText });
  await reached;
  // The contract of every audio-import kind offers pause and set, but a text-only job registers no control: they read "no control yet".
  const running = (await jobOf(lib.service, started.jobId)).contract.actions;
  assert.deepEqual([running.cancel.available, running.pause.reason?.code, running.set.reason?.code, running.retry.reason?.code],
    RUNTIME ? [true, 'capability-unsupported', 'capability-unsupported', 'not-ended'] : [true, 'no-control-yet', 'no-control-yet', 'not-ended']);
  const another = subtitleText.replace('朋友们唉', '各位同学');
  let other;
  if (RUNTIME) {
    // D-8 fixed: the same cues are refused as a subtitle import; a different lecture under the same file name is not.
    await assert.rejects(lib.service.call('audio.subtitles.import', { filename: 'copy.txt', text: subtitleText }), /这份字幕已经在处理/);
    other = await lib.service.call('audio.subtitles.import', { filename: 'pricing.txt', text: another });
    assert.ok(['queued', 'running'].includes(other.status));
  } else {
    // The duplicate guard of audio jobs is keyed by file name only: a different lecture under the same subtitle file name is refused as "this audio".
    await assert.rejects(lib.service.call('audio.subtitles.import', { filename: 'pricing.txt', text: another }), /这个音频已经在处理/);
  }
  const reply = await lib.service.call('job.cancel', { jobId: started.jobId });
  assert.equal(reply.jobs[0].status, 'cancelling');
  const done = await settleJob(lib.service, started.jobId);
  assert.deepEqual([done.status, done.retryable, done.sourceIds, done.stage], ['cancelled', true, RUNTIME ? [] : undefined, '已取消；已完成的部分会保留，再来一次会接着做']);
  assert.deepEqual(letters(await lib.state(), done.id), ['audio-failed'], 'a cancelled import is mailed as a failure');
  assert.match(notices[0].summary, RUNTIME ? /^字幕「pricing\.txt」导入已取消$/ : /^音频「pricing\.txt」导入已取消$/);
  if (other) { await lib.service.call('job.cancel', { all: true }); await settleJob(lib.service, other.jobId); }
  assert.deepEqual([(await lib.state()).sources, await lib.ledger()], [[], null]);
});
