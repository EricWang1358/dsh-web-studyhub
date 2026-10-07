import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob } from './helpers/wait.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { ONE_BY_ONE } from './helpers/supplement-fixtures.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { gate, openLibrary, restartedOver, jobsOf, soon } from './helpers/generation-baseline.mjs';

/* S3-7 (the S3-0 matrix row "mixed before its first draft", V3): a run of mixed kinds (quizzes and flashcards, the odd question of a call a quiz) is planned from the request, and the
   request - its kind included - is what the runtime keeps. A process that died after the first part came back as the same job; its retry writes the parts that are missing, quizzes
   and flashcards both, and keeps the part that was saved. The "death" is a copy of the library folder taken while the second part's author is held. */

const hostOf = (complete) => { const { starts: _starts, ...options } = managedRuntimeOptions({ complete, paths: ['generation', 'generationRestart'] }); return options; };
const world = mergedTranscript({ recordings: 1, parts: 4, paragraphs: 4 });

test('restart, a mixed run killed after its first part: the same job, its retry writes what is missing in both kinds, and keeps the part that was saved', async t => {
  const hold = gate(), model = clusteringModel();
  let authors = 0;
  const complete = async (system, prompt, context = {}) => {
    if (system.startsWith('You author') && ++authors === 2 && !hold.entered) { hold.entered = true; await hold.promise; }
    return model.complete(system, prompt, context);
  };
  const first = await openLibrary(t, { model: complete, hold, options: hostOf(complete) });
  for (const source of world.sources) await first.service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  const ids = world.sources.map(source => source.id);
  await first.service.call('generate', { sourceIds: ids, count: 4, kind: 'mixed', performance: ONE_BY_ONE });
  await soon(async () => (await first.service.call('export')).drafts[0]?.cards.length >= 1 && hold.entered, 'the first part to be saved and the second held');
  const saved = (await first.service.call('export')).drafts[0];
  const calls = []; let next = async system => { calls.push(String(system).slice(0, 30)); throw new Error('a restart must not call a model by itself'); };
  const after = await restartedOver(t, first.root, { options: hostOf((...args) => next(...args)), model: (...args) => next(...args) });
  const [job] = await jobsOf(after.service);
  assert.equal(job.contract.status, 'interrupted');
  assert.deepEqual(calls, []);
  next = clusteringModel().complete;
  const done = await settleJob(after.service, (await after.service.call('job.control', { jobId: job.id, action: 'retry' })).attemptId);
  assert.equal(done.status, 'complete', done.stage);
  const [draft] = (await after.service.call('export')).drafts;
  assert.equal(draft.id, saved.id, 'the same draft');
  assert.deepEqual(draft.cards.slice(0, saved.cards.length).map(item => item.id), saved.cards.map(item => item.id), 'what was approved stays in place');
  assert.ok(draft.cards.length > saved.cards.length, 'the retry wrote the parts that were missing');
  assert.equal(new Set(draft.cards.map(item => item.id)).size, draft.cards.length, 'nothing doubled');
  const kinds = new Set(draft.cards.map(item => item.kind));
  assert.ok(kinds.has('quiz') && kinds.has('flashcard'), `both kinds are written: ${[...kinds]}`);
  hold.open();
});
