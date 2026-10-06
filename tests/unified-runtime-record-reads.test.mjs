import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobLifecycle } from '../lib/jobs/lifecycle.js';
import { createRuntimeWork } from '../lib/runtime/work.js';

// A record of the job table presents itself through the definition's reader. Reading its fields one after the other (a spread, a scan of
// the table) is one read of the record, not one presentation per field: a presentation validates the whole contract.
async function probe(t, { present, run }) {
  const work = createRuntimeWork(), lifecycle = createJobLifecycle('root', work), owner = Symbol('owner');
  lifecycle.register({ effect() {} }, 'probe.v1', { kind: 'probe', version: 1, legacyFields: ['alpha'], capabilities: { cancel: true },
    async admit(context) { context.present(present); return { state: {} }; }, run });
  const executor = { assertAvailable() {}, witness: () => ({}), inspect: () => ({ state: 'lost' }), start({ run: go }) { void go(); return { id: 'h', ownerAgentId: 'o', stop() {} }; } };
  t.after(() => lifecycle.dispose());
  const jobs = lifecycle.scoped({ owner, domain: 'probe.v1', executor }), started = await jobs.submit('probe', {});
  await jobs.wait(started.jobId);
}

// The kernel checks that an Attempt is current before every publishing call; that check reads the lifecycle, it does not present the record.
test('the currency check of an Attempt does not present the record', async t => {
  let presentations = 0;
  const policy = { purpose: 'author', feature: 'generate', requestedEffort: 'default', executionMode: 'direct', budget: null };
  await probe(t, { present: () => { presentations++; return { legacy: { alpha: 1 } }; }, async run(context) {
    for (let index = 0; index < 20; index++) await context.gateway.step(`s:${index}`, policy).run(async () => {});
    return { refs: [], completeness: 'complete' };
  } });
  assert.ok(presentations < 6, `20 steps presented the record ${presentations} times`);
});

test('reading many fields of a job record in one turn presents it once; the next turn presents it again', async t => {
  const work = createRuntimeWork(), lifecycle = createJobLifecycle('root', work), owner = Symbol('owner');
  const scope = { effect() {} };
  let presentations = 0;
  const definition = { kind: 'probe', version: 1, legacyFields: ['alpha', 'beta', 'gamma'], capabilities: { cancel: true },
    async admit(context) { context.present(() => { presentations++; return { legacy: { alpha: 1, beta: 2, gamma: 3 } }; }); return { state: {} }; },
    async run() { return { refs: [], completeness: 'complete' }; } };
  lifecycle.register(scope, 'probe.v1', definition);
  const executor = { assertAvailable() {}, witness: () => ({}), inspect: () => ({ state: 'lost' }), start({ run }) { void run(); return { id: 'h', ownerAgentId: 'o', stop() {} }; } };
  const jobs = lifecycle.scoped({ owner, domain: 'probe.v1', executor });
  const started = await jobs.submit('probe', {});
  await jobs.wait(started.jobId);
  t.after(() => lifecycle.dispose());
  const record = work.jobs.get(started.runtime.legacyId);
  await new Promise(resolve => setImmediate(resolve));
  const before = presentations;
  const copy = { ...record };
  assert.deepEqual([copy.alpha, copy.beta, copy.gamma], [1, 2, 3]);
  assert.equal(presentations - before, 1, 'three fields and the contract: one presentation');
  await new Promise(resolve => setImmediate(resolve));
  void record.alpha;
  assert.equal(presentations - before, 2, 'a later turn sees the current state');
});
