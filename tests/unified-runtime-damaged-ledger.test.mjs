import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { durableFixture } from './fixtures/unified-runtime-durable.mjs';

// Usage is recorded for the learner's overview; it is never a condition of working. A durable job that owes the ledger nothing starts and ends
// whatever state the usage file is in; one that owes it usage is refused a retry until the ledger can be written.
test('a damaged usage ledger does not keep a durable job that owes it nothing from starting', async t => {
  let runs = 0;
  const f = await durableFixture(t, async () => { runs++; return { refs: [], completeness: 'complete' }; });
  await mkdir(join(f.root, 'model-usage.json'));
  const job = await f.port.submit('persist', {});
  assert.equal((await f.port.wait(job.jobId)).status, 'complete');
  assert.equal(runs, 1);
});
