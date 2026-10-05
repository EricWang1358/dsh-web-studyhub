import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { sectionKey } from '../lib/coverage.js';
import { sectionsOf } from '../lib/sections.js';

/* A coverage run through the service: the form's request (coverageLevel, optionally a total), the plan the job makes (importance weights from the light model, the first round of the plan),
   the spec the draft keeps and what the coverage view says about it. The planner clusters on purpose. */

const world = mergedTranscript();
async function library(t, { light = true, weightOf } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-coverage-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root), model = clusteringModel();
  service.complete = model.complete;
  const rated = [];
  if (light) service.light = async (system, prompt) => {
    const evidence = JSON.parse(prompt.split('\n\n')[0]).sections;
    rated.push(evidence.length);
    return JSON.stringify({ sections: evidence.map(item => ({ id: item.id, importance: weightOf?.(item) ?? 3, kind: 'definition', reason: `Reason for ${item.title}` })) });
  };
  for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  return { service, model, rated, ids: world.sources.map(source => source.id) };
}
const leafKeys = () => sectionsOf(world.sources).filter(section => section.leaf).map(section => sectionKey(section.sourceId, section.id));

test('a standard coverage run: the plan in the answer, the first round in the job, the spec in the draft', async (t) => {
  const { service, ids, rated } = await library(t, { weightOf: item => (/3\b/.test(item.title) && item.position.includes('recording 2') ? 5 : 3) });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', kind: 'quiz' });
  assert.equal(started.plan.level, 'standard');
  assert.equal(started.plan.sections, 81);
  assert.ok(started.plan.goal > 100 && started.plan.rounds >= 4, JSON.stringify(started.plan));
  assert.ok(started.plan.questions <= 30 && started.plan.round === 1);
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.equal(job.coveragePlan.weights, 'model');
  assert.deepEqual(rated, [20, 20, 20, 20, 1], 'one light call per chunk of 20 sections');
  const state = await service.call('export'), draft = state.drafts[0], spec = draft.editorial.coverageSpec;
  assert.equal(spec.level, 'standard');
  assert.equal(spec.weightSource, 'model');
  assert.equal(spec.goal, started.plan.goal);
  assert.equal(spec.weights.length, 81);
  assert.ok(spec.weights.every(item => item.source === 'model' && item.reason.startsWith('Reason for')));
  assert.deepEqual(spec.rounds.reduce((sum, round) => sum + round.questions, 0), spec.goal);
  assert.equal(draft.editorial.generation.coverageLevel, 'standard');
  assert.equal(draft.cards.length, spec.rounds[0].questions, 'the first round was written');
  assert.equal(draft.editorial.requested, spec.rounds[0].questions);
  const roundOne = new Set(spec.rounds[0].sectionIds), covered = new Set(draft.cards.map(card => leafKeys().find(key => {
    const [sourceId, id] = key.split('#'), section = sectionsOf(world.sources).find(item => item.sourceId === sourceId && item.id === id), text = world.sources.find(source => source.id === sourceId).text;
    return text.indexOf(card.citations[0].quote) >= section.start && text.indexOf(card.citations[0].quote) < section.end;
  })));
  assert.deepEqual([...covered].sort(), [...roundOne].sort(), 'the covered sections are exactly those the first round assigned');
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.equal(view.coverage.spec.goal, spec.goal);
  assert.ok(view.coverage.sections.every(section => section.weight?.importance >= 1 && section.weight.quota >= 1), 'every section says why: importance, kind, reason, quota');
  assert.equal(view.coverage.covered, roundOne.size);
});

test('without a light model the weights are the lengths, and the spec says so', async (t) => {
  const { service, ids } = await library(t, { light: false });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'lean' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const spec = (await service.call('export')).drafts[0].editorial.coverageSpec;
  assert.equal(spec.weightSource, 'length');
  assert.equal(spec.level, 'lean');
  assert.ok(spec.mustCover < 81 && spec.mustCover >= 5);
});

