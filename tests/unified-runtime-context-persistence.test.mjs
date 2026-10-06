import test from 'node:test';
import assert from 'node:assert/strict';
import { durableFixture } from './fixtures/unified-runtime-durable.mjs';

// A definition reads its own persistence port from the attempt context, so it never has
// to stash the port on shared bindings. Definitions without persistence see undefined.
test('admit and run receive the port their persistence.open returned', async t => {
  const seen = [];
  const observe = phase => context => { seen.push([phase, context.persistence?.inputRef?.id, typeof context.persistence?.store?.load]); };
  const f = await durableFixture(t, async context => { observe('run')(context); return { refs: [] }; }, { admit: async context => observe('admit')(context) });
  const job = await f.port.submit('persist', {});
  assert.equal((await f.port.wait(job.jobId)).status, 'complete');
  assert.deepEqual(seen, [['admit', 'single-fixture-1', 'function'], ['run', 'single-fixture-1', 'function']]);
});
