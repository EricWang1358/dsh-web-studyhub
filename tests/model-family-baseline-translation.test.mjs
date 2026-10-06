/* S4-0 baseline of the translation entries (docs/plans/unified-job-runtime/s4-0-model-baseline.md). Describes what origin/main does today; nothing
   here asks for a change. Gaps only: the lifecycle, usage, notice and control of a job are in translation-jobs / job-control-translation tests, and
   the passage rules in materials-translation. Fake model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { usageLedger } from '../lib/model-usage.js';
import { reportUsage } from '../lib/usage-scope.js';
import { until, settleJob } from './helpers/wait.mjs';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';
import { gate, privateRoot, panelDoor } from './helpers/model-family-baseline.mjs';

const lines = prefix => Array.from({ length: 8 }, (_, index) => `${prefix} paragraph ${index} explains one more consequence of the architecture in some detail.`);
const body = (prefix, extra = []) => `# ${prefix}\n\n${[...lines(prefix), ...extra].join('\n\n')}\n`;
const zh = text => `译文：${'字'.repeat(Math.ceil(text.replace(/\s/g, '').length * 0.5))}`;
const upload = (name, text, documentId) => ({ filename: name, ...(documentId ? { documentId } : {}), dataBase64: Buffer.from(text).toString('base64') });

/** Answers every batch like a careful translator; `gates` holds the n-th call until released. */
function model() {
  const control = { calls: [], gates: new Map(), signals: [] };
  control.complete = async (_system, prompt, options = {}) => {
    const data = JSON.parse(prompt), number = control.calls.length;
    control.calls.push(data); control.signals.push(options.signal);
    const held = control.gates.get(number);
    if (held) await new Promise((resolve, reject) => { held.promise.then(resolve); options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
    options.signal?.throwIfAborted();
    return JSON.stringify({ translations: data.passages.map(passage => ({ id: passage.id, text: zh(passage.text) })) });
  };
  return control;
}

async function library(t, fake = model()) {
  const root = await privateRoot(t, 'model-baseline-translation-');
  const runtime = createStudyRuntime(root, { complete: fake.complete, notify: () => {}, language: 'zh', ...switchOptions(SWITCH_MODE, { complete: fake.complete, paths: ['translation'] }) });
  t.after(() => runtime.dispose());
  const one = async (prefix, extra) => {
    const imported = await runtime.call('materials.document.import', upload(`${prefix}.md`, body(prefix, extra)));
    return { documentId: imported.documentId, revision: imported.revision, sourceId: imported.document.sources[0].id, scope: { sourceIds: [imported.document.sources[0].id] } };
  };
  const items = (documentId, extra = {}) => runtime.call('materials.translation.list', { documentId, ...extra });
  return { root, runtime, fake, one, items };
}
const row = (runtime, jobId) => runtime.call('snapshot').then(snapshot => snapshot.jobs.find(job => job.id === jobId));

test('translation waits on the per-library queue: a second job is queued behind the first, the model is not asked for it, and the queue is dropped when the work is done', async t => {
  const fake = model(); fake.gates.set(0, gate());
  const f = await library(t, fake);
  const [a, b] = [await f.one('Alpha'), await f.one('Beta')];
  const first = await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope });
  const second = await f.runtime.call('generation.translation.start', { documentId: b.documentId, scope: b.scope });
  assert.deepEqual([first.status, first.queuedBehind], ['running', 0]);
  assert.deepEqual([second.status, second.queuedBehind], ['queued', 1]);
  assert.equal(second.job.stage, 'Waiting for the previous generation');
  assert.equal(second.job.runStartedAt, undefined, 'a queued job has not started running');
  const queued = (await row(f.runtime, second.jobId)).contract;
  assert.deepEqual([queued.status, queued.stage.code, queued.actions.pause.mode], ['queued', 'translation.queued', 'checkpoint']);
  assert.ok(f.runtime.work.queues.has(f.root), 'the one per-library queue is what both wait on');
  await until(() => fake.calls.length >= 1, 'the first job reaches the model');
  assert.ok(fake.calls.every(call => call.passages.every(item => item.text.includes('Alpha'))), 'only the first document is sent while the queue is held');
  fake.gates.get(0).release();
  assert.equal((await settleJob(f.runtime, first.jobId)).status, 'complete');
  assert.equal((await settleJob(f.runtime, second.jobId)).status, 'complete');
  assert.ok(fake.calls.some(call => call.passages.some(item => item.text.startsWith('Beta'))), 'the second one ran after the first');
  await until(() => !f.runtime.work.queues.has(f.root), 'the settled queue to be dropped');
});

