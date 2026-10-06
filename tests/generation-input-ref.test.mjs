import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { inputRefOf, checkpointStatus } from '../lib/contexts/generation/jobs/input-ref.js';
import { checkpointRefOf } from '../lib/contexts/generation/jobs/checkpoint-ref.js';
import { SWITCH_MODE, switchOptions } from './helpers/runtime-switch.mjs';
import { settleJob } from './helpers/wait.mjs';
import { stagedModel } from './helpers/generation-baseline.mjs';

/* S3-2: what a run was asked, frozen with the draft that checkpoints it (S3-0 matrix: plain, extraSourceIds, target supplement), and which of its
   units are done. Whether a saved checkpoint still fits a new request is a judgement on these two records and nothing else. */

const sources = [{ id: 's', text: 'Architecture sets principles.' }, { id: 't', text: 'Layers separate concerns.' }];
const asked = (extra = {}) => ({ kind: 'quiz', count: 5, language: 'en', performance: { batchSize: 5, concurrency: 4, fillRounds: 2 }, ...extra });

test('the input of a run is identified by what decides its units, not by how fast or how patiently it runs', () => {
  const base = inputRefOf({ definition: 'generation@1', request: asked(), sources });
  assert.equal(base.version, 1);
  assert.deepEqual(base.sources.map(item => item.id), ['s', 't']);
  const same = inputRefOf({ definition: 'generation@1', request: asked({ performance: { batchSize: 5, concurrency: 1, fillRounds: 0 } }), sources: [...sources].reverse() });
  assert.equal(same.hash, base.hash, 'concurrency, fill rounds and the order sources were listed in do not change the units');
  for (const changed of [asked({ count: 6 }), asked({ kind: 'flashcard' }), asked({ language: 'zh' }), asked({ performance: { batchSize: 3 } }), asked({ difficulty: 'hard' })])
    assert.notEqual(inputRefOf({ definition: 'generation@1', request: changed, sources }).hash, base.hash);
  assert.notEqual(inputRefOf({ definition: 'generation@2', request: asked(), sources }).hash, base.hash, 'a new definition invalidates');
});

test('a checkpoint says why it no longer fits: the definition, a source, or the request', () => {
  const saved = inputRefOf({ definition: 'generation@1', request: asked(), sources });
  const check = (current) => checkpointStatus(saved, inputRefOf({ definition: 'generation@1', request: asked(), sources, ...current }));
  assert.deepEqual(check({}), { valid: true });
  assert.deepEqual(check({ sources: [{ ...sources[0], text: 'Architecture sets other principles.' }, sources[1]] }), { valid: false, reason: 'sources', changed: ['s'] });
  assert.deepEqual(check({ sources: [sources[0]] }), { valid: false, reason: 'sources', changed: ['t'] });
  assert.deepEqual(check({ request: asked({ count: 6 }) }), { valid: false, reason: 'request' });
  assert.deepEqual(checkpointStatus(saved, inputRefOf({ definition: 'generation@2', request: asked(), sources })), { valid: false, reason: 'definition' });
  assert.deepEqual(checkpointStatus(undefined, saved), { valid: false, reason: 'none' }, 'a draft from before the input was frozen has nothing to compare');
});

test('extra sources and the number of questions added are part of the frozen input of a top-up', () => {
  const plain = inputRefOf({ definition: 'generation@1', request: asked(), sources });
  const topUp = inputRefOf({ definition: 'generation@1', request: asked(), sources, extraSourceIds: ['t'], added: 3 });
  assert.deepEqual([topUp.extraSourceIds, topUp.added], [['t'], 3]);
  assert.notEqual(topUp.hash, plain.hash);
});

test('the units of a coverage run that are done are named by the round prefix of their step keys', () => {
  const draft = { id: 'd', draftVersion: 4, editorial: { coverageSpec: { rounds: [{ round: 1, status: 'done' }, { round: 2, status: 'running' }, { round: 3, status: 'skipped' }, { round: 4, status: 'failed' }, { round: 5 }] } } };
  assert.deepEqual(checkpointRefOf(draft), { ref: 'draft:d:v4', completed: ['r1', 'r3'] });
  assert.deepEqual(checkpointRefOf({ id: 'e', draftVersion: 1, editorial: {} }), { ref: 'draft:e:v1', completed: [] }, 'a plain draft is one checkpoint without finished rounds');
});

test('a draft written by a run carries the frozen input, the same one for the same request', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-s32-'));
  const staged = stagedModel(), service = new StudyService(root, { complete: staged.complete, ...switchOptions(SWITCH_MODE, { complete: staged.complete, paths: ['generation'] }) });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await service.call('source.add', { id: 's', title: 'Notes', text: 'Architecture sets principles that guide how a system is designed and changed.' });
  const refs = [];
  for (let run = 0; run < 2; run++) {
    const started = await service.call('generate', { sourceIds: ['s'], count: 1, kind: 'flashcard' });
    assert.equal((await settleJob(service, started.jobId)).status, 'complete');
    const drafts = (await service.call('export')).drafts;
    refs.push(drafts.at(-1).editorial.generation.inputRef);
  }
  assert.equal(refs[0].version, 1);
  assert.match(refs[0].definition, /^generation@\d+$/);
  assert.deepEqual(refs[0], refs[1], 'the same request over the same sources freezes the same input');
});
