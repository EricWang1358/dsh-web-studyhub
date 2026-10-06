import test from 'node:test';
import assert from 'node:assert/strict';
import { admitSlot } from '../lib/jobs/scheduler.js';
import { writeSaved } from '../lib/live.js';
import { reportUsage } from '../lib/usage-scope.js';
import { REPORTED, hostModel, letters, library } from './helpers/audio-family.mjs';
import { settleJob, until } from './helpers/wait.mjs';
import { SWITCH_MODE } from './helpers/audio-switch.mjs';

// On the runtime (S2-5) the correction of a class is one job of the console (D-12); the other entries stay as they were until S2-6.
const RUNTIME = SWITCH_MODE === 'runtime';

/* S2-0 characterization of the live-class entries that are not live.start/stop themselves: live.save (quick and proofread), live.correct and
   live.correct.background (lib/contexts/audio/operations.js, lib/live-job.js, lib/live-correction.js). Covered elsewhere: the quick/proofread documents and
   course handling (live.test), batch coverage of the correction window (live-correction). */

const ID = 'saved-class-0001';
const SENTENCES = ['Transactions preserve consistency across related database changes.', 'Partitioning splits one big table into smaller physical pieces by a chosen key.'];
const calls = n => ({ uncachedInputTokens: n * REPORTED.uncachedInputTokens, outputTokens: n * REPORTED.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, calls: n });
async function savedClass(t, { sentences = SENTENCES, ...options } = {}) {
  const log = [], notices = [];
  const lib = await library(t, { settings: { textProvider: 'host' }, complete: hostModel(log, options.model), notify: notice => notices.push(notice), ...options.library });
  await writeSaved(lib.root, { id: ID, title: 'Databases week 5', course: 'Databases', vocabulary: ['partition'],
    segments: sentences.map((en, index) => ({ id: index + 1, t: index * 5000, en, zh: `译：${en}`, zhState: 'done' })) });
  return { ...lib, log, notices };
}

test('a live class that cannot be saved is refused before any job record, model request, inbox letter or ledger row', async t => {
  const empty = await savedClass(t, { sentences: [] });
  await assert.rejects(empty.service.call('live.save', { id: ID }), /这场实录没有内容/);
  await assert.rejects(empty.service.call('live.save', { id: 'unknown-class' }), /没有找到这场实录/);
  await assert.rejects(empty.service.call('live.save', { id: ID, proofread: true }), /这场实录没有内容/);
  await writeSaved(empty.root, { id: ID, title: 'Databases week 5', segments: [{ id: 1, t: 0, en: SENTENCES[0], zh: '译', zhState: 'done' }] });
  empty.service.runtime.liveSessions.unregister(empty.root, ID);
  const noModel = await empty.open({ complete: undefined });
  await assert.rejects(noModel.call('live.save', { id: ID, proofread: true }), /当前没有可用的对话模型/);
  await noModel.call('audio.settings.set', { textProvider: 'gemini' });
  await assert.rejects(noModel.call('live.save', { id: ID, proofread: true }), /还没有配置 Gemini API 密钥/);
  assert.deepEqual([empty.log, (await noModel.call('snapshot')).jobs, (await empty.state()).inbox, await empty.ledger()], [[], [], [], null]);
});

test('quick save is synchronous: no job, no model request, no letter, no notice; the same class saves to the same ids', async t => {
  const lib = await savedClass(t);
  const first = await lib.service.call('live.save', { id: ID });
  assert.deepEqual([first.proofread, first.noteSourceId, first.sourceIds.length], [false, null, 1]);
  assert.match(first.sourceIds[0], /^live-saved-cl-[0-9a-f]{8}$/);
  assert.deepEqual([(await lib.service.call('snapshot')).jobs, lib.log, lib.notices, (await lib.state()).inbox, await lib.ledger()], [[], [], [], [], null]);
  assert.deepEqual((await lib.service.call('live.save', { id: ID })).sourceIds, first.sourceIds);
  const source = (await lib.state()).sources.find(item => item.id === first.sourceIds[0]);
  assert.deepEqual([source.audio.live, source.audio.proofread, source.courses, source.audio.sessionId], [true, false, ['Databases'], ID]);
});