test('a queued job that is cancelled makes no model call, but it only reports cancelled once the job ahead of it has let go of the queue', async t => {
  const fake = model(); fake.gates.set(0, gate());
  const f = await library(t, fake);
  const [a, b] = [await f.one('Alpha'), await f.one('Beta')];
  const first = await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope });
  const second = await f.runtime.call('generation.translation.start', { documentId: b.documentId, scope: b.scope });
  await until(() => fake.calls.length >= 1, 'the first job reaches the model');
  const reply = await f.runtime.call('job.cancel', { jobId: second.jobId });
  const stage = async () => (await f.runtime.call('generation.translation.status', { jobId: second.jobId })).job.stage;
  if (SWITCH_MODE === 'runtime') {
    // Reviewed difference of the runtime side (S4-2, defect D8): the stop is told at once and the job ends at once, still behind the first in the queue's order,
    // instead of waiting for its place in the queue just to say it was cancelled.
    assert.ok(['cancelling', 'cancelled'].includes(reply.jobs[0].status));
    await until(async () => (await stage()) === 'Cancelled before starting', 'the cancelled job to end while the first still holds the library');
    assert.equal((await settleJob(f.runtime, second.jobId)).status, 'cancelled');
  } else assert.equal(reply.jobs[0].status, 'cancelled', 'the learner is told at once');
  fake.gates.get(0).release();
  await settleJob(f.runtime, first.jobId);
  await until(async () => (await stage()) === 'Cancelled before starting', 'the queue to reach the cancelled job');
  assert.equal(fake.calls.some(call => call.passages.some(item => item.text.startsWith('Beta'))), false);
  assert.deepEqual(await f.items(b.documentId).then(list => list.items), []);
});

test('what a job was submitted with is what it keeps: a new revision, another target set afterwards do not reach a queued job (the glossary, read live by each wave, does)', async t => {
  const fake = model(); fake.gates.set(0, gate());
  const f = await library(t, fake);
  const [a, b] = [await f.one('Alpha'), await f.one('Beta')];
  await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope });
  const queued = await f.runtime.call('generation.translation.start', { documentId: b.documentId, scope: b.scope, label: 'Beta whole' });
  assert.equal(queued.status, 'queued');
  // The learner moves on: a newer revision of the document, English as its target, a glossary rule, after the submission.
  const next = await f.runtime.call('materials.document.import', upload('Beta.md', body('Beta', ['Beta paragraph added later is about something else.']), b.documentId));
  assert.notEqual(next.revision, b.revision);
  await f.runtime.call('materials.translation.glossary.set', { documentId: b.documentId, target: 'en', glossary: [{ term: 'architecture', rule: 'keep' }] });
  fake.gates.get(0).release();
  const done = await settleJob(f.runtime, queued.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual([done.revision, done.target, done.total, done.scopeLabel], [b.revision, 'zh', 9, 'Beta whole']);
  const kept = await f.items(b.documentId, { revision: b.revision, target: 'zh' });
  assert.equal(kept.items.length, 9, 'the nine paragraphs of the revision it was submitted for, in the target it was submitted with');
  assert.equal((await f.items(b.documentId, { revision: next.revision, target: 'zh' })).items.length, 0, 'the newer revision got nothing');
  const sent = fake.calls.flatMap(call => call.passages.map(item => item.text)).filter(text => text.startsWith('Beta'));
  assert.equal(sent.some(text => text.includes('added later')), false);
  // Not a snapshot (defect D1): the glossary of the document is read again by every wave, so a rule saved after the submission does reach the queued job.
  // Reviewed difference of the runtime side (S4-2): the glossary is frozen with the submission like the target, the revision and the scope.
  const reached = fake.calls.some(call => call.passages.some(item => item.text.includes('Beta')) && call.glossary?.some(entry => entry.term === 'architecture'));
  assert.equal(reached, SWITCH_MODE !== 'runtime');
});

