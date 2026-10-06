import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeAudioService, TEST_KEY, wav } from './fixtures/audio-single-characterization-process.mjs';
import { settleJob } from './helpers/wait.mjs';
import { flushAudioUsage } from '../lib/audio-dashboard.js';
import { createProviderResources } from '../lib/jobs/resources.js';

for (const managed of [false, true]) test(`validation and incomplete uploads never dispatch; completed uploads clean up after success; pilot=${managed}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-pilot-validation-')), root = join(directory, 'library'), prior = process.env.DSH_HOME;
  process.env.DSH_HOME = join(directory, 'home');
  const f = fakeAudioService(root, { managed });
  t.after(async () => { await f.service.dispose(); await flushAudioUsage(); if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior; await rm(directory, { recursive: true, force: true }); });
  await f.service.call('audio.settings.set', { paidKey: TEST_KEY, textProvider: 'host' });
  const bytes = wav(), { uploadId } = await f.service.call('audio.upload.start', { name: 'validation.wav', size: bytes.length });
  for (const input of [{ path: 'relative.wav' }, { path: '/missing.wav', uploadId }, { uploadId }, { uploadId, title: 'x'.repeat(300) }])
    await assert.rejects(f.service.call('audio.import', input));
  assert.equal(f.starts(), 0); assert.deepEqual(f.calls, []);
  assert.equal((await f.service.call('snapshot')).jobs.length, 0);
  await f.service.call('audio.upload.chunk', { uploadId, offset: 0, data: bytes.toString('base64') });
  await f.service.call('audio.upload.finish', { uploadId });
  const started = await f.service.call('audio.import', { uploadId });
  const done = await settleJob(f.service, started.jobId); assert.equal(done.status, 'complete', done.stage);
  await assert.rejects(readFile(join(root, 'audio-uploads', uploadId, 'validation.wav')), { code: 'ENOENT' });
});

for (const managed of [false, true]) test(`whole-content reuse preserves the exact document and merges courses without model calls; pilot=${managed}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-pilot-reuse-')), root = join(directory, 'library'), prior = process.env.DSH_HOME;
  process.env.DSH_HOME = join(directory, 'home');
  const f = fakeAudioService(root, { managed });
  t.after(async () => { await f.service.dispose(); await flushAudioUsage(); if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior; await rm(directory, { recursive: true, force: true }); });
  await f.service.call('audio.settings.set', { paidKey: TEST_KEY, textProvider: 'host' });
  const path = join(directory, 'reuse.wav'); await writeFile(path, wav());
  const first = await f.service.call('audio.import', { path, courses: ['Course A'] });
  assert.equal((await settleJob(f.service, first.jobId)).status, 'complete');
  const before = await f.service.call('snapshot'), firstCalls = [...f.calls];
  const second = await f.service.call('audio.import', { path, courses: ['Course B'] });
  const done = await settleJob(f.service, second.jobId); assert.equal(done.status, 'complete', done.stage);
  const after = await f.service.call('snapshot');
  assert.deepEqual(f.calls, firstCalls);
  assert.equal(after.sources.length, 1);
  assert.equal(after.sources[0].text, before.sources[0].text);
  assert.deepEqual(after.sources[0].courses, ['Course A', 'Course B']);
  assert.equal(done.reused, true);
});

