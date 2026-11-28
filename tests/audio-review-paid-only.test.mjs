import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { AUDIO_PROVIDERS } from '../lib/audio-providers.js';
import { geminiTextFake, hostModel, seedReview } from './helpers/audio-family.mjs';
import { AUDIO_SWITCHES } from './helpers/audio-switch.mjs';
import { SWITCH_MODES, switchOptions } from './helpers/runtime-switch.mjs';
import { settleJob } from './helpers/wait.mjs';

const FREE_KEY = 'AIzaReviewPaidOnlyFree_00000000001';
const PAID_KEY = 'AIzaReviewPaidOnlyPaid_00000000002';
const GROQ_KEY = 'gsk_ReviewPaidOnlyGroq_00000000003';
const NO_PAID_KEY_RE = /选择了只用付费密钥，但还没有配置付费密钥/;

function createReviewFetch({ failWhen = () => false } = {}) {
  const log = [];
  const wireKeys = [];
  const base = geminiTextFake(log);
  let requestIndex = 0;
  const httpFetch = async (url, init = {}) => {
    const apiKey = new Headers(init.headers || {}).get('x-goog-api-key');
    wireKeys.push(apiKey);
    const current = ++requestIndex;
    if (failWhen({ index: current, apiKey, url: String(url), init })) {
      return new Response(JSON.stringify({ error: { message: 'controlled fatal failure' } }), { status: 402 });
    }
    return base(url, init);
  };
  return { fetch: httpFetch, log, wireKeys };
}