test('a retranslation keeps the comment and the passages it was submitted with; a repeat of the same submission while it waits is the same job', async t => {
  const fake = model();
  const f = await library(t, fake);
  const [a, b] = [await f.one('Alpha'), await f.one('Beta')];
  const passages = [{ sourceId: b.sourceId, text: lines('Beta')[2] }];
  await f.runtime.call('materials.translation.translate', { documentId: b.documentId, passages });
  const hold = gate(); fake.gates.set(fake.calls.length, hold);
  const first = await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope });
  const args = { documentId: b.documentId, passages, retranslate: true, comment: 'Plainer words.' };
  const queued = await f.runtime.call('generation.translation.start', args);
  const again = await f.runtime.call('generation.translation.start', { ...args, comment: 'Plainer words.' });
  assert.deepEqual([queued.status, again.jobId, again.alreadyRunning], ['queued', queued.jobId, true]);
  const different = await f.runtime.call('generation.translation.start', { ...args, comment: 'A different request.' });
  assert.notEqual(different.jobId, queued.jobId, 'another comment is another job');
  hold.release();
  await Promise.all([first, queued, different].map(job => settleJob(f.runtime, job.jobId)));
  const mine = fake.calls.filter(call => call.learnerComment);
  assert.deepEqual([...new Set(mine.map(call => call.learnerComment))].sort(), ['A different request.', 'Plainer words.']);
});

test('the panel and the runtime door start the same translation: same paragraphs, same versions, same visible job fields', async t => {
  const direct = await library(t), panelRoot = await privateRoot(t, 'model-baseline-translation-panel-');
  const panel = panelDoor(t, panelRoot, { complete: model().complete, ...(SWITCH_MODE === 'runtime' ? { pilot: { translation: true } } : {}) });
  const a = await direct.one('Alpha');
  const imported = await panel('materials.document.import', upload('Alpha.md', body('Alpha')));
  const scope = { sourceIds: [imported.document.sources[0].id] };
  const viaRuntime = await direct.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope, label: 'Alpha' });
  const viaPanel = await panel('generation.translation.start', { documentId: imported.documentId, scope, label: 'Alpha' });
  await settleJob(direct.runtime, viaRuntime.jobId);
  await until(async () => (await panel('generation.translation.status', { jobId: viaPanel.jobId })).job.status === 'complete', 'the panel job to finish');
  const shape = async list => (await list()).items.map(({ quote, text, target, version }) => [quote, text, target, version]);
  assert.deepEqual(await shape(() => panel('materials.translation.list', { documentId: imported.documentId })), await shape(() => direct.items(a.documentId)));
  const visible = ({ job }) => [job.type, job.origin, job.target, job.total, job.done, job.translated, job.scopeLabel, job.status, job.stageCode];
  assert.deepEqual(visible(await panel('generation.translation.status', { jobId: viaPanel.jobId })), visible(await direct.runtime.call('generation.translation.status', { jobId: viaRuntime.jobId })));
});

