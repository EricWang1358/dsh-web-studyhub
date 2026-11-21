import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LiveSession, writeSaved } from '../lib/live.js';
import { checkpoints } from '../lib/audio-import.js';
import { GeminiTiers } from '../lib/gemini.js';
import { loadAudio, wavInfoFromFile } from '../lib/audio-file.js';
import { loopbackFactory } from '../lib/live-local.js';
import { createLocalClipPool, drainLocalClipPool, localClipPoolStats, transcribeLocally } from '../lib/contexts/audio/clip.js';
import { StudyService } from '../lib/service.js';
import { modelCompletion } from '../lib/runtime/host-model.js';
import { withUsageSink } from '../lib/usage-scope.js';
import { wavBytes } from '../ui/voice/wav.js';
import { createIndexLock, INDEX_LOCK_DEFAULTS } from '../packages/studyhub-desktop/adapters/retrieval/index-lock.mjs';
import { extractZipArchive } from '../packages/studyhub-desktop/adapters/retrieval/zip-extract.mjs';
import { createRetrievalInstaller } from '../packages/studyhub-desktop/adapters/retrieval/installer.mjs';
import { retrievalAssetName, retrievalChecksumsName } from '../packages/studyhub-desktop/domain/retrieval-policy.js';
import { createZipBuffer } from '../packages/studyhub-desktop/scripts/zip-utils.mjs';

const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/live-local/fake-sherpa.cjs', import.meta.url));
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const square = (seconds) => Int16Array.from({ length: Math.round(seconds * 16000) }, (_, i) => (i % 32 < 16 ? 8000 : -8000));

/* ---------- 1. Live fatal translation circuit breaker & atomic JSON persistence ---------- */

test('LiveSession halts translation on fatal error without hammering remaining pending batches and resumes on retryFailed', async () => {
  let calls = 0;
  let fatalMode = true;
  const session = new LiveSession({
    title: 'Fatal Circuit Breaker Test',
    tiers: new GeminiTiers({}),
    translate: async ({ items }) => {
      calls += 1;
      if (fatalMode) {
        throw Object.assign(new Error('402 insufficient balance'), { fatal: true });
      }
      return new Map(items.map((item) => [item.n, `译:${item.n}`]));
    },
    timing: { translateRetryMs: 5, translateAutoRetryMs: 20, saveDelayMs: 50 },
  });

  // Queue 15 English sentences (> 2 batches of TRANSLATE_BATCH=6)
  session.addSegments(Array.from({ length: 15 }, (_, i) => `Sentence number ${i + 1} explains distributed consensus.`));
  await session.settled();

  assert.equal(calls, 1, 'fatal translation error must circuit-break after the first failed batch instead of hammering remaining batches');
  assert.equal(session.translateHalted, true);
  assert.equal(session.pendingSegments().length, 0, 'all remaining pending segments marked error when halted');
  assert.equal(session.segments.every((s) => s.zhState === 'error'), true);
  assert.equal(session.snapshot().translating, 0);
  assert.match(session.message, /翻译停止/);

  // New speech arriving while halted must not fire API calls either
  session.addSegments(['Sentence number 16 arrives while translator is halted.']);
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(calls, 1, 'no new translation requests while halted (including auto-retry timer)');
  assert.equal(session.segments.at(-1).zhState, 'error');

  // After user fixes credentials and clicks manual retry, translation resumes cleanly
  fatalMode = false;
  session.retryFailed();
  await session.settled();
  assert.equal(session.translateHalted, false);
  assert.equal(session.segments.every((s) => s.zhState === 'done' && s.zh.startsWith('译:')), true);
  assert.ok(calls >= 3, 'resumed batches translated all 16 segments');
});

test('writeSaved and audio checkpoints write atomically via atomicJson leaving zero .tmp files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'audio-atomic-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeSaved(dir, { id: 'session-12345678', title: 'Atomic Live', segments: [] });
  const liveFiles = await readdir(join(dir, 'live'));
  assert.deepEqual(liveFiles, ['session-12345678.json']);

  const cacheDir = join(dir, 'audio-cache');
  const store = checkpoints(cacheDir);
  await store.set('raw-abc-0.json', { text: 'hello world', tier: 'paid', seconds: 60 });
  const cacheFiles = await readdir(cacheDir);
  assert.deepEqual(cacheFiles, ['raw-abc-0.json']);
  assert.deepEqual(await store.get('raw-abc-0.json'), { text: 'hello world', tier: 'paid', seconds: 60 });
});

