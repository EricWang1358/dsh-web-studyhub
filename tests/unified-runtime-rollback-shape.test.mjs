import test from 'node:test';
import assert from 'node:assert/strict';
import { durableFixture } from './fixtures/unified-runtime-durable.mjs';
import { validateStoredJob as acceptedByRelease } from './fixtures/release-2.7.1/store.js';

// Turning the switches off and going back to the previous release must keep every library readable: release 2.7.1 validates each manifest
// with a closed schema, and one it cannot read fails its whole snapshot. So every manifest the current runtime writes, at every point of a
// Job's life, must be accepted by that release's own validator (a verbatim copy in tests/fixtures/release-2.7.1).
const policy = { purpose: 'author', feature: 'generate', requestedEffort: 'default', executionMode: 'direct', budget: null };

/** A Job that makes the kinds of request the runtime knows, and checks the manifest on disk after each of them. */
async function writes(t, requests) {
  const seen = [];
  const f = await durableFixture(t, async context => {
    for (const [index, meta, outcome] of requests) {
      const step = context.gateway.step(`step:${index}`, policy);
      await step.run(() => step.observe(meta, async () => {
        seen.push(await f.store.load()); // the manifest while the request is in flight
        return outcome();
      })).catch(() => {});
    }
    return { refs: [], completeness: 'complete' };
  });
  const job = await f.port.submit('persist', {});
  await f.port.wait(job.jobId);
  return [...seen, await f.store.load()];
}

const ok = () => ({ value: 'text', status: 200 }), refused = () => { throw new Error('provider refused'); };

test('a manifest written at any point of a Job is one the previous release reads', async t => {
  const manifests = await writes(t, [
    [1, { boundary: 'external-request', kind: 'author' }, ok], // a side effect, answered
    [2, { boundary: 'external-request', kind: 'create', sideEffect: true }, refused], // a side effect whose outcome stays unknown
    [3, { boundary: 'external-request', kind: 'transcribe', sideEffect: false }, ok], // changes nothing remote
    [4, { boundary: 'host-attempt', kind: 'proofread', sideEffect: false }, refused],
    [5, { boundary: 'local-wait', kind: 'wait', reason: 'rate-limit' }, ok],
  ]);
  assert.equal(manifests.length, 6);
  for (const manifest of manifests) assert.doesNotThrow(() => acceptedByRelease(structuredClone(manifest)), JSON.stringify(manifest.requestIntents));
  // Only the requests with a side effect leave an intent: one changing nothing remote is simply asked again after a crash.
  assert.deepEqual(manifests.at(-1).requestIntents.map(intent => [intent.stepKey, intent.status]), [['step:1', 'completed'], ['step:2', 'pending']]);
});
