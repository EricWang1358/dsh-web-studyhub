/* How the executor uses its pure decisions (lib/contexts/generation/run-state.js, run-end.js, run-close.js), seen where a learner sees them: the job and the draft of a real service with a fake model.
   Each test here was checked by removing the wiring it is about, once, by hand: a pure test of the decision cannot see the wire. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { roundList } from '../lib/coverage-run.js';
import { shortfallOf } from '../lib/shortfall.js';
import { SELECTION_CHARS } from '../lib/limits.js';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { settleJob, until } from './helpers/wait.mjs';
import { corpusWorld, CORPUS_ROUND_LIMIT, weighing } from './helpers/record-run-corpus.mjs';

const world = corpusWorld(), PLAN = 'Plan a source-grounded assessment';

/** A library with the world's sources. `model`: what the model does, told the service and the plain fake to fall back on. */
async function open(t, model = (_service, inner) => inner) {
  const root = await mkdtemp(join(tmpdir(), 'study-run-wiring-')), inner = clusteringModel().complete;
  const service = new StudyService(root, { coverage: { roundLimit: CORPUS_ROUND_LIMIT } });
  service.light = weighing;
  service.complete = model(service, inner);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  return service;
}
const draftOf = async service => (await service.call('export')).drafts[0];
const start = (service, over = {}) => service.call('generate', { sourceIds: world.sources.map(source => source.id), coverageLevel: 'standard', kind: 'quiz', ...over });
const inRound = async (service, index) => (await draftOf(service))?.editorial.coverageSpec?.rounds[index]?.status === 'running';
const save = (service, draft, editorial, top = {}) => service.call('draft.save', { deck: { ...draft, ...top, editorial: { ...draft.editorial, ...editorial } }, requireExisting: true });

/** A finished run put back as a host leaves one that lost its closing write. `patch(spec)`: what else the plan should say. */
async function lostItsClosingWrite(service, patch = spec => spec, top = {}) {
  await settleJob(service, (await start(service)).jobId);
  const draft = await draftOf(service), { stop: _stop, ...marker } = draft.editorial.coverageRun;
  return save(service, draft, { coverageRun: { ...marker, state: 'running' }, coverageSpec: patch(draft.editorial.coverageSpec) }, top);
}

test('a run the learner stopped in a round: the row of that round says it was cancelled', async t => {
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const service = await open(t, (lib, inner) => async (system, prompt, context = {}) => {
    if (!entered && system.startsWith(PLAN) && await inRound(lib, 1)) { entered = true; await gate; }
    return inner(system, prompt, context);
  });
  const { jobId } = await start(service);
  await until(() => entered, 'round 2 in flight');
  await service.call('job.control', { jobId, action: 'cancel' });
  release();
  const job = await settleJob(service, jobId), draft = await draftOf(service);
  assert.equal(job.status, 'cancelled');
  assert.equal(draft.editorial.coverageSpec.rounds[1].reason, 'cancelled', 'the round-stopped event carries why');
  assert.equal(draft.editorial.coverageRun.stop.reason, 'learner');
});

test('a run that failed in a round the learner pressed for: the draft keeps what the failure was, for the sentence that says it', async t => {
  let fail = false;
  const service = await open(t, (_lib, inner) => async (system, prompt, context = {}) => {
    if (fail && system.startsWith(PLAN)) throw new Error('503 overloaded');
    return inner(system, prompt, context);
  });
  await settleJob(service, (await start(service, { autoComplete: false })).jobId);
  const draft = await draftOf(service);
  fail = true;
  const job = await settleJob(service, (await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true, autoComplete: false } })).jobId);
  const { stop } = (await draftOf(service)).editorial.coverageRun;
  assert.equal(job.status, 'failed');
  assert.equal(stop.reason, 'round-failed');
  assert.deepEqual([stop.code, stop.detail], ['plan-short', job.stage.slice(0, 200)], 'the stop carries its extra');
  assert.equal(job.retryable, true, 'it can go on: its draft is the checkpoint');
  assert.equal((await draftOf(service)).editorial.generation.runId, job.id, 'it wrote no question, and the draft still says which run it was on: every save of a run names it');
});

test('a run that failed before its first draft has nothing to go on from: no 接着做 is offered', async t => {
  const service = await open(t, (_lib, inner) => async (system, prompt, context = {}) => {
    if (system.startsWith(PLAN)) throw new Error('503 overloaded');
    return inner(system, prompt, context);
  });
  const job = await settleJob(service, (await start(service)).jobId);
  assert.equal(await draftOf(service), undefined);
  assert.equal(job.status, 'failed');
  assert.notEqual(job.retryable, true);
});

