import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { estimateFromState, estimateRun } from '../lib/token-estimate.js';
import { settleJob } from './helpers/wait.mjs';
import { transcriptFixture } from './helpers/coverage-fixture.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';

/* The line the creation form shows before a run (「标准：约 N 道题，覆盖 M/K 个部分，分 R 轮，预计 X–Y tok · A–B 次调用」) is the answer of usage.estimate for the request the form sends, and the run that
   starts makes the plan that answer promised. The real estimator prices it from the prompts of the pipeline; its old clamp of the count to 30 is gone. */

const fx = transcriptFixture();
const state = { sources: fx.sources, decks: [], drafts: [], settings: {} };
const ids = fx.sources.map(source => source.id);
const estimate = (args, over = {}) => estimateFromState('generate', { sourceIds: ids, ...args }, { ...state, ...over }, { language: 'zh' });

test('a coverage estimate says what the level means and prices every round, the importance calls and the re-asks', () => {
  const standard = estimate({ coverageLevel: 'standard' });
  assert.deepEqual([standard.coverage.level, standard.coverage.sections, standard.coverage.leaves], ['standard', 81, 81]);
  assert.ok(standard.coverage.goal > 200 && standard.coverage.rounds >= Math.ceil(standard.coverage.goal / 30), 'rounds of at most 30 questions');
  assert.ok(standard.coverage.firstRound <= 30);
  assert.ok(standard.totalTokens.low > 1_000_000 && standard.totalTokens.high > standard.totalTokens.low);
  assert.ok(standard.calls.low > standard.coverage.rounds && standard.calls.high > standard.calls.low);
  const stage = id => standard.stages.find(item => item.id === id);
  assert.ok(stage('plan').calls >= 5 + 25, 'a planning call per group of sections plus the importance calls (one per chunk of 20 sections)');
  assert.ok(stage('author').calls >= standard.coverage.rounds);
  assert.deepEqual(Object.keys(standard.coverage.levels), ['lean', 'standard', 'full']);
  const [lean, full] = [estimate({ coverageLevel: 'lean' }), estimate({ coverageLevel: 'full' })];
  assert.ok(lean.coverage.goal < standard.coverage.goal && standard.coverage.goal < full.coverage.goal);
  assert.ok(lean.totalTokens.low < standard.totalTokens.low && standard.totalTokens.low < full.totalTokens.low, 'more questions cost more tokens');
  assert.deepEqual(standard.coverage.levels.lean, { goal: lean.coverage.goal, sections: lean.coverage.sections });
  assert.equal(JSON.stringify(estimate({ coverageLevel: 'standard' })), JSON.stringify(standard), 'deterministic');
});

test('a custom total: any number up to 500 is priced as asked, not cut to 30', () => {
  const custom = estimate({ coverageLevel: 'standard', count: 100 });
  assert.equal(custom.coverage.goal, 100);
  assert.equal(custom.coverage.custom, true);
  assert.equal(custom.coverage.rounds, 4);
  assert.ok(custom.stages.find(item => item.id === 'review').calls >= 20);
  const alone = estimate({ count: 40 });
  assert.equal(alone.coverage.goal, 40, 'a count above one round alone is a custom total at the default strength');
  const plain = estimateRun('generate', { sources: fx.sources.slice(0, 1), count: 60, kind: 'quiz' });
  const thirty = estimateRun('generate', { sources: fx.sources.slice(0, 1), count: 30, kind: 'quiz' });
  assert.ok(plain.totalTokens.low > thirty.totalTokens.low * 1.5, 'the old clamp of the count to 30 is gone from the pricing');
  assert.ok(estimate({ count: 20 }).coverage === undefined, 'a count up to one round alone is priced as before, with no plan');
});

test('the selection bound of a plan: over 600 000 characters is priced, not blocked; over the sanity bound it is blocked and says how much fits', () => {
  const big = mergedTranscript({ recordings: 5, parts: 16, paragraphs: 14 });
  const bigState = { sources: big.sources, decks: [], drafts: [], settings: {} }, bigIds = big.sources.map(source => source.id);
  const priced = estimateFromState('generate', { sourceIds: bigIds, coverageLevel: 'lean' }, bigState, { language: 'zh' });
  assert.equal(priced.blocked, undefined);
  assert.ok(priced.coverage.goal > 100);
  const legacy = estimateFromState('generate', { sourceIds: bigIds, count: 10 }, bigState, { language: 'zh' });
  assert.equal(legacy.blocked?.code, 'over-limit', 'a request without a plan is bound as before');
  assert.equal(legacy.blocked.limit, 600000);
  const paragraph = 'A paragraph of a very long book that says something about platform teams and what every product group must build. '.repeat(20);
  const text = Array.from({ length: Math.ceil(650000 / paragraph.length) }, () => paragraph).join('\n\n');
  const huge = Array.from({ length: 5 }, (_, at) => ({ id: `book-${at}`, title: `Book ${at}`, text }));
  const over = estimateFromState('generate', { sourceIds: huge.map(item => item.id), coverageLevel: 'lean' }, { sources: huge, decks: [], drafts: [], settings: {} }, { language: 'zh' });
  assert.equal(over.blocked?.code, 'over-limit');
  assert.equal(over.blocked.limit, 3_000_000, 'the sanity bound of a plan');
  assert.ok(over.blocked.fitSources >= 1 && over.blocked.fitSources < 5);
});

test('parity: the plan a coverage run makes is the plan the estimate promised, for the same request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-coverage-parity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root);
  service.complete = clusteringModel().complete;
  for (const source of fx.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  for (const request of [{ coverageLevel: 'standard' }, { coverageLevel: 'lean' }, { coverageLevel: 'full', count: 90 }, { count: 75 }]) {
    const promised = await service.call('usage.estimate', { feature: 'generate', sourceIds: ids, ...request });
    const started = await service.call('generate', { sourceIds: ids, ...request });
    assert.deepEqual({ level: started.plan.level, goal: started.plan.goal, sections: started.plan.sections, rounds: started.plan.rounds, firstRound: started.plan.questions },
      { level: promised.coverage.level, goal: promised.coverage.goal, sections: promised.coverage.sections, rounds: promised.coverage.rounds, firstRound: promised.coverage.firstRound }, JSON.stringify(request));
    await service.call('job.cancel', { jobId: started.jobId });
    await settleJob(service, started.jobId).catch(() => {});
  }
});
