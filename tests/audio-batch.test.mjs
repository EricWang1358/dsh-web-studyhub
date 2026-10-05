import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { batchDocuments, readAudioBatch, saveAudioBatch } from '../lib/audio-batch.js';
import { checkpoints } from '../lib/audio-import.js';
import { storeDocuments } from '../lib/audio-job.js';
import { settleJob, until } from './helpers/wait.mjs';

const KEY = 'AIzaAudioBatchTest_00000000000001';
test('BOM-prefixed audio manifests and checkpoints remain readable without rewriting text', async t => {
  const root = await mkdtemp(join(tmpdir(), 'audio-bom-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchId = 'audio-record-001', directory = join(root, 'audio-batches', batchId);
  await mkdir(directory, { recursive: true });
  const value = { id: batchId, text: 'Keep embedded \uFEFF and ordinary text.' };
  const raw = '\uFEFF' + JSON.stringify(value);
  await writeFile(join(directory, 'manifest.json'), raw, 'utf8');
  assert.deepEqual(await readAudioBatch(root, batchId), value);
  await writeFile(join(directory, 'checkpoint.json'), raw, 'utf8');
  assert.deepEqual(await checkpoints(directory).get('checkpoint.json'), value);
  assert.equal(await readFile(join(directory, 'manifest.json'), 'utf8'), raw);
});

for (const failure of ['exhausted replacement', 'partial write']) test(`a normal ${failure} failure cleans its temporary file and preserves the committed audio manifest`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'audio-manifest-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batch = { id: 'audio-cleanup-001', status: 'queued', members: [] };
  const directory = join(root, 'audio-batches', batch.id), file = join(directory, 'manifest.json');
  await mkdir(directory, { recursive: true });
  await saveAudioBatch(root, batch);
  const committed = await readFile(file, 'utf8'), originalRename = fs.promises.rename, originalWrite = fs.promises.writeFile;
  const fault = Object.assign(new Error(failure), { code: failure === 'partial write' ? 'ENOSPC' : 'EPERM' });
  let remaining = Infinity, attempts = 0;
  fs.promises.rename = async (from, to) => {
    if (failure === 'exhausted replacement' && to === file && remaining > 0) { remaining--; attempts++; throw fault; }
    return originalRename(from, to);
  };
  fs.promises.writeFile = async (path, value, options) => {
    if (failure === 'partial write' && String(path).startsWith(`${file}.`) && remaining > 0) {
      remaining--; attempts++; await originalWrite(path, value.slice(0, 8), options); throw fault;
    }
    return originalWrite(path, value, options);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(saveAudioBatch(root, { ...batch, status: 'complete' }), error => error === fault);
    assert.equal(attempts, failure === 'exhausted replacement' ? 8 : 1);
    assert.equal(await readFile(file, 'utf8'), committed);
    assert.deepEqual(await readdir(directory), ['manifest.json'], 'the rejected write must leave no temporary file');
    remaining = failure === 'exhausted replacement' ? 2 : 0;
    await saveAudioBatch(root, { ...batch, status: 'complete' });
    assert.equal((await readAudioBatch(root, batch.id)).status, 'complete');
    assert.deepEqual(await readdir(directory), ['manifest.json']);
    assert.equal(attempts, failure === 'exhausted replacement' ? 10 : 1);
  } finally {
    fs.promises.rename = originalRename; fs.promises.writeFile = originalWrite; syncBuiltinESMExports();
  }
});
const reply = text => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} }));
export function wav(fill) {
  const data = Buffer.alloc(16000, fill), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
async function fixture(t, { hold = false, fail = () => false, limit = 1 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'audio-batch-')), root = join(dir, 'library'), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  const calls = [], prompts = [], held = new Map();
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('transcribe:')) {
      const audio = body.contents[0].parts.find(part => part.inlineData).inlineData.data;
      const name = Buffer.from(audio, 'base64').at(-1) === 1 ? 'A' : 'B';
      calls.push(`transcribe:${name}`);
      if (hold) await new Promise((resolve, reject) => { held.set(name, resolve); init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true }); });
      return reply(`${name} describes database transactions and indexes.`);
    }
    const system = body.systemInstruction.parts[0].text, prompt = body.contents[0].parts[0].text;
    prompts.push(prompt);
    const kind = system.startsWith('You proofread') ? 'proofread' : system.startsWith('You translate') ? 'translate' : 'title';
    const name = /B describes|"filename":"B/.test(prompt) ? 'B' : 'A';
    calls.push(`${kind}:${name}`);
    if (kind === 'proofread') return reply('{"corrections":[]}');
    if (kind === 'title') return reply('{"titleEn":"Database lecture"}');
    if (fail(name)) return reply('bad JSON');
    const payload = JSON.parse(prompt.split('\n\nYour previous')[0]);
    return reply(JSON.stringify({ titleZh: '数据库', titleEn: 'Databases', paragraphs: payload.paragraphs.map(p => ({ n: p.n, zh: `${name} 的翻译。` })) }));
  };
  const service = new StudyService(root, { fetch });
  await service.call('audio.settings.set', { paidKey: KEY, textProvider: 'gemini', transcribeConcurrency: limit });
  const a = join(dir, 'A.wav'), b = join(dir, 'B.wav');
  await writeFile(a, wav(1)); await writeFile(b, wav(2));
  t.after(async () => { for (const release of held.values()) release(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  const wait = job => settleJob(service, job.jobId || job.id);
  return { dir, root, service, a, b, calls, prompts, held, wait };
}
async function upload(service, name, bytes) {
  const { uploadId } = await service.call('audio.upload.start', { name, size: bytes.length });
  await service.call('audio.upload.chunk', { uploadId, offset: 0, data: bytes.toString('base64') });
  await service.call('audio.upload.finish', { uploadId });
  return { uploadId };
}

test('batch recordings run in submitted order, with frozen courses and no partial sources', async t => {
  const { service, a, b, held, wait, calls } = await fixture(t, { hold: true });
  const started = await service.call('audio.import', { files: [{ path: b }, { path: a }], title: 'Week 3', courses: ['Course A'] });
  await until(() => held.has('B'));
  assert.deepEqual(calls, ['transcribe:B']);
  assert.ok(!held.has('A'));
  held.get('B')();
  // The transcription slot passes to A at once; B's own proofreading and translation continue and finish on their own.
  await until(() => held.has('A'));
  await until(async () => (await service.call('snapshot')).jobs.find(j => j.id === started.jobId).members[0].status === 'complete', 'member B to finish its text steps');
  assert.equal((await service.call('snapshot')).sources.length, 0);
  held.get('A')();
  const job = await wait(started);
  assert.equal(job.status, 'complete', job.stage);
  const state = await service.store.read(), source = state.sources[0];
  assert.equal(state.sources.length, 1);
  assert.ok(source.text.indexOf('B.wav') < source.text.indexOf('A.wav'));
  assert.deepEqual(source.audio.batch.members.map(m => m.filename), ['B.wav', 'A.wav']);
  assert.deepEqual(source.courses, ['Course A']);
  assert.equal(source.audio.batch.id, job.batchId);
  assert.deepEqual(job.sourceIds, [source.id]);
});

test('batch members and single imports share one slot; cancelled work can resume', async t => {
  const { service, a, b, calls, held, wait } = await fixture(t, { hold: true, limit: 1 });
  const batch = await service.call('audio.import', { files: [{ path: a }, { path: b }] });
  const single = await service.call('audio.import', { path: b });
  await until(() => held.has('A'));
  assert.equal(calls.length, 1);
  held.get('A')();
  await until(() => held.has('B'));
  await until(async () => (await service.call('snapshot')).jobs.find(j => j.id === batch.jobId).members[0].status === 'complete', 'member A to finish its text steps');
  assert.equal(calls.filter(call => call === 'transcribe:B').length, 1, 'one slot for the B member, none for the queued single');
  await service.call('job.cancel', { all: true });
  const stopped = await wait(batch);
  await wait(single);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.members[0].status, 'complete');
  assert.equal((await service.store.read()).sources.length, 0);
  const resumed = await service.call('audio.retry', { jobId: stopped.id });
  await until(() => calls.filter(call => call === 'transcribe:B').length === 2);
  held.get('B')();
  assert.equal((await wait(resumed)).status, 'complete');
  assert.equal(calls.filter(call => call === 'transcribe:A').length, 1);
  await service.call('job.dismiss', { all: true });
  assert.equal((await service.call('snapshot')).jobs.length, 0);
});

test('an assembly save failure retries only assembly and changed path inputs are rejected', async t => {
  const { service, a, b, calls, wait } = await fixture(t);
  const original = service.store.update.bind(service.store);
  let fail = true;
  service.store.update = mutate => original(async state => {
    const result = await mutate(state);
    if (fail && state.sources.some(source => source.audio?.batch)) { fail = false; throw new Error('Assembly disk failure'); }
    return result;
  });
  const first = await wait(await service.call('audio.import', { files: [{ path: a }, { path: b }] }));
  assert.equal(first.status, 'failed');
  assert.match(first.stage, /Assembly disk failure/);
  assert.equal((await service.store.read()).sources.length, 0);
  const spent = calls.length;
  const done = await wait(await service.call('audio.retry', { jobId: first.id }));
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(calls.length, spent);

  fail = true;
  const another = await wait(await service.call('audio.import', { files: [{ path: a }, { path: b }] }));
  assert.equal(another.status, 'failed');
  await writeFile(b, wav(3));
  const changed = await wait(await service.call('audio.retry', { jobId: another.id }));
  assert.equal(changed.status, 'failed');
  assert.match(changed.stage, /文件已改变/);
});

test('long combined transcripts keep filename boundaries and the existing source size limit', async t => {
  const docs = batchDocuments('Long lecture', [{ filename: 'B.wav' }, { filename: 'A.wav' }],
    [{ documents: ['B paragraph.\n\n'.repeat(26000)] }, { documents: ['A paragraph.\n\n'.repeat(26000)] }]);
  assert.ok(docs.length > 1);
  assert.ok(docs.every(doc => doc.length <= 400000));
  assert.ok(docs[0].includes('## 1. B.wav'));
  assert.ok(docs.at(-1).includes('## 2. A.wav'));
  assert.ok(docs.join('\n').indexOf('B paragraph') < docs.join('\n').indexOf('A paragraph'));
  const { service } = await fixture(t);
  const ids = docs.map((_, index) => `volume-${index + 1}`);
  await storeDocuments({ store: service.store, ids, documents: docs, title: 'Long lecture', courses: ['A'], corrections: { applied: [], skipped: [] },
    meta: { batch: { id: 'volume-batch', members: [{ order: 1, filename: 'B.wav' }, { order: 2, filename: 'A.wav' }] } } });
  for (const [index, id] of ids.entries()) {
    const source = await service.call('source.get', { id });
    assert.deepEqual(source.audio.batch.sourceIds, ids);
    assert.equal(source.audio.batch.volume, index + 1);
    assert.equal(source.audio.batch.volumes, ids.length);
  }
});

test('a fresh process recovers an interrupted uploaded batch without automatic model calls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'audio-batch-process-')), root = join(dir, 'library');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const child = mode => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/audio-batch-process.mjs', import.meta.url)), root, mode],
      { env: { ...process.env, DSH_HOME: join(dir, 'home') }, windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', data => { out += data; }); proc.stderr.on('data', data => { err += data; });
    proc.on('error', reject); proc.on('close', code => code ? reject(new Error(err || out)) : resolve(JSON.parse(out.trim())));
  });
  const first = await child('interrupt');
  // Completed members written before the checkpoint envelope remain reusable.
  const legacyPath = join(root, 'audio-batches', first.batchId, 'result-0.json');
  const legacyResult = JSON.parse(await readFile(legacyPath, 'utf8'));
  delete legacyResult.checkpoint;
  await writeFile(legacyPath, JSON.stringify(legacyResult), 'utf8');
  const second = await child('resume');
  assert.equal(second.before.status, 'failed');
  assert.equal(second.before.id, first.jobId);
  assert.equal(second.before.retryable, true);
  assert.equal(second.callsBeforeRetry, 0);
  assert.equal(second.done.status, 'complete', second.done.stage);
  assert.deepEqual(second.transcribed, ['B']);
  assert.equal(second.sources.length, 1);
  assert.deepEqual(second.sources[0].audio.batch.members.map(m => m.filename), ['A.wav', 'B.wav']);
  assert.deepEqual(second.sources[0].courses, ['Frozen A']);
  assert.equal(second.oldFailureLetters, 0);
});

