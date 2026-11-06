import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { reportUsage } from '../lib/usage-scope.js';
import { settleJob } from './helpers/wait.mjs';
import { mergedTranscript } from './helpers/merged-transcript.mjs';
import { clusteringModel } from './helpers/clustering-model.mjs';

/* The learner's own token ceiling for a plain run (#761). A plain question run used to be bounded only by the wall clock, so a thinking model could spend far more than the
   learner agreed to; the budget is read where a call is admitted (lib/batch.js, limitedComplete), so the run stops at the next call and the questions that passed are kept
   exactly as at the time limit. A coverage run keeps its own budget checked round by round (lib/coverage-run.js), which is why this file drives a plain run. */

const world = mergedTranscript({ recordings: 2, parts: 6, paragraphs: 4 });
const EFFORTS = { effortPlanning: 'follow', effortReview: 'follow', effortWriting: 'low', effortRepair: 'low' };
const PLAIN = { kind: 'quiz', count: 6, performance: { concurrency: 1, batchSize: 4, jobTimeoutMinutes: 20, fillRounds: 0, ...EFFORTS } };
const PER_CALL = 500;

/** A library with a fake model that reports what a provider reports (usage), so the run has something to count. */
async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-token-cap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { coverage: { roundLimit: 8 } });
  t.after(() => service.dispose());
  const model = clusteringModel(), calls = { total: 0 };
  service.complete = async (system, prompt, context = {}) => {
    calls.total += 1;
    reportUsage({ uncachedInputTokens: PER_CALL, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, { calls: 1 });
    return model.complete(system, prompt, context);
  };
  service.light = async (system, prompt) => JSON.stringify({ sections: JSON.parse(prompt.split('\n\n')[0]).sections.map(item => ({ id: item.id, importance: 3, kind: 'definition', reason: 'Reason for ' + item.title })) });
  for (const source of world.sources) await service.call('source.add', { id: source.id, title: source.title, text: source.text, audio: source.audio });
  return { service, ids: world.sources.map(source => source.id), calls };
}

const jobOf = async (service, jobId) => (await service.call('snapshot')).jobs.find(job => job.id === jobId);

test('a plain run stops at the token ceiling the learner set, keeps what passed and offers 接着做', async (t) => {
  const { service, ids, calls } = await library(t);
  const started = await service.call('generate', { sourceIds: ids, ...PLAIN, tokenBudget: PER_CALL * 6 });
  const ended = await settleJob(service, started.jobId);
  assert.equal(ended.status, 'failed', ended.stage);
  assert.match(ended.stage, /token budget/i, 'the card says which budget stopped it');
  assert.equal(calls.total, 6, 'a call is admitted only while the run is under the ceiling: the seventh is never made');
  assert.ok(ended.tokenUsage && ended.tokenUsage.uncachedInputTokens >= PER_CALL * 6, 'what the provider reported is what the ceiling measured');
  const draft = (await service.call('export')).drafts[0];
  assert.ok(draft.cards.length > 0, 'the questions that passed are kept');
  assert.ok(draft.cards.length < PLAIN.count, 'the run stopped before it was done');
  assert.equal(draft.editorial.requested, PLAIN.count, 'the goal does not move');
  const { contract } = await jobOf(service, started.jobId);
  assert.equal(contract.actions.retry.available, true, '接着做 is offered, as it is at the time limit');
  assert.equal(contract.progress.total, PLAIN.count);
});

test('without a ceiling a plain run is bounded by the clock alone, as before: nothing stops early', async (t) => {
  const { service, ids } = await library(t);
  const started = await service.call('generate', { sourceIds: ids, ...PLAIN });
  const ended = await settleJob(service, started.jobId);
  assert.doesNotMatch(String(ended.stage || ''), /token budget/i);
  const draft = (await service.call('export')).drafts[0];
  assert.ok(draft.cards.length >= 4, 'a run with no ceiling writes its questions');
});
