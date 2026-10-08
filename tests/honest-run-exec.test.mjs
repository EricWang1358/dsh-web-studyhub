import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { roundList, REPEAT_LIMIT, FILL_ROUNDS } from '../lib/coverage-run.js';
import { shortfallOf } from '../lib/shortfall.js';
import { settleJob } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { stuckRun, refusePlannerUntilFill } from './helpers/staggered-refusals.mjs';

/* The honest states of a coverage run (the evaluation of 2026-10-06): D-15 a last planned round that covers nothing does not end the run before its bounded fill rounds, and the stop
   says how many sections are left; D-16 a section that fails again and again is remembered on the plan and left to the learner (after REPEAT_LIMIT tries; sooner when a retry round gains no section at all); D-5 a refused key is one plain
   typed cause, and the run can be continued once the key is fixed; D-1 a stopped run is never 100%. Fake models only; the round size is injected (a run is a few seconds). */

const world = mergedTranscript({ recordings: 2, parts: 6, paragraphs: 4 });
const PLAN = 'Plan a source-grounded assessment', REVIEW = 'Act as a strict assessment editor';
const refusal = () => Object.assign(new Error('401 Unauthorized: Invalid API key'), { status: 401 });

async function library(t, { model = clusteringModel(), wrap, coverage = { roundLimit: 8 } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-honest-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { coverage });
  t.after(() => service.dispose());
  service.complete = wrap ? wrap(model.complete, service) : model.complete;
  service.light = async (system, prompt) => JSON.stringify({ sections: JSON.parse(prompt.split('\n\n')[0]).sections.map(item => ({ id: item.id, importance: 3, kind: 'definition', reason: `Reason for ${item.title}` })) });
  for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  return { service, ids: world.sources.map(source => source.id) };
}
const draftOf = async service => (await service.call('export')).drafts[0];
const contractOfJob = async (service, jobId) => (await service.call('snapshot')).jobs.find(job => job.id === jobId)?.contract;
const statuses = draft => roundList(draft.editorial.coverageSpec).map(round => `${round.fill ? 'fill:' : ''}${round.status}`);
const planned = (service, draft = null) => service.call('export').then(state => (draft || state.drafts[0])?.editorial?.coverageSpec?.rounds || []);

/** A model wrapper: while `when(rounds)` (the rounds of the draft being run, as the draft says them) holds, the planner answers 'insufficient evidence' for every call. */
const planRefusedWhile = when => (complete, service) => async (system, prompt, context = {}) => {
  if (system.startsWith(PLAN) && when(await planned(service))) return JSON.stringify({ error: 'insufficient evidence' });
  return complete(system, prompt, context);
};
const running = (rounds, predicate) => rounds.some((round, index) => round.status === 'running' && predicate(round, index));

test('D-15: the LAST planned round covers nothing: the run writes the sections again in a fill round before it says "no progress"', async (t) => {
  const { service, ids } = await library(t, { wrap: planRefusedWhile(rounds => running(rounds, (round, index) => !round.fill && index === 2)) });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = await draftOf(service);
  assert.deepEqual(statuses(draft), ['done', 'done', 'failed', 'fill:done'], 'the failed last round did not end the run: the fill round wrote its sections');
  assert.equal(draft.editorial.coverageRun.state, 'complete');
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.equal(view.coverage.covered, view.coverage.leaves);
});

test('D-15: a planned round that covers nothing, with another planned round behind it, still stops the run (once), and the stop says how many sections are left', async (t) => {
  const { service, ids } = await library(t, { wrap: planRefusedWhile(rounds => running(rounds, (round, index) => !round.fill && index === 1)) });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  assert.equal((await settleJob(service, started.jobId)).status, 'complete');
  const draft = await draftOf(service), run = draft.editorial.coverageRun;
  assert.deepEqual(statuses(draft), ['done', 'failed', 'pending'], 'no fill round: a planned round is still waiting');
  assert.equal(run.state, 'stopped');
  assert.equal(run.stop.reason, 'no-progress');
  const view = await service.call('coverage.get', { draftId: draft.id });
  const left = view.coverage.leaves - view.coverage.covered;
  assert.ok(left > 0);
  assert.equal(run.stop.left, left, 'the stop knows how many sections have no question');
  const contract = await contractOfJob(service, started.jobId);
  assert.equal(contract.events.find(event => event.code === 'run-stop').args.left, left, 'and so does the log line');
  assert.ok(contract.progress.percent < 100, `a stopped run is not 100% (${contract.progress.percent})`);
});

