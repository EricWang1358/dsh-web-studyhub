import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob } from './helpers/wait.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { ONE_BY_ONE } from './helpers/supplement-fixtures.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { parseJson } from '../lib/generation.js';
import { gate, openLibrary, restartedOver, jobsOf, soon } from './helpers/generation-baseline.mjs';

/* S3-7 (the S3-0 matrix row "mixed before its first draft", V3): a run of mixed kinds (quizzes and flashcards, the odd question of a call a quiz) is planned from the request, and the
   request - its kind included - is what the runtime keeps. A process that died after the first part came back as the same job; its retry writes the parts that are missing, quizzes
   and flashcards both, and keeps the part that was saved. The "death" is a copy of the library folder taken while the second part's author is held.

   The planner of this fake is deterministic and CLUSTERS: it takes the first sentences of the material, numbering its objectives from 1 within the process that runs it. So what a retry
   comes to depends on one thing only, whether its planner remembers what it planned before the death: a planner that does (the real one is told the questions the draft already holds)
   writes four new questions; one that starts again from 1 plans the question the draft already holds, and the server skips that one as a duplicate and SAYS so in the draft's failures. */

const hostOf = (complete) => { const { starts: _starts, ...options } = managedRuntimeOptions({ complete, paths: ['generation', 'generationRestart'] }); return options; };
const world = mergedTranscript({ recordings: 1, parts: 4, paragraphs: 4 });
const SKIPPED = '补题时跳过了一道与已有草稿重复的题';
const ASK = { count: 4, kind: 'mixed', performance: ONE_BY_ONE };

/** The planned, written and kept questions of one model: every planned target, every authored card, in order. */
function recorded(model) {
  const planned = [], written = [], writtenCards = [];
  const complete = async (system, prompt, context = {}) => {
    const reply = await model.complete(system, prompt, context);
    if (system.startsWith('Plan a source-grounded assessment')) planned.push(...(parseJson(reply).targets ?? []).map(target => target.objective));
    if (system.startsWith('You author')) { const value = parseJson(reply), cards = value.deck?.cards ?? value.cards ?? []; written.push(...cards.map(card => card.objective)); writtenCards.push(...cards); }
    return reply;
  };
  return { complete, planned, written, writtenCards };
}
const objectives = draft => draft.cards.map(item => item.objective);
const PLAN = 'Plan a source-grounded assessment';

/** The planner of a retry that REMEMBERS: it is told which passages the questions the draft already holds were planned from (the real planner is told those questions), and does not plan them again.
 * `quoteOf` is what the planner of the first process planned each objective from. */
function remembering(model, quoteOf) {
  const complete = async (system, prompt, context = {}) => {
    if (!system.startsWith(PLAN)) return model.complete(system, prompt, context);
    const [head, data] = prompt.split('REQUEST DATA:\n'), request = parseJson(data);
    const already = (request.existing ?? []).map(objective => quoteOf.get(objective)).filter(Boolean);
    return model.complete(system, `${head}REQUEST DATA:\n${JSON.stringify({ ...request, assignments: [{ alreadyPlanned: already }] })}`, context);
  };
  return { complete, log: model.log };
}

/** One uninterrupted run, for the number the retry has to be held to. */
async function uninterrupted(t, ids) {
  const model = recorded(clusteringModel()), lib = await openLibrary(t, { prefix: 'study-s37-whole-', model: model.complete });
  for (const source of world.sources) await lib.service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  assert.equal((await settleJob(lib.service, (await lib.service.call('generate', { sourceIds: ids, ...ASK })).jobId)).status, 'complete');
  return { draft: (await lib.service.call('export')).drafts[0], model };
}