test('every save of a run says when: the marker of a finished run is newer than its start', async t => {
  const service = await open(t);
  await settleJob(service, (await start(service)).jobId);
  const { startedAt, updatedAt } = (await draftOf(service)).editorial.coverageRun;
  assert.ok(Date.parse(updatedAt) > Date.parse(startedAt), `${startedAt} -> ${updatedAt}`);
});

test('a supplement is not closed: it still has its publication to do, so 接着做 of a covered plan is refused as ever', async t => {
  const service = await open(t);
  await lostItsClosingWrite(service);
  const first = await draftOf(service), deck = await service.call('draft.publish.quick', { id: first.id, draftVersion: first.draftVersion });
  await lostItsClosingWrite(service, undefined, { mergeTargetId: deck.deckId || deck.id });
  const draft = await draftOf(service);
  await assert.rejects(service.call('supplement', { deckId: deck.deckId || deck.id, resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true } }), /出题计划已经完成|plan of this draft is complete/);
  assert.equal((await draftOf(service)).editorial.coverageRun.state, 'running', 'nothing was written');
});

test('the close looks again when its turn comes: a plan that changed while it waited in the queue is not closed, and the job says so in plain words', async t => {
  let release, held = false, holding = false;
  const gate = new Promise(resolve => { release = resolve; });
  const service = await open(t, (_lib, inner) => async (system, prompt, context = {}) => {
    if (holding && system.startsWith(PLAN)) { held = true; await gate; }
    return inner(system, prompt, context);
  });
  await lostItsClosingWrite(service);
  const draft = await draftOf(service);
  holding = true;
  const other = await start(service, { title: 'Another draft', coverageLevel: undefined, count: 1 });
  await until(() => held, 'another job holds the queue');
  const closing = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true } });
  // While it waits the plan comes to want a section that is not in the material: this is no longer a run with nothing to do.
  const now = (await service.call('export')).drafts.find(item => item.id === draft.id);
  await save(service, now, { coverageSpec: { ...now.editorial.coverageSpec, quotas: [...now.editorial.coverageSpec.quotas, { sectionId: 'a-section-that-is-gone', quota: 1 }] } });
  release();
  await settleJob(service, other.jobId);
  const job = await settleJob(service, closing.jobId);
  assert.equal(job.status, 'failed');
  assert.match(job.stage, /资料或草稿已变化|material or the draft changed/);
  assert.equal((await service.call('export')).drafts.find(item => item.id === draft.id).editorial.coverageRun.state, 'running', 'the draft is left as it stands');
});

test('a fill round in flight when the host stopped is settled by the close: no row of a closed run is pending', async t => {
  const service = await open(t);
  await lostItsClosingWrite(service, spec => ({ ...spec, rounds: [...spec.rounds, { round: spec.rounds.length + 1, questions: 1, sectionIds: [spec.quotas[0].sectionId], fill: true, status: 'running', askedKeys: [spec.quotas[0].sectionId] }] }));
  const draft = await draftOf(service);
  const job = await settleJob(service, (await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true } })).jobId);
  assert.equal(job.status, 'complete', job.stage);
  const closed = await draftOf(service);
  assert.deepEqual(roundList(closed.editorial.coverageSpec).filter(round => round.status === 'pending' || round.status === 'running'), []);
  assert.equal(closed.editorial.coverageSpec.rounds.at(-1).status, 'done');
});

test('an empty row of a plan does not reach the learner as an internal message: the run is closed', async t => {
  const service = await open(t);
  await lostItsClosingWrite(service, spec => ({ ...spec, rounds: [null, ...spec.rounds] }));
  const draft = await draftOf(service);
  const job = await settleJob(service, (await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true } })).jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.ok((await draftOf(service)).editorial.coverageSpec.rounds.every(Boolean));
});

test('what a run closed short owes is asked for a round at a time: more than a round is not refused as nothing missing, and the job keeps the whole goal', async t => {
  const service = await open(t, () => clusteringModel({ readsExisting: true }).complete);
  await settleJob(service, (await start(service)).jobId);
  const draft = await draftOf(service), goal = draft.cards.length + 35;
  await save(service, draft, { requested: goal, coverageSpec: { ...draft.editorial.coverageSpec, goal }, coverageRun: { ...draft.editorial.coverageRun, state: 'stopped', stop: { reason: 'questions-short', round: 1 } } });
  const short = await draftOf(service);
  const reply = await service.call('generate', { resumeDraftId: short.id, draftVersion: short.draftVersion });
  assert.equal(reply.missing, 30);
  const job = await settleJob(service, reply.jobId);
  assert.equal(job.requestedTotal, goal);
});

