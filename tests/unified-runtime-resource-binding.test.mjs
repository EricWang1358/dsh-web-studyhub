import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderResources } from '../lib/jobs/resources.js';
import { GeminiTiers } from '../lib/gemini.js';
import { finishTranscript } from '../lib/audio-import.js';
import { createPool } from '../lib/audio-pool.js';

const owner = Symbol('trusted host');
const binding = (resourceRef, quotaDomainRef, routes) => ({ resourceRef, quotaDomainRef, routes, limit: 1, providerObservation: 'external-request' });
const config = { sharedProviderQuota: true, queueTimeoutMs: 1000, bindings: [binding('shared', 'account-a', ['free', 'paid'])] };
const create = (options = config) => createProviderResources({ owner, scopeId: 'audio.v1', ...options });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const reply = () => response({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });

test('S1-3 resources are default off, owner-bound, and cannot infer a quota domain', async () => {
  const off = create({}), lease = off.scoped(owner, 'audio.v1').open();
  assert.equal(lease.enabled, false); await lease.finish();
  assert.throws(() => off.scoped(Symbol('other'), 'audio.v1'), { code: 'resource-unbound' });
  assert.throws(() => off.scoped(owner, 'other.v1'), { code: 'resource-unbound' });
  assert.throws(() => create({ ...config, bindings: [binding('x', '', ['free'])] }), { code: 'quota-domain-unresolved' });
  assert.throws(() => create({ ...config, bindings: [{ ...config.bindings[0], providerObservation: 'host-attempt' }] }), { code: 'capability-unverified' });
  assert.throws(() => create({ ...config, bindings: [binding('one', 'same', ['free']), binding('two', 'same', ['paid'])] }), { code: 'resource-owner-conflict' });
  assert.throws(() => new GeminiTiers({ resources: { run() {} } }), { code: 'resource-unbound' });
});

test('S1-3 the kernel binds the registered domain without an audio-specific branch', async () => {
  const hub = create({ ...config, scopeId: 'another.v1' });
  assert.equal(hub.forDomain(owner, 'audio.v1'), undefined);
  const lease = hub.forDomain(owner, 'another.v1').open();
  assert.equal(await lease.resources.run('shared', () => 'scoped', { queueTimeoutMs: 1000 }), 'scoped');
  await lease.finish();
});

test('S1-3 alias routes share one actual permit and an unbound ref never executes', async () => {
  const hub = create(), one = hub.scoped(owner, 'audio.v1').open(), two = hub.scoped(owner, 'audio.v1').open();
  const held = Promise.withResolvers(); let started = false;
  const first = one.resources.run('shared', () => held.promise, { queueTimeoutMs: 1000 });
  const second = two.resources.run('shared', () => { started = true; }, { queueTimeoutMs: 1000 });
  await flush(); assert.equal(started, false);
  await assert.rejects(one.resources.run('input-controlled-ref', () => assert.fail('unbound I/O'), { queueTimeoutMs: 1000 }), { code: 'resource-unbound' });
  held.resolve(); await Promise.all([first, second]);
  await Promise.all([one.finish(), two.finish()]);
});

