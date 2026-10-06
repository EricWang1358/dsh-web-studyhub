import test from 'node:test';
import assert from 'node:assert/strict';
import { durableFixture } from './fixtures/unified-runtime-durable.mjs';

// A definition whose work already has a public name (a conversion's folder and history row) can keep it as the Job's list id, across retries.
const named = (f, domain, legacyId) => {
  let attempts = 0;
  f.lifecycle.register(f.ctx, domain, { kind: 'named', version: 1, capabilities: { retry: true }, ...(legacyId ? { legacyId } : {}),
    run: async () => { if (++attempts === 1) throw new Error('first attempt fails'); return { refs: [] }; } });
  return f.lifecycle.scoped({ owner: Symbol(domain), domain, executor: f.executor });
};

test('a definition can name its Job: the list id is the name, it survives a retry, and the Job is found by it', async t => {
  const f = await durableFixture(t, async () => ({ refs: [] }));
  const port = named(f, 'named.v1', input => input.name);
  const job = await port.submit('named', { name: 'book-2026-a' });
  assert.equal(job.runtime.legacyId, 'book-2026-a');
  assert.equal((await port.wait(job.jobId)).status, 'failed');
  assert.equal(port.status('book-2026-a').jobId, job.jobId, 'authorised and found by the name');
  await port.control(job.jobId, 'retry');
  const done = await port.wait(job.jobId);
  assert.deepEqual([done.status, done.runtime.legacyId], ['complete', 'book-2026-a']);
  assert.deepEqual(port.list().map(item => item.runtime.legacyId), ['book-2026-a']);
});

test('a name the Job cannot be listed under is refused before any Job exists; without one the id is still fresh per Job and per retry', async t => {
  const f = await durableFixture(t, async () => ({ refs: [] }));
  const port = named(f, 'bad.v1', () => '');
  await assert.rejects(port.submit('named', {}), { code: 'invalid-legacy-id' });
  assert.deepEqual(port.list(), []);
  const plain = named(f, 'plain.v1');
  const first = await plain.submit('named', {}); await plain.wait(first.jobId);
  const before = plain.status(first.jobId).runtime.legacyId;
  await plain.control(first.jobId, 'retry'); await plain.wait(first.jobId);
  assert.notEqual(plain.status(first.jobId).runtime.legacyId, before);
});
