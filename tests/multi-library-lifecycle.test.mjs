import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp, { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { Context } from '@deepseek-ai/cordis';
import { Store } from '../lib/store.js';
import { StudyService } from '../lib/service.js';
import { acquireContexts } from '../lib/runtime/lifecycle.js';
import { createJobLifecycle } from '../lib/jobs/lifecycle.js';
import { createManifestJobStore, validateStoredJob } from '../lib/jobs/store.js';
import { dshJobExecutor, hostJobExecutor } from '../lib/jobs/executor.js';
import { compactJobSteps, MAX_CALLS } from '../lib/job-calls.js';
import { snapshotJob } from '../lib/job-contract.js';
import { createRuntimeWork } from '../lib/runtime/work.js';
import { seedLibrary } from '../scripts/qa/perf-seed.mjs';
import { validateStoredJob as acceptedByRelease271 } from './fixtures/release-2.7.1/store.js';

let forceGc = null;
function settledMemory() {
  try {
    if (!forceGc) {
      if (typeof globalThis.gc !== 'function') setFlagsFromString('--expose-gc');
      forceGc = typeof globalThis.gc === 'function' ? globalThis.gc : runInNewContext('gc');
    }
    forceGc(); forceGc();
  } catch { /* best-effort GC */ }
  const m = process.memoryUsage();
  const MB = 1024 * 1024;
  return { rss: m.rss / MB, heapUsed: m.heapUsed / MB };
}

class Probe {
  #counts = {
    jsonParseCalls: 0, jsonParseChars: 0, jsonStringifyCalls: 0, jsonStringifyChars: 0,
    structuredCloneCalls: 0, structuredCloneChars: 0,
    manifestReads: 0, shardReads: 0, shardWrites: 0, manifestWrites: 0,
  };
  #restore = null;
  #sizeClones;
  constructor({ sizeClones = false } = {}) { this.#sizeClones = sizeClones; }
  install() {
    if (this.#restore) return this;
    const counts = this.#counts;
    const { parse, stringify } = JSON, clone = globalThis.structuredClone;
    const readFile = fsp.readFile, writeFile = fsp.writeFile, readFileSync = fs.readFileSync;
    JSON.parse = function (text, ...rest) {
      counts.jsonParseCalls++;
      if (typeof text === 'string') counts.jsonParseChars += text.length;
      return parse.call(this, text, ...rest);
    };
    JSON.stringify = function (...args) {
      const out = stringify.apply(this, args);
      counts.jsonStringifyCalls++;
      if (typeof out === 'string') counts.jsonStringifyChars += out.length;
      return out;
    };
    const sizeClones = this.#sizeClones;
    globalThis.structuredClone = (...args) => {
      counts.structuredCloneCalls++;
      if (sizeClones) { try { counts.structuredCloneChars += stringify(args[0])?.length ?? 0; } catch { /* non-JSON */ } }
      return clone(...args);
    };
    const isShard = path => /[\\/]shards[\\/]/.test(String(path));
    const isManifest = path => /study-workspace\.json(\.[0-9a-f-]+\.tmp)?$/.test(String(path));
    fsp.readFile = async function (path, ...rest) {
      const out = await readFile.call(this, path, ...rest);
      if (isShard(path)) counts.shardReads++;
      else if (isManifest(path)) counts.manifestReads++;
      return out;
    };
    fs.readFileSync = function (path, ...rest) {
      const out = readFileSync.call(this, path, ...rest);
      if (isShard(path)) counts.shardReads++;
      return out;
    };
    fsp.writeFile = async function (path, data, ...rest) {
      if (isShard(path)) counts.shardWrites++;
      else if (isManifest(path)) counts.manifestWrites++;
      return writeFile.call(this, path, data, ...rest);
    };
    syncBuiltinESMExports();
    this.#restore = () => {
      JSON.parse = parse; JSON.stringify = stringify; globalThis.structuredClone = clone;
      fsp.readFile = readFile; fsp.writeFile = writeFile; fs.readFileSync = readFileSync;
      syncBuiltinESMExports();
      this.#restore = null;
    };
    return this;
  }
  uninstall() { this.#restore?.(); }
  read() { return { ...this.#counts }; }
  async measure(fn) {
    const before = this.read();
    const value = await fn();
    const after = this.read();
    return { value, counts: Object.fromEntries(Object.keys(after).map(k => [k, after[k] - (before[k] || 0)])) };
  }
}

const flushTurn = () => new Promise(resolve => setImmediate(resolve));
const settledHeap = async () => {
  await flushTurn();
  await flushTurn();
  return settledMemory();
};

async function createTempRoot(t, prefix = 'multi-lib-budget-') {
  const base = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return base;
}

test('1 / 10 / 50 sequential multi-library open, switch, and last-owner release keep Store caches and heap bounded', async t => {
  const base = await createTempRoot(t, 'multi-lib-scale-');
  // Baseline any prior unpinned caches from earlier suites in this worker.
  Store.evictIdleCaches(0);
  const startMem = await settledHeap();

  const scaleMetrics = {};
  for (const count of [1, 10, 50]) {
    const roots = [];
    const started = performance.now();
    for (let i = 0; i < count; i++) {
      const root = join(base, `scale-${count}-lib-${String(i).padStart(2, '0')}`);
      roots.push(root);
      await seedLibrary(root, {
        sources: 16,
        decks: 3,
        cardsPerDeck: 12,
        runs: 2,
        attempts: 60,
        courses: 2,
        largeSources: 1,
        largeSourceChars: 16000,
      });
      const service = new StudyService(root);
      const snap = await service.call('snapshot');
      assert.equal(snap.sources.length, 16);
      // Disposing the sole owner releases its Store shard cache while preserving disk files.
      await service.dispose();
      assert.equal(service.store.cacheStats().cached, false, `closed library ${i} evicted its Store cache`);
      assert.equal(service.store.cacheStats().parsedShards, 0, `closed library ${i} evicted parsed shards`);
    }
    const elapsedMs = Math.round(performance.now() - started);
    const mem = await settledHeap();
    const diag = Store.cacheDiagnostics();
    scaleMetrics[count] = {
      elapsedMs,
      heapUsedMb: +mem.heapUsed.toFixed(2),
      heapDeltaMb: +(mem.heapUsed - startMem.heapUsed).toFixed(2),
      cachedLibraries: diag.cachedLibraries,
      totalParsedShards: diag.totalParsedShards,
    };
    assert.equal(diag.pinnedLibraries, 0);
    assert.equal(diag.cachedLibraries, 0, `all ${count} closed libraries released their Store caches`);
    assert.equal(diag.totalParsedShards, 0);

    // Reopening the first library reloads transparently from disk with all data intact.
    const reopened = new StudyService(roots[0]);
    const snapAgain = await reopened.call('snapshot');
    assert.equal(snapAgain.sources.length, 16);
    assert.equal(snapAgain.decks.length, 3);
    await reopened.dispose();
  }

  t.diagnostic(`multi-library StudyService lifecycle (1 / 10 / 50): ${JSON.stringify(scaleMetrics)}`);
  // Opening & closing 50 libraries must not retain 50x library state in heap (sub-linear post-GC delta).
  const growth10To50 = scaleMetrics[50].heapUsedMb - scaleMetrics[10].heapUsedMb;
  assert.ok(growth10To50 <= 24, `heap grew ${growth10To50.toFixed(2)} MB between 10 and 50 sequential libraries; budget <= 24 MB`);

  // Also verify acquireContexts().api.forLibrary(path) idle LRU eviction across 20 unowned libraries while keeping an owned library pinned.
  const ctx = new Context();
  const contexts = acquireContexts(ctx, ['materials', 'bank', 'study', 'library'], { maxIdleLibraries: 4 });
  t.after(async () => { await contexts.release(); await ctx.fiber.dispose(); });

  const pinnedRoot = join(base, 'scale-50-lib-00');
  const pinnedHandle = contexts.api.acquireLibrary(pinnedRoot);
  await pinnedHandle.forLibrary().call('source.list', { limit: 5 });

  for (let i = 1; i <= 18; i++) {
    const root = join(base, `scale-50-lib-${String(i).padStart(2, '0')}`);
    const list = await contexts.api.forLibrary(root).call('source.list', { limit: 5 });
    assert.equal(list.sources.length, 5);
  }
  await contexts.api.evictIdleLibraries();
  const scopeDiag = contexts.api.diagnostics();
  t.diagnostic(`acquireContexts LRU diagnostics: ${JSON.stringify(scopeDiag)}`);
  assert.equal(scopeDiag.ownedLibraries, 1, 'explicitly acquired library stays pinned');
  assert.ok(scopeDiag.idleLibraries <= 4, `idle libraries capped at <= 4, got ${scopeDiag.idleLibraries}`);
  assert.ok(scopeDiag.activeLibraries <= 5, `total active libraries capped at <= 5, got ${scopeDiag.activeLibraries}`);
  assert.equal(pinnedHandle.runtime.storage.cacheStats().cached, true, 'pinned library keeps its Store cache warm');

  await pinnedHandle.release();
  assert.equal(pinnedHandle.runtime.storage.cacheStats().cached, false, 'releasing last owner evicts Store cache');
});

test('dual-owner isolation: closing one owner never evicts the shared library cache needed by a second active owner', async t => {
  const base = await createTempRoot(t, 'multi-lib-dual-owner-');
  const root = join(base, 'shared-lib');
  await seedLibrary(root, { sources: 40, decks: 4, cardsPerDeck: 20, runs: 3, attempts: 120, courses: 2 });

  const ctx = new Context();
  const contexts = acquireContexts(ctx, ['materials', 'bank', 'study', 'library']);
  t.after(async () => { await contexts.release(); await ctx.fiber.dispose(); });

  const ownerA = Symbol('session-a');
  const ownerB = Symbol('session-b');
  const leaseA = contexts.api.acquireLibrary(root, ownerA);
  const leaseB = contexts.api.acquireLibrary(root, ownerB);
  assert.equal(leaseA.runtime, leaseB.runtime, 'both owners share the canonical library runtime');

  // Warm the shared Store cache via owner A.
  const snapA = await leaseA.forLibrary().call('snapshot');
  assert.equal(snapA.sources.length, 40);
  assert.ok(leaseB.runtime.storage.cacheStats().retainedOwners >= 2);

  // Close owner A while owner B is still active.
  await leaseA.release();
  assert.equal(leaseB.runtime.storage.cacheStats().cached, true, 'cache stays warm for owner B after owner A closes');

  // Measure owner B's read: zero shard reads and zero JSON parses of library shards!
  const probe = new Probe({ sizeClones: true }).install();
  t.after(() => probe.uninstall());
  const { value: scene, counts } = await probe.measure(() => leaseB.forLibrary().call('study.scene.get', {}));
  probe.uninstall();

  assert.ok(scene);
  assert.equal(counts.shardReads, 0, 'owner B reads zero shard files from disk after owner A closed');
  assert.equal(counts.jsonParseChars, 0, 'owner B parses zero library JSON after owner A closed');

  // Now close owner B (the last owner): runtime disposes and Store cache is evicted immediately.
  const released = await leaseB.release();
  assert.equal(released, true);
  assert.equal(leaseB.runtime.storage.cacheStats().cached, false, 'last owner release evicts Store cache');
  assert.equal(leaseB.runtime.storage.cacheStats().parsedShards, 0);
});

test('100 / 1,000 / 5,000 long-job calls bound retained history, sub-quadratic clone/write cost, release-2.7.1 compatibility, and pending-intent crash safety', async t => {
  const base = await createTempRoot(t, 'long-job-budget-');
  const policy = { purpose: 'author', feature: 'generate', requestedEffort: 'default', executionMode: 'direct', budget: null };

  async function runDurableScaledJob(callCount) {
    const dir = join(base, `job-${callCount}`);
    await mkdtemp(join(tmpdir(), 'unused-')).then(p => rm(p, { recursive: true, force: true }));
    const { mkdir, writeFile, stat } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const manifestFile = join(dir, 'manifest.json');
    await writeFile(manifestFile, JSON.stringify({ id: `m-${callCount}` }), 'utf8');
    const store = createManifestJobStore(manifestFile);

    const ctx = new Context();
    const work = createRuntimeWork();
    const lifecycle = createJobLifecycle(dir, work);
    const owner = Symbol(`owner-${callCount}`);
    const agent = { id: 'bench-agent' };
    const host = {
      get: key => key === 'agents'
        ? { get: id => (id === agent.id ? agent : undefined) }
        : key === 'jobs'
          ? {
            start(spec) { spec.run({ id: 'h-1' }); return 'h-1'; },
            kill() {},
            readAt() { return { chunks: [] }; },
          }
          : undefined,
    };

    lifecycle.register(ctx, 'gen.v1', {
      kind: 'generation',
      version: 1,
      capabilities: { cancel: true, pauseMode: 'checkpoint', recoveryMode: 'resume-checkpoint', retry: true, set: false, executionModes: ['direct'] },
      persistence: {
        open: async () => ({
          store,
          inputRef: { id: `in-${callCount}`, hash: 'sha256:abc', size: callCount },
          validateInput: async () => {},
          validateCheckpoint: async () => {},
          reconcileCommit: async commit => commit.receipt || { ok: true },
          replayCall: async () => {},
        }),
      },
      run: async context => {
        const waveSize = callCount >= 5000 ? 500 : callCount >= 1000 ? 200 : 25;
        const checkpointAt = Math.floor(callCount / 2);
        for (let baseIdx = 0; baseIdx < callCount; baseIdx += waveSize) {
          const endIdx = Math.min(callCount, baseIdx + waveSize);
          const wave = [];
          for (let i = baseIdx + 1; i <= endIdx; i++) {
            const step = context.gateway.step(`author:${i}`, policy);
            wave.push(step.run(() => step.observe(
              { boundary: 'host-attempt', kind: 'author', sideEffect: false, modelRequest: true, runner: 'direct' },
              async () => ({
                value: 'ok',
                status: 200,
                tokenUsage: { uncachedInputTokens: 100, outputTokens: 25, cacheReadTokens: 10, cacheWriteTokens: 0 },
              }),
            )));
          }
          await Promise.all(wave);
          if (baseIdx < checkpointAt && endIdx >= checkpointAt) {
            await context.commit(
              async () => ({ saved: checkpointAt, checkpoint: { version: 1, ref: `cp:${checkpointAt}`, digest: `d:${checkpointAt}`, stepKey: `author:${checkpointAt}` } }),
              () => {},
              `commit:${checkpointAt}`,
            );
          }
        }
        return { refs: [{ kind: 'draft', id: `draft-${callCount}` }], completeness: 'complete' };
      },
    });

    const port = lifecycle.scoped({
      owner,
      domain: 'gen.v1',
      executor: dshJobExecutor(host, agent),
    });

    const probe = new Probe({ sizeClones: true }).install();
    let submitted, ended;
    const { counts } = await probe.measure(async () => {
      submitted = await port.submit('generation', { count: callCount });
      ended = await port.wait(submitted.jobId);
    });
    probe.uninstall();

    const persisted = await store.load();
    assert.doesNotThrow(() => validateStoredJob(persisted));
    assert.doesNotThrow(() => acceptedByRelease271(structuredClone(persisted)), `manifest at ${callCount} calls stays readable by release 2.7.1`);

    const manifestBytes = (await stat(manifestFile)).size;
    const mem = await settledHeap();

    // Measure cold-start restore into a brand-new lifecycle instance.
    const coldWork = createRuntimeWork();
    const coldLifecycle = createJobLifecycle(dir, coldWork);
    coldLifecycle.register(ctx, 'gen.v1', {
      kind: 'generation',
      version: 1,
      capabilities: { cancel: true, pauseMode: 'checkpoint', recoveryMode: 'resume-checkpoint', retry: true, set: false, executionModes: ['direct'] },
      persistence: {
        open: async () => ({
          store,
          inputRef: { id: `in-${callCount}`, hash: 'sha256:abc', size: callCount },
          validateInput: async () => {},
          validateCheckpoint: async () => {},
          reconcileCommit: async commit => commit.receipt || { ok: true },
          replayCall: async () => {},
        }),
      },
      run: async () => ({ refs: [], completeness: 'complete' }),
    });
    const coldPort = coldLifecycle.scoped({ owner, domain: 'gen.v1', executor: dshJobExecutor(host, agent) });
    const restoreProbe = new Probe({ sizeClones: true }).install();
    const restoreStarted = performance.now();
    const { value: restored, counts: restoreCounts } = await restoreProbe.measure(() => coldPort.restore('generation', { count: callCount }));
    const restoreMs = +(performance.now() - restoreStarted).toFixed(2);
    restoreProbe.uninstall();

    await coldLifecycle.dispose();
    await lifecycle.dispose();
    await ctx.fiber.dispose();

    return {
      callCount,
      ended,
      restored,
      persisted,
      manifestBytes,
      restoreMs,
      restoreParsedChars: restoreCounts.jsonParseChars,
      heapUsedMb: +mem.heapUsed.toFixed(2),
      clonedCharsPerCall: Math.round(counts.structuredCloneChars / callCount),
      stringifiedCharsPerCall: Math.round(counts.jsonStringifyChars / callCount),
      jsonStringifyCalls: counts.jsonStringifyCalls,
    };
  }

  const r100 = await runDurableScaledJob(100);
  const r1000 = await runDurableScaledJob(1000);
  const r5000 = await runDurableScaledJob(5000);

  t.diagnostic(`long-job scaling (100 / 1000 / 5000): ${JSON.stringify({
    100: { retainedCalls: r100.ended.calls.length, retainedSteps: r100.ended.runtime.steps.length, manifestBytes: r100.manifestBytes, clonedPerCall: r100.clonedCharsPerCall, restoreParsedChars: r100.restoreParsedChars, restoreMs: r100.restoreMs, heapMb: r100.heapUsedMb },
    1000: { retainedCalls: r1000.ended.calls.length, retainedSteps: r1000.ended.runtime.steps.length, manifestBytes: r1000.manifestBytes, clonedPerCall: r1000.clonedCharsPerCall, restoreParsedChars: r1000.restoreParsedChars, restoreMs: r1000.restoreMs, heapMb: r1000.heapUsedMb },
    5000: { retainedCalls: r5000.ended.calls.length, retainedSteps: r5000.ended.runtime.steps.length, manifestBytes: r5000.manifestBytes, clonedPerCall: r5000.clonedCharsPerCall, restoreParsedChars: r5000.restoreParsedChars, restoreMs: r5000.restoreMs, heapMb: r5000.heapUsedMb },
  })}`);

  for (const r of [r100, r1000, r5000]) {
    assert.equal(r.ended.status, 'complete');
    assert.ok(r.ended.calls.length <= MAX_CALLS, `${r.callCount} calls retained <= ${MAX_CALLS} calls, got ${r.ended.calls.length}`);
    assert.ok(r.ended.runtime.steps.length <= MAX_CALLS + 2, `${r.callCount} calls retained bounded steps, got ${r.ended.runtime.steps.length}`);
    // Exact token and call accounting preserved across all 5,000 calls!
    assert.equal(r.ended.usage.calls, r.callCount, `exact call count preserved at ${r.callCount}`);
    assert.equal(r.ended.usage.tokens, r.callCount * 135, `exact total tokens preserved at ${r.callCount}`);
    assert.equal(r.restored.usage.calls, r.callCount, `cold restore preserves exact call count at ${r.callCount}`);
    assert.equal(r.restored.usage.tokens, r.callCount * 135, `cold restore preserves exact token usage at ${r.callCount}`);
    assert.ok(r.manifestBytes <= 320_000, `persisted manifest at ${r.callCount} calls stays bounded (${r.manifestBytes} bytes <= 320 KB)`);
    assert.ok(r.restoreParsedChars <= 960_000, `cold-start restore at ${r.callCount} calls parses bounded JSON (${r.restoreParsedChars} chars <= 960 KB)`);
    assert.ok(r.restoreMs < 5000, `cold-start restore at ${r.callCount} calls completed in ${r.restoreMs} ms (< 5000 ms ceiling)`);
  }
  // Without history compaction, manifestBytes, restoreParsedChars, and clonedCharsPerCall at 5,000 calls would be ~16.6x larger than at 300 calls;
  // with bounded 300-entry sliding window, 5,000-call manifest & cold-restore size stay within 1.25x of 1,000-call size!
  assert.ok(r5000.manifestBytes <= r1000.manifestBytes * 1.25, `5000-call manifest (${r5000.manifestBytes}) stays flat vs 1000-call (${r1000.manifestBytes})`);
  assert.ok(r5000.restoreParsedChars <= r1000.restoreParsedChars * 1.25, `5000-call cold restore (${r5000.restoreParsedChars}) stays flat vs 1000-call (${r1000.restoreParsedChars})`);
  assert.ok(r5000.clonedCharsPerCall <= r1000.clonedCharsPerCall * 1.35, `per-call clone cost stays O(1) bounded (${r5000.clonedCharsPerCall} vs ${r1000.clonedCharsPerCall})`);

  // Verify #845 AC3: an unknown remote side-effect outcome (`pending` requestIntent) is NEVER evicted even after 400 more calls,
  // blocking blind retry on recovery!
  {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const dir = join(base, 'pending-intent-safety');
    await mkdir(dir, { recursive: true });
    const manifestFile = join(dir, 'manifest.json');
    await writeFile(manifestFile, JSON.stringify({ id: 'm-intent' }), 'utf8');
    const store = createManifestJobStore(manifestFile);
    const ctx = new Context(), work = createRuntimeWork(), lifecycle = createJobLifecycle(dir, work), owner = Symbol('intent-owner');
    const agent = { id: 'intent-agent' };
    const host = {
      get: key => key === 'agents'
        ? { get: id => (id === agent.id ? agent : undefined) }
        : key === 'jobs'
          ? { start(spec) { spec.run({ id: 'h-i' }); return 'h-i'; }, kill() {}, readAt() { return { chunks: [] }; } }
          : undefined,
    };
    lifecycle.register(ctx, 'gen.v1', {
      kind: 'generation',
      version: 1,
      capabilities: { cancel: true, pauseMode: 'unsupported', recoveryMode: 'retry-from-start', retry: true, set: false, executionModes: ['direct'] },
      persistence: {
        open: async () => ({
          store,
          inputRef: { id: 'in-intent', hash: 'sha256:1', size: 1 },
          validateInput: async () => {},
          validateCheckpoint: async () => {},
          reconcileCommit: async () => ({ ok: true }),
          replayCall: async () => {},
        }),
      },
      run: async context => {
        // Call #1: side-effecting external request whose remote outcome is unknown!
        const s0 = context.gateway.step('remote:create', policy);
        await s0.run(() => s0.observe(
          { boundary: 'external-request', kind: 'author', sideEffect: true },
          async () => ({ value: null, status: 502, remoteResultUnknown: true }),
        ));
        // Followed by 360 completed side-effecting calls (> 300 cap) in waves of 120.
        for (let b = 0; b < 360; b += 120) {
          const wave = [];
          for (let i = b + 1; i <= b + 120; i++) {
            const step = context.gateway.step(`follow:${i}`, policy);
            wave.push(step.run(() => step.observe(
              { boundary: 'external-request', kind: 'author', sideEffect: true },
              async () => ({ value: 'ok', status: 200 }),
            )));
          }
          await Promise.all(wave);
        }
        throw new Error('stopped after unknown side effect');
      },
    });
    const port = lifecycle.scoped({ owner, domain: 'gen.v1', executor: dshJobExecutor(host, agent) });
    const job = await port.submit('generation', {});
    const failed = await port.wait(job.jobId);
    assert.equal(failed.status, 'failed');

    const saved = await store.load();
    assert.doesNotThrow(() => acceptedByRelease271(structuredClone(saved)));
    assert.equal(saved.requestIntents.filter(i => i.status === 'pending').length, 1, 'pending intent was preserved across 360+ subsequent intents');
    await assert.rejects(() => port.control(job.jobId, 'retry'), { code: 'remote-result-unknown' });

    await lifecycle.dispose();
    await ctx.fiber.dispose();
  }
});

test('polling snapshot during a 100-call and 600-call active job stays within strict structuredClone char budgets', async t => {
  const base = await createTempRoot(t, 'snapshot-job-budget-');
  const root = join(base, 'lib');
  await seedLibrary(root, { sources: 30, decks: 3, cardsPerDeck: 15, runs: 2, attempts: 50, courses: 2 });
  const service = new StudyService(root);
  t.after(() => service.dispose());

  // Seed an active generation job on this library that has already accumulated 100 steps, then 600 steps via compactJobSteps.
  const job = {
    id: 'gen-long-active',
    root,
    type: 'generate',
    status: 'running',
    stage: '正在出题',
    startedAt: new Date().toISOString(),
    requestedTotal: 120,
    savedCount: 45,
    steps: [],
    events: [],
    waits: [],
  };
  for (let i = 1; i <= 100; i++) {
    job.steps.push({
      id: `step-${i}`,
      stage: 'authoring',
      kind: i % 3 === 0 ? 'review' : 'author',
      part: i,
      status: i === 100 ? 'running' : 'complete',
      startedAt: new Date().toISOString(),
      ...(i < 100 ? { finishedAt: new Date().toISOString() } : {}),
      tokenUsage: { uncachedInputTokens: 200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 },
    });
    compactJobSteps(job);
  }
  service.runtime.work.jobs.set(job.id, job);

  const probe = new Probe({ sizeClones: true }).install();
  t.after(() => probe.uninstall());

  const initialSnap = await service.call('snapshot');
  const activeRow100 = initialSnap.jobs.find(r => r.id === job.id);
  assert.ok(activeRow100, 'active job appears in snapshot');
  assert.equal(activeRow100.contract.calls.length, 100);

  // Measure an unchanged snapshot poll during the 100-call active job.
  const poll100 = await probe.measure(() => service.call('snapshot', { since: initialSnap.fingerprint }));
  assert.equal(poll100.value.unchanged, true);
  assert.equal(poll100.counts.jsonParseChars, 0);
  assert.ok(poll100.counts.structuredCloneChars <= 60_000, `100-call unchanged snapshot poll cloned ${poll100.counts.structuredCloneChars} chars; budget <= 60,000`);

  // Advance the job to 600 calls (599 complete + 1 running) and verify both stage progress accuracy and bounded clone cost!
  job.steps.at(-1).status = 'complete';
  job.steps.at(-1).finishedAt = new Date().toISOString();
  for (let i = 101; i <= 600; i++) {
    job.steps.push({
      id: `step-${i}`,
      stage: 'authoring',
      kind: i % 3 === 0 ? 'review' : 'author',
      part: i,
      status: i === 600 ? 'running' : 'complete',
      startedAt: new Date().toISOString(),
      ...(i < 600 ? { finishedAt: new Date().toISOString() } : {}),
      tokenUsage: { uncachedInputTokens: 200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 },
    });
    compactJobSteps(job);
  }
  assert.ok(job.steps.length <= MAX_CALLS, `in-memory job.steps capped at <= ${MAX_CALLS}, got ${job.steps.length}`);
  const snapView600 = snapshotJob(job);
  const segAuthor = snapView600.contract.progress.segments.find(s => s.stage === 'author');
  const segReview = snapView600.contract.progress.segments.find(s => s.stage === 'review');
  assert.equal(segAuthor.total + segReview.total, 600, 'archivedStageCounts preserves exact 600-call stage totals');
  assert.equal(segAuthor.done + segReview.done, 599, 'archivedStageCounts preserves exact 599 completed stage counts');

  const poll600 = await probe.measure(() => service.call('snapshot', { since: initialSnap.fingerprint }));
  t.diagnostic(`snapshot poll clone chars: 100-call=${poll100.counts.structuredCloneChars}, 600-call=${poll600.counts.structuredCloneChars}`);
  assert.equal(poll600.value.unchanged, true);
  assert.ok(poll600.counts.structuredCloneChars <= 160_000, `600-call unchanged snapshot poll cloned ${poll600.counts.structuredCloneChars} chars; budget <= 160,000`);
});

test('cancellation teardown budget: queued, running, cancelOwner, late-write fence, refused stop, and redacted diagnostics', async t => {
  const base = await createTempRoot(t, 'cancel-teardown-budget-');
  const root = join(base, 'cancel-lib');
  await seedLibrary(root, { sources: 8, decks: 2, cardsPerDeck: 8, runs: 1, attempts: 10, courses: 1 });

  const owner = Symbol('session-owner');
  const secretToken = 'sk-secret-credential-998877';
  const sensitivePrompt = 'CONFIDENTIAL_PROMPT_TEXT_DO_NOT_LOG';
  const ctx = new Context();

  // Host double supporting both queued (never-entered) jobs and running jobs, plus a refused-stop mode.
  const agent = { id: 'cancel-agent' };
  const hostJobs = new Map();
  let nextHostId = 0;
  let queueHold = false;
  let refuseKill = false;
  const host = {
    get: key => key === 'agents'
      ? { get: id => (id === agent.id ? agent : undefined) }
      : key === 'jobs'
        ? {
          start(spec) {
            const id = `dsh-job-${++nextHostId}`;
            if (queueHold) {
              hostJobs.set(id, { queued: true, spec });
              return id;
            }
            const hooks = spec.run({ id });
            hostJobs.set(id, { queued: false, hooks });
            return id;
          },
          kill(id, _ownerId, reason) {
            if (refuseKill) throw new Error('executor transport refused stop');
            const item = hostJobs.get(id);
            if (!item) return;
            if (item.queued) {
              hostJobs.delete(id);
              return;
            }
            item.hooks?.cancel?.(reason || 'killed');
          },
          readAt() { return { chunks: [] }; },
        }
        : undefined,
  };

  const service = new StudyService(root, {
    workOwner: owner,
    jobExecutor: dshJobExecutor(host, agent),
    apiKey: secretToken,
  });
  const runtime = service.runtime;
  t.after(async () => { await service.dispose(); await ctx.fiber.dispose(); });

  const releaseRunning = Promise.withResolvers();
  const enteredRunning = Promise.withResolvers();
  let lateWriteError = null;

  runtime.register({
    id: 'benchprobe',
    collections: [{ name: 'benchItems', mode: 'item' }],
    operations: {
      submit: (_args, context) => context.jobs.submit('work', { prompt: sensitivePrompt }),
      writeItem: (_args, context) => context.state.update(state => {
        state.benchItems.push({ id: 'late-1', text: 'should never land' });
        return { ok: true };
      }),
    },
  });
  runtime.registerJob(ctx, 'benchprobe.v1', {
    kind: 'work',
    version: 1,
    title: sensitivePrompt,
    run: async context => {
      enteredRunning.resolve(context);
      await releaseRunning.promise;
      // Attempt a late write to Store after owner cancellation was requested!
      try {
        await runtime.call('benchprobe.writeItem', {}, { workOwner: owner });
      } catch (err) {
        lateWriteError = err;
      }
      context.signal.throwIfAborted();
      return { refs: [] };
    },
  });

  // 1. Submit a running job (with executionTimeoutMs timer) AND a queued job (held in external queue with queueTimeoutMs timer),
  // plus a pending prep timer on runtime.work.prepPending.
  const runningSubmitted = await runtime.call('benchprobe.submit', {}, {
    workOwner: owner,
    jobExecutor: dshJobExecutor(host, agent),
  });
  await enteredRunning.promise;

  queueHold = true;
  const queuedSubmitted = await runtime.call('benchprobe.submit', {}, {
    workOwner: owner,
    jobExecutor: dshJobExecutor(host, agent),
  });
  queueHold = false;
  assert.equal(queuedSubmitted.status, 'queued');

  const prepTimer = setTimeout(() => {}, 60_000);
  const { ownWork } = await import('../lib/runtime/work-ownership.js');
  runtime.work.prepPending.set('prep-1', ownWork({ timer: prepTimer }, owner));

  const revBeforeCancel = (await service.store.read()).revision;
  const probe = new Probe().install();
  t.after(() => probe.uninstall());

  // 2. Trigger cancelOwner(owner): distinguish immediate "cancel requested" (`cancelling`, not yet settled)
  // from "actual resource release" (`settled === true` after producer cleanup finishes)!
  let cancelSettled = false;
  const cancelStarted = performance.now();
  const cancellingPromise = runtime.cancelOwner(owner).then(() => { cancelSettled = true; });

  const midDiag = runtime.diagnostics();
  assert.equal(cancelSettled, false, 'cancelOwner waits for in-flight producer cleanup before resolving');
  assert.equal(midDiag.prepTimers, 0, 'prepPending timer cleared immediately on cancelOwner');
  const queuedMid = midDiag.jobs.jobs.find(j => j.jobId === queuedSubmitted.jobId);
  assert.equal(queuedMid.status, 'cancelled', 'queued unstarted job cancelled immediately without hanging');
  assert.equal(queuedMid.activeTimers, 0, 'queued job left zero timers behind');
  const runningMid = midDiag.jobs.jobs.find(j => j.jobId === runningSubmitted.jobId);
  assert.equal(runningMid.status, 'cancelling', 'running job reports cancelling until physical cleanup finishes');
  assert.ok(runningMid.cancelRequestedAt, 'cancelRequestedAt timestamp recorded');

  // Release the running producer after 15ms; it tries a late Store write, which must be fenced!
  await new Promise(resolve => setTimeout(resolve, 15));
  const { counts: lateCounts } = await probe.measure(async () => {
    releaseRunning.resolve();
    await cancellingPromise;
  });
  probe.uninstall();
  const cancelElapsedMs = performance.now() - cancelStarted;

  assert.equal(cancelSettled, true);
  assert.ok(cancelElapsedMs < 500, `cancelOwner settled within teardown budget (${cancelElapsedMs.toFixed(1)} ms < 500 ms)`);
  assert.match(String(lateWriteError?.message || ''), /Work owner unloaded/, 'late Store write after cancelOwner was fenced');
  assert.equal(lateCounts.shardWrites, 0, 'zero shard writes occurred after cancelOwner');
  assert.equal(lateCounts.manifestWrites, 0, 'zero manifest writes occurred after cancelOwner');
  assert.equal((await service.store.read()).revision, revBeforeCancel, 'Store revision stayed unchanged after cancelOwner');

  const settledDiag = runtime.diagnostics();
  t.diagnostic(`settled cancellation diagnostics: ${JSON.stringify(settledDiag)}`);
  assert.equal(settledDiag.jobs.activeJobs, 0, 'zero active jobs after settlement');
  assert.equal(settledDiag.jobs.activeTimers, 0, 'zero active job timers after settlement');
  assert.equal(settledDiag.settledWaiters, 0, 'zero stranded settled waiters');
  assert.ok(settledDiag.lastCancelMs >= 0);
  const runningAfter = settledDiag.jobs.jobs.find(j => j.jobId === runningSubmitted.jobId);
  assert.equal(runningAfter.status, 'cancelled');
  assert.ok(runningAfter.cancelSettleMs >= 5, `cancelSettleMs distinguishes request from actual release (${runningAfter.cancelSettleMs} ms)`);

  // Redaction check (#845 AC5): diagnostics must NEVER leak credentials, prompts, titles, or filesystem paths!
  const diagJson = JSON.stringify(settledDiag);
  assert.ok(!diagJson.includes(secretToken), 'diagnostics never include credentials');
  assert.ok(!diagJson.includes(sensitivePrompt), 'diagnostics never include prompts or user prose');
  assert.ok(!diagJson.includes(root), 'diagnostics never include library filesystem paths');

  // 3. Refused-stop state (#845 AC4): when executor.kill throws, stopConfirmation === 'unknown' is surfaced until producer exits cleanly.
  const owner2 = Symbol('refused-stop-owner');
  const heldRefused = Promise.withResolvers(), startedRefused = Promise.withResolvers();
  runtime.register({
    id: 'refuseprobe',
    operations: {
      submit: (_args, context) => context.jobs.submit('refusable', {}),
      control: (args, context) => context.jobs.control(args.jobId, 'cancel'),
    },
  });
  runtime.registerJob(ctx, 'refuseprobe.v1', {
    kind: 'refusable',
    version: 1,
    run: async context => {
      startedRefused.resolve(context);
      await heldRefused.promise;
      context.signal.throwIfAborted();
      return { refs: [] };
    },
  });
  const refusedJob = await runtime.call('refuseprobe.submit', {}, { workOwner: owner2, jobExecutor: dshJobExecutor(host, agent) });
  await startedRefused.promise;
  refuseKill = true;
  await runtime.call('refuseprobe.control', { jobId: refusedJob.jobId }, { workOwner: owner2, jobExecutor: dshJobExecutor(host, agent) });
  refuseKill = false;

  const refusedMid = runtime.diagnostics();
  assert.equal(refusedMid.jobs.stopRefusedJobs, 1, 'diagnostics flags refused-stop job while cancelling');
  const refusedEntry = refusedMid.jobs.jobs.find(j => j.jobId === refusedJob.jobId);
  assert.equal(refusedEntry.status, 'cancelling');
  assert.equal(refusedEntry.stopConfirmation, 'unknown');

  heldRefused.resolve();
  await runtime.cancelOwner(owner2);
  const afterRefused = runtime.diagnostics();
  assert.equal(afterRefused.jobs.activeJobs, 0);
  assert.equal(afterRefused.jobs.activeTimers, 0);
  assert.equal(afterRefused.settledWaiters, 0);
  void hostJobExecutor;
});
