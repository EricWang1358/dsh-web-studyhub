/* S4-4: a batch of 为你定制 as a Job of the unified runtime (runtime.pilot.coach). The characterization suites (coach, coach-daily, the S4-0 baseline) run on
   both sides of the switch through their `.runtime.test.mjs` twins; this file holds what only the runtime path has: the Job itself, its stop, its usage. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createModelGateway } from '../lib/jobs/gateway.js';
import { gatewayModel } from '../lib/gateway-model.js';
import { createJobServices } from '../lib/runtime/jobs.js';
import { createRuntimeWork } from '../lib/runtime/work.js';
import { dayOf } from '../lib/coach-daily.js';
import { usageLedger } from '../lib/model-usage.js';
import { reportUsage } from '../lib/usage-scope.js';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { lightModel, miss, seed } from './helpers/coach-library.mjs';
import { until } from './helpers/wait.mjs';

async function library(t, { runtime = true, model = lightModel() } = {}) {
  const root = await privateRoot(t, 'coach-runtime-');
  const { starts: _starts, ...options } = runtime ? managedRuntimeOptions({ complete: model.complete, paths: ['coach'] }) : {};
  const service = new StudyService(root, { complete: model.complete, completeLight: model.complete, coach: true, ...options });
  t.after(() => service.dispose());
  const call = (action, args) => service.call(action, args);
  await seed(call);
  return { root, service, call, model };
}
const batchJobs = service => [...service.runtime.work.jobs.values()].filter(job => job.type === 'coach-prep');
const dayRow = async call => (await call('snapshot', {})).jobs.find(job => job.type === 'coach-daily');
const prepare = async (call, refs) => { await call('coach.variants', { cards: refs, consent: true }); await call('coach.prepare'); };

test('with the switch on a batch is one Job: its Call, its usage once, its day, hidden as a row of its own', async t => {
  const f = await library(t), refs = await miss(f.call, 3);
  const ledger = usageLedger(f.root), before = (await ledger.summary({ days: 1 })).byFeature.coach?.calls || 0;
  await prepare(f.call, refs);
  const [job] = batchJobs(f.service), contract = job.contract;
  assert.equal(batchJobs(f.service).length, 1);
  assert.deepEqual([contract.kind, contract.status, contract.result.completeness, contract.runtime.attempts.length], ['coach-prep', 'complete', 'complete', 1]);
  assert.equal(contract.capabilities.executionModes.join(), 'direct');
  const [call] = contract.calls;
  assert.deepEqual([contract.calls.length, call.kind, call.feature, call.requestedEffort, call.runner, call.observation.boundary], [1, 'prep', 'coach', 'lowest', 'direct', 'host-attempt']);
  assert.ok(call.tokens > 0, 'the usage the host reported rides on the Call');
  const row = await dayRow(f.call), day = row.contract.detail;
  assert.equal(day.batches.length, 1);
  assert.equal(day.batches[0].id, contract.jobId, 'the batch of the day and the Job are named alike');
  assert.equal(day.batches[0].tokens.input + day.batches[0].tokens.output + day.batches[0].tokens.cache, call.tokens);
  assert.deepEqual((await f.call('snapshot', {})).jobs.map(item => item.type), ['coach-daily'], 'a batch is still no row of the console');
  assert.equal((await f.call('job.status', { jobId: contract.jobId })).status, 'complete', 'but its id answers to the job tools');
  const summary = await ledger.summary({ days: 1 });
  assert.equal(summary.byFeature.coach.calls - before, 1, 'the usage ledger counted the batch once, by the gateway');
  const archived = await f.call('job.archive', { all: true });
  assert.deepEqual(archived.archived, [], 'a part of the day is never archived');
  assert.deepEqual((await f.call('job.archive', { jobId: job.id })).skipped, [{ id: job.id, reason: 'not-archivable' }]);
});

test('with the switch on but no live executor a batch fails in plain words and the day is not touched', async t => {
  const model = lightModel(), root = await privateRoot(t, 'coach-runtime-none-');
  const service = new StudyService(root, { complete: model.complete, completeLight: model.complete, coach: true, runtimePilot: { coach: true }, workOwner: Symbol('owner') });
  t.after(() => service.dispose());
  const call = (action, args) => service.call(action, args);
  await seed(call);
  const before = model.options.length;
  await call('coach.variants', { cards: await miss(call, 3), consent: true });
  await until(async () => (await call('coach.status')).preparing === false, 'the batch to end');
  const [task] = (await call('coach.status')).tasks;
  assert.deepEqual([task.status, task.message], ['failed', '后台执行器暂时不可用，请稍后再试']);
  assert.equal(await dayRow(call), undefined); assert.equal(model.options.length, before);
});

test('with the switch off no Job exists and the batches are as they were', async t => {
  const f = await library(t, { runtime: false });
  await prepare(f.call, await miss(f.call, 3));
  assert.equal(batchJobs(f.service).length, 0);
  assert.equal((await dayRow(f.call)).contract.detail.batches.length, 1);
});

test('cancelling one batch stops only it: the batch behind it, the prepared cards and the learner\'s record are untouched', async t => {
  const f = await library(t), refs = await miss(f.call, 5), hold = f.model.arm(), before = f.model.options.length;
  const attempts = (await f.call('export')).attempts.length;
  await f.call('coach.variants', { cards: refs, consent: true });
  await until(() => f.model.options.length === before + 1, 'the first batch to reach the model');
  const [first] = batchJobs(f.service);
  assert.equal(first.contract.status, 'running');
  const reply = await f.call('job.control', { jobId: first.contract.jobId, action: 'cancel' });
  assert.equal(reply.action, 'cancel');
  await until(async () => (await f.call('coach.status')).preparing === false, 'both batches to end');
  hold.release();
  assert.equal(first.contract.status, 'cancelled'); assert.equal(first.contract.endReason, 'user-cancel');
  assert.equal(f.model.options[before].signal.aborted, true, 'the stop reached the request');
  const [cancelled, second] = (await dayRow(f.call)).contract.detail.batches;
  assert.deepEqual([cancelled.status, cancelled.reason, second.status, second.targets], ['skipped', 'cancelled', 'ok', 2]);
  const exported = await f.call('export');
  assert.equal(exported.prepared.filter(item => item.status === 'ready').length, 2, 'only the second batch wrote cards');
  assert.equal(exported.attempts.length, attempts);
  const view = await f.call('coach.status');
  assert.equal(view.failedCards.length, 3); assert.match(view.failedCards[0].message, /已取消/);
});

test('a failing batch says the same thing everywhere: the task, the Job, the day', async t => {
  const f = await library(t, { model: { complete: async () => { throw new Error('unprocessable request'); } } });
  await f.call('coach.variants', { cards: await miss(f.call, 3), consent: true });
  await until(async () => (await f.call('coach.status')).preparing === false, 'the batch to end');
  const [job] = batchJobs(f.service), task = (await f.call('coach.status')).tasks.find(item => item.kind === 'prep');
  const [batch] = (await dayRow(f.call)).contract.detail.batches;
  assert.deepEqual([task.status, job.contract.status, batch.status, batch.reason], ['failed', 'failed', 'failed', 'error']);
  assert.deepEqual([job.contract.error.message, job.contract.detail.legacy.message, batch.message], [task.message, task.message, task.message]);
  assert.equal(job.contract.calls[0].status, 'failed');
});

test('a batch is booked on the day its call began, and its usage once', async t => {
  const model = lightModel(), complete = model.complete; let crossing = false;
  model.complete = async (...args) => { const reply = await complete(...args); if (crossing) t.mock.timers.tick(20_000); return reply; };
  const f = await library(t, { model }), refs = await miss(f.call, 3);
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 5, 23, 59, 50).getTime() }); crossing = true;
  await prepare(f.call, refs);
  assert.equal(dayOf(Date.now()), '2026-10-06', 'the call ended after midnight');
  const { days } = JSON.parse(await readFile(join(f.root, 'model-usage.json'), 'utf8'));
  assert.deepEqual(Object.entries(days).filter(([, features]) => features.coach).map(([date, features]) => [date, features.coach.at(-1)]), [['2026-10-05', 1]]);
  const rows = (await f.call('snapshot', {})).jobs.filter(job => job.type === 'coach-daily');
  assert.deepEqual(rows.map(item => item.id), ['coach:2026-10-05'], 'the day row is the day the batch began');
});

test('the parts of a day are no rows, are never archived and only the newest few stay in the table', () => {
  const work = createRuntimeWork(), services = createJobServices(work);
  for (let index = 0; index < 25; index++) {
    const id = `part-${index}`;
    work.jobs.set(id, { id, root: '/library', type: 'coach-prep', status: 'complete', listedIn: 'coach-daily', startedAt: new Date(Date.UTC(2026, 9, 5, 0, index)).toISOString() });
  }
  work.jobs.set('own', { id: 'own', root: '/library', type: 'translation', status: 'complete', startedAt: '2026-10-04T00:00:00.000Z' });
  services.pruneJobs();
  assert.equal([...work.jobs.values()].filter(job => job.listedIn).length, 20);
  assert.ok(work.jobs.has('part-24') && !work.jobs.has('part-0') && work.jobs.has('own'));
});

test('gatewayModel: one Step, one observed host attempt; the Step signal and the usage cross over', async () => {
  const record = structuredClone(goldenRuntimeContracts.running); record.calls = []; record.runtime.steps = [];
  const controller = new AbortController(), booked = [];
  const context = { jobId: record.jobId, attemptId: record.attemptId, signal: controller.signal, assertCurrent: () => controller.signal.throwIfAborted() };
  const gateway = createModelGateway({ context, record, host: {}, ledger: call => { booked.push(call); } });
  const seen = [];
  const model = async (system, prompt, options) => { seen.push(options); reportUsage({ uncachedInputTokens: 4, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }); return `${system}/${prompt}`; };
  const policy = { purpose: 'prep', feature: 'coach', requestedEffort: 'lowest', executionMode: 'direct', budget: null };
  const complete = gatewayModel(gateway, { stepKey: 'variants:1', policyFor: options => ({ ...policy, requestedEffort: options.reasoningEffort ?? 'lowest' }) }, model);
  assert.equal(await complete('s', 'p', { maxTokens: 9, reasoningEffort: 'high' }), 's/p');
  assert.deepEqual([seen[0].maxTokens, seen[0].reasoningEffort, seen[0].signal instanceof AbortSignal], [9, 'high', true]);
  const [call] = record.calls;
  assert.deepEqual([call.requestedEffort, call.tokens, call.tokenUsage.calls, booked.length], ['high', 5, undefined, 1]);
  controller.abort();
  await assert.rejects(() => complete('s', 'p'));
});

test('the light model\'s hedged request stops with the caller\'s signal', async t => {
  let modelCompletion;
  try { ({ modelCompletion } = await import('../lib/index.js')); }
  catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('@deepseek-ai')) { t.skip('Host SDK absent'); return; } throw error; }
  const started = Promise.withResolvers();
  const ctx = { llm: { resolveModelInfo: async () => ({ reasoning: { efforts: [] } }), resolveCallConfig: async config => config,
    async *stream({ signal }) { started.resolve(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); yield { type: 'text-delta', text: '' }; } } };
  const light = modelCompletion(ctx, () => ({ provider: 'p', model: 'm' }), 's', { light: true, lightTimeoutMs: 60_000, hedgeMs: 60_000 });
  const controller = new AbortController(), pending = light('system', 'prompt', { signal: controller.signal });
  await started.promise; controller.abort();
  const late = new Promise(resolve => setTimeout(resolve, 5000, 'still waiting for the provider'));
  assert.equal(await Promise.race([pending.then(() => 'answered', () => 'stopped'), late]), 'stopped');
});
