import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createModelGateway } from '../lib/jobs/gateway.js';
import { GeminiTiers, tiersFromSettings } from '../lib/gemini.js';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';
import { validateRuntimeContract } from '../lib/jobs/contract.js';
import { until } from './helpers/wait.mjs';
import { recordAudioUsage } from '../lib/audio-dashboard.js';
const policy = { purpose: 'proofread', feature: 'audio', requestedEffort: 'medium', executionMode: 'direct', budget: null };
function setup(host, ledger, requiresExternalObservation = false) {
  const record = structuredClone(goldenRuntimeContracts.running); record.calls = []; record.runtime.steps = [];
  const controller = new AbortController(); let current = true;
  const context = { jobId: record.jobId, attemptId: record.attemptId, signal: controller.signal, requiresExternalObservation,
    assertCurrent() { if (!current) throw Object.assign(new Error('stale'), { code: 'stale-attempt' }); controller.signal.throwIfAborted(); } };
  const gateway = createModelGateway({ context, record, host, ledger });
  return { record, controller, gateway, revoke: () => { current = false; } };
}
const reply = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => body });
test('gateway rejects missing/unsupported policies and out-of-step calls before I/O', async () => {
  const { gateway } = setup();
  for (const value of [{}, { ...policy, executionMode: 'magic' }, { ...policy, budget: { dollars: 1 } }, { ...policy, requestedEffort: 'xhigh' }])
    assert.throws(() => gateway.step('a', value), { code: 'invalid-gateway-policy' });
  let sent = 0;
  await assert.rejects(() => gateway.observe({ boundary: 'external-request' }, () => sent++), { code: 'step-required' });
  assert.equal(sent, 0);
});
test('gateway records actual retry-success, fallback and permanent failures once per leaf', async () => {
  for (const statuses of [[503, 200], [401, 200], [503, 503, 503]]) {
    const { gateway, record } = setup(); let sent = 0;
    const tiers = new GeminiTiers({ keys: { free: 'fake-free', ...(statuses[0] === 401 ? { paid: 'fake-paid' } : {}) },
      gateway, sleep: async () => {}, fetch: async () => { const status = statuses[Math.min(sent++, statuses.length - 1)]; return reply(status, status === 200 ? { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } : {}); } });
    const pending = gateway.step('proofread:1', policy).run(() => tiers.generate('fake', {}, {}));
    if (statuses.at(-1) === 200) assert.equal((await pending).text, 'ok'); else await assert.rejects(() => pending);
    assert.equal(record.calls.length, sent); assert.ok(sent >= statuses.length);
    assert.equal(new Set(record.calls.map(call => call.callId)).size, sent);
    assert.ok(record.calls.every(call => call.observation.requestCount === 1 && call.endedAt));
    assert.ok(record.calls.every(call => call.tokenUsage === null && call.tokens === null));
    if (statuses[0] === 401) assert.deepEqual(record.calls.map(call => call.tier), ['free', 'paid']);
    validateRuntimeContract(record);
  }
});
test('gateway permits physical cleanup after cancellation, but rejects new business work', async () => {
  const { gateway, controller, record } = setup(); const held = Promise.withResolvers(), entered = Promise.withResolvers();
  const step = gateway.step('work', policy);
  const running = step.run(() => gateway.observe({ boundary: 'external-request', kind: 'model' }, async () => { entered.resolve(); await held.promise; return { value: 'late' }; }));
  await entered.promise; controller.abort(); assert.equal(record.calls[0].status, 'running');
  held.resolve(); await assert.rejects(() => running);
  assert.equal(record.calls[0].status, 'cancelled');
  await assert.rejects(() => step.run(() => {}));
});
test('required child rejects and preferred falls back visibly without fabricated lineage', async () => {
  const host = { ctx: {}, sessionId: 'absent', route: { provider: 'fake', model: 'fake' }, complete: async () => 'ok' };
  const { gateway, record } = setup(host);
  await assert.rejects(() => gateway.step('required', { ...policy, executionMode: 'agent-required' }).complete('s', 'p'), { code: 'agent-unavailable' });
  assert.equal(record.calls.length, 0);
  assert.equal(await gateway.step('preferred', { ...policy, requestedEffort: 'default', executionMode: 'agent-preferred' }).complete('s', 'p'), 'ok');
  assert.equal(record.calls[0].fallbackReason, 'agent-unavailable');
  assert.equal(record.calls[0].observation.requestCount, null);
  assert.equal(record.calls[0].childId, undefined);
});
test('stale Attempt cannot open another Step or execute a captured capability', async () => {
  const { gateway, revoke } = setup(); const step = gateway.step('a', policy); revoke();
  assert.throws(() => gateway.step('b', policy), { code: 'stale-attempt' });
  await assert.rejects(() => step.run(() => {}), { code: 'stale-attempt' });
});
test('managed audio replaces the old fetch meter and stable Call replay is idempotent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-ledger-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = directory;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(directory, { recursive: true, force: true }); });
  const { gateway, record } = setup();
  const tiers = tiersFromSettings({ freeKey: 'fake-key' }, { gateway, fetch: async () => reply(200, { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 }, candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) });
  await gateway.step('proofread:1', policy).run(() => tiers.generate('fake', {}, {}));
  const event = record.calls[0].ledgerEvent;
  assert.ok(event?.callId); assert.equal(record.calls[0].tokens, 7);
  await Promise.all([recordAudioUsage(event), recordAudioUsage(event)]);
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `import { recordAudioUsage } from ${JSON.stringify(new URL('../lib/audio-dashboard.js', import.meta.url).href)}; await recordAudioUsage(${JSON.stringify(event)});`]);
  const path = join(directory, 'study/audio-usage', new Date(event.at).toISOString().slice(0, 10) + '.jsonl');
  const rows = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1); assert.equal(rows[0].callId, record.calls[0].callId);
  assert.equal(tiers.meter.recorded, 1); assert.equal(tiers.meter.unrecorded, 0);
});
test('fire-and-forget leaf work is drained before its Step settles', async () => {
  const { gateway, record } = setup(); const held = Promise.withResolvers(), entered = Promise.withResolvers(); let done = false;
  const pending = gateway.step('drain', policy).run(() => {
    void gateway.observe({ boundary: 'external-request' }, async () => { entered.resolve(); await held.promise; return { value: true }; });
  }).then(() => { done = true; });
  await entered.promise; assert.equal(done, false); assert.equal(record.runtime.steps[0].status, 'running');
  held.resolve(); await pending; assert.equal(record.runtime.steps[0].status, 'complete');
});
test('non-model uploads and deletion are Calls without billing events', async () => {
  const { gateway, record } = setup();
  const tiers = new GeminiTiers({ keys: { free: 'fake' }, gateway, fetch: async () => reply(200, {}) });
  await gateway.step('cleanup', policy).run(() => tiers.transport('free', true)('https://generativelanguage.googleapis.com/v1beta/files/fake', { method: 'DELETE' }));
  assert.equal(record.calls.length, 1); assert.equal(record.calls[0].ledgerEvent, undefined);
  assert.deepEqual(record.calls[0].observation, { boundary: 'external-request', requestCount: 1 });
});
test('native admission cancellation waits for late handle disposal before returning', async () => {
  const { startBoundedChild } = await import('../lib/host-capabilities.js');
  const controller = new AbortController(), admitted = Promise.withResolvers(), disposed = Promise.withResolvers(); let ended = false, disposing = false;
  const pending = startBoundedChild({ start: () => admitted.promise }, { signal: controller.signal }, { awaitAdmissionCleanup: true }).catch(error => { ended = true; throw error; });
  void pending.catch(() => {});
  controller.abort(); await Promise.resolve(); assert.equal(ended, false);
  admitted.resolve({ dispose: () => { disposing = true; return disposed.promise; } });
  await until(() => disposing, 'late handle disposal'); assert.equal(ended, false);
  disposed.resolve(); await assert.rejects(() => pending); assert.equal(ended, true);
});
test('host ledger deduplicates stable Calls after its writer is reconstructed', async t => {
  const { createUsageLedger } = await import('../lib/model-usage.js');
  const root = await mkdtemp(join(tmpdir(), 'gateway-host-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const event = { callId: 'stable-host-call', feature: 'audio', usage: { uncachedInputTokens: 3, outputTokens: 4 }, calls: 1 };
  await createUsageLedger(root).record(event);
  const restarted = createUsageLedger(root);
  await Promise.all([restarted.record(event), restarted.record(event)]);
  assert.equal((await restarted.summary()).total.calls, 1);
  assert.equal((await restarted.summary()).total.outputTokens, 4);
});
test('Gemini rejected inline form falls back through upload and cleans up with separate non-billed Calls', async () => {
  const { gateway, record } = setup(); let modelRequests = 0;
  const tiers = new GeminiTiers({ keys: { free: 'fake' }, gateway, fetch: async (url, init) => {
    if (url.includes(':generateContent')) return ++modelRequests === 1 ? reply(400) : reply(200, { candidates: [{ content: { parts: [{ text: 'transcript' }] } }] });
    if (url.includes('/upload/')) return { ...reply(200), headers: new Headers({ 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload-target' }) };
    if (url.endsWith('upload-target')) return reply(200, { file: { name: 'files/fake', uri: 'https://generativelanguage.googleapis.com/files/fake', state: 'ACTIVE' } });
    assert.equal(init.method, 'DELETE'); return reply(200);
  } });
  const result = await gateway.step('transcribe:1', { ...policy, purpose: 'transcribe' }).run(() => tiers.transcribe({ bytes: Buffer.from('synthetic-audio'), mimeType: 'audio/wav', seconds: 1 }));
  assert.equal(result.text, 'transcript'); assert.equal(record.calls.length, 5);
  assert.equal(record.calls.filter(call => call.modelRequest).length, 2);
  assert.equal(record.calls.at(-1).kind, 'provider-io');
  assert.ok(record.calls.every(call => call.endedAt));
});
test('failed host responses retain observed usage and use the one supplied ledger writer', async () => {
  const { reportUsage } = await import('../lib/usage-scope.js'); const written = [];
  const host = { ctx: {}, sessionId: 'absent', route: {}, complete: async () => { reportUsage({ uncachedInputTokens: 4, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }); throw new Error('provider failure'); } };
  const { gateway, record } = setup(host, call => { written.push(call.callId); });
  await assert.rejects(() => gateway.step('failed', { ...policy, requestedEffort: 'default' }).complete('s', 'p'));
  assert.equal(record.calls[0].tokens, 6); assert.equal(record.calls[0].status, 'failed');
  // Replay is a ledger operation, never another provider execution.
  assert.deepEqual(written, [record.calls[0].callId]); assert.equal(record.calls[0].accounting, 'recorded');
});
test('stable host Call replay fails closed if its existing ledger is corrupt', async t => {
  const { createUsageLedger } = await import('../lib/model-usage.js'); const { writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'gateway-corrupt-ledger-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'model-usage.json'), '{incomplete');
  await assert.rejects(() => createUsageLedger(root).record({ callId: 'observed', usage: { uncachedInputTokens: 2, outputTokens: 3 } }));
  assert.equal(await readFile(join(root, 'model-usage.json'), 'utf8'), '{incomplete');
});

test('opaque host calls cannot bypass an enabled physical provider quota', async () => {
  let calls = 0;
  const { gateway, record } = setup({ ctx: {}, route: {}, complete: () => { calls++; } }, undefined, true);
  await assert.rejects(() => gateway.step('host', policy).complete('s', 'p'), { code: 'capability-unverified' });
  assert.equal(calls, 0); assert.equal(record.calls.length, 0);
});
for (const textProvider of ['gemini', 'host']) test(`existing single-file ${textProvider} audio pipeline uses gateway Calls without the old meter`, async t => {
  const { executeAudioJob } = await import('../lib/audio-job.js');
  const { Store } = await import('../lib/store.js'); const { readAudioSettings } = await import('../lib/audio-settings.js');
  const { writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'gateway-audio-pipeline-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(directory, 'home');
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(directory, { recursive: true, force: true }); });
  const bytes = Buffer.alloc(44 + 16000); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(16000, 40);
  const path = join(directory, 'one.wav'); await writeFile(path, bytes);
  const settings = { ...await readAudioSettings(), freeKey: 'fake', paidKey: '', groqKey: '', siliconflowKey: '', textProvider };
  let requests = 0;
  const fetch = async (url, init) => {
    requests++; const body = JSON.parse(init.body);
    let text = '今天我们学习软件架构。模块需要清楚的边界。';
    if (!url.includes('transcribe:')) {
      const system = body.systemInstruction.parts[0].text, prompt = body.contents[0].parts[0].text;
      text = system.startsWith('You proofread') ? '{"corrections":[]}' : system.startsWith('You translate')
        ? JSON.stringify({ titleZh: '软件架构', titleEn: 'Architecture', paragraphs: JSON.parse(prompt).paragraphs.map(p => ({ n: p.n, en: 'Clear boundaries.', zh: '清楚的边界。' })) })
        : '{"titleEn":"Architecture"}';
    }
    return reply(200, { usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 }, candidates: [{ content: { parts: [{ text }] } }] });
  };
  const host = { ctx: {}, route: {}, sessionId: 'synthetic', complete: async (system, prompt) => {
    const response = await fetch('host', { body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ parts: [{ text: prompt }] }] }) });
    return (await response.json()).candidates[0].content.parts[0].text;
  } };
  const { gateway, record, controller } = setup(host); const store = new Store(join(directory, 'library'));
  const job = { id: 'domain-facade', root: store.root, warnings: [], language: 'zh' };
  await executeAudioJob({ job, args: { path }, settings, store, fetch, signal: controller.signal, gateway });
  assert.ok(requests >= 3); assert.equal(record.calls.length, requests);
  assert.equal(record.calls.filter(call => call.accounting === 'recorded').length, record.calls.filter(call => call.observation.boundary === 'external-request').length);
  assert.ok(job.sourceIds.length > 0); assert.ok((await store.read()).sources.length > 0);
  assert.equal(job.tasks, undefined, 'managed calls are not written a second time by legacy taskTracker');
});