test('public single audio pilot produces one canonical durable job and the same source through the real API', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-pilot-')), root = join(directory, 'library');
  const prior = process.env.DSH_HOME; process.env.DSH_HOME = join(directory, 'home');
  let starts = 0;
  const executor = { assertAvailable() {}, witness: () => ({ pid: process.pid, host: 'fixture', instance: 'controlled' }),
    inspect: () => ({ state: 'lost', reason: 'controlled' }), start({ run, cancel }) { void run(); return { id: `controlled-${++starts}`, ownerAgentId: 'controlled-owner', stop: cancel, append() {} }; } };
  const f = fakeAudioService(root, { runtimeOptions: { runtimePilot: { audioSingle: true }, workOwner: Symbol('fixture'), jobExecutor: executor,
    jobModelHost: { ctx: {}, route: { provider: 'fixture', model: 'fixture' } } } });
  t.after(async () => { await f.service.dispose(); await flushAudioUsage(); if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior; await rm(directory, { recursive: true, force: true }); });
  await f.service.call('audio.settings.set', { paidKey: TEST_KEY, textProvider: 'host', transcribeConcurrency: 1 });
  const path = join(directory, 'lecture.wav'); await writeFile(path, wav());
  const started = await f.service.call('audio.import', { path, courses: ['Database course'] });
  const done = await settleJob(f.service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  const snapshot = await f.service.call('snapshot'), job = snapshot.jobs.find(item => item.id === started.jobId);
  assert.equal(job.contract.contractVersion, 2);
  assert.equal(starts, 1);
  assert.equal(snapshot.sources.length, 1); assert.equal(snapshot.decks.length, 0);
  assert.deepEqual(snapshot.sources[0].courses, ['Database course']);
  assert.deepEqual(f.calls, ['transcribe', 'proofread', 'translate', 'title']);
  assert.equal(f.notifications.length, 1); assert.equal(f.notifications[0].wakeup, false);
  const proof = job.contract.calls.find(call => call.kind === 'proofread');
  const output = await f.service.call('job.output', { jobId: started.jobId, callId: proof.callId });
  assert.ok(JSON.stringify(output).includes('corrections'));
  assert.equal(proof.outputPreview, '{"corrections":[]}');
  const manifest = JSON.parse(await readFile(join(root, 'audio-batches', job.singleId, 'manifest.json'), 'utf8'));
  assert.equal(manifest.runtimeJob.contract.jobId, job.contract.jobId);
  assert.equal(manifest.runtimeJob.contract.status, 'complete');
  assert.equal(JSON.stringify(manifest).includes(TEST_KEY), false);
});

test('public checkpoint pause drains transcription, persists safely and resumes with a new native Attempt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-pilot-pause-')), root = join(directory, 'library');
  const prior = process.env.DSH_HOME; process.env.DSH_HOME = join(directory, 'home');
  let starts = 0;
  const executor = { assertAvailable() {}, witness: () => ({ pid: process.pid, host: 'fixture', instance: 'pause' }), inspect: () => ({ state: 'lost' }),
    start({ run, cancel }) { void run(); return { id: `pause-native-${++starts}`, ownerAgentId: 'controlled-owner', stop: cancel, append() {} }; } };
  const f = fakeAudioService(root, { holdTranscription: true, runtimeOptions: { runtimePilot: { audioSingle: true }, workOwner: Symbol('pause'), jobExecutor: executor,
    jobModelHost: { ctx: {}, route: { provider: 'fixture', model: 'fixture' } } } });
  t.after(async () => { f.release(); await f.service.dispose(); await flushAudioUsage(); if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior; await rm(directory, { recursive: true, force: true }); });
  await f.service.call('audio.settings.set', { paidKey: TEST_KEY, textProvider: 'host', transcribeConcurrency: 1 });
  const path = join(directory, 'pause.wav'); await writeFile(path, wav());
  const started = await f.service.call('audio.import', { path });
  const { until } = await import('./helpers/wait.mjs');
  await until(() => f.calls.includes('transcribe'), 'managed transcription');
  await f.service.call('job.control', { jobId: started.jobId, action: 'set', patch: { textConcurrency: 2 } });
  await f.service.call('job.control', { jobId: started.jobId, action: 'pause' });
  assert.equal(f.signals[0].aborted, false);
  f.release();
  const read = async () => (await f.service.call('snapshot')).jobs.find(job => job.id === started.jobId);
  await until(async () => (await read()).contract.status === 'paused', 'durable pipeline pause');
  assert.deepEqual(f.calls, ['transcribe']);
  const paused = await read();
  const manifest = JSON.parse(await readFile(join(root, 'audio-batches', paused.singleId, 'manifest.json'), 'utf8'));
  assert.ok(manifest.runtimeJob.checkpoint);
  await f.service.call('job.control', { jobId: started.jobId, action: 'resume' });
  const done = await settleJob(f.service, started.jobId);
  assert.equal(done.status, 'complete', done.stage); assert.equal(starts, 2);
  assert.deepEqual(f.calls, ['transcribe', 'proofread', 'translate', 'title']);
  assert.equal((await read()).contract.runtime.attempts.length, 2);
});

