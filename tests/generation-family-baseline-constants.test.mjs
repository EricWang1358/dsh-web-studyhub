import test from 'node:test';
import assert from 'node:assert/strict';
import { FILL_ROUNDS, REPEAT_LIMIT, STOP_REASONS } from '../lib/coverage-run.js';
import { ROUND_LIMIT } from '../lib/coverage-round.js';
import { GENERATION_TIMEOUT_MS, GENERATION_JOB_TIMEOUT_MS } from '../lib/generation-limits.js';
import { GOAL_QUESTIONS_MAX, CALL_CHARS, CALL_TARGETS } from '../lib/limits.js';
import { GENERATION_PERFORMANCE_DEFAULTS, GENERATION_SETTINGS_LIMITS } from '../lib/generation-settings.js';
import { reserveCount } from '../lib/generation-yield.js';
import { REVIEW_REASKS } from '../lib/generation-failure.js';
import { MAX_SELECTED_CHARS, MAX_PLAN_TARGETS } from '../lib/batch.js';

/* S3-0 baseline: the numbers that bound a generation run today (the "hard-coded constants" table of docs/plans/unified-job-runtime/s3-0-generation-baseline.md). Existing tests lock the BEHAVIOUR
   of the bounds (generation-fill-rounds, coverage-run-exec, generation-yield, generation-throughput); this file locks the VALUES in one place, so that moving them into settings (S3-2) is a
   visible, reviewed change. Values that are private to a module (the 429 retry count in lib/batch.js, the 45 s of the suggest calls) are listed in the document, not imported here. */

test('the bounds of a generation run have the values the baseline document lists', () => {
  assert.deepEqual({ fillRoundsOfARun: FILL_ROUNDS, repeatLimit: REPEAT_LIMIT, roundLimit: ROUND_LIMIT, goalMax: GOAL_QUESTIONS_MAX, reviewReasks: REVIEW_REASKS, callChars: CALL_CHARS, callTargets: CALL_TARGETS, planTargets: MAX_PLAN_TARGETS },
    { fillRoundsOfARun: 2, repeatLimit: 2, roundLimit: 30, goalMax: 500, reviewReasks: 2, callChars: 60000, callTargets: 10, planTargets: 10 });
  assert.equal(GENERATION_TIMEOUT_MS, 10 * 60 * 1000, 'one model call');
  assert.equal(GENERATION_JOB_TIMEOUT_MS, 20 * 60 * 1000, 'a repair run, a selection fill (fixed), the default of a plain run');
  assert.ok(MAX_SELECTED_CHARS > 0);
});

test('the per-job performance defaults and their ranges are the settings home of concurrency, batch, time limit and fill rounds', () => {
  assert.deepEqual({ concurrency: GENERATION_PERFORMANCE_DEFAULTS.concurrency, batchSize: GENERATION_PERFORMANCE_DEFAULTS.batchSize, jobTimeoutMinutes: GENERATION_PERFORMANCE_DEFAULTS.jobTimeoutMinutes, fillRounds: GENERATION_PERFORMANCE_DEFAULTS.fillRounds },
    { concurrency: 4, batchSize: 5, jobTimeoutMinutes: 20, fillRounds: 2 });
  assert.deepEqual([GENERATION_SETTINGS_LIMITS.concurrency, GENERATION_SETTINGS_LIMITS.batchSize, GENERATION_SETTINGS_LIMITS.jobTimeoutMinutes, GENERATION_SETTINGS_LIMITS.fillRounds],
    [{ min: 1, max: 8 }, { min: 1, max: 5 }, { min: 5, max: 180 }, { min: 0, max: 4 }]);
});

test('the reserve is 20% of the questions asked for a group of pages, at most 3, and none under three questions', () => {
  assert.deepEqual([0, 1, 2, 3, 5, 10, 15, 30, 100].map(reserveCount), [0, 0, 0, 1, 1, 2, 3, 3, 3]);
});

test('every reason a coverage run can stop for is listed with its level; only complete and target are "ok"', () => {
  assert.deepEqual(Object.entries(STOP_REASONS).map(([name, value]) => [name, value.ok]).sort(), [['budget', false], ['complete', true], ['learner', false], ['no-progress', false],
    ['refused', false], ['round-failed', false], ['sections-left', false], ['target', true]]);
});