/** A finished run put back as a close leaves one that owes `owed` more questions. */
async function closedShort(service, owed, over = {}) {
  await settleJob(service, (await start(service, over)).jobId);
  const draft = await draftOf(service), goal = draft.cards.length + owed;
  return save(service, draft, { requested: goal, coverageSpec: { ...draft.editorial.coverageSpec, goal }, coverageRun: { ...draft.editorial.coverageRun, state: 'stopped', stop: { reason: 'questions-short', round: 1 } } });
}
const shortOf = async service => { const draft = await draftOf(service); return { draft, short: shortfallOf({ draft, coverage: (await service.call('coverage.get', { draftId: draft.id })).coverage }) }; };
const press = (service, draft) => service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion });
/** A model for a draft that is pressed: `allow()` says how many more calls come back before the next ones fail. */
const pressing = allow => (_lib, inner) => { const fresh = clusteringModel({ readsExisting: true }).complete; return async (system, prompt, context = {}) => {
  const left = allow();
  if (left === null) return inner(system, prompt, context);
  if (left.calls-- <= 0) throw new Error('503 overloaded');
  return fresh(system, prompt, context);
}; };

test('the reply of a close says what is missing, and the close leaves the number the next press counts from', async t => {
  const service = await open(t);
  await lostItsClosingWrite(service, spec => ({ ...spec, goal: 40 }));
  const draft = await draftOf(service);
  assert.ok(draft.editorial.requested < 40, 'the number of the first round until now');
  const reply = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { run: true } });
  assert.equal(reply.missing, 40 - draft.cards.length);
  await settleJob(service, reply.jobId);
  assert.equal((await draftOf(service)).editorial.requested, 40);
});

test('a press that falls short keeps the action, whatever came of its job; the goal met clears it', async t => {
  let budget = null;
  const service = await open(t, pressing(() => budget));
  const kept = (await closedShort(service, 13)).cards.length;
  budget = { calls: 9 };
  const first = (await shortOf(service)).draft, job = await settleJob(service, (await press(service, first)).jobId);
  const { draft, short } = await shortOf(service);
  assert.ok(draft.cards.length > kept && draft.cards.length < kept + 13, `${kept} -> ${draft.cards.length} (${job.status}: ${job.stage})`);
  assert.equal(draft.editorial.coverageRun.stop.reason, 'questions-short', 'its saves carry the state');
  assert.deepEqual([short.questionsGoal, short.action, short.continueKind, short.canContinue, short.reason], [kept + 13, 'continue', 'count', true, 'questions-short']);
  budget = { calls: 999 };
  await settleJob(service, (await press(service, draft)).jobId);
  const end = await shortOf(service);
  assert.equal(end.draft.cards.length, kept + 13);
  assert.deepEqual([end.draft.editorial.coverageRun.state, end.draft.editorial.coverageRun.stop.reason, end.short.ready, end.short.action, end.short.percent], ['complete', 'complete', true, null, 100]);
});

test('a job that failed on a draft closed short leaves the same action', async t => {
  let budget = null;
  const service = await open(t, pressing(() => budget));
  await closedShort(service, 5);
  budget = { calls: 0 };
  const before = (await shortOf(service)).draft, job = await settleJob(service, (await press(service, before)).jobId);
  const { draft } = await shortOf(service), { coverage } = await service.call('coverage.get', { draftId: draft.id });
  const short = shortfallOf({ draft, coverage, job });
  assert.deepEqual([job.status, short.action, short.continueKind, short.canContinue], ['failed', 'continue', 'count', true]);
});

