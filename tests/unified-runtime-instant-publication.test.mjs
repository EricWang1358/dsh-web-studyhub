import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createProviderResources } from '../lib/jobs/resources.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { usageLedger } from '../lib/model-usage.js';
import { importExample } from '../ui/json-prompts.js';
import { until } from './helpers/wait.mjs';
import { gate } from './helpers/model-family-baseline.mjs';
import { seed } from './helpers/coach-library.mjs';

/* S6-5a for the last model call that was not metered: the review a publication asks before it writes (authoring/publication.js). Asked outside a Job - the learner or an agent calls
   `draft.publish` itself - it is an instant request: one lease of the `instant-text` resource under the shared provider quota, the usage booked once. Inside a publish Job it is the
   Job's own (the gateway behind `generationPublish`, the ledger-only path before it) and takes no instant lease. Fakes only. */

const INSTANT = { resourceRef: 'instant-text', quotaDomainRef: 'instant-domain', routes: ['instant-text'], limit: 1, providerObservation: 'host-attempt' };

/** The fake of the whole library (it reports usage like a provider) with the review calls counted, in flight and, on request, held (all of them, by one gate). */
function reviewing() {
  const inner = createFakeModel({ usage: true }), control = { calls: 0, reviews: 0, inFlight: 0, peak: 0, gate: null };
  control.complete = async (system, prompt, options = {}) => {
    control.calls += 1; control.inFlight += 1; control.peak = Math.max(control.peak, control.inFlight);
    try {
      if (String(system).startsWith('Act as a strict')) { control.reviews += 1; if (control.gate) await control.gate.promise; }
      return await inner(system, prompt, options);
    } finally { control.inFlight -= 1; }
  };
  return control;
}

async function library(t, { shared = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'instant-publication-')), fake = reviewing(), workOwner = Symbol('host');
  const resources = createProviderResources({ owner: workOwner, scopeId: 'audio.v1', sharedProviderQuota: shared, queueTimeoutMs: 20_000, bindings: shared ? [INSTANT] : [] });
  const service = new StudyService(root, { complete: fake.complete, completeLight: fake.complete, coach: true, workOwner, providerResources: resources });
  t.after(async () => { fake.gate?.release(); await service.dispose(); await resources.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await seed(service.call.bind(service));
  const draft = await service.call('draft.import', { text: importExample('flashcard') });
  return { root, service, fake, draft };
}
const another = f => f.service.call('card.followup.suggest', { deckId: 'd', cardId: 'q1' });

test('the review of a publication asked outside a Job takes the instant lease: another instant request waits for it, and the usage is booked once', async t => {
  const f = await library(t), hold = gate(); f.fake.gate = hold;
  const publication = f.service.call('draft.publish', { id: f.draft.id, draftVersion: f.draft.draftVersion });
  await until(() => f.fake.reviews >= 1, 'the review to be at the model');
  const second = another(f);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(f.fake.calls - f.fake.reviews, 0, 'the other instant request waits for the lease: it has not asked the model');
  hold.release();
  const [result] = await Promise.all([publication, second]);
  assert.ok(result.autoReviewed > 0);
  assert.equal(f.fake.peak, 1, 'never two instant calls at the model at once, the review included');
  const { byFeature } = await usageLedger(f.root).summary({ days: 1 });
  assert.equal(byFeature.repair.calls, f.fake.reviews, 'every review is in the ledger once: as many as the model answered');
});

test('inside a publish Job the review is the Jobs own: it takes no instant lease', async t => {
  const f = await library(t), hold = gate(); f.fake.gate = hold;
  const started = await f.service.call('draft.publish.start', { id: f.draft.id, draftVersion: f.draft.draftVersion });
  await until(() => f.fake.reviews >= 1, 'the review of the Job to be at the model');
  await another(f);
  assert.ok(f.fake.peak >= 2, 'an instant request is not made to wait for the review of a Job');
  hold.release();
  assert.equal((await f.service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 30 })).status, 'complete');
});

test('with the shared quota off the review of a publication is exactly what it was', async t => {
  const f = await library(t, { shared: false }), hold = gate(); f.fake.gate = hold;
  const publication = f.service.call('draft.publish', { id: f.draft.id, draftVersion: f.draft.draftVersion });
  await until(() => f.fake.reviews >= 1, 'the review to be at the model');
  await another(f);
  assert.ok(f.fake.peak >= 2, 'nothing is limited');
  hold.release();
  assert.ok((await publication).autoReviewed > 0);
});