test('a model that reports nothing leaves the usage unknown, never zero, and a call with no host child is a direct call of the job', async t => {
  const f = await library(t), a = await f.one('Alpha');
  const started = await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope });
  const ended = await settleJob(f.runtime, started.jobId);
  assert.equal(ended.status, 'complete');
  const { contract } = await row(f.runtime, started.jobId);
  assert.equal(contract.usage.tokens, null, 'no tokens were reported: the contract says unknown');
  assert.equal(contract.usage.tokenUsage, null);
  assert.equal(ended.tokenUsage, undefined, 'the legacy record has no usage either');
  assert.deepEqual([...new Set(contract.calls.map(call => call.runner))], ['direct']);
  assert.equal(contract.execution.mode, 'direct');
  assert.ok(contract.calls.every(call => call.kind && !call.childId), 'no child of a host was involved');
});

test('translating one passage or selection from the reader is not a job and not on the queue: it answers while a page job holds the library, and no job row is made for it', async t => {
  const fake = model(); fake.gates.set(0, gate());
  const f = await library(t, fake);
  const [a, b] = [await f.one('Alpha'), await f.one('Beta')];
  const job = await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope });
  await until(() => fake.calls.length >= 1, 'the page job to hold the model');
  const sentence = lines('Beta')[3];
  const result = await f.runtime.call('materials.translation.translate', { documentId: b.documentId, passages: [{ sourceId: b.sourceId, kind: 'selection', text: sentence.slice(0, 40), prefix: '', suffix: '' }], requestId: 'reader-1' });
  assert.deepEqual([result.status, result.results[0].status, result.results[0].kind], ['done', 'translated', 'selection']);
  assert.equal((await f.runtime.call('generation.translation.status', { jobId: job.jobId })).job.status, 'running', 'the page job is still waiting for its model call');
  assert.deepEqual((await f.runtime.call('snapshot')).jobs.map(item => item.id), [job.jobId], 'the selection made no row of its own');
  assert.deepEqual(await f.runtime.call('materials.translation.cancel', { requestId: 'reader-1' }), { cancelled: false }, 'a finished call has nothing left to cancel');
  fake.gates.get(0).release();
  await settleJob(f.runtime, job.jobId);
});

test('what the model reports is counted once per call in the job and once in the ledger, under the feature other; the two wrappers around the call do not double it', async t => {
  const fake = model(), answer = fake.complete;
  fake.complete = async (...args) => { reportUsage({ uncachedInputTokens: 500, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }); return answer(...args); };
  const f = await library(t, fake), a = await f.one('Alpha');
  const started = await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope });
  const ended = await settleJob(f.runtime, started.jobId);
  assert.equal(ended.tokenUsage.calls, fake.calls.length);
  const { byFeature } = await usageLedger(f.root).summary({ days: 1 });
  assert.deepEqual(Object.keys(byFeature), ['other']);
  assert.equal(byFeature.other.calls, fake.calls.length);
  assert.equal(byFeature.other.uncachedInputTokens, 500 * fake.calls.length);
});

test('a restart loses the job but not the paragraphs: the job table is in memory, what each finished wave kept is in the library, and nothing is recovered or marked interrupted', async t => {
  const fake = model(); fake.gates.set(1, gate());
  const f = await library(t, fake), a = await f.one('Alpha');
  const started = await f.runtime.call('generation.translation.start', { documentId: a.documentId, scope: a.scope, concurrency: 1 });
  await until(() => fake.calls.length >= 2, 'the second wave to be with the model');
  await f.runtime.dispose();
  const reopened = createStudyRuntime(f.root, { complete: model().complete, notify: () => {}, language: 'zh' });
  t.after(() => reopened.dispose());
  assert.deepEqual((await reopened.call('generation.translation.jobs', {})).jobs, [], 'no record of the job, interrupted or otherwise');
  await assert.rejects(reopened.call('generation.translation.status', { jobId: started.jobId }), /does not exist/);
  assert.equal((await reopened.call('materials.translation.list', { documentId: a.documentId })).items.length, 6, 'the first wave stays kept');
  const again = await reopened.call('generation.translation.start', { documentId: a.documentId, scope: a.scope });
  assert.equal(again.job.total, 3, 'a new submission does only what is left');
});