test('above one round: each press asks for a round of questions and the action stays until the goal; the estimate prices the same press', async t => {
  const service = await open(t, () => clusteringModel({ readsExisting: true }).complete);
  await closedShort(service, 35);
  const { draft, short } = await shortOf(service);
  assert.deepEqual([short.questionsMissing, short.continueCount], [35, 30]);
  const cost = async deck => (await service.call('usage.estimate', { feature: 'generate', resumeDraftId: deck.id, draftVersion: deck.draftVersion })).totalTokens;
  const priced = await cost(draft);
  const asThirty = await save(service, draft, { requested: draft.cards.length + 30 });
  assert.deepEqual(await cost(asThirty), priced, 'a press above one round is priced as one round');
  const back = await save(service, asThirty, { requested: draft.cards.length + 35 });
  const reply = await press(service, back);
  assert.equal(reply.missing, short.continueCount, 'the number on the button is the number of the job');
  await settleJob(service, reply.jobId);
  const after = await shortOf(service);
  assert.equal(after.short.questionsGoal, draft.cards.length + 35);
  assert.equal(after.short.action, after.short.questionsMissing > 0 ? 'continue' : null);
});

const LONG = 'Filler paragraph about the topic that a learner would have in a long book. '.repeat(Math.ceil(SELECTION_CHARS / 75)).slice(0, SELECTION_CHARS - 10);

test('a continuation of a coverage run has the limit of the run: a selection above the limit of a plain run is not refused, and the estimate does not call it over', async t => {
  const service = await open(t, () => clusteringModel({ readsExisting: true }).complete);
  await closedShort(service, 2);
  await service.call('source.add', { id: 'big', title: 'big', text: LONG });
  const draft = await draftOf(service), saved = await save(service, draft, { generation: { ...draft.editorial.generation, sourceIds: [...draft.editorial.generation.sourceIds, 'big'] } });
  assert.equal((await service.call('usage.estimate', { feature: 'generate', resumeDraftId: saved.id, draftVersion: saved.draftVersion })).blocked, undefined);
  const reply = await press(service, saved);
  assert.equal(reply.missing, 2);
  await settleJob(service, reply.jobId);
});

test('the job card prices a press above the limit of a plain run the same as the form did', async t => {
  const service = await open(t, () => clusteringModel({ readsExisting: true }).complete);
  await closedShort(service, 13);
  const ids = ['big0', 'big1', 'big2', 'big3'];
  for (const id of ids) await service.call('source.add', { id, title: id, text: 'Filler paragraph about the topic that a learner would have in a long book.\n\n'.repeat(7663) });
  const draft = await draftOf(service), saved = await save(service, draft, { generation: { ...draft.editorial.generation, sourceIds: [...draft.editorial.generation.sourceIds, ...ids] } });
  const form = await service.call('usage.estimate', { feature: 'generate', resumeDraftId: saved.id, draftVersion: saved.draftVersion });
  const reply = await press(service, saved);
  const { estimate } = (await service.call('snapshot')).jobs.find(job => job.id === reply.jobId || job.contract?.jobId === reply.jobId);
  assert.ok(Math.abs(estimate.totalTokens.high - form.totalTokens.high) < form.totalTokens.high * 0.05, `form ${form.totalTokens.high}, job ${estimate.totalTokens.high}`);
  await settleJob(service, reply.jobId);
});

test('a plain run keeps the limit of a plain run', async t => {
  const service = await open(t, () => clusteringModel({ readsExisting: true }).complete);
  await settleJob(service, (await start(service, { coverageLevel: undefined, count: 2, title: 'Plain' })).jobId);
  await service.call('source.add', { id: 'big', title: 'big', text: LONG });
  const draft = await draftOf(service);
  assert.equal(draft.editorial.coverageSpec, undefined);
  const saved = await save(service, draft, { requested: draft.cards.length + 2, generation: { ...draft.editorial.generation, sourceIds: [...draft.editorial.generation.sourceIds, 'big'] } });
  await assert.rejects(press(service, saved), /the limit is/);
});

test('several kinds: a press that falls short, then another: the split comes from what the draft holds, never a stale one the job refuses', async t => {
  let budget = null;
  const service = await open(t, pressing(() => budget));
  const kept = (await closedShort(service, 8, { kinds: ['quiz', 'flashcard'], kind: undefined })).cards.length;
  budget = { calls: 9 };
  const first = (await shortOf(service)).draft, one = await settleJob(service, (await press(service, first)).jobId);
  assert.doesNotMatch(String(one.stage), /Invalid mixed/);
  budget = { calls: 999 };
  const { draft, short } = await shortOf(service);
  assert.ok(draft.cards.length >= kept);
  assert.equal(short.action, short.questionsMissing > 0 ? 'continue' : null);
  if (short.questionsMissing) assert.doesNotMatch(String((await settleJob(service, (await press(service, draft)).jobId)).stage), /Invalid mixed/);
});