test('D-16: a section whose review fails every time is retried by ONE fill round, which gains nothing and ends the run; the plan remembers it with its reason and the learner is offered the top-up', async (t) => {
  let broken = 0;
  const wrap = complete => async (system, prompt, context = {}) => {
    if (system.startsWith(REVIEW) && JSON.parse(prompt).candidate.cards.some(card => card.citations.some(citation => /Recording 1, part 2, point/.test(citation.quote)))) { broken += 1; return '{"issues":'; }
    return complete(system, prompt, context);
  };
  const { service, ids } = await library(t, { wrap });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = await draftOf(service), spec = draft.editorial.coverageSpec, run = draft.editorial.coverageRun;
  const fills = roundList(spec).filter(round => round.fill);
  assert.equal(fills.length, 1, 'the planned round and one fill round tried it; the fill round gained no section, so a second one would only repeat it');
  const view = await service.call('coverage.get', { draftId: draft.id });
  const open = view.coverage.sections.filter(item => item.state !== 'covered');
  assert.ok(open.length > 0, 'the sections whose review never comes back are still without a question');
  for (const section of open) assert.deepEqual(spec.attempts[section.key], { n: 1 + fills.length, reason: 'review-protocol', round: fills[0].round, rounds: [{ round: spec.attempts[section.key].rounds[0].round }, { round: fills[0].round, fill: true }] }, `${section.key}: the planned round and the retry, typed, with the rounds they were made in, on the plan`);
  assert.ok(1 + fills.length < REPEAT_LIMIT, 'the run ended with attempts to spare: the retry gained nothing');
  assert.equal(run.state, 'stopped');
  assert.equal(run.stop.reason, 'no-progress');
  assert.equal(run.stop.left, open.length);
  const found = shortfallOf({ draft, coverage: view.coverage, round: view.round });
  assert.equal(found.state, 'stopped');
  assert.equal(found.reason, 'no-progress');
  assert.equal(found.action, 'topup', 'left to the learner: the one action offered is 为没覆盖的部分补题');
  assert.equal(found.sectionsUncovered, open.length);
  assert.ok(broken > 0);
});