test('S1-3 old Gemini tiers and a scoped resource port share physical body occupancy', async () => {
  const hub = create(), legacy = hub.scoped(owner, 'audio.v1').open(), current = hub.scoped(owner, 'audio.v1').open();
  const body = Promise.withResolvers(); let entered = false, successor = false;
  const tiers = new GeminiTiers({ keys: { free: 'fake' }, resources: legacy.resources,
    fetch: async () => { entered = true; return { status: 200, ok: true, headers: new Headers(), json: () => body.promise }; } });
  const old = tiers.complete('alias-one', 'system', 'prompt'); await flush(); assert.equal(entered, true);
  const next = current.resources.run('shared', () => { successor = true; }, { queueTimeoutMs: 1000 });
  await flush(); assert.equal(successor, false);
  body.resolve({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
  assert.equal(await old, 'ok'); await next;
  await Promise.all([legacy.finish(), current.finish()]);
});

test('S1-3 Gemini HTTP 429 cools the common domain without resending in the resource layer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const hub = create(), a = hub.scoped(owner, 'audio.v1').open(), b = hub.scoped(owner, 'audio.v1').open();
  for (const [source, peer] of [[a, b], [b, a]]) {
    let calls = 0, peerCalls = 0;
    const tiers = new GeminiTiers({ keys: { free: 'fake' }, resources: source.resources,
      fetch: async () => { calls++; return response({ error: {} }, 429, { 'retry-after': '0.1' }); } });
    const other = new GeminiTiers({ keys: { paid: 'fake' }, resources: peer.resources,
      fetch: async () => { peerCalls++; return reply(); } });
    // json is the physical seam, independent of GeminiTiers.request's existing retry policy.
    assert.equal((await tiers.json('https://example.invalid', 'fake', {}, undefined, 1000, undefined, 'free')).status, 429);
    const waiting = other.complete('alias', 'system', 'prompt');
    t.mock.timers.tick(99); await flush(); assert.equal(peerCalls, 0); assert.equal(calls, 1);
    t.mock.timers.tick(1); await waiting; assert.equal(peerCalls, 1);
  }
  await Promise.all([a.finish(), b.finish()]);
});

test('S1-3 disable revokes new Attempts and drains the fixed binding before baseline admission', async () => {
  const hub = create(), lease = hub.scoped(owner, 'audio.v1').open(), held = Promise.withResolvers();
  const work = lease.resources.run('shared', () => held.promise, { queueTimeoutMs: 1000 }); await flush();
  let done = false; const switching = hub.disable().then(() => { done = true; });
  assert.throws(() => hub.scoped(owner, 'audio.v1').open(), { code: 'scope-unloaded' });
  held.resolve(); await work; await flush(); assert.equal(done, false);
  assert.equal(await lease.resources.run('shared', () => 'old Attempt finishes under original policy', { queueTimeoutMs: 1000 }), 'old Attempt finishes under original policy');
  await lease.finish(); await switching;
  const baseline = hub.scoped(owner, 'audio.v1').open(); assert.equal(baseline.enabled, false); await baseline.finish();
});

test('S1-3 configured routes must be bound before a tier can perform I/O', async () => {
  const hub = create(), lease = hub.scoped(owner, 'audio.v1').open();
  assert.throws(() => new GeminiTiers({ keys: { groq: 'fake' }, resources: lease.resources, fetch: () => assert.fail('unbound provider') }), { code: 'resource-unbound' });
  const tiers = new GeminiTiers({ keys: { free: 'fake' }, resources: lease.resources, fetch: async () => reply() });
  assert.equal(await tiers.complete('alias-two', 'system', 'prompt'), 'ok');
  await lease.finish();
});

test('S1-3 window processing does not add transport retries when the provider owns them', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const complete = Object.assign(async () => { calls++; throw Object.assign(new Error('provider unavailable'), { status: 503 }); }, { providerOwnsRetry: true });
  const result = assert.rejects(finishTranscript({ paragraphs: ['One paragraph.'], filename: 'probe', complete,
    settings: { textConcurrency: 1 }, saved: { get: async () => null, set: async () => {} }, keys: { raw: 'r', text: 't' },
    signal: new AbortController().signal, pools: { text: createPool({ limit: 1, refusals: 0 }) } }), /provider unavailable/);
  await flush(); t.mock.timers.tick(800); await flush(); t.mock.timers.tick(2000); await result;
  assert.equal(calls, 1);
});

test('S1-3 an admitted Attempt retains bounded cleanup access after cancel and policy drain', async () => {
  const hub = create(), controller = new AbortController(), lease = hub.scoped(owner, 'audio.v1').open(controller.signal);
  let deleted = false;
  const tiers = new GeminiTiers({ keys: { free: 'fake' }, resources: lease.resources,
    fetch: async (_url, init) => { assert.equal(init.signal?.aborted, undefined); deleted = true; return response({}); } });
  const drain = hub.disable(); controller.abort();
  await tiers.transport('free', true)('https://example.invalid/owned-upload', { method: 'DELETE', timeoutMs: 30000 });
  assert.equal(deleted, true); await lease.finish(); await drain;
});

test('S1-3 release waits for outstanding physical promises and revokes retained ports', async () => {
  const hub = create(), lease = hub.scoped(owner, 'audio.v1').open(), held = Promise.withResolvers();
  const request = lease.resources.run('shared', () => held.promise, { queueTimeoutMs: 1000 }); await flush();
  let finished = false; const closing = lease.finish().then(() => { finished = true; });
  await flush(); assert.equal(finished, false);
  await assert.rejects(lease.resources.run('shared', () => assert.fail('retained port'), { queueTimeoutMs: 1000 }), { code: 'scope-unloaded' });
  held.resolve(); await request; await closing; assert.equal(finished, true);
});

test('S1-3 every Gemini file request, including cleanup, is individually admitted', async () => {
  const hub = create(), lease = hub.scoped(owner, 'audio.v1').open(), calls = [];
  const file = { name: 'files/owned', uri: 'https://generativelanguage.googleapis.com/file/owned', state: 'ACTIVE' };
  const tiers = new GeminiTiers({ keys: { paid: 'fake' }, resources: lease.resources, fetch: async (url, init) => {
    calls.push([String(url), init.method || 'GET']); assert.equal(init.awaitPhysicalClose, true);
    if (init.method === 'DELETE') return response({});
    if (String(url).includes('/upload/')) return response({}, 200, { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload-target' });
    if (String(url).endsWith('/upload-target')) return response({ file });
    return reply();
  } });
  const result = await tiers.transcribe({ bytes: Buffer.alloc(13 * 1024 * 1024), mimeType: 'audio/wav', seconds: 1 });
  assert.equal(result.text, 'ok'); assert.equal(calls.length, 4);
  assert.deepEqual(calls.map(call => call[1]), ['POST', 'POST', 'POST', 'DELETE']);
  await lease.finish();
});

test('S1-3 actual tier fallback releases and reacquires without a nested same-domain permit', async () => {
  const hub = create(), lease = hub.scoped(owner, 'audio.v1').open(); let calls = 0;
  const tiers = new GeminiTiers({ keys: { free: 'fake-free', paid: 'fake-paid' }, resources: lease.resources,
    fetch: async () => ++calls === 1 ? response({ error: { message: 'bad key' } }, 403) : reply() });
  assert.equal(await tiers.complete('model', 'system', 'prompt'), 'ok'); assert.equal(calls, 2);
  await lease.finish();
});
