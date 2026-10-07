import { createHash } from 'node:crypto';
import { durableFixture } from '../fixtures/unified-runtime-durable.mjs';

/* The key paths of the kernel's manifest over a Job's whole life, and their fingerprint. The guard (tests/unified-runtime-boundaries.test.mjs) compares them to
   tests/fixtures/release-2.7.1/shape-baseline.json; `tests/fixtures/release-2.7.1/make-shape-baseline.mjs` writes that file, only after the rollback fixtures have been checked. */

const policy = { purpose: 'author', feature: 'generate', requestedEffort: 'default', executionMode: 'direct', budget: null };
// Free-form detail (what a definition puts in a call's extras, an event's args, a result) is the domain's: the kernel's own shape is what the rollback fixtures validate.
const DOMAIN = /\.(?:legacy|args|detail|extra|meta)\b/;

export const fingerprint = paths => createHash('sha256').update(paths.join('\n')).digest('hex').slice(0, 16);

/** Requests of each kind (answered, of unknown outcome, refused, a wait), a checkpoint and a delivered notice: every part of the manifest is written at least once. */
export async function manifestPaths(t) {
  const seen = [];
  let f;
  f = await durableFixture(t, async context => {
    const asks = [[1, { boundary: 'external-request', kind: 'author' }, () => ({ value: 'text', status: 200 })],
      [2, { boundary: 'external-request', kind: 'create', sideEffect: true }, () => { throw new Error('refused'); }],
      [3, { boundary: 'host-attempt', kind: 'proofread', sideEffect: false }, () => ({ value: 'ok', status: 200 })],
      [4, { boundary: 'local-wait', kind: 'wait', reason: 'rate-limit' }, () => ({ value: 'ok', status: 200 })]];
    for (const [index, meta, outcome] of asks) {
      const step = context.gateway.step(`step:${index}`, policy);
      await step.run(() => step.observe(meta, async () => { seen.push(await f.store.load()); return outcome(); })).catch(() => {});
    }
    await context.saveCheckpoint({ version: 1, ref: 'saved:one', digest: 'observed-by-the-guard', stepKey: 'safe' });
    return { refs: [], completeness: 'complete' };
  }, { notifications: [{ channel: 'inbox', idempotent: true, deliver: async () => {} }], waitForDelivery: true });
  const job = await f.port.submit('persist', {});
  await f.port.wait(job.jobId);
  seen.push(await f.store.load());
  const paths = new Set();
  const visit = (value, prefix) => {
    if (Array.isArray(value)) { paths.add(`${prefix}[]`); for (const item of value) visit(item, `${prefix}[]`); }
    else if (value && typeof value === 'object') for (const [name, inner] of Object.entries(value)) { paths.add(`${prefix}.${name}`); visit(inner, `${prefix}.${name}`); }
  };
  for (const manifest of seen) visit(manifest, 'job');
  return [...paths].filter(path => !DOMAIN.test(path)).sort();
}