test('D-16: a section whose review never comes back usable is written again by every fill round that still gains a section, until it has REPEAT_LIMIT failed attempts; then it is listed with its reason and left to the learner', async (t) => {
  // The owner's report (「自动补到完整」 ticked, 92%): the stuck section is part REPEAT_LIMIT + 1; the helpers before it come out one fill round later each (tests/helpers/staggered-refusals.mjs), so every fill round gains a section
  // and the run goes on. Small batches (2 questions): the review of the stuck section's batch must not take a helper's question with it.
  const { stuck, freeFrom } = stuckRun();
  let broken = 0;
  const reviewBroken = new RegExp(`Recording 1, part ${stuck}, point`);
  const wrap = (complete, service) => refusePlannerUntilFill(freeFrom)(async (system, prompt, context = {}) => {
    if (system.startsWith(REVIEW) && JSON.parse(prompt).candidate.cards.some(card => card.citations.some(citation => reviewBroken.test(citation.quote)))) { broken += 1; return '{"issues":'; }
    return complete(system, prompt, context);
  }, service);
  const { service, ids } = await library(t, { wrap });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', performance: { batchSize: 2 } });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = await draftOf(service), spec = draft.editorial.coverageSpec, run = draft.editorial.coverageRun;
  const fills = roundList(spec).filter(round => round.fill);
  assert.equal(fills.length, REPEAT_LIMIT - 1, 'the planned round and REPEAT_LIMIT - 1 fill rounds: the run went on while each fill round gained a section');
  assert.ok(fills.length <= FILL_ROUNDS);
  assert.ok(fills.every(round => round.covered >= 1), 'every fill round gained at least one section');
  const view = await service.call('coverage.get', { draftId: draft.id });
  const open = view.coverage.sections.filter(item => item.state !== 'covered');
  assert.equal(open.length, 1, 'only the stuck section has no question');
  assert.ok(open[0].key.endsWith(`.p${stuck}`), open[0].key);
  const record = spec.attempts[open[0].key];
  assert.deepEqual(record, { n: REPEAT_LIMIT, reason: 'review-protocol', round: fills.at(-1).round, rounds: [{ round: record.rounds[0].round }, ...fills.map(round => ({ round: round.round, fill: true }))] }, 'REPEAT_LIMIT failed attempts, typed, with the rounds they were made in');
  assert.ok(Object.values(spec.attempts).every(item => item.n <= REPEAT_LIMIT), 'no section was tried more often than REPEAT_LIMIT');
  assert.equal(run.state, 'stopped');
  assert.equal(run.stop.reason, 'sections-left');
  assert.equal(run.stop.left, 1);
  const found = shortfallOf({ draft, coverage: view.coverage, round: view.round });
  assert.deepEqual(found.repeating.map(item => [item.key, item.reason, item.attempts]), [[open[0].key, 'review-protocol', REPEAT_LIMIT]], 'listed as failing again and again');
  assert.equal(found.state, 'stopped');
  assert.equal(found.reason, 'sections-left');
  assert.equal(found.action, 'topup');
  assert.ok(broken > 0);
});

test('D-5: a refused key stops the run with ONE typed cause (credential), not the provider\'s English per part; the draft keeps what passed and 接着做 goes on once the key works', async (t) => {
  let revoked = true;
  const wrap = (complete, service) => async (system, prompt, context = {}) => {
    if (revoked && system.startsWith(PLAN) && running(await planned(service), (round, index) => index >= 1)) throw refusal();
    return complete(system, prompt, context);
  };
  const { service, ids } = await library(t, { wrap });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'failed');
  const draft = await draftOf(service), run = draft.editorial.coverageRun;
  assert.equal(run.state, 'stopped');
  assert.equal(run.stop.reason, 'refused');
  assert.equal(run.stop.code, 'credential', 'the failure is typed, so every screen says it in its own words');
  assert.ok(!('detail' in run.stop) || !/Part \d+:.*Part \d+:/s.test(run.stop.detail), 'no per-part English list on the stop');
  assert.equal(roundList(draft.editorial.coverageSpec)[1].code, 'credential', 'the round that was refused carries the code too');
  assert.ok(draft.cards.length > 0, 'what passed is kept');
  const contract = await contractOfJob(service, started.jobId);
  assert.equal(contract.status, 'failed');
  assert.equal(contract.actions.retry.available, true, '接着做 is offered after a refusal: the next round is still there');
  assert.ok(contract.progress.percent < 100);
  assert.equal(shortfallOf({ draft, coverage: (await service.call('coverage.get', { draftId: draft.id })).coverage, job: { ...job, coverageRun: contract.detail.run } }).action, 'model-settings');
  // The learner fixes the key.
  revoked = false;
  const reply = await service.call('job.control', { jobId: started.jobId, action: 'retry' });
  assert.equal((await settleJob(service, reply.jobId)).status, 'complete');
  const done = await draftOf(service);
  assert.equal(done.editorial.coverageRun.state, 'complete');
  assert.equal(done.cards.length, done.editorial.coverageSpec.goal, 'the rounds not done were made; nothing doubled');
  assert.deepEqual((await service.call('snapshot')).jobs.filter(job => job.draftId === done.id).map(job => job.status), ['complete'], 'the refused run is continued, not left on the list beside its continuation');
});