/** The run, cut short after its first part; then the retry with the planner `again` (the one that remembers, or a fresh one). */
async function retried(t, ids, again) {
  const hold = gate(), planner = clusteringModel(), first = { ...recorded(planner), planner }; let authors = 0;
  const complete = async (system, prompt, context = {}) => {
    if (system.startsWith('You author') && ++authors === 2 && !hold.entered) { hold.entered = true; await hold.promise; }
    return first.complete(system, prompt, context);
  };
  const live = await openLibrary(t, { model: complete, hold, options: hostOf(complete) });
  for (const source of world.sources) await live.service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  await live.service.call('generate', { sourceIds: ids, ...ASK });
  await soon(async () => (await live.service.call('export')).drafts[0]?.cards.length >= 1 && hold.entered, 'the first part to be saved and the second held');
  const saved = (await live.service.call('export')).drafts[0];
  const calls = []; let next = async system => { calls.push(String(system).slice(0, 30)); throw new Error('a restart must not call a model by itself'); };
  const after = await restartedOver(t, live.root, { options: hostOf((...args) => next(...args)), model: (...args) => next(...args) });
  const [job] = await jobsOf(after.service);
  assert.equal(job.contract.status, 'interrupted');
  assert.deepEqual(calls, [], 'no model call by itself');
  const second = recorded(again(first));
  next = second.complete;
  const done = await settleJob(after.service, (await after.service.call('job.control', { jobId: job.id, action: 'retry' })).attemptId);
  assert.equal(done.status, 'complete', done.stage);
  hold.open();
  return { saved, draft: (await after.service.call('export')).drafts[0], first, second };
}

test('restart, a mixed run killed after its first part, planner that remembers: the retry comes to exactly what the run that was never cut short comes to, card by card', async t => {
  const ids = world.sources.map(source => source.id), whole = await uninterrupted(t, ids);
  const run = await retried(t, ids, first => remembering(clusteringModel(), first.planner.log.quoteOf));
  assert.equal(run.draft.id, run.saved.id, 'the same draft');
  assert.deepEqual(run.draft.cards.slice(0, run.saved.cards.length).map(item => item.id), run.saved.cards.map(item => item.id), 'what was approved stays in place');
  assert.equal(whole.draft.cards.length, 4);
  assert.equal(run.draft.cards.length, whole.draft.cards.length, 'as many as the run that was never cut short');
  assert.deepEqual(run.draft.cards.map(item => item.kind).sort(), whole.draft.cards.map(item => item.kind).sort(), 'the same quizzes and flashcards');
  assert.equal(new Set(objectives(run.draft)).size, 4, 'four different questions: nothing doubled');
  assert.deepEqual(run.draft.editorial.failures ?? [], [], 'and nothing was skipped');
  assert.deepEqual(objectives(run.draft), [...objectives(run.saved), ...run.second.written], 'kept = the saved part + everything the retry wrote: no card written was dropped');
});

test('restart, a mixed run killed after its first part, planner that starts again from 1: the retry skips the one question it planned twice, says so, and loses nothing it wrote', async t => {
  const ids = world.sources.map(source => source.id);
  const run = await retried(t, ids, () => clusteringModel());
  const kept = objectives(run.draft), saved = objectives(run.saved), written = run.second.written;
  assert.equal(saved.length, 1);
  assert.equal(written.length, 3, 'the retry wrote the three parts that were missing');
  // The card that is not kept is the one whose question the draft already held: planned again by a planner that did not remember it.
  const promptsOf = draft => draft.cards.map(item => item.prompt);
  const savedPrompts = promptsOf(run.saved), keptObjectives = new Set(kept);
  const missing = run.second.writtenCards.filter(card => !keptObjectives.has(card.objective));
  assert.deepEqual(missing.map(card => card.prompt), savedPrompts, 'the one written question that is not added asks what the saved one asks: a repeat, not a question of its own');
  assert.equal(kept.length, 3);
  assert.equal(new Set(run.draft.cards.map(item => item.prompt)).size, 3, 'no question twice');
  assert.deepEqual(kept.slice(1), written.filter(objective => missing.every(card => card.objective !== objective)), 'every other written question is kept, in order');
  assert.deepEqual(run.draft.editorial.failures, [SKIPPED], 'the draft says that one was skipped, so it is not a silent loss');
  assert.ok(run.draft.editorial.requested > run.draft.cards.length, 'and the draft still shows that it is short, so 接着做 can top it up');
});
