/* S6-5a: instant model requests (no Job, no card) share the provider quota through one metered entry (lib/runtime/instant.js): the lease of the `instant-text` resource, which
   the config's `runtime.resources.bindings` gives its own quota domain and limit, and the usage booked once. Occupancy is read at the model (calls in flight). Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createProviderResources, providerResourcesFor } from '../lib/jobs/resources.js';
import { usageLedger } from '../lib/model-usage.js';
import { until } from './helpers/wait.mjs';
import { gate } from './helpers/model-family-baseline.mjs';
import { reportUsage } from '../lib/usage-scope.js';
import { seed } from './helpers/coach-library.mjs';

const INSTANT = { resourceRef: 'instant-text', quotaDomainRef: 'instant-domain', routes: ['instant-text'], limit: 1, providerObservation: 'host-attempt' };
const AUDIO = { resourceRef: 'audio-provider', quotaDomainRef: 'trusted-account', routes: ['paid'], limit: 1, providerObservation: 'external-request' };

/** A model that answers the follow-up suggestion prompt, counts what is in flight, and can hold or fail calls. */
function model() {
  const control = { calls: 0, inFlight: 0, peak: 0, holds: [], failWith: null };
  control.complete = async (_system, prompt, options = {}) => {
    control.calls += 1; control.inFlight += 1; control.peak = Math.max(control.peak, control.inFlight);
    try {
      const held = control.holds.shift();
      if (held) await held.promise;
      options.signal?.throwIfAborted();
      reportUsage({ uncachedInputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
      if (control.failWith) throw control.failWith;
      const input = JSON.parse(prompt);
      return JSON.stringify(input.question ? { question: 'Why?', answer: 'Because.' } : { questions: ['One?', 'Two?', 'Three?'] });
    } finally { control.inFlight -= 1; }
  };
  return control;
}

async function library(t, { bindings, shared = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'instant-quota-')), fake = model(), workOwner = Symbol('host');
  const resources = createProviderResources({ owner: workOwner, scopeId: 'audio.v1', sharedProviderQuota: shared, queueTimeoutMs: 20_000, bindings });
  const service = new StudyService(root, { complete: fake.complete, completeLight: fake.complete, coach: true, workOwner, providerResources: resources });
  t.after(async () => { for (const hold of fake.holds) hold.release(); await service.dispose(); await resources.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await seed(service.call.bind(service));
  return { root, service, fake, resources, workOwner, ref: { deckId: 'd', cardId: 'q1' } };
}
/** One request per card: a second request for the same card shares the first one's answer, so overlap is asked for different cards. */
const ask = (f, card = 'q1') => f.service.call('card.followup.suggest', { deckId: 'd', cardId: card });

test('instant requests of one quota domain go one at a time at the model, in order; the wait is counted and shown in the usage summary', async t => {
  const f = await library(t, { bindings: [INSTANT] });
  const hold = gate(); f.fake.holds.push(hold);
  const before = f.fake.calls;
  const first = ask(f, 'q1'), second = ask(f, 'q2');
  await until(() => f.fake.calls === before + 1, 'the first request at the model');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(f.fake.calls, before + 1, 'the second waits for the lease: it has not asked the model');
  hold.release();
  await Promise.all([first, second]);
  assert.equal(f.fake.peak, 1, 'never two instant calls at the model at once');
  const summary = await f.service.call('usage.summary', {});
  assert.ok(summary.instant.waitedCalls >= 1 && summary.instant.waitedMs > 0, JSON.stringify(summary.instant));
  assert.equal(summary.instant.cooldowns, 0);
  const { byFeature } = await usageLedger(f.root).summary({ days: 1 });
  assert.ok(byFeature.coach, 'the usage is still booked in the ledger');
});

test('a bigger limit lets instant requests overlap and nothing waited: the summary has no instant block', async t => {
  const f = await library(t, { bindings: [{ ...INSTANT, limit: 2 }] });
  const holds = [gate(), gate()]; f.fake.holds.push(...holds);
  const both = Promise.all([ask(f, 'q1'), ask(f, 'q2')]);
  await until(() => f.fake.peak === 2, 'two instant calls at the model together');
  holds.forEach(hold => hold.release());
  await both;
  const summary = await f.service.call('usage.summary', {});
  assert.equal(Object.hasOwn(summary, 'instant'), false);
});

test('audio holding its own quota never makes an instant request wait; only a binding of both to one domain would', async t => {
  const f = await library(t, { bindings: [INSTANT, AUDIO] });
  const lease = f.resources.scoped(f.workOwner, 'audio.v1').open(), adapter = providerResourcesFor(lease.resources), held = gate();
  const audio = adapter.run('paid', () => held.promise);
  await ask(f);
  assert.equal(f.fake.peak, 1);
  held.release(); await audio; await lease.finish();
  assert.equal(Object.hasOwn(await f.service.call('usage.summary', {}), 'instant'), false, 'nothing waited');
});

test('with no instant-text binding (or the shared quota off) instant requests are not limited and not counted', async t => {
  for (const options of [{ bindings: [AUDIO] }, { bindings: [], shared: false }]) {
    const f = await library(t, options);
    const holds = [gate(), gate()]; f.fake.holds.push(...holds);
    const pair = Promise.all([ask(f, 'q1'), ask(f, 'q2')]);
    await until(() => f.fake.peak === 2, 'two instant calls at the model together');
    holds.forEach(hold => hold.release());
    await pair;
    assert.equal(Object.hasOwn(await f.service.call('usage.summary', {}), 'instant'), false);
  }
});

test('a rate-limit answer cools the shared pool and is counted', async t => {
  const f = await library(t, { bindings: [INSTANT] });
  f.fake.failWith = Object.assign(new Error('429 Too Many Requests'), { status: 429 });
  await ask(f).catch(() => {}); // the coach answers a failed suggestion with its own fallback, and the host's own retries ask again: what matters is that the pool was told
  f.fake.failWith = null;
  const summary = await f.service.call('usage.summary', {});
  assert.ok(summary.instant.cooldowns >= 1, JSON.stringify(summary.instant));
});

test('a host-attempt binding is accepted only for the instant route', () => {
  assert.doesNotThrow(() => createProviderResources({ owner: Symbol('o'), scopeId: 'audio.v1', sharedProviderQuota: true, bindings: [INSTANT] }));
  assert.throws(() => createProviderResources({ owner: Symbol('o'), scopeId: 'audio.v1', sharedProviderQuota: true, bindings: [{ ...AUDIO, providerObservation: 'host-attempt' }] }), { code: 'capability-unverified' });
});
