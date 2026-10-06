import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { estimateFromState } from '../lib/token-estimate.js';
import { weighsSections, SMALL_TARGET_QUESTIONS } from '../lib/coverage-plan.js';
import { settleJob } from './helpers/wait.mjs';
import { transcriptFixture } from './helpers/coverage-fixture.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';

/* Token cost: the importance of every section of a long material is asked of a light model (one call per ~20 sections, lib/section-weights.js). That pays when the run
   spreads many questions over the sections (the weights decide which sections get them). A SMALL custom total (a few questions asked of a long material) does not need
   it: the questions go to the longest sections either way, so the run weighs the sections by length (the same fallback as having no light model) and says so. */

const fx = transcriptFixture();
const state = { sources: fx.sources, decks: [], drafts: [], settings: {} };
const ids = fx.sources.map(source => source.id);
const planned = (args) => estimateFromState('generate', { sourceIds: ids, ...args }, state, { language: 'zh' });

test('the rule: a custom total of at most 10 questions, or fewer than a quarter of the sections, is not weighed by the model', () => {
  assert.equal(SMALL_TARGET_QUESTIONS, 10);
  assert.equal(weighsSections({ goalCount: 4, sections: 81 }), false, '4 questions over 81 sections');
  assert.equal(weighsSections({ goalCount: 10, sections: 81 }), false, 'the bound itself is small');
  assert.equal(weighsSections({ goalCount: 20, sections: 81 }), false, '20 questions: fewer than a quarter of 81 sections');
  assert.equal(weighsSections({ goalCount: 20, sections: 80 }), true, '20 questions over 80 sections is a quarter, not less');
  assert.equal(weighsSections({ goalCount: 11, sections: 30 }), true, 'above 10 and not under a quarter of the sections');
  assert.equal(weighsSections({ goalCount: 1, sections: 3 }), false);
  assert.equal(weighsSections({ goalCount: undefined, sections: 81 }), true, 'a level (no custom total) is always weighed');
  assert.equal(weighsSections({ sections: 0 }), true, 'nothing to decide here: the ordinary path handles an empty material');
});

test('the estimate prices no importance calls for a small custom total, and still prices them for a level', () => {
  const small = planned({ coverageLevel: 'standard', count: 4 });
  const level = planned({ coverageLevel: 'standard' });
  const smallPlan = small.stages.find(item => item.id === 'plan').calls;
  assert.ok(smallPlan <= 2, `a small total plans in ${smallPlan} calls and makes no importance calls`);
  assert.ok(level.stages.find(item => item.id === 'plan').calls >= 25, 'a level still prices one importance call per chunk of 20 sections');
  const noWeights = planned({ coverageLevel: 'standard', count: 4 });
  assert.equal(JSON.stringify(noWeights), JSON.stringify(small), 'deterministic');
  // The same total, but with enough of the material asked for that the weights are worth their calls.
  const many = planned({ coverageLevel: 'standard', count: 40 });
  assert.ok(many.stages.find(item => item.id === 'plan').calls >= 5, 'a total of 40 over 81 sections is weighed');
});

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-small-weights-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  t.after(() => service.dispose());
  service.complete = clusteringModel().complete;
  const lightCalls = [];
  service.light = async (system, prompt) => {
    lightCalls.push(prompt);
    const evidence = JSON.parse(prompt.split('\n\n')[0]).sections;
    return JSON.stringify({ sections: evidence.map(item => ({ id: item.id, importance: 3, kind: 'definition', reason: `Reason for ${item.title}` })) });
  };
  for (const source of fx.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  return { service, lightCalls };
}

test('a run of a small custom total makes no importance call: the sections are weighed by length, and the draft says why', async (t) => {
  const { service, lightCalls } = await library(t);
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'standard', count: 4, kind: 'quiz' });
  const job = await settleJob(service, started.jobId);
  assert.equal(job.status, 'complete', job.stage);
  assert.equal(lightCalls.length, 0, 'the light model was never asked');
  const draft = (await service.call('export')).drafts[0], spec = draft.editorial.coverageSpec;
  assert.equal(spec.weightSource, 'length');
  assert.equal(spec.weightReason, 'small-target', 'the draft keeps the reason: the total is small, so the sections were not weighed one by one');
  assert.equal(spec.goal, 4);
  assert.equal(draft.cards.length, 4);
  assert.ok(spec.weights.every(item => item.source === 'length' && item.importance === 3));
});

test('a level is still weighed by the light model, one call per chunk of sections', async (t) => {
  const { service, lightCalls } = await library(t);
  const started = await service.call('generate', { sourceIds: ids, coverageLevel: 'lean', kind: 'quiz' });
  await new Promise(resolve => setTimeout(resolve, 50));
  await service.call('job.cancel', { jobId: started.jobId });
  await settleJob(service, started.jobId).catch(() => {});
  assert.ok(lightCalls.length >= 4, `${lightCalls.length} importance calls for 81 sections`);
});
