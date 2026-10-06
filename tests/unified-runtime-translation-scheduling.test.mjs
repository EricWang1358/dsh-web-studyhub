/* S4-3: a translation need not wait for the whole-library generation in front of it (runtime.pilot.translationParallel, default off). What it still waits for is another
   translation of the same document. Occupancy is observed at the model: how many calls of each kind are in flight at once, not what a status field says. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { until, settleJob } from './helpers/wait.mjs';
import { gate, privateRoot } from './helpers/model-family-baseline.mjs';
import { gate as holdGate, stagedModel } from './helpers/generation-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { body, lines, upload, zh } from './helpers/translation-library.mjs';

/** The path of each family: 'legacy' keeps the in-process executor, 'runtime' is the Job of the unified runtime. */
const COMBINATIONS = [['legacy', 'legacy'], ['runtime', 'legacy'], ['runtime', 'runtime']];
const TRANSLATOR = 'You are a careful translator';

/** One model for both families; it counts what is in flight at once, per family and together. */
function twoFamilies({ holdGeneration } = {}) {
  const staged = stagedModel({ holdAt: 'plan', hold: holdGeneration });
  const live = { translation: 0, generation: 0, peak: { translation: 0, generation: 0, both: 0 } }, translating = [], gates = new Map(), failures = [];
  const track = async (kind, run) => {
    live[kind] += 1; live.peak[kind] = Math.max(live.peak[kind], live[kind]); live.peak.both = Math.max(live.peak.both, live.translation + live.generation);
    try { return await run(); } finally { live[kind] -= 1; }
  };
  const complete = async (system, prompt, options = {}) => {
    if (!system.startsWith(TRANSLATOR)) return track('generation', () => staged.complete(system, prompt, options));
    const data = JSON.parse(prompt), number = translating.length;
    translating.push(data);
    return track('translation', async () => {
      const held = gates.get(number);
      if (held) await new Promise((resolve, reject) => { held.promise.then(resolve); options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
      options.signal?.throwIfAborted();
      const failure = failures.shift();
      if (failure) throw failure;
      return JSON.stringify({ translations: data.passages.map(passage => ({ id: passage.id, text: zh(passage.text) })) });
    });
  };
  return { complete, live, translating, gates, failures, staged };
}

async function library(t, { translationMode, generationMode, parallel, holdGeneration }) {
  const fake = twoFamilies({ holdGeneration }), root = await privateRoot(t, 'translation-scheduling-');
  const paths = [...(translationMode === 'runtime' ? ['translation'] : []), ...(generationMode === 'runtime' ? ['generation'] : [])];
  const options = paths.length ? switchOptions('runtime', { complete: fake.complete, paths }) : {};
  const runtime = createStudyRuntime(root, { complete: fake.complete, notify: () => {}, language: 'zh', ...options, runtimePilot: { ...(options.runtimePilot || {}), translationParallel: parallel } });
  t.after(async () => { holdGeneration?.open(); for (const held of fake.gates.values()) held.release(); await runtime.dispose(); });
  const one = async prefix => {
    const imported = await runtime.call('materials.document.import', upload(`${prefix}.md`, body(prefix)));
    return { documentId: imported.documentId, scope: { sourceIds: [imported.document.sources[0].id] } };
  };
  const translate = (doc, extra = {}) => runtime.call('generation.translation.start', { documentId: doc.documentId, ...(extra.passages ? {} : { scope: doc.scope }), ...extra });
  const generate = async () => { await runtime.call('source.add', { id: 's', title: 'Notes', text: 'Architecture sets principles that guide how a system is designed and changed.' }); return runtime.call('generate', { sourceIds: ['s'], count: 1, kind: 'flashcard' }); };
  return { runtime, fake, one, translate, generate };
}

for (const [translationMode, generationMode] of COMBINATIONS) {
  const label = `translation ${translationMode}, generation ${generationMode}`;

  test(`${label}: without the switch a translation waits for the generation in front of it, and asks no model until its turn`, async t => {
    const hold = holdGate(), f = await library(t, { translationMode, generationMode, parallel: false, holdGeneration: hold }), doc = await f.one('Alpha');
    const generating = await f.generate();
    await until(() => hold.entered, 'the generation to be at the model');
    const translating = await f.translate(doc, { concurrency: 1 });
    assert.deepEqual([translating.status, translating.queuedBehind], ['queued', 1]);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(f.fake.translating.length, 0, 'a queued translation has not asked the model');
    hold.open();
    const generated = await settleJob(f.runtime, generating.jobId), translated = await settleJob(f.runtime, translating.jobId);
    assert.deepEqual([generated.status, translated.status], ['complete', 'complete']);
    assert.equal(f.fake.live.peak.both, 1, 'one model call at a time in the library');
    assert.ok(Date.parse(generated.finishedAt) <= Date.parse(translated.finishedAt), 'generation first, as accepted');
  });

  test(`${label}: with the switch the translation runs while the whole-library generation is at the model`, async t => {
    const hold = holdGate(), f = await library(t, { translationMode, generationMode, parallel: true, holdGeneration: hold }), doc = await f.one('Alpha');
    const generating = await f.generate();
    await until(() => hold.entered, 'the generation to be at the model');
    f.fake.gates.set(0, gate());
    const translating = await f.translate(doc, { concurrency: 1 });
    assert.equal(translating.queuedBehind, 0, 'nothing of the translation\'s own document is in front of it');
    await until(() => f.fake.live.translation === 1 && f.fake.live.generation === 1, 'both families to be at the model together');
    assert.equal(f.fake.live.peak.both, 2, 'real overlap: one generation call and one translation call in flight at once');
    assert.equal(f.runtime.work.queues.size, 2, 'the library chain and the translation\'s own chain');
    f.fake.gates.get(0).release();
    assert.equal((await settleJob(f.runtime, translating.jobId)).status, 'complete', 'the translation ends while the generation is still held');
    assert.equal(hold.entered && f.fake.live.generation, 1);
    hold.open();
    assert.equal((await settleJob(f.runtime, generating.jobId)).status, 'complete');
    assert.equal((await f.runtime.call('materials.translation.list', { documentId: doc.documentId })).items.length, 9);
  });

  test(`${label}: with the switch translations of one document stay one at a time and those of two documents overlap`, async t => {
    const f = await library(t, { translationMode, generationMode, parallel: true }), [a, b] = [await f.one('Alpha'), await f.one('Beta')];
    f.fake.gates.set(0, gate()); f.fake.gates.set(1, gate());
    const first = await f.translate(a, { concurrency: 1 });
    await until(() => f.fake.live.translation === 1, 'the first translation at the model');
    const same = await f.translate(a, { concurrency: 1, passages: lines('Alpha').slice(0, 2).map(text => ({ sourceId: a.scope.sourceIds[0], text })) }), other = await f.translate(b, { concurrency: 1 });
    assert.deepEqual([same.status, same.queuedBehind], ['queued', 1], 'the same document waits for the one in front of it');
    assert.equal(other.queuedBehind, 0);
    await until(() => f.fake.live.translation === 2, 'the other document to be at the model beside it');
    assert.equal(f.fake.translating.filter(data => data.passages[0].text.startsWith('Alpha')).length, 1, 'the second translation of Alpha has not asked the model');
    f.fake.gates.get(0).release(); f.fake.gates.get(1).release();
    for (const started of [first, same, other]) assert.equal((await settleJob(f.runtime, started.jobId)).status, 'complete');
    assert.equal(f.fake.live.peak.translation, 2, 'two documents at once, never two of the same document');
  });

  test(`${label}: without the switch two documents are translated one after the other`, async t => {
    const f = await library(t, { translationMode, generationMode, parallel: false }), [a, b] = [await f.one('Alpha'), await f.one('Beta')];
    f.fake.gates.set(0, gate());
    const first = await f.translate(a, { concurrency: 1 }), second = await f.translate(b, { concurrency: 1 });
    await until(() => f.fake.live.translation === 1, 'the first at the model');
    assert.equal(second.status, 'queued');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(f.fake.live.translation, 1);
    f.fake.gates.get(0).release();
    for (const started of [first, second]) await settleJob(f.runtime, started.jobId);
    assert.equal(f.fake.live.peak.translation, 1);
  });
}

test('a busy model (429) cools a parallel translation instead of failing it: it waits, asks again one batch at a time, and keeps what it has', async t => {
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => original(callback, ms === 5000 ? 10 : ms, ...args));
  const f = await library(t, { translationMode: 'runtime', generationMode: 'legacy', parallel: true }), doc = await f.one('Alpha');
  f.fake.failures.push(Object.assign(new Error('429 Too Many Requests'), { status: 429 }));
  const started = await f.translate(doc, { concurrency: 2 });
  const ended = await settleJob(f.runtime, started.jobId);
  assert.equal(ended.status, 'complete', ended.stage);
  assert.equal((await f.runtime.call('materials.translation.list', { documentId: doc.documentId })).items.length, 9);
  assert.equal(f.fake.failures.length, 0, 'the busy answer was met');
  assert.ok(f.fake.translating.length >= 3, 'the wave was asked again after the wait');
  assert.deepEqual([ended.done, ended.total], [9, 9]);
});

test('a busy model fails a translation as before when the switch is off', async t => {
  const f = await library(t, { translationMode: 'runtime', generationMode: 'legacy', parallel: false }), doc = await f.one('Alpha');
  f.fake.failures.push(Object.assign(new Error('429 Too Many Requests'), { status: 429 }));
  const ended = await settleJob(f.runtime, (await f.translate(doc)).jobId);
  assert.equal(ended.status, 'failed');
});

test('a stop while a translation is cooling ends it at once, with what it kept', async t => {
  const f = await library(t, { translationMode: 'runtime', generationMode: 'legacy', parallel: true }), doc = await f.one('Alpha');
  f.fake.failures.push(Object.assign(new Error('429 Too Many Requests'), { status: 429 }));
  const started = await f.translate(doc, { concurrency: 1 });
  await until(async () => (await f.runtime.call('snapshot')).jobs.find(job => job.id === started.jobId)?.stage === 'The model is busy; waiting before asking again', 'the translation to be cooling');
  await f.runtime.call('job.control', { jobId: started.jobId, action: 'cancel' });
  const ended = await settleJob(f.runtime, started.jobId);
  assert.equal(ended.status, 'cancelled');
  assert.equal(f.fake.translating.length, 1, 'it did not ask again after the stop');
});