test('request validation: a custom total up to 500 becomes rounds; an old caller with only a count up to 30 is planned as before', async (t) => {
  const { service, ids } = await library(t);
  const custom = await service.call('generate', { sourceIds: ids, coverageLevel: 'full', count: 120 });
  assert.equal(custom.plan.goal, 120);
  assert.equal(custom.plan.rounds, 4);
  await settleJob(service, custom.jobId);
  const alone = await service.call('generate', { sourceIds: ids, count: 45 });
  assert.equal(alone.plan.level, 'standard', 'a count above one round alone is a custom total at the default strength');
  assert.equal(alone.plan.goal, 45);
  await settleJob(service, alone.jobId);
  for (const bad of [{ coverageLevel: 'thorough' }, { coverageLevel: 'standard', count: 0 }, { coverageLevel: 'standard', count: 501 }, { coverageLevel: 'standard', count: 12.5 }, { count: 501 }])
    await assert.rejects(service.call('generate', { sourceIds: ids, ...bad }), /覆盖强度|Choose|coverageLevel|题/, JSON.stringify(bad));
  const old = await service.call('generate', { sourceIds: ids.slice(0, 1), count: 10, kind: 'quiz' });
  assert.equal(old.plan, undefined, 'no coverage plan for an old caller');
  const job = await settleJob(service, old.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const draft = (await service.call('export')).drafts.find(item => item.id === job.draftId) || (await service.call('export')).drafts.at(-1);
  assert.equal(draft.editorial.coverageSpec, undefined);
  assert.equal(draft.editorial.requested, 10);
  await assert.rejects(service.call('generate', { sourceIds: ids.slice(0, 1), count: 0 }), /Choose 1–30/);
});

test('the selection bound: a request with a plan reads a selection over 600 000 characters; a request without one is refused as before', async (t) => {
  const big = mergedTranscript({ recordings: 5, parts: 16, paragraphs: 14 });
  const root = await mkdtemp(join(tmpdir(), 'study-coverage-big-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  service.complete = clusteringModel().complete;
  for (const source of big.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  const ids = big.sources.map(source => source.id), chars = big.sources.reduce((sum, source) => sum + source.text.length, 0);
  assert.ok(chars > 600000 && chars < 3000000, `${chars} characters`);
  await assert.rejects(service.call('generate', { sourceIds: ids, count: 10 }), /limit is 600000/);
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'lean' });
  assert.equal((await settleJob(service, started.jobId)).status, 'complete');
});

test('the top-up of a draft that kept its plan continues it: the quotas of the plan, the heaviest first, enforced assignments, the plan stays', async (t) => {
  const { service, ids } = await library(t, { weightOf: item => (item.position.startsWith('40/') || item.position.startsWith('41/') ? 5 : 3) });
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard' });
  assert.equal((await settleJob(service, started.jobId)).status, 'complete');
  const draft = (await service.call('export')).drafts[0], spec = draft.editorial.coverageSpec;
  const view = await service.call('coverage.get', { draftId: draft.id });
  assert.ok(view.coverage.scheduled > 50, `${view.coverage.scheduled} sections wait for a later round of the plan`);
  const quotaOf = new Map(spec.quotas.map(item => [item.sectionId, item.quota]));
  for (const pick of view.round.picks) assert.equal(pick.questions, quotaOf.get(pick.key), 'an uncovered section costs the quota the plan gave it');
  const heaviest = new Set(spec.rounds[1].sectionIds);
  assert.ok(view.round.picks.filter(pick => heaviest.has(pick.key)).length >= view.round.picks.length - 2, 'the second round of the plan is what the top-up runs');
  const next = await service.call('generate', { resumeDraftId: draft.id, draftVersion: draft.draftVersion, coverage: { sectionIds: view.round.picks.map(pick => pick.key) } });
  assert.equal(next.coverage.questions, view.round.questions);
  const job = await settleJob(service, next.jobId);
  assert.equal(job.status, 'complete', job.stage);
  const after = (await service.call('export')).drafts[0];
  assert.equal(after.cards.length, draft.cards.length + view.round.questions, 'the round was written');
  assert.deepEqual(after.editorial.coverageSpec, spec, 'the plan stays with the draft');
  assert.equal(after.editorial.requested, draft.editorial.requested, 'what the draft was asked for did not grow');
  const again = await service.call('coverage.get', { draftId: draft.id });
  assert.equal(again.coverage.covered, view.coverage.covered + view.round.sections);
  assert.ok(again.coverage.scheduled < view.coverage.scheduled);
});
