import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelGateway } from '../lib/jobs/gateway.js';
import { validateRuntimeContract } from '../lib/jobs/contract.js';
import { EFFORT_PREFERENCE, withEffortPreference } from '../lib/reasoning-effort.js';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';

// One owner of the reasoning level: the gateway resolves the call's own request, or follows the learner's
// generation level on the host route; a level it chose is never overridden by that level again downstream.
const OFFERED = ['lowest', 'low', 'medium', 'high'];
const ctx = { llm: { resolveModelInfo: async () => ({ reasoning: { efforts: OFFERED.map(id => ({ id })), defaultEffort: 'medium' } }) } };
const policy = { purpose: 'author', feature: 'generate', requestedEffort: 'low', executionMode: 'direct', budget: null };

function setup(route) {
  const record = structuredClone(goldenRuntimeContracts.running); record.calls = []; record.runtime.steps = [];
  const controller = new AbortController(), seen = [];
  const host = { ctx, sessionId: 'fixture', route: () => route, complete: async (_system, _prompt, options) => { seen.push(options.route); return 'ok'; } };
  const context = { jobId: record.jobId, attemptId: record.attemptId, signal: controller.signal, assertCurrent() { controller.signal.throwIfAborted(); } };
  return { record, seen, gateway: createModelGateway({ context, record, host }) };
}

test('a level the call asked for is sent as a plain route, not overridden by the learner level riding on the host route', async () => {
  const route = withEffortPreference({ provider: 'p', model: 'm', reasoningEffort: 'medium' }, 'high');
  const { gateway, seen } = setup(route);
  await gateway.step('author:1', policy).complete('system', 'prompt');
  assert.equal(seen[0].reasoningEffort, 'low');
  assert.equal(seen[0][EFFORT_PREFERENCE], undefined, 'the learner-level marker is not forwarded: it would replace the requested level downstream');
});

test('follow uses the learner generation level when the model offers it, else the route own level', async () => {
  for (const [preference, own, expected] of [['high', 'medium', 'high'], ['max', 'medium', 'medium'], ['', 'low', 'low']]) {
    const { gateway, seen } = setup(withEffortPreference({ provider: 'p', model: 'm', reasoningEffort: own }, preference));
    await gateway.step('author:1', { ...policy, requestedEffort: 'follow' }).complete('system', 'prompt');
    assert.equal(seen[0].reasoningEffort, expected, `preference "${preference}" over own "${own}"`);
    assert.equal(seen[0][EFFORT_PREFERENCE], undefined);
  }
});

test('a call records the round, re-ask and queue wait it belongs to as step labels', async () => {
  const { gateway, record } = setup({ provider: 'p', model: 'm' });
  const labels = { stage: 'Writing', part: 2, slot: 1, round: 3, retry: 1, queuedMs: 40 };
  await gateway.step('r3:author:2', policy, { labels }).complete('system', 'prompt');
  assert.deepEqual(['round', 'retry', 'queuedMs'].map(key => record.calls[0][key]), [3, 1, 40]);
  validateRuntimeContract(record);
  assert.throws(() => gateway.step('x', policy, { labels: { round: -1 } }), { code: 'invalid-step-labels' });
  assert.throws(() => gateway.step('x', policy, { labels: { unknown: 1 } }), { code: 'invalid-step-labels' });
});

test('a step can be stopped by a narrower signal of its owner (a round budget) without stopping the Attempt', async () => {
  const record = structuredClone(goldenRuntimeContracts.running); record.calls = []; record.runtime.steps = [];
  const attempt = new AbortController(), round = new AbortController(), entered = Promise.withResolvers();
  const host = { ctx, sessionId: 'fixture', route: () => ({ provider: 'p', model: 'm' }),
    complete: async (_system, _prompt, options) => { entered.resolve(); await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))); } };
  const context = { jobId: record.jobId, attemptId: record.attemptId, signal: attempt.signal, assertCurrent() { attempt.signal.throwIfAborted(); } };
  const gateway = createModelGateway({ context, record, host });
  const pending = gateway.step('r1:author:1', policy, { signal: round.signal }).complete('system', 'prompt');
  await entered.promise; round.abort(new Error('round budget'));
  await assert.rejects(pending, /round budget/);
  assert.equal(attempt.signal.aborted, false);
  assert.equal(record.calls[0].status, 'cancelled');
});

test('an unknown requested level is still refused', () => {
  const { gateway } = setup({ provider: 'p', model: 'm' });
  assert.throws(() => gateway.step('x', { ...policy, requestedEffort: 'xhigh' }), { code: 'invalid-gateway-policy' });
});