for (const managed of [false, true]) test(`explicit failed-translation retry reuses finished audio and replaces the failure notice; pilot=${managed}`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-pilot-retry-')), root = join(directory, 'library'), prior = process.env.DSH_HOME;
  process.env.DSH_HOME = join(directory, 'home');
  const responses = { translate: '{"invalid":"fixture-format-failure"}' };
  const f = fakeAudioService(root, { managed, responses });
  t.after(async () => { await f.service.dispose(); await flushAudioUsage(); if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior; await rm(directory, { recursive: true, force: true }); });
  await f.service.call('audio.settings.set', { paidKey: TEST_KEY, textProvider: 'host', transcribeConcurrency: 1 });
  const path = join(directory, 'retry.wav'); await writeFile(path, wav());
  const initial = await f.service.call('audio.import', { path });
  const failed = await settleJob(f.service, initial.jobId); assert.equal(failed.status, 'failed');
  const before = (await f.service.call('snapshot')).jobs.find(job => job.id === initial.jobId);
  const firstCalls = [...f.calls]; delete responses.translate;
  const resumed = await f.service.call('audio.retry', { jobId: initial.jobId });
  const done = await settleJob(f.service, resumed.jobId); assert.equal(done.status, 'complete', done.stage);
  assert.notEqual(resumed.jobId, initial.jobId);
  assert.deepEqual(f.calls.slice(firstCalls.length), ['translate', 'title']);
  const snapshot = await f.service.call('snapshot'), after = snapshot.jobs.find(job => job.id === resumed.jobId);
  assert.equal(after.contract.jobId, before.contract.jobId); assert.equal(snapshot.sources.length, 1);
  assert.equal(snapshot.inbox.items.some(item => item.kind === 'audio-failed' && item.jobId === initial.jobId), false);
  assert.equal(snapshot.jobs.filter(job => job.singleId === after.singleId).length, 1);
});

test('switch changes only new admissions while legacy and managed imports share the existing gate', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-pilot-switch-')), root = join(directory, 'library'), prior = process.env.DSH_HOME;
  process.env.DSH_HOME = join(directory, 'home');
  const runtimePilot = { audioSingle: false }, audioGate = { limit: 1, active: new Set(), waiting: [] };
  const f = fakeAudioService(root, { managed: true, holdTranscription: true, runtimeOptions: { runtimePilot, audioGate } });
  t.after(async () => { f.release(); await f.service.dispose(); await flushAudioUsage(); if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior; await rm(directory, { recursive: true, force: true }); });
  const { until } = await import('./helpers/wait.mjs');
  await f.service.call('audio.settings.set', { paidKey: TEST_KEY, textProvider: 'host', transcribeConcurrency: 1 });
  const paths = [];
  for (let index = 0; index < 3; index++) { const path = join(directory, `lecture-${index}.wav`), bytes = wav(); bytes[bytes.length - 1] = index + 4; await writeFile(path, bytes); paths.push(path); }
  const first = await f.service.call('audio.import', { path: paths[0] });
  await until(() => f.calls.filter(kind => kind === 'transcribe').length === 1, 'legacy held request');
  runtimePilot.audioSingle = true;
  const second = await f.service.call('audio.import', { path: paths[1] });
  assert.equal(second.queuedBehind, 1, 'managed admission retains the existing queue receipt');
  const read = async () => (await f.service.call('snapshot')).jobs;
  await until(async () => (await read()).find(job => job.id === second.jobId)?.contract.status === 'queued', 'managed queued admission');
  const observed = (await read()).find(job => job.id === second.jobId).contract;
  runtimePilot.audioSingle = false;
  const third = await f.service.call('audio.import', { path: paths[2] });
  let rows = await read();
  assert.equal(rows.find(job => job.id === first.jobId).contract.contractVersion, 1);
  assert.equal(rows.find(job => job.id === third.jobId).contract.contractVersion, 1);
  assert.deepEqual(rows.find(job => job.id === second.jobId).contract.runtime.attempts, observed.runtime.attempts);
  assert.equal(f.starts(), 1); assert.equal(audioGate.active.size, 1); assert.equal(audioGate.waiting.length, 2);
  for (let count = 1; count <= 3; count++) {
    await until(() => f.calls.filter(kind => kind === 'transcribe').length === count, `transcription ${count}`);
    assert.equal(audioGate.active.size, 1); f.release();
  }
  for (const job of [first, second, third]) assert.equal((await settleJob(f.service, job.jobId)).status, 'complete');
  rows = await read(); assert.equal(rows.find(job => job.id === second.jobId).contract.runtime.attempts.length, 1);
  assert.equal(audioGate.active.size, 0); assert.equal(audioGate.waiting.length, 0);
});

