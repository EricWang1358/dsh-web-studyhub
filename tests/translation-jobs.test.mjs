/* 翻译本页 / 翻译本章 as an ordinary background job (generation.translation.*): the job table, queue, cancel controller, usage
   scope, token estimate, session notice and inbox letter every other generation job uses. Paragraph by paragraph in bounded
   batches, paragraphs that already have a translation are skipped, one job per page, progress n/m, a stop that keeps what was
   translated. Fake model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { reportUsage } from '../lib/usage-scope.js';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
async function waitFor(check, label = 'condition') {
  for (let i = 0; i < 600; i++) { const value = await check(); if (value) return value; await sleep(10); }
  throw new Error(`Timed out waiting for ${label}`);
}

const lines = Array.from({ length: 14 }, (_, index) => `Paragraph number ${index} explains one more consequence of the architecture in some detail.`);
const markdown = `# Notes\n\n${lines.join('\n\n')}\n`;
const zh = text => `译文：${'字'.repeat(Math.ceil(text.replace(/\s/g, '').length * 0.5))}`;
const en = text => `Translation: ${'word '.repeat(Math.ceil(text.replace(/\s/g, '').length * 3 / 5))}`.trim();

function gatedModel() {
  const control = { calls: [], gates: new Map(), signals: [], inFlight: 0, peak: 0, usage: false, failWith: null, delay: 0, say: zh };
  control.complete = async (system, prompt, options = {}) => {
    const data = JSON.parse(prompt), number = control.calls.length;
    control.calls.push(data); control.signals.push(options.signal);
    control.inFlight += 1; control.peak = Math.max(control.peak, control.inFlight);
    try {
      const gate = control.gates.get(number);
      if (gate) await new Promise((resolve, reject) => { gate.promise.then(resolve); options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
      if (control.delay) await sleep(control.delay);
      options.signal?.throwIfAborted();
      if (control.failWith) throw new Error(control.failWith);
      if (control.usage) reportUsage({ uncachedInputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 });
      return JSON.stringify({ translations: data.passages.map(passage => ({ id: passage.id, text: control.say(passage.text) })) });
    } finally { control.inFlight -= 1; }
  };
  return control;
}

async function fixture(t, { model = gatedModel(), notices = [], language = 'zh', noModel = false, body = markdown } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'translation-jobs-'));
  const runtime = createStudyRuntime(root, { ...(noModel ? {} : { complete: model.complete, ...switchOptions(SWITCH_MODE, { complete: model.complete, paths: ['translation'] }) }), notify: message => notices.push(message), language });
  // The runtime is disposed first (a stopped job may still be writing a shard), then the folder goes, with retries for a slow filesystem.
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const imported = await runtime.call('materials.document.import', { filename: 'notes.md', dataBase64: Buffer.from(body).toString('base64') });
  const source = imported.document.sources[0];
  const scope = { sourceIds: [source.id] };
  const list = async () => (await runtime.call('materials.translation.list', { documentId: imported.documentId })).items;
  const status = async jobId => (await runtime.call('job.wait', { jobId, timeoutSeconds: 1 }));
  return { root, runtime, model, notices, imported, source, scope, list, status };
}
const wait = (f, jobId) => f.runtime.call('job.wait', { jobId, timeoutSeconds: 30 });

test('the price comes first: an estimate makes no job and no model call, and says how much is left to do', async t => {
  const f = await fixture(t, { noModel: true });
  const priced = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: f.scope, estimate: true });
  assert.equal(priced.status, 'estimate');
  assert.equal(priced.modelAvailable, false);
  assert.equal(priced.counts.toTranslate, 15, 'the title and the fourteen paragraphs');
  assert.ok(priced.estimate.totalTokens.low > 0 && priced.estimate.calls.low >= 3);
  assert.deepEqual((await f.runtime.call('generation.translation.jobs', {})).jobs, []);
  assert.equal(f.model.calls.length, 0);
});

test('starting answers at once with a job handle; progress is counted paragraph by paragraph and the job ends in the reader\'s record', async t => {
  const model = gatedModel(); model.gates.set(1, deferred());
  const f = await fixture(t, { model });
  const started = await Promise.race([f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: f.scope, concurrency: 1 }), sleep(2000).then(() => 'blocked')]);
  assert.notEqual(started, 'blocked', 'start does not wait for the model');
  assert.ok(started.jobId);
  assert.equal(started.job.type, 'translation');
  assert.equal(started.job.origin, 'translation');
  assert.equal(started.job.documentId, f.imported.documentId);
  assert.equal(started.job.total, 15);
  assert.equal(started.job.target, 'zh');
  assert.ok(started.job.estimate.totalTokens.low > 0, 'what the run was expected to use is kept');
  const midway = await waitFor(async () => { const job = (await f.status(started.jobId)); return job.done > 0 && job.done < job.total && job; }, 'first batch done');
  assert.equal(midway.status, 'running');
  assert.equal(midway.done, 6, 'a batch of six paragraphs is done');
  assert.ok(midway.runStartedAt);
  assert.equal((await f.list()).length, 6, 'what is done is already kept');
  model.gates.get(1).release();
  const done = await wait(f, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual([done.done, done.translated, done.rejected], [15, 15, 0]);
  assert.equal((await f.list()).length, 15);
  assert.ok(model.calls.every(call => call.passages.length <= 6));
});

test('paragraphs that already have a translation are skipped and never sent', async t => {
  const f = await fixture(t);
  await f.runtime.call('materials.translation.translate', { documentId: f.imported.documentId, passages: [{ sourceId: f.source.id, text: lines[3] }, { sourceId: f.source.id, text: lines[4] }] });
  const before = f.model.calls.length;
  const started = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: f.scope });
  assert.equal(started.job.total, 13);
  const done = await wait(f, started.jobId);
  assert.equal(done.status, 'complete');
  const sent = f.model.calls.slice(before).flatMap(call => call.passages.map(item => item.text));
  assert.equal(sent.length, 13);
  assert.ok(!sent.includes(lines[3]) && !sent.includes(lines[4]));
  assert.equal((await f.list()).length, 15);
});

test('a second start for the same page while it runs is the same job, not a duplicate', async t => {
  const model = gatedModel(); model.gates.set(0, deferred());
  const f = await fixture(t, { model });
  const first = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: f.scope, concurrency: 1 });
  const second = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: f.scope, concurrency: 1 });
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.alreadyRunning, true);
  assert.equal((await f.runtime.call('generation.translation.jobs', { documentId: f.imported.documentId })).jobs.length, 1);
  model.gates.get(0).release();
  assert.equal((await wait(f, first.jobId)).status, 'complete');
});

test('stopping keeps the paragraphs already translated and stops asking the model', async t => {
  const model = gatedModel(); model.gates.set(1, deferred());
  const f = await fixture(t, { model });
  const started = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: f.scope, concurrency: 1 });
  await waitFor(() => model.calls.length >= 2, 'second batch started');
  const stopping = await f.runtime.call('job.cancel', { jobId: started.jobId });
  assert.match(stopping.jobs[0].stage, /translated paragraphs are kept/i);
  const done = await wait(f, started.jobId);
  assert.equal(done.status, 'cancelled');
  assert.equal(model.signals[1].aborted, true);
  assert.equal((await f.list()).length, 6);
  assert.equal(model.calls.length, 2);
  assert.equal(done.stageCode, 'cancelled');
  const again = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: f.scope });
  assert.equal(again.job.total, 9, 'a new job continues with what is left');
  assert.notEqual(again.jobId, started.jobId);
});

test('the job tallies the usage the model reports, keeps its estimate, files an inbox letter and tells the session', async t => {
  const model = gatedModel(); model.usage = true;
  const notices = [];
  const f = await fixture(t, { model, notices });
  const started = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: f.scope });
  assert.ok((await f.runtime.call('snapshot')).jobs.some(job => job.id === started.jobId && job.type === 'translation'), 'listed with the other jobs');
  const done = await wait(f, started.jobId);
  assert.equal(done.tokenUsage.calls, 3);
  assert.equal(done.tokenUsage.uncachedInputTokens, 1500);
  assert.ok(done.estimate.calls.low === 3);
  assert.equal(notices.length, 1);
  assert.match(notices[0].summary, /notes\.md/);
  const inbox = (await f.runtime.call('snapshot')).inbox;
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].kind, 'translate-result');
  assert.equal(inbox.items[0].label, '译文已生成');
  assert.deepEqual(inbox.items[0].sourceIds, [f.source.id]);
  const opened = await f.runtime.call('inbox.open', { id: inbox.items[0].id });
  assert.deepEqual(opened.sourceIds, [f.source.id], 'the letter opens the material');
});

test('English: the letter, the notice and the refusals are English', async t => {
  const model = gatedModel(); model.say = en;
  const notices = [];
  const chinese = `# 笔记\n\n${Array.from({ length: 14 }, (_, index) => `第${index}段说明了这套架构带来的又一个后果，并且讲得相当详细。`).join('\n\n')}\n`;
  const f = await fixture(t, { model, notices, language: 'en', body: chinese });
  const started = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: f.scope });
  const done = await wait(f, started.jobId);
  assert.equal(done.status, 'complete');
  assert.match(notices[0].summary, /Translation/);
  assert.equal((await f.runtime.call('snapshot')).inbox.items[0].label, 'Translation ready');
  assert.equal(done.target, 'en', 'an English interface translates into English unless the document says otherwise');
});

test('without a model the job is refused plainly, and the estimate still works', async t => {
  const f = await fixture(t, { noModel: true });
  const refused = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: f.scope });
  assert.deepEqual([refused.available, refused.reason], [false, 'model_unavailable']);
  assert.deepEqual((await f.runtime.call('generation.translation.jobs', {})).jobs, []);
});

test('a model that fails ends the job as failed, keeps what was translated and files a letter that says so', async t => {
  const model = gatedModel();
  const f = await fixture(t, { model });
  await f.runtime.call('materials.translation.translate', { documentId: f.imported.documentId, passages: [{ sourceId: f.source.id, text: lines[0] }] });
  model.failWith = 'The provider is down';
  const started = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: f.scope });
  const done = await wait(f, started.jobId);
  assert.equal(done.status, 'failed');
  assert.match(done.stage, /provider is down/);
  assert.equal(done.stageCode, 'failed');
  assert.equal((await f.list()).length, 1);
  assert.equal((await f.runtime.call('snapshot')).inbox.items[0].kind, 'translate-failed');
});

test('paragraphs the model keeps getting wrong are counted as rejected and the job is partial', async t => {
  const model = gatedModel();
  const answer = model.complete;
  model.complete = async (system, prompt, options) => {
    const data = JSON.parse(prompt);
    if (data.passages.some(item => item.text === lines[5])) { model.calls.push(data); return JSON.stringify({ translations: data.passages.filter(item => item.text !== lines[5]).map(item => ({ id: item.id, text: zh(item.text) })) }); }
    return answer(system, prompt, options);
  };
  const f = await fixture(t, { model });
  const started = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: f.scope });
  const done = await wait(f, started.jobId);
  assert.equal(done.status, 'complete');
  assert.equal(done.rejected, 1);
  assert.equal(done.translated, 14);
  assert.equal(done.stageCode, 'partial');
  assert.equal((await f.list()).length, 14);
});

test('no more than three batches are in flight, however many are asked for, and a job can be asked for explicit passages', async t => {
  const model = gatedModel(); model.delay = 20;
  const f = await fixture(t, { model });
  const many = Array.from({ length: 30 }, (_, index) => `Another paragraph, number ${index}, says something different about the same design.`);
  const body = `# Big\n\n${many.join('\n\n')}\n`;
  const big = await f.runtime.call('materials.document.import', { filename: 'big.md', dataBase64: Buffer.from(body).toString('base64') });
  const started = await f.runtime.call('generation.translation.start', { documentId: big.documentId, concurrency: 9,
    passages: many.map(text => ({ sourceId: big.document.sources[0].id, text })) });
  assert.equal(started.job.total, 30);
  assert.equal(started.job.concurrency, 3);
  const done = await wait(f, started.jobId);
  assert.equal(done.status, 'complete');
  assert.ok(model.peak <= 3 && model.peak >= 2, `peak ${model.peak}`);
});

test('the jobs of one document are listed oldest first and carry what the reader needs to draw them', async t => {
  const f = await fixture(t);
  const first = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: f.scope, label: '第 1 页' });
  await wait(f, first.jobId);
  const listed = (await f.runtime.call('generation.translation.jobs', { documentId: f.imported.documentId })).jobs;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].scopeLabel, '第 1 页');
  assert.equal(listed[0].status, 'complete');
  assert.equal(listed[0].root, undefined, 'no library path leaves the backend');
  assert.equal((await f.runtime.call('generation.translation.status', { jobId: first.jobId })).job.id, first.jobId);
});

test('retranslating chosen passages is a job too: it sends them again even though they have a translation, and counts them', async t => {
  const f = await fixture(t);
  const some = [lines[1], lines[2]].map(text => ({ sourceId: f.source.id, text }));
  await f.runtime.call('materials.translation.translate', { documentId: f.imported.documentId, passages: some });
  const calls = f.model.calls.length;
  const plain = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, passages: some });
  assert.equal(plain.status, 'nothing', 'translated passages are not a job');
  const started = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, passages: some, retranslate: true, comment: 'Plainer words.' });
  assert.equal(started.job.total, 2);
  const done = await wait(f, started.jobId);
  assert.equal(done.status, 'complete');
  assert.equal(f.model.calls.length, calls + 1);
  assert.equal(f.model.calls.at(-1).learnerComment, 'Plainer words.');
  assert.deepEqual((await f.list()).map(entry => entry.version), [2, 2]);
});

test('a chapter is a job scope too, as the effective segmentation defines it: only its paragraphs are in the job', async t => {
  const f = await fixture(t);
  await f.runtime.call('materials.outline.save', { documentId: f.imported.documentId, entries: [{ title: 'Part one', level: 1, startBlock: 0 }, { title: 'Part two', level: 1, startBlock: 8 }], segmentLevel: 1 });
  const priced = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: { chapter: 1 }, estimate: true });
  assert.equal(priced.counts.toTranslate, 7);
  const started = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: { chapter: 1 }, label: 'Part two' });
  assert.equal(started.job.total, 7);
  assert.deepEqual(started.job.sourceIds, [f.source.id]);
  assert.equal(started.job.scopeLabel, 'Part two');
  const done = await wait(f, started.jobId);
  assert.equal(done.status, 'complete');
  const kept = await f.list();
  assert.deepEqual(kept.map(entry => entry.quote.slice(0, 20)), lines.slice(7).map(line => line.slice(0, 20)));
  const first = await f.runtime.call('generation.translation.start', { documentId: f.imported.documentId, scope: { chapter: 0 } });
  assert.equal(first.job.total, 8, 'the other chapter still has its own paragraphs to do');
  await wait(f, first.jobId);
});
