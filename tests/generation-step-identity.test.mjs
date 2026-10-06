import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { generateBatched } from '../lib/batch.js';
import { unifyCall } from '../lib/job-calls.js';
import { stepKeyOf } from '../lib/contexts/generation/jobs/step-identity.js';
import { fakeModel, source } from './helpers/fill-rounds-model.mjs';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';
import { settleJob } from './helpers/wait.mjs';

/* S3-2: every model call of a run names the logical unit it belongs to (round, group, part, attempt of the part, fill round, review re-ask),
   so its step key is the same in a new attempt of the same run and different for different units (S3-0 D-6: the key had no round, no fill round). */

const request = (fillRounds = 2) => ({ count: 5, kind: 'quiz', sources: [source], performance: { concurrency: 1, batchSize: 5, fillRounds } });
const rejected = new Set(['Planned 1', 'Planned 2', 'Planned 3']);

async function keysOf(options = {}, extra = {}) {
  const contexts = [];
  const model = fakeModel({ rejectObjectives: rejected, onCall: (system, context) => contexts.push({ stage: context?.stage, ...context }) });
  await generateBatched(model.complete, { ...request(options.fillRounds), ...extra });
  return contexts.map(context => stepKeyOf({ ...context, purpose: options.purposeOf(context) }));
}
const purposeOf = context => unifyCall({ stage: context.stage, kind: context.kind }).kind;

test('a run with fill rounds names every logical unit once: first pass, reserve round, replanned round differ in their keys', async () => {
  const keys = await keysOf({ purposeOf });
  assert.equal(new Set(keys).size, keys.length, `duplicate keys: ${keys.join(' ')}`);
  assert.ok(keys.some(key => /:f1:/.test(key)) && keys.some(key => /:f2:/.test(key)), `fill rounds are in the keys: ${keys.join(' ')}`);
});

test('the same run again has exactly the same keys: they are the unit\'s identity, not a counter of this attempt', async () => {
  assert.deepEqual(await keysOf({ purposeOf }), await keysOf({ purposeOf }));
});

test('fillRounds 0 and 1 name only the units they run', async () => {
  const none = await keysOf({ fillRounds: 0, purposeOf }), one = await keysOf({ fillRounds: 1, purposeOf });
  assert.ok(none.every(key => !/:f\d/.test(key)));
  assert.ok(one.some(key => /:f1:/.test(key)) && one.every(key => !/:f2:/.test(key)));
});

test('the key of a unit is a pure function of its coordinates', () => {
  const unit = { purpose: 'review', round: 2, part: 3, fill: 1, retry: 1 };
  assert.equal(stepKeyOf(unit), stepKeyOf({ ...unit }));
  const coordinates = [{}, { round: 1 }, { round: 2 }, { part: 1 }, { part: 2 }, { group: 1 }, { attempt: 2 }, { fill: 1 }, { fill: 2 }, { retry: 1 }, { unit: 'weights' }];
  const keys = coordinates.map(extra => stepKeyOf({ purpose: 'author', ...extra }));
  assert.equal(new Set(keys).size, keys.length, keys.join(' '));
  assert.ok(stepKeyOf({ purpose: 'review', part: 1, attempt: 1 }) === stepKeyOf({ purpose: 'review', part: 1 }), 'the first attempt is the default one');
  assert.ok(stepKeyOf({ purpose: 'x'.repeat(400), part: 1 }).length <= 200, 'a key always fits the runtime\'s bound');
});

test('a run that keeps fewer questions than asked ends complete with a partial result: shortness is a result field, never a lifecycle state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-s32-partial-'));
  const model = fakeModel({ rejectObjectives: rejected });
  const service = new StudyService(root, { complete: model.complete, ...switchOptions(SWITCH_MODE, { complete: model.complete, paths: ['generation'] }) });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await service.call('source.add', source);
  const started = await service.call('generate', { sourceIds: [source.id], count: 5, kind: 'quiz', performance: { concurrency: 1, batchSize: 5, fillRounds: 0 } });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const contract = (await service.call('snapshot')).jobs.find(item => item.id === started.jobId).contract;
  assert.deepEqual([contract.status, contract.result.completeness], ['complete', 'partial']);
});