/* ---------- 2. GeminiTiers.transcribe per-tier uploadFailed isolation ---------- */

test('GeminiTiers.transcribe isolates upload failures per tier so a free-tier upload failure does not short-circuit paid-tier fallback forms', async () => {
  const FREE = 'AIzaFreeTierKey_00000000000000001';
  const PAID = 'AIzaPaidTierKey_00000000000000002';
  let paidUploads = 0;
  const generateForms = [];

  const fetch = async (url, init = {}) => {
    url = String(url);
    const key = init.headers?.['x-goog-api-key'];
    if (init.method === 'DELETE') return json({});
    if (url.endsWith('/upload/v1beta/files')) {
      if (key === FREE) {
        return json({ error: { code: 429, message: 'Quota exceeded per day (PerDay)' } }, 429);
      }
      paidUploads += 1;
      return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/session/paid1' } });
    }
    if (url.endsWith('/upload/session/paid1')) {
      return json({ file: { name: 'files/paid1', uri: 'https://generativelanguage.googleapis.com/v1beta/files/paid1', state: 'ACTIVE' } });
    }
    const body = JSON.parse(init.body);
    const cfg = body.generationConfig?.audioTranscriptionConfig || null;
    generateForms.push({ key, hasVocab: Boolean(cfg?.customVocabulary), mode: cfg?.mode || null });
    if (cfg?.customVocabulary) {
      return json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'customVocabulary unsupported' } }, 400);
    }
    return json({ candidates: [{ content: { parts: [{ text: 'paid fallback succeeded' }] } }], usageMetadata: {} });
  };

  const tiers = new GeminiTiers({ keys: { free: FREE, paid: PAID }, fetch, sleep: async () => {} });
  // > 12 MB forces file-only delivery (no inline fallback)
  const bigChunk = Buffer.alloc(13 * 1024 * 1024);
  const res = await tiers.transcribe({
    bytes: bigChunk,
    mimeType: 'audio/mp3',
    seconds: 600,
    config: { vocabulary: ['ACID'], mode: 'SMART' },
  });

  assert.equal(res.text, 'paid fallback succeeded');
  assert.equal(res.tier, 'paid');
  assert.equal(paidUploads, 1, 'paid tier uploaded the file once and reused it across simplified forms');
  assert.deepEqual(generateForms, [
    { key: PAID, hasVocab: true, mode: 'SMART' },
    { key: PAID, hasVocab: false, mode: 'SMART' },
  ]);
});

/* ---------- 3. Streaming measureOnly preflight + warm idle-TTL local ASR clip pool ---------- */

