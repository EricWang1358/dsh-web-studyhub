/* How a generation job ended when something was thrown (lib/contexts/generation/run-end.js): one decision, pure, read here as a table. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { endOfRun } from '../lib/contexts/generation/run-end.js';

const facts = (extra = {}) => ({ error: new Error('boom'), aborted: false, abortCode: undefined, cancelRequested: false, planStarted: false, hasSpec: false, stopped: false, hasDraft: false, hasPlan: false, covering: false, publishTarget: false, retryable: false, savedCount: 0, ...extra });
const running = (extra = {}) => facts({ planStarted: true, hasSpec: true, hasPlan: true, hasDraft: true, ...extra });
const BUDGET = 'GENERATION_BUDGET';

test('a plain run: failed, or cancelled when the learner asked; 接着做 is looked for when it kept a draft', () => {
  assert.deepEqual(endOfRun(facts()), { status: 'failed', stop: null, retryAfterStop: false, readAsked: false, offerContinue: false, publishWhatPassed: false });
  assert.equal(endOfRun(facts({ aborted: true, cancelRequested: true })).status, 'cancelled');
  assert.equal(endOfRun(facts({ aborted: true })).status, 'failed', 'stopped by something else, and it has no plan to come back to');
  assert.equal(endOfRun(facts({ hasDraft: true })).offerContinue, true);
  assert.equal(endOfRun(facts({ hasDraft: true, aborted: true, cancelRequested: true })).offerContinue, true);
  assert.equal(endOfRun(facts({ hasDraft: true, retryable: true })).offerContinue, false, 'it already can');
  assert.equal(endOfRun(facts({ hasDraft: true, publishTarget: true })).offerContinue, false, 'a supplement has its own way on');
});

test('a top-up of one round that kept a draft reads what the draft was asked for', () => {
  assert.equal(endOfRun(facts({ covering: true, hasDraft: true })).readAsked, true);
  assert.equal(endOfRun(facts({ covering: true })).readAsked, false);
  assert.equal(endOfRun(running({ covering: true })).readAsked, false, 'a run has its plan');
});

test('the host stopped under a run: interrupted, and the draft is left as it is', () => {
  const end = endOfRun(running({ aborted: true }));
  assert.deepEqual([end.status, end.stop], ['interrupted', null]);
  assert.equal(endOfRun(running({ aborted: true, cancelRequested: true })).status, 'cancelled');
  assert.equal(endOfRun(running({ aborted: true, abortCode: BUDGET })).status, 'failed', 'the time limit is not a stopped host');
  assert.equal(endOfRun(facts({ aborted: true, hasPlan: true })).status, 'failed', 'a run that had not started has nothing to come back to');
});

test('a run that ends says why on its draft, once; the learner\'s stop is not a failure', () => {
  const learner = endOfRun(running({ aborted: true, cancelRequested: true }));
  assert.deepEqual(learner.stop, { reason: 'learner', extra: {}, roundReason: 'cancelled' });
  assert.equal(learner.retryAfterStop, false);
  const failed = endOfRun(running({ error: new Error(`model ${'x'.repeat(300)}`) }));
  assert.equal(failed.stop.reason, 'round-failed');
  assert.equal(failed.stop.roundReason.length, 160);
  assert.equal(failed.stop.extra.detail.length, 200);
  assert.equal(failed.retryAfterStop, true);
  const refused = endOfRun(running({ error: Object.assign(new Error('401 Unauthorized: invalid api key'), { status: 401 }) }));
  assert.deepEqual([refused.stop.reason, refused.stop.extra.code], ['refused', 'credential']);
  assert.equal(endOfRun(running({ hasDraft: false })).retryAfterStop, false, 'nothing to go on from');
  assert.equal(endOfRun(running({ stopped: true })).stop, null, 'it has said why already');
  assert.equal(endOfRun(running({ hasSpec: false })).stop, null);
  assert.equal(endOfRun(running({ planStarted: false })).stop, null);
  assert.deepEqual(endOfRun(running({ error: 'a plain string' })).stop.extra, { detail: 'a plain string' });
});

test('a supplement at its time limit publishes what passed', () => {
  const at = { publishTarget: true, abortCode: BUDGET, aborted: true, hasDraft: true, savedCount: 2 };
  assert.equal(endOfRun(facts(at)).publishWhatPassed, true);
  assert.equal(endOfRun(facts({ ...at, savedCount: 0 })).publishWhatPassed, false);
  assert.equal(endOfRun(facts({ ...at, savedCount: undefined })).publishWhatPassed, false);
  assert.equal(endOfRun(facts({ ...at, hasDraft: false })).publishWhatPassed, false);
  assert.equal(endOfRun(facts({ ...at, cancelRequested: true })).publishWhatPassed, false);
  assert.equal(endOfRun(facts({ ...at, abortCode: undefined })).publishWhatPassed, false);
  assert.equal(endOfRun(facts({ ...at, publishTarget: false })).publishWhatPassed, false);
});
