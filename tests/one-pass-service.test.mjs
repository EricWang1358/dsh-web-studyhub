import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { settleJob } from './helpers/wait.mjs';

/* A coverage run through the service, as the learner starts it (one pass is the default): every planned section gets a question, the model is asked only the
   one-pass prompts, and every call is a step of the job with its stage (write, review) and its token usage, as the 任务 console lists them. */

const world = mergedTranscript({ recordings: 2, parts: 4, paragraphs: 8, distinct: true });

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-one-pass-'));
  const log = [], complete = createFakeModel({ log, usage: true });
  const service = new StudyService(root, { coach: false, complete, coverage: { roundLimit: 8 } });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  return { service, log, ids: world.sources.map(source => source.id) };
}

test('a standard coverage run in one pass: every planned section covered, only one-pass calls, each a job step with its stage and tokens', async t => {
  const { service, log, ids } = await library(t);
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz', language: 'English' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = (await service.call('export')).drafts[0];
  assert.equal(draft.editorial.generation.performance.strategy, 'one-pass');
  const view = await service.call('coverage.get', { draftId: draft.id });
  const planned = view.coverage.sections.filter(section => section.state !== 'unplanned' && section.leaf !== false);
  assert.ok(planned.length >= 4);
  assert.deepEqual(view.coverage.sections.filter(section => section.state !== 'covered').map(section => section.title), [], 'every section has a question');
  assert.deepEqual(draft.editorial.failures, []);

  const generation = log.filter(entry => entry.handler?.startsWith('generation.'));
  assert.deepEqual([...new Set(generation.map(entry => entry.handler))].sort(), ['generation.one-pass.merge', 'generation.one-pass.review', 'generation.one-pass.write']);
  const writes = generation.filter(entry => entry.handler === 'generation.one-pass.write').length;
  assert.equal(writes, draft.editorial.partPlans.length, 'one write per portion, no section asked again');
  assert.deepEqual(draft.editorial.previousFailures ?? [], [], 'no part of any round failed on the way');
  assert.equal(draft.cards.length, draft.editorial.partPlans.reduce((sum, plan) => sum + plan.targets.length, 0), 'every verified target kept its question');

  const contract = (await service.call('snapshot')).jobs.find(item => item.id === started.jobId).contract;
  const calls = contract.calls.filter(call => call.kind !== 'plan');
  assert.equal(calls.length, generation.length, 'every model call is a step of the job');
  assert.deepEqual([...new Set(calls.map(call => call.kind))].sort(), ['author', 'review']);
  const merges = generation.filter(entry => entry.handler === 'generation.one-pass.merge').length;
  assert.ok(merges >= 1, 'every round ends with its same-fact merge');
  assert.equal(calls.filter(call => !/^Part \d+\/\d+ · /.test(call.stage)).length, merges, 'each other step carries its part and stage');
  assert.ok(calls.filter(call => !/^Part /.test(call.stage)).every(call => call.kind === 'review'), 'the merge is a review step of the run');
  assert.ok(calls.every(call => Number.isInteger(call.tokens) && call.tokens > 0), 'and its token usage');
});

/* The 出题深度 picked on 创建题组 (ui/generate-form.js: `performance` of lib/generation-presets.js) is this run's only: it reaches every write call through the
   `generate` action, the draft records it, and the saved default is what it was. */
test('the form\'s per-run depth reaches the run: 快问 writes in the quick style, and the saved 情境题 stays the default', async t => {
  const { service, log, ids } = await library(t);
  const { WRITE_STYLES } = await import('../lib/one-pass/write-style.js');
  const { performanceOfDepth } = await import('../lib/generation-presets.js');
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'lean', kind: 'quiz', language: 'English', performance: performanceOfDepth('quick') });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const writes = log.filter(entry => entry.handler === 'generation.one-pass.write');
  assert.ok(writes.length >= 1);
  for (const entry of writes) {
    const said = `${entry.system}\n${entry.prompt}`;
    assert.ok(said.includes(WRITE_STYLES.quick), 'every write call asks in the quick style');
    assert.ok(!said.includes(WRITE_STYLES.scenario), 'and not in the scenario one');
  }
  const draft = (await service.call('export')).drafts[0];
  assert.deepEqual([draft.editorial.generation.performance.strategy, draft.editorial.generation.performance.writeStyle], ['one-pass', 'quick'], 'the draft records how it was written');
  const saved = (await service.call('snapshot')).settings.generation;
  assert.equal(saved.writeStyle ?? 'scenario', 'scenario', 'the saved style is untouched');
  assert.notEqual(saved.strategy, 'staged');
});