test('public legacy and managed audio share the separately enabled HTTP quota across overlapping pipelines', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'audio-pilot-quota-')), root = join(directory, 'library'), prior = process.env.DSH_HOME;
  process.env.DSH_HOME = join(directory, 'home');
  const owner = Symbol('quota-owner'), runtimePilot = { audioSingle: false }, audioGate = { limit: 2, active: new Set(), waiting: [] };
  const resources = createProviderResources({ owner, scopeId: 'audio.v1', sharedProviderQuota: true,
    bindings: [{ resourceRef: 'fake-gemini', quotaDomainRef: 'fake-project', providerObservation: 'external-request', limit: 1, routes: ['paid'] }] });
  const held = Promise.withResolvers(); let sent = 0, active = 0, peak = 0;
  const fetch = async (_url, options) => {
    sent++; active++; peak = Math.max(peak, active);
    try {
      if (sent === 1) await held.promise;
      const body = JSON.parse(options.body), system = body.systemInstruction?.parts?.[0]?.text || '', prompt = body.contents?.[0]?.parts?.[0]?.text;
      const text = system.startsWith('You proofread') ? '{"corrections":[]}' : system.startsWith('You translate')
        ? JSON.stringify({ titleZh: '数据库', titleEn: 'Databases', paragraphs: JSON.parse(prompt).paragraphs.map(p => ({ n: p.n, zh: '数据库。' })) })
        : system.startsWith('You write') ? '{"titleEn":"Database Lecture"}' : 'Today we discuss database transactions.';
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2 } }));
    } finally { active--; }
  };
  const f = fakeAudioService(root, { managed: true, runtimeOptions: { runtimePilot, audioGate, workOwner: owner, providerResources: resources, fetch } });
  t.after(async () => { held.resolve(); await f.service.dispose(); await resources.dispose(); await flushAudioUsage(); if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior; await rm(directory, { recursive: true, force: true }); });
  await f.service.call('audio.settings.set', { paidKey: TEST_KEY, textProvider: 'gemini', transcribeConcurrency: 2 });
  const firstPath = join(directory, 'legacy.wav'), secondPath = join(directory, 'managed.wav'), changed = wav(); changed[changed.length - 1] = 5;
  await writeFile(firstPath, wav()); await writeFile(secondPath, changed);
  const first = await f.service.call('audio.import', { path: firstPath });
  const { until } = await import('./helpers/wait.mjs');
  await until(() => sent === 1, 'legacy held HTTP request'); runtimePilot.audioSingle = true;
  const second = await f.service.call('audio.import', { path: secondPath });
  await until(() => audioGate.active.size === 2, 'two admitted audio pipelines');
  assert.equal(active, 1); assert.equal(sent, 1);
  held.resolve();
  for (const item of [first, second]) { const done = await settleJob(f.service, item.jobId); assert.equal(done.status, 'complete', done.stage); }
  assert.equal(peak, 1); assert.equal(active, 0); assert.equal(audioGate.active.size, 0);
  assert.equal(sent, 8);
});

for (const boundary of ['checkpoint', 'unresolved-request']) test(`new process cold read and explicit managed audio recovery: ${boundary}`, { timeout: 120_000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const directory = await mkdtemp(join(tmpdir(), 'audio-pilot-process-')), root = join(directory, 'library'), children = new Set();
  t.after(async () => { await Promise.all([...children].map(child => new Promise(resolve => { child.once('close', resolve); child.kill(); }))); await rm(directory, { recursive: true, force: true }); });
  const run = mode => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/unified-runtime-audio-process.mjs', import.meta.url)), root, mode],
      { env: { ...process.env, DSH_HOME: join(directory, 'home') }, windowsHide: true });
    children.add(child); let out = '', err = '';
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; }); child.on('error', reject);
    child.on('close', code => { children.delete(child); if (code) reject(new Error(err || out || `fixture exit ${code}`)); else { try { resolve(JSON.parse(out.trim())); } catch (error) { reject(error); } } });
  });
  const first = await run(boundary === 'checkpoint' ? 'pause' : 'interrupt');
  const second = await run(boundary === 'checkpoint' ? 'resume' : 'refuse');
  assert.deepEqual(second.callsBefore, []);
  assert.equal(second.job.contract.jobId, first.job.contract.jobId);
  if (boundary === 'checkpoint') {
    assert.equal(first.job.contract.status, 'paused'); assert.equal(second.done.status, 'complete', second.done.stage);
    assert.equal(second.starts, 1); assert.equal(second.job.contract.runtime.attempts.length, 2);
    assert.deepEqual(second.calls, ['proofread', 'translate', 'title']); assert.equal(second.sources.length, 1);
    assert.equal(second.notifications.length, 1);
  } else {
    assert.equal(second.before.contract.status, 'running', 'cold observer cannot infer death without an executor witness');
    assert.equal(second.refusal, 'remote-result-unknown'); assert.equal(second.starts, 0); assert.deepEqual(second.calls, []);
    assert.equal(second.job.contract.status, 'interrupted');
  }
});
