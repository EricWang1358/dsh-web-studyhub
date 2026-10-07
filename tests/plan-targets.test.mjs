import test from 'node:test';
import assert from 'node:assert/strict';
import { generateBatched } from '../lib/batch.js';
import { PLAN_TARGET_LIMITS, mergePlanTargets, readPlanTargets } from '../lib/plan-targets.js';
import { planTargetsOf } from '../lib/plan-target-record.js';
import { jobContract } from '../lib/job-contract.js';
import { injectedModel, source } from './helpers/review-injector.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';

/* The knowledge points a question run planned (the planning stage's own targets, no extra model call) reach the job as `planTargets` and the contract as `detail.targets`:
   compact (objective clipped, a source reference), bounded, and with the state each point reached. */

const run = (model, request = {}) => generateBatched(model.complete, { count: 10, kind: 'quiz', sources: [source], performance: { concurrency: 1, batchSize: 5, fillRounds: 0 }, ...request });

test('the run announces its targets when the plan returns and again as each part settles, in the compact shape', async () => {
  const seen = [];
  const model = injectedModel({ review: ({ part }) => (part === 2 ? '{"issues":' : undefined) });
  await run(model, { onTargets: (record) => seen.push(structuredClone(record)) });
  assert.ok(seen.length >= 2, 'at least the plan and the end');
  const first = seen[0];
  assert.equal(first.list.length, 10, 'every planned point of both parts');
  assert.ok(first.list.every((item) => item.state === 'planned'), 'nothing is decided when the plan has just returned');
  assert.ok(first.list.every((item) => item.id && item.objective && item.part >= 1), 'id, objective and part');
  assert.equal(first.list[0].source.sourceId, 's');
  assert.equal(first.list[0].source.title, 'Course notes');
  const last = seen.at(-1);
  assert.deepEqual(last.list.filter((item) => item.part === 1).map((item) => item.state), Array(5).fill('kept'));
  const failed = last.list.filter((item) => item.part === 2);
  assert.equal(failed.length, 5);
  assert.ok(failed.every((item) => item.state === 'failed' && item.reason === 'review-protocol'), 'a failed point says why, with the code the log already uses');
});

test('nobody listening costs nothing: no onTargets, same run', async () => {
  const deck = await run(injectedModel());
  assert.equal(deck.cards.length, 10);
});

const entry = (index, extra = {}) => ({ part: Math.floor(index / 5) + 1, id: `t${index}`, objective: `Point ${index} ${'x'.repeat(300)}`, state: 'planned', source: { sourceId: 's', title: 'T'.repeat(200), page: index + 1 }, ...extra });

test('merging keeps other rounds, replaces its own, clips every string and stops at the bound with a count of the rest', () => {
  const one = mergePlanTargets(null, 1, { list: Array.from({ length: 5 }, (_, i) => entry(i)), short: [] });
  assert.equal(one.list.length, 5);
  assert.ok(one.list.every((item) => item.round === 1 && item.objective.length <= PLAN_TARGET_LIMITS.objective && item.source.title.length <= PLAN_TARGET_LIMITS.title));
  const two = mergePlanTargets(one, 2, { list: Array.from({ length: 4 }, (_, i) => entry(i, { id: `r${i}` })), short: [] });
  assert.deepEqual([...new Set(two.list.map((item) => item.round))], [1, 2], 'round 1 stayed');
  const again = mergePlanTargets(two, 2, { list: [entry(0, { id: 'only', state: 'kept' })], short: [] });
  assert.equal(again.list.filter((item) => item.round === 2).length, 1, 'the new announcement of round 2 replaces the old one');
  const big = mergePlanTargets(null, undefined, { list: Array.from({ length: 450 }, (_, i) => entry(i)), short: [] });
  assert.equal(big.list.length, PLAN_TARGET_LIMITS.targets);
  assert.equal(big.more, 150);
  assert.equal(big.list[0].round, undefined, 'a plain run has no round');
});

test('a part that came back short is told as numbers, not as a target', () => {
  const planned = [{ sources: [], count: 3, short: [{ key: 'sec', quota: 3, planned: 1 }] }];
  const record = planTargetsOf({ planned, outcomes: [{ error: 'The plan came back short (plan-short): 1 of 3', final: true }], plans: new Map(), tries: new Map(), notes: new Map() });
  assert.deepEqual(record.list, []);
  assert.deepEqual(record.short, [{ part: 1, needed: 3, got: 1 }]);
});

test('the reader makes anything safe: junk is dropped, strings clipped, an old job (nothing recorded) is null', () => {
  assert.equal(readPlanTargets(undefined), null);
  assert.equal(readPlanTargets({ list: 'no' }), null);
  assert.equal(readPlanTargets({ list: [] }), null, 'nothing to list');
  const read = readPlanTargets({ list: [entry(0), { id: 5 }, null, entry(1, { state: 'weird' }), entry(2, { reason: 'quote', state: 'failed' })], more: 'x', short: [{ part: 1, needed: 3, got: 1 }, { part: 'a' }] });
  assert.deepEqual(read.list.map((item) => item.id), ['t0', 't1', 't2']);
  assert.equal(read.list[1].state, 'planned', 'an unknown state is not claimed');
  assert.equal(read.list[2].reason, 'quote');
  assert.equal(read.more, undefined);
  assert.deepEqual(read.short, [{ part: 1, needed: 3, got: 1 }]);
});

// The run itself: the job a real (fake-model) generation leaves carries the points and their states, in the contract too.
const EFFORTS = { effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' };
test('a real run records planTargets on the job, bounded and with every point decided at the end', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-plan-targets-')), previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'home');
  const fake = createFakeModel({ latencyMs: 5, usage: true });
  const service = new StudyService(root, { complete: (system, prompt, context = {}) => fake(system, prompt, context), coach: false, language: 'zh' });
  t.after(async () => {
    await service.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const text = 'Microservices split a system into independently deployable services that own their data. Event-driven architecture lets services react to events published by others. ';
  const material = await service.call('source.add', { title: 'Service architecture', text: text.repeat(3) });
  const started = await service.call('generate', { sourceIds: [material.id], count: 5, kind: 'quiz', title: 'Plan', concurrency: 1, batchSize: 2, jobTimeoutMinutes: 5, fillRounds: 2, ...EFFORTS,
    performance: { concurrency: 1, batchSize: 2, jobTimeoutMinutes: 5, fillRounds: 2, ...EFFORTS } });
  const job = await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 });
  assert.equal(job.status, 'complete', job.stage);
  const { list } = job.planTargets;
  assert.ok(list.length >= 5 && list.length <= PLAN_TARGET_LIMITS.targets);
  assert.ok(list.every((item) => item.objective.length <= PLAN_TARGET_LIMITS.objective && item.source?.sourceId === material.id && item.source.title === 'Service architecture'));
  assert.equal(list.filter((item) => item.state === 'kept').length, 5, 'the five questions that were kept are the five points that passed');
  assert.deepEqual(jobContract(job).detail.targets.list.map((item) => item.id), list.map((item) => item.id));
});

test('the contract carries it as detail.targets; a job without it has none', () => {
  const base = { id: 'g', status: 'running', deckTitle: 'D', requestedTotal: 5, parts: 1, startedAt: '2026-10-05T10:00:00.000Z' };
  assert.equal(jobContract(base).detail.targets, null);
  const withTargets = jobContract({ ...base, planTargets: { list: [entry(0)] } }).detail.targets;
  assert.equal(withTargets.list.length, 1);
  assert.equal(withTargets.list[0].objective.length, PLAN_TARGET_LIMITS.objective);
});
