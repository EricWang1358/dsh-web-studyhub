import test from 'node:test';
import assert from 'node:assert/strict';
import { jobContract, checkAction, reasonText } from '../lib/job-contract.js';
import { planRound, topUpSpec } from '../lib/coverage-round.js';

/* The contract of a plain question run (a count, no plan): it is continued (接着做), with a reason code when it cannot be. Old records that never knew any of this degrade to "nothing to continue". Pure. */

const plain = (over = {}) => ({ id: 'p1', status: 'failed', draftId: 'd1', stage: 'Generation reached its 20-minute total budget; approved questions were retained', requestedTotal: 15, savedCount: 13, ...over });

test('a failed or stopped plain run that kept a draft can be continued; it still has nothing to pause between', () => {
  for (const status of ['failed', 'cancelled', 'interrupted']) assert.equal(jobContract(plain({ status, retryable: true })).actions.retry.available, true, status);
  const { actions } = jobContract(plain({ retryable: true }));
  assert.equal(actions.pause.available, false);
  assert.equal(actions.pause.mode, 'unsupported');
  assert.deepEqual(checkAction(plain({ retryable: true }), 'retry'), { ok: true });
});

test('a record that knows nothing of continuing (an older snapshot) offers nothing, and says why with a code', () => {
  const old = jobContract(plain());
  assert.equal(old.actions.retry.available, false);
  assert.equal(old.actions.retry.reason.code, 'not-retryable');
  assert.equal('continuedBy' in old, false);
  assert.equal(checkAction(plain(), 'retry').ok, false);
  assert.equal(jobContract(plain({ status: 'running', retryable: true })).actions.retry.reason.code, 'not-ended');
  assert.equal(jobContract(plain({ status: 'complete', retryable: true })).actions.retry.available, false);
});

test('a record that was continued keeps its numbers, offers nothing and says by which task it was continued', () => {
  const done = jobContract(plain({ retryable: true, continuedBy: 'p2' }));
  assert.equal(done.actions.retry.available, false);
  assert.deepEqual(done.actions.retry.reason, { code: 'continued', by: 'p2' });
  assert.equal(done.continuedBy, 'p2');
  assert.deepEqual([done.progress.done, done.progress.total], [13, 15]);
  assert.match(reasonText('continued'), /接着做/);
  assert.equal(checkAction(plain({ retryable: true, continuedBy: 'p2' }), 'retry').code, 'continued');
});

test('the plan of a top-up: the uncovered sections cut into rounds of at most the limit; the goal is what the draft holds plus every question the rounds make', () => {
  const sections = Array.from({ length: 70 }, (_, index) => ({ key: `s#${index}`, id: String(index), sourceId: 's', title: `S${index}`, start: index * 10, end: index * 10 + 9, state: index < 6 ? 'covered' : 'never-planned' }));
  const coverage = { leaves: 70, covered: 6, sections };
  const round = planRound(coverage, { limit: 30 });
  assert.deepEqual([round.sections, round.questions, round.left, round.rounds, round.allQuestions], [30, 30, 34, 3, 64]);
  const spec = topUpSpec(coverage, { kept: 13, limit: 30 });
  assert.equal(spec.topup, true);
  assert.deepEqual(spec.rounds.map(item => item.questions), [30, 30, 4]);
  assert.equal(spec.goal, 13 + 64);
  assert.equal(spec.quotas.length, 64);
  assert.deepEqual(spec.rounds[0].sectionIds, round.picks.map(pick => pick.key), 'the first round is exactly the one the screen showed');
  assert.deepEqual(spec.weights, []);
});