async function setupLibrary(t, mode, { settings = {}, fetch, complete } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'audio-review-paid-only-'));
  const root = join(dir, 'library');
  const previousHome = process.env.DSH_HOME;
  const previousProviderEnv = new Map();
  process.env.DSH_HOME = join(dir, 'home');
  for (const { envVar } of AUDIO_PROVIDERS) {
    previousProviderEnv.set(envVar, process.env[envVar]);
    delete process.env[envVar];
  }
  const service = new StudyService(root, {
    ...switchOptions(mode, { complete, paths: [...AUDIO_SWITCHES] }),
    ...(fetch ? { fetch } : {}),
    ...(complete ? { complete } : {}),
  });
  t.after(async () => {
    await service.dispose?.().catch(() => {});
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    for (const [envVar, value] of previousProviderEnv) {
      if (value === undefined) delete process.env[envVar];
      else process.env[envVar] = value;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  if (Object.keys(settings).length) await service.call('audio.settings.set', settings);
  const state = () => service.store.read();
  return { service, state };
}

const unreviewedCount = async (state, id = 'talk-1') =>
  (await state()).sources.find(item => item.id === id).audio.corrections.skipped.filter(item => !item.review).length;

for (const mode of SWITCH_MODES) {
  test(`[${mode}] paidOnlyByDefault: true with omitted paidOnly sends only PAID_KEY, never FREE_KEY`, async t => {
    const fake = createReviewFetch();
    const { service } = await setupLibrary(t, mode, {
      fetch: fake.fetch,
      settings: { textProvider: 'gemini', freeKey: FREE_KEY, paidKey: PAID_KEY, paidOnlyByDefault: true },
    });
    await seedReview(service, 2);
    const started = await service.call('audio.corrections.review', { sourceId: 'talk-1' });
    const done = await settleJob(service, started.jobId);
    assert.equal(done.status, 'complete', done.stage);
    assert.deepEqual(fake.log, ['review']);
    assert.deepEqual(fake.wireKeys, [PAID_KEY]);
    assert.ok(!fake.wireKeys.includes(FREE_KEY));
  });

  test(`[${mode}] paidOnlyByDefault: false with explicit paidOnly: true sends only PAID_KEY, never FREE_KEY`, async t => {
    const fake = createReviewFetch();
    const { service } = await setupLibrary(t, mode, {
      fetch: fake.fetch,
      settings: { textProvider: 'gemini', freeKey: FREE_KEY, paidKey: PAID_KEY, paidOnlyByDefault: false },
    });
    await seedReview(service, 2);
    const started = await service.call('audio.corrections.review', { sourceId: 'talk-1', paidOnly: true });
    const done = await settleJob(service, started.jobId);
    assert.equal(done.status, 'complete', done.stage);
    assert.deepEqual(fake.log, ['review']);
    assert.deepEqual(fake.wireKeys, [PAID_KEY]);
    assert.ok(!fake.wireKeys.includes(FREE_KEY));
  });

  test(`[${mode}] paidOnlyByDefault: true with explicit paidOnly: false lets explicit false win and sends FREE_KEY`, async t => {
    const fake = createReviewFetch();
    const { service } = await setupLibrary(t, mode, {
      fetch: fake.fetch,
      settings: { textProvider: 'gemini', freeKey: FREE_KEY, paidKey: PAID_KEY, paidOnlyByDefault: true },
    });
    await seedReview(service, 2);
    const started = await service.call('audio.corrections.review', { sourceId: 'talk-1', paidOnly: false });
    const done = await settleJob(service, started.jobId);
    assert.equal(done.status, 'complete', done.stage);
    assert.deepEqual(fake.log, ['review']);
    assert.deepEqual(fake.wireKeys, [FREE_KEY]);
    assert.ok(!fake.wireKeys.includes(PAID_KEY));
  });

  test(`[${mode}] freeKey-only with paidOnlyByDefault: false succeeds on FREE_KEY without requiring paidKey`, async t => {
    const fake = createReviewFetch();
    const { service } = await setupLibrary(t, mode, {
      fetch: fake.fetch,
      settings: { textProvider: 'gemini', freeKey: FREE_KEY, paidOnlyByDefault: false },
    });
    await seedReview(service, 2);
    const started = await service.call('audio.corrections.review', { sourceId: 'talk-1' });
    const done = await settleJob(service, started.jobId);
    assert.equal(done.status, 'complete', done.stage);
    assert.deepEqual(fake.log, ['review']);
    assert.deepEqual(fake.wireKeys, [FREE_KEY]);
  });

  test(`[${mode}] paid-only without paidKey rejects synchronously with NO_PAID_KEY, zero HTTP requests, zero jobs, zero inbox letters`, async t => {
    const fake = createReviewFetch();
    const { service, state } = await setupLibrary(t, mode, {
      fetch: fake.fetch,
      settings: { textProvider: 'gemini', freeKey: FREE_KEY, paidOnlyByDefault: true },
    });
    await seedReview(service, 2);

    await assert.rejects(
      service.call('audio.corrections.review', { sourceId: 'talk-1' }),
      NO_PAID_KEY_RE,
    );

    await service.call('audio.settings.set', { paidOnlyByDefault: false });
    await assert.rejects(
      service.call('audio.corrections.review', { sourceId: 'talk-1', paidOnly: true }),
      NO_PAID_KEY_RE,
    );

    await service.call('audio.settings.set', { freeKey: '', groqKey: GROQ_KEY, paidOnlyByDefault: true });
    await assert.rejects(
      service.call('audio.corrections.review', { sourceId: 'talk-1' }),
      NO_PAID_KEY_RE,
    );

    assert.deepEqual(fake.wireKeys, []);
    assert.deepEqual(fake.log, []);
    assert.deepEqual((await service.call('snapshot')).jobs, []);
    assert.deepEqual((await state()).inbox, []);
  });

  test(`[${mode}] [C39] retry after enabling paidOnlyByDefault uses only PAID_KEY for remaining batch`, async t => {
    let failBatch2 = true;
    const fake = createReviewFetch({ failWhen: ({ index }) => failBatch2 && index === 2 });
    const { service, state } = await setupLibrary(t, mode, {
      fetch: fake.fetch,
      settings: { textProvider: 'gemini', freeKey: FREE_KEY, paidKey: PAID_KEY, paidOnlyByDefault: false },
    });
    await seedReview(service, 16);

    const started = await service.call('audio.corrections.review', { sourceId: 'talk-1' });
    const failed = await settleJob(service, started.jobId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.done, 1);
    assert.equal(failed.total, 2);
    assert.equal(failed.retryable, true);
    assert.equal(await unreviewedCount(state), 1);
    assert.deepEqual(fake.wireKeys, [FREE_KEY, FREE_KEY]);

    failBatch2 = false;
    await service.call('audio.settings.set', { paidOnlyByDefault: true });
    const beforeRetry = fake.wireKeys.length;
    const retried = await service.call('job.control', { jobId: failed.id, action: 'retry' });
    const retryId = mode === 'runtime' ? retried.attemptId : retried.jobId;
    const done = await settleJob(service, retryId);

    assert.equal(done.status, 'complete', done.stage);
    assert.equal(await unreviewedCount(state), 0);
    const retryKeys = fake.wireKeys.slice(beforeRetry);
    assert.deepEqual(retryKeys, [PAID_KEY]);
    assert.ok(!retryKeys.includes(FREE_KEY));
  });

  test(`[${mode}] [C39] retry after clearing paidKey with paidOnlyByDefault enabled refuses with NO_PAID_KEY and sends zero requests to FREE_KEY`, async t => {
    let failBatch2 = true;
    const fake = createReviewFetch({ failWhen: ({ index }) => failBatch2 && index === 2 });
    const { service, state } = await setupLibrary(t, mode, {
      fetch: fake.fetch,
      settings: { textProvider: 'gemini', freeKey: FREE_KEY, paidKey: PAID_KEY, paidOnlyByDefault: false },
    });
    await seedReview(service, 16);

    const started = await service.call('audio.corrections.review', { sourceId: 'talk-1' });
    const failed = await settleJob(service, started.jobId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.done, 1);
    assert.equal(await unreviewedCount(state), 1);
    assert.deepEqual(fake.wireKeys, [FREE_KEY, FREE_KEY]);

    failBatch2 = false;
    await service.call('audio.settings.set', { paidKey: '', paidOnlyByDefault: true });
    const beforeRetry = fake.wireKeys.length;
    const retried = await service.call('job.control', { jobId: failed.id, action: 'retry' });
    const retryId = mode === 'runtime' ? retried.attemptId : retried.jobId;
    const retryDone = await settleJob(service, retryId);

    assert.equal(retryDone.status, 'failed');
    assert.match(String(retryDone.stage || retryDone.error?.message || ''), NO_PAID_KEY_RE);
    const retryKeys = fake.wireKeys.slice(beforeRetry);
    assert.deepEqual(retryKeys, []);
    assert.ok(!retryKeys.includes(FREE_KEY));
    assert.equal(await unreviewedCount(state), 1);
  });

  test(`[${mode}] [C39] retry preserves explicit paidOnly: true even when paidOnlyByDefault is false`, async t => {
    let failBatch2 = true;
    const fake = createReviewFetch({ failWhen: ({ index }) => failBatch2 && index === 2 });
    const { service, state } = await setupLibrary(t, mode, {
      fetch: fake.fetch,
      settings: { textProvider: 'gemini', freeKey: FREE_KEY, paidKey: PAID_KEY, paidOnlyByDefault: false },
    });
    await seedReview(service, 16);

    const started = await service.call('audio.corrections.review', { sourceId: 'talk-1', paidOnly: true });
    const failed = await settleJob(service, started.jobId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.done, 1);
    assert.equal(failed.total, 2);
    assert.equal(failed.retryable, true);
    assert.equal(await unreviewedCount(state), 1);
    assert.deepEqual(fake.wireKeys, [PAID_KEY, PAID_KEY]);
    assert.ok(!fake.wireKeys.includes(FREE_KEY));

    failBatch2 = false;
    const beforeRetry = fake.wireKeys.length;
    const retried = await service.call('job.control', { jobId: failed.id, action: 'retry' });
    const retryId = mode === 'runtime' ? retried.attemptId : retried.jobId;
    const done = await settleJob(service, retryId);

    assert.equal(done.status, 'complete', done.stage);
    assert.equal(await unreviewedCount(state), 0);
    const retryKeys = fake.wireKeys.slice(beforeRetry);
    assert.deepEqual(retryKeys, [PAID_KEY]);
    assert.ok(!retryKeys.includes(FREE_KEY));
  });

  test(`[${mode}] [C39] retry preserves explicit paidOnly: false even after enabling paidOnlyByDefault`, async t => {
    let failBatch2 = true;
    const fake = createReviewFetch({ failWhen: ({ index }) => failBatch2 && index === 2 });
    const { service, state } = await setupLibrary(t, mode, {
      fetch: fake.fetch,
      settings: { textProvider: 'gemini', freeKey: FREE_KEY, paidKey: PAID_KEY, paidOnlyByDefault: false },
    });
    await seedReview(service, 16);

    const started = await service.call('audio.corrections.review', { sourceId: 'talk-1', paidOnly: false });
    const failed = await settleJob(service, started.jobId);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.done, 1);
    assert.equal(failed.total, 2);
    assert.equal(failed.retryable, true);
    assert.equal(await unreviewedCount(state), 1);
    assert.deepEqual(fake.wireKeys, [FREE_KEY, FREE_KEY]);

    failBatch2 = false;
    await service.call('audio.settings.set', { paidOnlyByDefault: true });
    const beforeRetry = fake.wireKeys.length;
    const retried = await service.call('job.control', { jobId: failed.id, action: 'retry' });
    const retryId = mode === 'runtime' ? retried.attemptId : retried.jobId;
    const done = await settleJob(service, retryId);

    assert.equal(done.status, 'complete', done.stage);
    assert.equal(await unreviewedCount(state), 0);
    const retryKeys = fake.wireKeys.slice(beforeRetry);
    assert.deepEqual(retryKeys, [FREE_KEY]);
    assert.ok(!retryKeys.includes(PAID_KEY));
  });

  test(`[${mode}] textProvider: host succeeds with paidOnlyByDefault: true and explicit paidOnly: true without paidKey`, async t => {
    const log = [];
    const { service } = await setupLibrary(t, mode, {
      complete: hostModel(log),
      fetch: async () => { throw new Error('Gemini HTTP must not be called when textProvider is host'); },
      settings: { textProvider: 'host', paidOnlyByDefault: true },
    });
    await seedReview(service, 2, 'talk-1');
    await seedReview(service, 2, 'talk-2');

    const first = await settleJob(service, (await service.call('audio.corrections.review', { sourceId: 'talk-1' })).jobId);
    assert.equal(first.status, 'complete', first.stage);
    assert.equal(first.review.applied, 2);

    const second = await settleJob(service, (await service.call('audio.corrections.review', { sourceId: 'talk-2', paidOnly: true })).jobId);
    assert.equal(second.status, 'complete', second.stage);
    assert.equal(second.review.applied, 2);

    assert.deepEqual(log, ['review', 'review']);
  });
}
