import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createManifestJobStore, validateStoredJob } from '../lib/jobs/store.js';
import { saveAudioBatch, readAudioBatch } from '../lib/audio-batch.js';
import { createUsageLedger } from '../lib/model-usage.js';
import { goldenRuntimeContracts } from './fixtures/unified-runtime-contract.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batch = { id: 'single-test-001', kind: 'single', args: { title: 'original' }, input: { hash: 'input-hash', size: 42 }, job: { id: 'legacy', status: 'queued' } };
  const dir = join(root, 'audio-batches', batch.id); await mkdir(dir, { recursive: true });
  await saveAudioBatch(root, batch);
  const file = join(dir, 'manifest.json');
  const envelope = { schemaVersion: 1, revision: 0, contract: structuredClone(goldenRuntimeContracts.queued),
    inputRef: { id: batch.id, hash: 'input-hash', size: 42 }, checkpoint: null, requestIntents: [], commits: [], deliveries: [], executorWitness: null };
  return { root, batch, file, envelope, store: createManifestJobStore(file, { projectLegacy: contract => ({ id: contract.runtime.legacyId || 'legacy', status: contract.status }) }) };
}
test('single manifest runtime and stale domain saves preserve each other through the existing writer', async t => {
  const f = await fixture(t);
  assert.equal(await f.store.load(), null);
  const saved = await f.store.save(f.envelope, { expectedRevision: null });
  assert.equal(saved.revision, 1);
  f.batch.args.title = 'domain update';
  await Promise.all([saveAudioBatch(f.root, f.batch), f.store.save({ ...saved, contract: { ...saved.contract, title: 'durable title' } }, { expectedRevision: 1 })]);
  const disk = await readAudioBatch(f.root, f.batch.id);
  assert.equal(disk.args.title, 'domain update');
  assert.equal(disk.runtimeJob.contract.title, 'durable title');
  assert.equal(disk.runtimeJob.revision, 2);
  await assert.rejects(f.store.save(saved, { expectedRevision: 1 }), { code: 'revision-conflict' });
});
test('legacy remains unpromoted and malformed/future runtime metadata is preserved and refused', async t => {
  const f = await fixture(t);
  for (const runtimeJob of [{ ...f.envelope, schemaVersion: 99 }, { ...f.envelope, requestIntents: {} }]) {
    const raw = JSON.stringify({ ...f.batch, runtimeJob }); await writeFile(f.file, raw);
    await assert.rejects(f.store.load(), /store|schema|invalid/i);
    await assert.rejects(saveAudioBatch(f.root, f.batch), /store|schema|invalid/i);
    assert.equal(await readFile(f.file, 'utf8'), raw);
  }
  assert.throws(() => validateStoredJob({ ...f.envelope, contract: { ...f.envelope.contract, contractVersion: 99 } }));
});
test('stable-call replay rejects semantic ledger corruption without rewriting it', async t => {
  const f = await fixture(t), file = join(f.root, 'model-usage.json');
  for (const value of [{ version: 99, days: {} }, { version: 1, days: {}, callIds: [] }, { version: 1, days: {}, callIds: { one: 42 } }]) {
    const raw = JSON.stringify(value); await writeFile(file, raw);
    await assert.rejects(createUsageLedger(f.root).record({ callId: 'stable-call', feature: 'audio', usage: { uncachedInputTokens: 1, outputTokens: 1 } }), /ledger|version|invalid/i);
    assert.equal(await readFile(file, 'utf8'), raw);
  }
  await writeFile(file, JSON.stringify({ version: 1, days: {} }));
  const ledger = createUsageLedger(f.root); await ledger.record({ callId: 'stable-call', feature: 'audio', usage: { uncachedInputTokens: 1, outputTokens: 1 } });
  assert.equal((await ledger.summary()).total.calls, 1);
});