test('wavInfoFromFile and loadAudio(measureOnly) probe headers without reading giant audio payloads into memory', async (t) => {
  // Synthetic 400 MB WAV file handle that fails immediately if anything reads past the first 4 KB header
  const fakeSize = 400 * 1024 * 1024;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(fakeSize - 8, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(fakeSize - 44, 40);

  let maxOffsetRead = 0;
  const fakeFile = {
    async read(buf, offset, length, position) {
      assert.ok(position + length <= 4096, `must not read payload bytes at offset ${position}..${position + length}`);
      maxOffsetRead = Math.max(maxOffsetRead, position + length);
      const copied = header.copy(buf, offset, position, Math.min(header.length, position + length));
      return { bytesRead: copied };
    },
  };
  const info = await wavInfoFromFile(fakeFile, fakeSize);
  assert.ok(info);
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.dataLength, fakeSize - 44);
  assert.ok(Math.abs(info.seconds - (fakeSize - 44) / 32000) < 0.01);
  assert.ok(maxOffsetRead <= 64, `only read ${maxOffsetRead} bytes for a 400 MB WAV`);

  // Real temp WAV: measureOnly matches full loadAudio exactly
  const dir = await mkdtemp(join(tmpdir(), 'audio-measure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wavPath = join(dir, 'sample.wav');
  await writeFile(wavPath, Buffer.from(wavBytes([square(2)])));
  const measured = await loadAudio({ path: wavPath, measureOnly: true });
  const loaded = await loadAudio({ path: wavPath, measureOnly: false });
  assert.equal(measured.ext, loaded.ext);
  assert.equal(measured.seconds, loaded.seconds);
  assert.equal(measured.parts, loaded.chunks.length);
});

test('local ASR clip pool reuses warm worker across clips, evicts on model switch/TTL, and drains cleanly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'clip-pool-'));
  t.after(async () => {
    await drainLocalClipPool();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const modelDir = join(dir, 'model');
  await mkdir(modelDir, { recursive: true });
  for (const name of ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx', 'turbo-encoder.int8.onnx', 'turbo-decoder.int8.onnx', 'turbo-tokens.txt']) {
    await writeFile(join(modelDir, name), 'fake');
  }

  const pool = createLocalClipPool({ idleTtlMs: 80 });
  t.after(() => pool.drain());
  const wsSense = loopbackFactory({ enginePath: FAKE_ENGINE, modelDir, modelId: 'sense-voice' });
  const pcm1 = Buffer.from(square(1).buffer);
  const pcm2 = Buffer.from(square(0.5).buffer);

  assert.equal(await transcribeLocally(wsSense, pcm1, { pool }), '句（10）');
  assert.equal(pool.stats().spawns, 1);
  assert.equal(pool.stats().hasWorker, true);

  assert.equal(await transcribeLocally(wsSense, pcm2, { pool }), '句（5）');
  assert.equal(pool.stats().spawns, 1, 'second clip reused warm resident worker without cold load');

  // Switching model evicts old worker and spawns new one
  const wsWhisper = loopbackFactory({ enginePath: FAKE_ENGINE, modelDir, modelId: 'whisper-turbo' });
  assert.equal(await transcribeLocally(wsWhisper, pcm2, { pool }), '句（5）');
  assert.equal(pool.stats().spawns, 2, 'switching model replaced resident worker');

  // Idle TTL reclaims worker automatically
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(pool.stats().hasWorker, false, 'idle worker reclaimed after TTL');

  // Also test default pool drain helper
  assert.equal(await transcribeLocally(wsSense, pcm2), '句（5）');
  assert.equal(localClipPoolStats().hasWorker, true);
  await drainLocalClipPool();
  assert.equal(localClipPoolStats().hasWorker, false);
});

/* ---------- 4. classify-jobs cross-course dedupe, per-course slots & host-model audio() fixes ---------- */

test('classify-jobs isolates dedupe by course & keysHash, preserves per-course pending slots, and passes non-audio task + #1179 timeoutMs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'classify-slots-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  const gateA = Promise.withResolvers();
  const enteredA = Promise.withResolvers();
  const seenOptions = [];

  const service = new StudyService(dir, {
    complete: async (_sys, prompt, options = {}) => {
      seenOptions.push(options);
      if (prompt.includes('CourseA Doc')) {
        enteredA.resolve();
        await gateA.promise;
        return JSON.stringify({ folders: ['A-Folder'], assignments: [{ id: 'source:a1', folder: 'A-Folder' }] });
      }
      return JSON.stringify({ folders: ['B-Folder'], assignments: [{ id: 'source:b1', folder: 'B-Folder' }] });
    },
  });
  t.after(() => service.dispose());

  await service.store.update((s) => {
    s.sources.push(
      { id: 'a1', title: 'CourseA Doc', text: '# A\nBody', courses: ['Course A'] },
      { id: 'a2', title: 'CourseA Doc 2', text: '# A2\nBody', courses: ['Course A'] },
      { id: 'b1', title: 'CourseB Doc', text: '# B\nBody', courses: ['Course B'] },
    );
  });

  const jobA = await service.call('source.folder.classify', { course: 'Course A', keys: ['source:a1'] });
  assert.equal(jobA.reused, false);
  await enteredA.promise;

  // Same course + same keys deduplicates
  const dupA = await service.call('source.folder.classify', { course: 'Course A', keys: ['source:a1'] });
  assert.equal(dupA.reused, true);
  assert.equal(dupA.job.id, jobA.job.id);

  // Different keys in same course must NOT deduplicate into jobA
  const diffKeys = await service.call('source.folder.classify', { course: 'Course A', keys: ['source:a2'] });
  assert.equal(diffKeys.reused, false);
  assert.notEqual(diffKeys.job.id, jobA.job.id);

  // Different course must NOT deduplicate into jobA
  const jobB = await service.call('source.folder.classify', { course: 'Course B', keys: ['source:b1'] });
  assert.equal(jobB.reused, false);
  assert.notEqual(jobB.job.id, jobA.job.id);

  gateA.resolve();
  await service.call('job.wait', { jobId: jobA.job.id });
  await service.call('job.wait', { jobId: diffKeys.job.id });
  await service.call('job.wait', { jobId: jobB.job.id });

  // Both Course A and Course B pending proposals coexist in materialClassifyPendingByCourse
  const snap = await service.call('snapshot');
  assert.ok(snap.settings.materialClassifyPendingByCourse['Course A'], 'Course A pending slot preserved');
  assert.ok(snap.settings.materialClassifyPendingByCourse['Course B'], 'Course B pending slot preserved');

  // Dismissing Course B promotes Course A and keeps Course A intact
  await service.call('source.folder.dismiss', { jobId: jobB.job.id });
  const afterDismissB = await service.call('snapshot');
  assert.equal(afterDismissB.settings.materialClassifyPendingByCourse['Course B'], undefined);
  assert.ok(afterDismissB.settings.materialClassifyPendingByCourse['Course A']);
  assert.equal(afterDismissB.settings.materialClassifyPending.course, 'Course A');

  // Verify task attribution & #1179 default unlimited timeoutMs (0)
  assert.ok(seenOptions.length >= 2);
  for (const opts of seenOptions) {
    assert.equal(opts.task, 'materials.classify', 'classify-jobs must not pollute audio.text task');
    assert.equal(opts.timeoutMs, 0, 'bookCallTimeoutMinutes=0 passes unlimited timeoutMs=0');
  }
});

test('host-model audio() forwards resolved choice.id, honors timeoutMs=0, and records caller task', async (t) => {
  const timeouts = [];
  const origTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => { timeouts.push(ms); return origTimeout(ms); };
  t.after(() => { AbortSignal.timeout = origTimeout; });

  const resolvedConfigs = [];
  let modelInfoLookups = 0;
  const llm = {
    listProviders: () => [{ id: 'test-provider' }],
    async resolveModelInfo() {
      modelInfoLookups += 1;
      return { reasoning: { efforts: [{ id: 'minimal', name: 'Minimal' }, { id: 'high', name: 'High' }] } };
    },
    async resolveCallConfig(cfg) {
      resolvedConfigs.push(cfg);
      return cfg;
    },
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '{"ok":true}' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"ok":true}' } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const ctx = { llm, get: (name) => (name === 'llm' ? llm : undefined), on: () => () => {} };
  const complete = modelCompletion(ctx, () => ({ provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' }), 'sess-1');

  const reported = [];
  const reply = await withUsageSink({ key: 'test-sink', sink: (usage, meta) => reported.push({ usage, meta }) }, () =>
    complete('sys', 'prompt', {
      jobId: 'mat-job-1',
      stage: 'taxonomy',
      task: 'materials.classify',
      resultOwner: 'plugin',
      reasoningEffort: 'lowest',
      timeoutMs: 0,
    }),
  );

  assert.equal(reply, '{"ok":true}');
  assert.deepEqual(timeouts, [], 'timeoutMs=0 must not arm a hidden 8-minute/10-minute AbortSignal.timeout');
  assert.equal(resolvedConfigs.length, 1);
  assert.equal(String(resolvedConfigs[0].reasoningEffort), 'minimal', 'passes resolved choice.id ("minimal") instead of raw "lowest" or parent "high"');
  assert.equal(modelInfoLookups, 1, 'reasoningFor resolves effort once without double correctionEffort lookup');
  assert.equal(reported[0]?.meta?.task, 'materials.classify');
});

/* ---------- 5. StudyHub Desktop: index-lock, async streaming zip-extract (+x & symlink) & installer ---------- */

test('desktop index-lock defaults align with 15-min indexing and abort promptly on AbortSignal', async (t) => {
  assert.equal(INDEX_LOCK_DEFAULTS.stale, 30_000);
  assert.equal(INDEX_LOCK_DEFAULTS.update, 10_000);
  assert.ok(INDEX_LOCK_DEFAULTS.retries.maxRetryTime >= 15 * 60 * 1000, 'lock wait budget aligns with 15-min indexing');
  assert.ok(INDEX_LOCK_DEFAULTS.retries.retries >= 150);

  const dir = await mkdtemp(join(tmpdir(), 'desk-lock-abort-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lockA = createIndexLock({ retrievalDir: dir });
  const lockB = createIndexLock({ retrievalDir: dir });

  const held = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const holding = lockA.withLock(async () => {
    entered.resolve();
    await held.promise;
  });
  await entered.promise;

  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(new Error('cancelled-wait')), 40);
  await assert.rejects(
    lockB.withLock(async () => 'never', { signal: ac.signal }),
    /cancelled-wait/,
  );
  assert.ok(Date.now() - started < 2000, 'aborted immediately instead of blocking for 15 minutes');
  held.resolve();
  await holding;
});

test('desktop zip-extract streams from disk asynchronously, restores Unix +x permissions, and blocks symlinks', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'desk-zip-unix-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Build ZIP with Unix executable entry (0o100755)
  const execZip = createZipBuffer([{ name: 'bin/helper', data: Buffer.from('#!/bin/sh\necho hi\n') }]);
  const cdIndex = execZip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  execZip.writeUInt16LE((3 << 8) | 20, cdIndex + 4);
  execZip.writeUInt32LE((0o100755 << 16) >>> 0, cdIndex + 38);

  const zipPath = join(dir, 'bundle.zip');
  await writeFile(zipPath, execZip);
  const outDir = join(dir, 'extracted');
  const chmodCalls = [];
  const stats = await extractZipArchive(zipPath, outDir, {
    platform: 'linux',
    chmodFile: async (target, mode) => { chmodCalls.push({ target, mode }); },
  });
  assert.equal(stats.fileCount, 1);
  assert.equal(await readFile(join(outDir, 'bin', 'helper'), 'utf8'), '#!/bin/sh\necho hi\n');
  assert.equal(chmodCalls.length, 1);
  assert.equal(chmodCalls[0].mode, 0o755, 'restores Unix executable bit +x from externalFileAttributes');

  // Symlink in disk-backed ZIP is still rejected
  const symZip = createZipBuffer([{ name: 'evil-link', data: Buffer.from('/etc/passwd') }]);
  const symCd = symZip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  symZip.writeUInt16LE((3 << 8) | 20, symCd + 4);
  symZip.writeUInt32LE((0o120777 << 16) >>> 0, symCd + 38);
  const symPath = join(dir, 'sym.zip');
  await writeFile(symPath, symZip);
  await assert.rejects(extractZipArchive(symPath, join(dir, 'sym-out')), (err) => err?.code === 'extension-zip-unsafe');

  // Installer streams to disk, verifies SHA-256, extracts cleanly via file path
  const dshHome = join(dir, 'dsh');
  const targetDir = join(dir, 'tools', 'retrieval');
  const version = '5.2.1';
  const goodZip = createZipBuffer([
    { name: 'package.json', data: Buffer.from(JSON.stringify({ name: '@ericwang1358/studyhub-retrieval', version, type: 'module' })) },
    { name: 'server.mjs', data: Buffer.from('export {};\n') },
    { name: 'heal.js', data: Buffer.from('export async function healIndex() { return {}; }\n') },
    { name: 'node_modules/mcp-local-rag/package.json', data: Buffer.from('{"name":"mcp-local-rag","version":"0.20.0","main":"./index.js"}') },
    { name: 'node_modules/mcp-local-rag/index.js', data: Buffer.from('module.exports = {};\n') },
  ]);
  const sha = createHash('sha256').update(goodZip).digest('hex');
  const assetName = retrievalAssetName(version);
  const sumsName = retrievalChecksumsName(version);
  const installer = createRetrievalInstaller({
    env: { DSH_HOME: dshHome },
    desktopDir: targetDir,
    dshHome,
    downloadPrefix: 'http://127.0.0.1:1/',
    attempts: 1,
    httpFetch: async (url) => {
      const p = new URL(url).pathname;
      if (p.endsWith(`/${sumsName}`)) return new Response(`${sha}  ${assetName}\n`, { status: 200 });
      if (p.endsWith(`/${assetName}`)) return new Response(goodZip, { status: 200, headers: { 'content-length': String(goodZip.length) } });
      return new Response('404', { status: 404 });
    },
  });
  const res = await installer.install({ version });
  assert.equal(res.version, version);
  assert.equal(res.sha256, sha);
  assert.equal(res.bytes, goodZip.length);
});
