import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, REPORTED, geminiTextFake, hostModel, letters, library, seedReview } from './helpers/audio-family.mjs';
import { settleJob } from './helpers/wait.mjs';

/* S2-0 characterization of `audio.corrections.review` (lib/contexts/audio/operations.js, lib/audio-review.js) on the code as it is.
   Already covered elsewhere: cross-volume application and legacy membership (subtitle-review-flow), batches kept on failure/cancel (subtitle-review-flow), pure helpers (audio-review). */

const calls = n => ({ uncachedInputTokens: n * REPORTED.uncachedInputTokens, outputTokens: n * REPORTED.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, calls: n });
async function seeded(t, count, options = {}) {
  const log = [], notices = [];
  const lib = await library(t, { settings: { textProvider: 'host' }, complete: hostModel(log, options), notify: notice => notices.push(notice) });
  await seedReview(lib.service, count);
  return { ...lib, log, notices };
}
const unreviewed = async lib => (await lib.state()).sources[0].audio.corrections.skipped.filter(item => !item.review).length;

test('an unusable review request is refused before any job record, model request, inbox letter or ledger row', async t => {
  const lib = await seeded(t, 0);
  await seedReview(lib.service, 1, 'has-pending'); await seedReview(lib.service, 1, 'holed');
  await lib.service.store.update(state => {
    state.sources.push({ id: 'plain', title: 'plain', text: 'no audio record' }, { id: 'owner-less', title: 'x', text: 't', audio: { sourceIds: ['owner-less'] } });
    state.sources.find(item => item.id === 'holed').audio.sourceIds = ['holed', 'holed-p2'];
  });
  for (const [sourceId, message] of [[undefined, /没有找到这份逐字稿/], ['nope', /没有找到这份逐字稿/], ['plain', /没有找到这份逐字稿/],
    ['owner-less', /没有校对记录/], ['holed', /部分分卷已被删除/], ['talk-1', /没有待复核的存疑处/]])
    await assert.rejects(lib.service.call('audio.corrections.review', { sourceId }), message);
  const noModel = await lib.open({ complete: undefined });
  await assert.rejects(noModel.call('audio.corrections.review', { sourceId: 'has-pending' }), /当前没有可用的对话模型/);
  assert.deepEqual([lib.log, (await lib.service.call('snapshot')).jobs, (await lib.state()).inbox, await lib.ledger()], [[], [], [], null]);
});

test('sixteen unsure items: two requests of 15 and 1 in order, committed per batch, usage booked on task and ledger, one letter worded as a transcription', async t => {
  const lib = await seeded(t, 16);
  const started = await lib.service.call('audio.corrections.review', { sourceId: 'talk-1' });
  const done = await settleJob(lib.service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(lib.log, ['review', 'review']);
  assert.deepEqual([done.filename, done.type, done.sourceIds, done.done, done.total], ['复核 · talk-1 · 中英对照逐字稿', 'audio-import', ['talk-1'], 2, 2]);
  assert.deepEqual(done.review, { applied: 16, rejected: 0, unsure: 0 });
  assert.equal(done.stage, '复核完成：改进正稿 16 处 · 判定原文无误 0 处 · 仍拿不准 0 处');
  assert.deepEqual([done.tokenUsage, await lib.ledger()], [calls(2), calls(2)]);
  assert.deepEqual(done.tasks.map(task => task.stage), ['复核存疑处 1/2', '复核存疑处 2/2']);
  const view = (await lib.service.call('snapshot')).jobs.find(job => job.id === done.id);
  assert.deepEqual(view.contract.calls.map(call => call.stepKey), ['proofread:1', 'proofread:2'], 'a review request is booked under the proofread kind');
  assert.equal(view.contract.detail.review.applied, 16);
  // The source is edited in place in both stores; no new source id is created and the job is not a transcription.
  const state = await lib.state();
  for (const list of [state.sources, state.audioResults]) {
    assert.equal(list.length, 1);
    assert.equal(list[0].audio.corrections.appliedCount, 16);
    assert.match(list[0].text, /The term15 is here\./);
  }
  assert.deepEqual(letters(state, done.id), ['audio-result']);
  assert.deepEqual(state.inbox[0].sourceIds, ['talk-1']);
  assert.equal(lib.notices.length, 1);
  assert.match(lib.notices[0].summary, /^音频「复核 · talk-1 · 中英对照逐字稿」已转写成中英对照逐字稿$/);
  assert.equal(done.usage, undefined, 'no audio quota tally: a review makes no Gemini request');
});

test('a review that fails after its first batch keeps that batch, and its retry only asks for what is still pending', async t => {
  const lib = await seeded(t, 16, { failOn: (kind, n) => kind === 'review' && n === 2 });
  const failed = await settleJob(lib.service, (await lib.service.call('audio.corrections.review', { sourceId: 'talk-1' })).jobId);
  assert.equal(failed.status, 'failed');
  assert.deepEqual([lib.log, failed.done, failed.total, failed.retryable], [['review', 'review'], 1, 2, true]);
  assert.equal(await unreviewed(lib), 1);
  assert.deepEqual(letters(await lib.state(), failed.id), ['audio-failed']);
  assert.deepEqual(failed.review, { applied: 15, rejected: 0, unsure: 0 }, 'totals count what was committed');

  // The retained closure resumes from the persisted state: the new attempt counts only its own batch.
  const retried = await lib.service.call('job.control', { jobId: failed.id, action: 'retry' });
  assert.notEqual(retried.jobId, failed.id);
  const done = await settleJob(lib.service, retried.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual([lib.log.length, done.review, done.total], [3, { applied: 1, rejected: 0, unsure: 0 }, 1]);
  assert.equal(await unreviewed(lib), 0);
  assert.deepEqual(letters(await lib.state(), failed.id), []);
});

test('a review job is gone after a restart: the transcript itself is the checkpoint, and a new request only asks for what is still pending', async t => {
  const second = await seeded(t, 16, { failOn: (kind, n) => kind === 'review' && n === 2 });
  const broken = await settleJob(second.service, (await second.service.call('audio.corrections.review', { sourceId: 'talk-1' })).jobId);
  assert.equal(broken.status, 'failed');
  const restarted = await second.open({ complete: hostModel(second.log) });
  assert.deepEqual((await restarted.call('snapshot')).jobs, []);
  await assert.rejects(restarted.call('audio.retry', { jobId: broken.id }), /这个任务不能重试/);
  const again = await settleJob(restarted, (await restarted.call('audio.corrections.review', { sourceId: 'talk-1' })).jobId);
  assert.equal(again.status, 'complete', again.stage);
  assert.deepEqual([second.log.length, again.review.applied, again.total], [3, 1, 1]);
});

test('a review on the Gemini text route: one request, no usage on the job at all (the tally of its text model is dropped), no daily-ledger row', async t => {
  const log = [], lib = await library(t, { fetch: geminiTextFake(log), settings: { paidKey: KEY, textProvider: 'gemini' } });
  await seedReview(lib.service, 2);
  const done = await settleJob(lib.service, (await lib.service.call('audio.corrections.review', { sourceId: 'talk-1' })).jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual([log, done.review, done.usage, done.usageRun, done.tokenUsage, done.textProvider], [['review'], { applied: 2, rejected: 0, unsure: 0 }, undefined, undefined, undefined, undefined]);
  assert.equal(await lib.ledger(), null);
});