import { prepareSingleAudioRecord } from '../lib/audio-batch.js';
import { createSingleAudioPersistence } from '../lib/audio-runtime-store.js';
test('single audio publication checks Attempt authority before delegating to an external domain writer', async t => {
  const f = await fixture(t), path = join(f.root, 'guard.wav'); await writeFile(path, 'synthetic fingerprint');
  const record = await prepareSingleAudioRecord(f.root, { path }); let publications = 0;
  const adapter = await createSingleAudioPersistence(f.root, { library: { publishSources: async () => { publications++; } } }).open({ singleId: record.id });
  const prepared = await adapter.prepareArtifacts('publish:1', [{ id: 'source', text: 'synthetic' }]);
  await assert.rejects(adapter.publishArtifacts(prepared, { assertCurrent() { throw Object.assign(new Error('stale'), { code: 'stale-attempt' }); } }), { code: 'stale-attempt' });
  assert.equal(publications, 0);
});
import { recordAudioUsage } from '../lib/audio-dashboard.js';
test('stable audio accounting refuses a malformed complete ledger row instead of losing deduplication history', async t => {
  const f = await fixture(t), previous = process.env.DSH_HOME; process.env.DSH_HOME = join(f.root, 'private-home');
  t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; });
  const at = Date.now(), directory = join(process.env.DSH_HOME, 'study', 'audio-usage'), file = join(directory, new Date(at).toISOString().slice(0, 10) + '.jsonl');
  await mkdir(directory, { recursive: true }); const raw = '{broken-stable-call-row}\n'; await writeFile(file, raw);
  await assert.rejects(recordAudioUsage({ callId: 'stable-audio', at, type: 'request', tier: 'paid', status: 200 }), { code: 'ledger-invalid' });
  assert.equal(await readFile(file, 'utf8'), raw);
});
test('single audio recovery validates actual file, submitted context and checkpoint bytes', async t => {
  const f = await fixture(t), path = join(f.root, 'input.wav'); await writeFile(path, 'original bytes');
  const record = await prepareSingleAudioRecord(f.root, { path, title: 'original' });
  const persistence = createSingleAudioPersistence(f.root, { library: { read: async () => ({ sources: [] }) } });
  const adapter = await persistence.open({ singleId: record.id }); await adapter.validateInput(adapter.inputRef);
  await writeFile(path, 'different bytes'); await assert.rejects(adapter.validateInput(adapter.inputRef), { code: 'input-changed' });
  await writeFile(path, 'original bytes');
  record.args.title = 'changed context'; await saveAudioBatch(f.root, record);
  await assert.rejects(adapter.validateInput(adapter.inputRef), { code: 'input-changed' });
  record.args.title = 'original'; await saveAudioBatch(f.root, record);
  const prepared = await adapter.prepareArtifacts('publish:1', [{ id: 'source', text: 'original' }]);
  await adapter.validateCheckpoint(prepared.checkpoint);
  await writeFile(join(f.root, 'audio-batches', record.id, prepared.checkpoint.ref), '{}');
  await assert.rejects(adapter.validateCheckpoint(prepared.checkpoint), { code: 'checkpoint-invalid' });
});
import { StudyService } from '../lib/service.js';
test('legacy audio restart does not reinterpret a canonical live executor as failed or offer a legacy retry', async t => {
  const f = await fixture(t), contract = structuredClone(goldenRuntimeContracts.running);
  await f.store.save({ ...f.envelope, contract }, { expectedRevision: null });
  const service = new StudyService(f.root, { fetch: async () => { throw new Error('unexpected model request'); } });
  const job = (await service.call('snapshot')).jobs.find(job => job.id === contract.runtime.legacyId);
  assert.equal(job.status, 'running');
  await assert.rejects(service.call('audio.retry', { jobId: job.id }), /不能重试|kernel-recovery-required/);
  assert.equal((await f.store.load()).contract.status, 'running');
});
test('stable model accounting refuses an unknown call date and an orphaned identity index', async t => {
  const f = await fixture(t), ledger = createUsageLedger(f.root);
  await assert.rejects(ledger.record({ callId: 'unknown-date', at: NaN, usage: { uncachedInputTokens: 1, outputTokens: 1 } }), { code: 'ledger-invalid' });
  const file = join(f.root, 'model-usage.json'), raw = JSON.stringify({ version: 1, days: {}, callIds: { previous: new Date().toISOString().slice(0, 10) } });
  await writeFile(file, raw);
  await assert.rejects(ledger.validate(), { code: 'ledger-invalid' }); assert.equal(await readFile(file, 'utf8'), raw);
});

test('derived single manifest facade clears an old completion time when a new Attempt is queued', async t => {
  const f = await fixture(t);
  f.batch.job.finishedAt = '2026-10-05T00:00:00.000Z';
  f.batch.job.filename = 'retained.wav';
  await saveAudioBatch(f.root, f.batch);
  const adapter = await createSingleAudioPersistence(f.root).open({ singleId: f.batch.id });
  await adapter.store.save(f.envelope, { expectedRevision: null });
  const disk = await readAudioBatch(f.root, f.batch.id);
  assert.equal(disk.job.status, 'queued');
  assert.equal(Object.hasOwn(disk.job, 'finishedAt'), false);
  assert.equal(disk.job.filename, 'retained.wav');
});

test('managed audio pipeline checkpoint records completed cache bytes and safe settings only', async t => {
  const f = await fixture(t), path = join(f.root, 'pipeline.wav'); await writeFile(path, 'pipeline input');
  const record = await prepareSingleAudioRecord(f.root, { path });
  const adapter = await createSingleAudioPersistence(f.root, { library: { read: async () => ({ sources: [] }) } }).open({ singleId: record.id });
  const pipeline = await adapter.createPipelineCache({ transcribeModel: 'fixture-model', textConcurrency: 2, paidKey: 'private-key-never-save' });
  await pipeline.cache.set('raw-12345678-0.json', { text: 'finished transcript' });
  const checkpoint = await pipeline.checkpoint('proofread', { textConcurrency: 3, autoBackoff: false }); await adapter.validateCheckpoint(checkpoint);
  const payload = await readFile(join(f.root, 'audio-batches', record.id, checkpoint.ref), 'utf8');
  assert.equal(payload.includes('private-key-never-save'), false);
  assert.equal(payload.includes('finished transcript'), false, 'domain cache content is referenced, not copied into the checkpoint');
  const resumed = await adapter.createPipelineCache({ transcribeModel: 'changed-model', textConcurrency: 9 }, checkpoint);
  assert.equal(resumed.settings.transcribeModel, 'fixture-model'); assert.equal(resumed.settings.textConcurrency, 2);
  assert.deepEqual(resumed.controls, { textConcurrency: 3, autoBackoff: false });
  assert.equal((await resumed.cache.get('raw-12345678-0.json')).text, 'finished transcript');
  await assert.rejects(pipeline.cache.set('../escape.json', {}), { code: 'checkpoint-invalid' });
  const stored = JSON.parse(payload), cacheFile = join(f.root, 'audio-cache', record.input.hash.slice(0, 16), stored.files[0].name);
  await writeFile(cacheFile, '{"text":"tampered"}');
  await assert.rejects(adapter.validateCheckpoint(checkpoint), { code: 'checkpoint-invalid' });
});