test('transient Windows manifest replacement failures preserve the finished member before process interruption', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'audio-batch-replacement-')), root = join(dir, 'library');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const preload = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.promises.rename; let denied = 0;
    fs.promises.rename = async (from, to) => {
      if (String(to).endsWith('manifest.json') && denied < 2) {
        const value = JSON.parse(await fs.promises.readFile(from, 'utf8'));
        if (value.members?.[0]?.status === 'complete') {
          denied++; throw Object.assign(new Error('Transient Windows sharing violation'), { code: 'EPERM' });
        }
      }
      return rename(from, to);
    }; syncBuiltinESMExports();`;
  const child = mode => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [
      ...(mode === 'interrupt' ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] : []),
      fileURLToPath(new URL('./fixtures/audio-batch-process.mjs', import.meta.url)), root, mode,
    ], { env: { ...process.env, DSH_HOME: join(dir, 'home') }, windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', data => { out += data; }); proc.stderr.on('data', data => { err += data; });
    proc.on('error', reject); proc.on('close', code => code ? reject(new Error(err || out)) : resolve(JSON.parse(out.trim())));
  });
  await child('interrupt');
  const recovered = await child('resume');
  assert.equal(recovered.before.retryable, true);
  assert.equal(recovered.callsBeforeRetry, 0);
  assert.equal(recovered.done.status, 'complete', recovered.done.stage);
  assert.deepEqual(recovered.transcribed, ['B'], 'the persisted first member must not be transcribed again');
  assert.equal(recovered.sources.length, 1);
});

async function orphanedBatch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'audio-batch-orphan-')), root = join(dir, 'library');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const preload = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.promises.rename; let denied = 0;
    fs.promises.rename = async (from, to) => {
      if (String(to).endsWith('manifest.json')) {
        const value = JSON.parse(await fs.promises.readFile(from, 'utf8'));
        if (value.members?.[0]?.status === 'complete') {
          if (++denied === 8) setImmediate(() => {
            process.stdout.write(JSON.stringify({ jobId: value.job.id, batchId: value.id, denied }));
            process.exit(0);
          });
          throw Object.assign(new Error('Persistent Windows sharing violation'), { code: 'EPERM' });
        }
      }
      return rename(from, to);
    }; syncBuiltinESMExports();`;
  const child = mode => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [
      ...(mode === 'interrupt' ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] : []),
      fileURLToPath(new URL('./fixtures/audio-batch-process.mjs', import.meta.url)), root, mode,
    ], { env: { ...process.env, DSH_HOME: join(dir, 'home') }, windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', data => { out += data; }); proc.stderr.on('data', data => { err += data; });
    proc.on('error', reject); proc.on('close', code => code ? reject(new Error(err || out)) : resolve(JSON.parse(out.trim())));
  });
  const first = await child('interrupt'), batchDir = join(root, 'audio-batches', first.batchId);
  assert.equal(first.denied, 8, 'the completed-result write succeeded but every manifest replacement failed');
  const manifest = JSON.parse(await readFile(join(batchDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.members[0].status, 'queued');
  const resultPath = join(batchDir, 'result-0.json'), result = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.ok(result.documents.length);
  // Reuse must come from the fully completed member result, even without the ordinary transcript cache.
  await rm(join(root, 'audio-cache'), { recursive: true, force: true });
  return { root, child, manifest, result, resultPath };
}

test('a restart recovers the completed member result after exhausted manifest replacement without new model cost', async t => {
  const { root, child, manifest, result } = await orphanedBatch(t);
  const recovered = await child('resume');
  assert.equal(recovered.callsBeforeRetry, 0);
  assert.equal(recovered.done.status, 'complete', recovered.done.stage);
  assert.deepEqual(recovered.transcribed, ['B'], 'a durable complete orphan result must not transcribe A again');
  const first = recovered.done.members[0], second = recovered.done.members[1];
  assert.equal(first.reused, true);
  assert.equal(first.status, 'complete');
  assert.deepEqual(first.usage, result.meta.usage);
  assert.ok(first.usage.paid.requests > 0, 'the completed attempt retains its original cost');
  assert.equal(recovered.done.usage.paid.requests, first.usage.paid.requests + second.usage.paid.requests);
  assert.equal(recovered.done.usageRun.paid.requests, second.usageRun.paid.requests, 'the resumed run pays only for B');
  assert.equal(recovered.sources.length, 1);
  assert.deepEqual(recovered.sources[0].audio.usage, recovered.done.usage);
  const persisted = await readAudioBatch(root, manifest.id);
  assert.equal(persisted.members[0].status, 'complete');
  assert.deepEqual(persisted.members[0].progress.usage, first.usage);
});

for (const invalid of ['corrupt JSON', 'changed transcript', 'wrong member identity', 'empty documents']) test(`an orphan result with ${invalid} is reprocessed instead of published`, async t => {
  const { child, result, resultPath } = await orphanedBatch(t);
  if (invalid === 'corrupt JSON') await writeFile(resultPath, '{', 'utf8');
  else if (invalid === 'changed transcript') {
    result.documents[0] = 'An unrelated transcript with an invalid integrity digest.';
    await writeFile(resultPath, JSON.stringify(result), 'utf8');
  }
  else {
    if (invalid === 'wrong member identity') result.checkpoint.index = 1;
    else result.documents = [];
    const { checkpoint, ...payload } = result, { digest: _digest, ...metadata } = checkpoint;
    checkpoint.digest = createHash('sha256').update(JSON.stringify({ result: payload, checkpoint: metadata })).digest('hex');
    await writeFile(resultPath, JSON.stringify(result), 'utf8');
  }
  const recovered = await child('resume');
  assert.equal(recovered.done.status, 'complete', recovered.done.stage);
  assert.deepEqual(recovered.transcribed, ['A', 'B']);
  assert.equal(recovered.sources.length, 1);
  assert.ok(recovered.sources[0].text.includes('A.wav'));
});

test('orphan result recovery still rejects a changed original recording before any model call or publication', async t => {
  const { child, manifest } = await orphanedBatch(t);
  await writeFile(manifest.members[0].path, wav(3));
  const recovered = await child('resume');
  assert.equal(recovered.done.status, 'failed');
  assert.match(recovered.done.stage, /文件已改变/);
  assert.deepEqual(recovered.transcribed, []);
  assert.equal(recovered.sources.length, 0);
});

test('failed second member retries without transcribing or translating the first again', async t => {
  let failing = true;
  const { service, a, b, calls, wait } = await fixture(t, { fail: name => failing && name === 'B' });
  const first = await wait(await service.call('audio.import', { files: [{ path: a }, { path: b }] }));
  assert.equal(first.status, 'failed');
  assert.equal((await service.store.read()).sources.length, 0);
  assert.equal(first.members[0].status, 'complete');
  const aCalls = calls.filter(call => call.endsWith(':A')).length;
  failing = false;
  const finished = await wait(await service.call('audio.retry', { jobId: first.id }));
  assert.equal(finished.status, 'complete', finished.stage);
  assert.equal(calls.filter(call => call.endsWith(':A')).length, aCalls);
  assert.equal(calls.filter(call => call === 'transcribe:B').length, 1);
  assert.equal((await service.store.read()).inbox.filter(item => item.jobId === first.id && item.kind === 'audio-failed').length, 0);
});

test('mixed uploads and paths retain original names and duplicate content has no repeated model cost', async t => {
  const { service, a, calls, root, wait } = await fixture(t);
  const uploaded = await upload(service, 'Another name.wav', wav(1));
  const job = await wait(await service.call('audio.import', { files: [uploaded, { path: a }], courses: [] }));
  assert.equal(job.status, 'complete', job.stage);
  assert.equal(calls.filter(call => call.startsWith('transcribe:')).length, 1);
  assert.equal(calls.filter(call => call.startsWith('translate:')).length, 1);
  assert.equal(calls.filter(call => call.startsWith('title:')).length, 1);
  assert.ok(job.warnings.length);
  assert.deepEqual((await service.store.read()).sources[0].audio.batch.members.map(m => m.filename), ['Another name.wav', 'A.wav']);
  const manifest = await readFile(join(root, 'audio-batches', job.batchId, 'manifest.json'), 'utf8');
  assert.ok(!manifest.includes(KEY));
  assert.deepEqual(await readdir(join(root, 'audio-uploads')), []);
});

test('queued batch freezes vocabulary and course before global focus changes', async t => {
  const { service, a, b, held, prompts, wait } = await fixture(t, { hold: true, limit: 1 });
  await service.store.update(state => {
    state.decks.push({ id: 'course-a', title: 'AlphaTerminology', course: 'Course A', cards: [] }, { id: 'course-b', title: 'BetaTerminology', course: 'Course B', cards: [] });
  });
  await service.call('focus.set', { mode: 'class', course: 'Course A' });
  const single = await service.call('audio.import', { path: a });
  await until(() => held.has('A'));
  const batch = await service.call('audio.import', { files: [{ path: b }, { path: a }] });
  await service.call('focus.set', { mode: 'class', course: 'Course B' });
  held.get('A')(); await wait(single);
  await until(() => held.has('B'));
  held.get('B')();
  const result = await wait(batch);
  assert.equal(result.status, 'complete', result.stage);
  const source = (await service.store.read()).sources.find(source => source.audio?.batch);
  assert.deepEqual(source.courses, ['Course A']);
  assert.ok(prompts.some(prompt => prompt.includes('AlphaTerminology')));
  assert.ok(prompts.every(prompt => !prompt.includes('BetaTerminology')));
});

test('batch reuse preserves an independently saved source and does not request models again', async t => {
  const { service, a, calls, wait } = await fixture(t);
  const single = await wait(await service.call('audio.import', { path: a }));
  const original = (await service.store.read()).sources[0], spent = calls.length;
  const batch = await wait(await service.call('audio.import', { files: [{ path: a }, { path: a }], courses: ['Batch only'] }));
  assert.equal(batch.status, 'complete', batch.stage);
  assert.equal(calls.length, spent);
  const retained = (await service.store.read()).sources.find(source => source.id === single.sourceIds[0]);
  assert.equal(retained.text, original.text);
  assert.deepEqual(retained.courses, original.courses);
});

test('resumable upload copies and their job card outlive automatic terminal job pruning', async t => {
  let failing = true;
  const { service, a, calls, root, wait } = await fixture(t, { fail: name => failing && name === 'B' });
  const uploaded = await upload(service, 'B.wav', wav(2));
  const failed = await wait(await service.call('audio.import', { files: [{ path: a }, uploaded] }));
  assert.equal(failed.status, 'failed');
  const manifestPath = join(root, 'audio-batches', failed.batchId, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (let i = 0; i < 103; i++) assert.equal((await wait(await service.call('audio.import', { path: a }))).status, 'complete');
  assert.ok((await service.call('snapshot')).jobs.some(job => job.id === failed.id && job.retryable));
  assert.equal((await readFile(manifest.members[1].path)).at(-1), 2);
  const before = calls.filter(call => call === 'transcribe:B').length;
  failing = false;
  assert.equal((await wait(await service.call('audio.retry', { jobId: failed.id }))).status, 'complete');
  assert.equal(calls.filter(call => call === 'transcribe:B').length, before);
});

test('inputs survive when sources commit but the terminal manifest cannot be saved', async t => {
  const { service, a, root, wait } = await fixture(t);
  const uploaded = await upload(service, 'B.wav', wav(2)), originalUpdate = service.store.update.bind(service.store);
  let blocked;
  service.store.update = async mutate => {
    const result = await originalUpdate(mutate);
    const batchSource = (await service.store.read()).sources.find(source => source.audio?.batch);
    if (batchSource && !blocked) {
      const file = join(root, 'audio-batches', batchSource.audio.batch.id, 'manifest.json');
      blocked = JSON.parse(await readFile(file, 'utf8'));
      await rename(file, `${file}.saved`); await mkdir(file);
    }
    return result;
  };
  const job = await wait(await service.call('audio.import', { files: [{ path: a }, uploaded] }));
  assert.equal(job.status, 'complete', job.stage);
  assert.equal((await service.store.read()).sources.length, 1);
  assert.ok(job.warnings.some(warning => warning.includes('任务进度')));
  assert.equal((await readFile(blocked.members[1].path)).at(-1), 2, 'no cleanup before durable completion');
});