test('proofread save is an audio-import job that waits on the transcription gate, books the daily ledger but not its own task usage, and reuses its source', async t => {
  const gate = { limit: 1, active: new Set(), waiting: [] };
  const lib = await savedClass(t, { library: { audioGate: gate } });
  let free; const held = admitSlot(gate, 'other-recording', new AbortController().signal, release => new Promise(resolve => { free = () => { release(); resolve(); }; }));
  await until(() => gate.active.has('other-recording'));
  const started = await lib.service.call('live.save', { id: ID, proofread: true });
  assert.deepEqual([started.status, started.queuedBehind], ['queued', 1], 'a text-only proofread still queues behind a transcription (unlike subtitles)');
  assert.deepEqual(lib.log, []);
  free(); await held;
  const done = await settleJob(lib.service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual(lib.log, ['proofread', 'translate', 'title']);
  assert.deepEqual([done.type, done.filename, done.titleEn, done.sourceIds.length], ['audio-import', 'Databases week 5', 'Coding Plans Get Pricier', 1]);
  assert.match(done.sourceIds[0], /^live-saved-cl-[0-9a-f]{8}$/);
  // Unlike audio, subtitle and review jobs, nothing wraps the host call in withJobUsage: the ledger has the tokens, the task shows none.
  assert.deepEqual(await lib.ledger(), calls(3));
  assert.equal(done.tokenUsage, undefined);
  const view = (await lib.service.call('snapshot')).jobs.find(job => job.id === done.id);
  assert.deepEqual([view.contract.usage.tokens, view.contract.usage.tokenUsage, view.contract.usage.calls], [null, null, 3], 'unobserved usage is null, not zero tokens');
  assert.deepEqual(view.contract.calls.map(call => [call.stepKey, call.tokens]), [['proofread', null], ['translate', null], ['title', null]], 'the calls are listed, their tokens are not observed');
  assert.deepEqual(letters(await lib.state(), done.id), ['audio-result']);
  assert.match(lib.notices[0].summary, /^音频「Databases week 5」已转写成中英对照逐字稿$/);
  const again = await settleJob(lib.service, (await lib.service.call('live.save', { id: ID, proofread: true })).jobId);
  assert.deepEqual([again.reused, again.sourceIds, lib.log.length], [true, done.sourceIds, 3]);
});

test('a failed proofread save is not recoverable after a restart; saving the class again reuses its checkpoints', async t => {
  const lib = await savedClass(t, { model: { failOn: (kind, n) => kind === 'translate' && n === 1 } });
  const failed = await settleJob(lib.service, (await lib.service.call('live.save', { id: ID, proofread: true })).jobId);
  assert.deepEqual([failed.status, failed.retryable, lib.log], ['failed', true, ['proofread', 'translate']]);
  assert.deepEqual(letters(await lib.state(), failed.id), ['audio-failed']);
  lib.service.runtime.liveSessions.unregister(lib.root, ID);
  const restarted = await lib.open();
  assert.deepEqual((await restarted.call('snapshot')).jobs, []);
  await assert.rejects(restarted.call('audio.retry', { jobId: failed.id }), /这个任务不能重试/);
  const again = await settleJob(restarted, (await restarted.call('live.save', { id: ID, proofread: true })).jobId);
  assert.equal(again.status, 'complete', again.stage);
  assert.deepEqual(lib.log, ['proofread', 'translate', 'translate', 'title']);
});

test('live correction is not a job: it books the daily ledger and leaves no task, letter or notice (on the runtime it is one job, D-12)', async t => {
  const requests = [];
  const correction = async (_system, prompt, options) => {
    const input = JSON.parse(prompt); requests.push(RUNTIME ? 'live.correct' : options.task);
    reportUsage({ ...REPORTED });
    const last = input.items.at(-1).n;
    return JSON.stringify({ items: [], note: { text: '知识点', refs: [last] }, memory: { text: '课程摘要', refs: [last] }, followups: [] });
  };
  const lib = await savedClass(t, { library: { complete: correction, completeLight: correction } });
  const reply = await lib.service.call('live.correct', { id: ID });
  assert.equal(reply.status, 'ended');
  const session = lib.service.runtime.liveSessions.registered(lib.root, ID);
  await until(() => session.correction.snapshot().pending === 0 && !session.correction.snapshot().running);
  assert.deepEqual(requests, ['live.correct']);
  assert.deepEqual(await lib.ledger(), calls(1));
  if (RUNTIME) {
    // D-12 fixed: the correction of a class is a job of the console (visible, cancellable); it ends with the class's last pass and writes no letter.
    const [job] = (await lib.service.call('snapshot')).jobs;
    assert.deepEqual([job.type, job.title ?? job.contract.title, (await settleJob(lib.service, job.id)).status, job.contract.calls.length], ['audio-live-correction', '课堂校正 · Databases week 5', 'complete', 1]);
    assert.deepEqual([(await lib.state()).inbox, lib.notices], [[], []]);
  } else assert.deepEqual([(await lib.service.call('snapshot')).jobs, (await lib.state()).inbox, lib.notices], [[], [], []]);
  await lib.service.call('live.correct.background', { id: ID });
  assert.deepEqual(requests, ['live.correct'], 'nothing is pending in the background, so no request');
});
