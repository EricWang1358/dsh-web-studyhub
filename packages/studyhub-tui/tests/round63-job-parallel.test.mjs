// Round 63 Track 1: TasksView [P] job.parallel (run queued background job in parallel immediately, 0 LLM tokens)
// `node --test --test-concurrency=1 tests/round63-job-parallel.test.mjs`
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

// Canonical dist chunk discovery
const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let createTuiHost = null;
let saveTuiPreferences = null;
let displayWidth = null;
let useTuiStore = null;
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
    if (!DEFAULT_PREFERENCES && mod.DEFAULT_PREFERENCES) DEFAULT_PREFERENCES = mod.DEFAULT_PREFERENCES;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round63-parallel-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

function resetDistStore(language = 'zh', asciiMode = false, extra = {}) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    loading: false,
    refreshing: false,
    toasts: [],
    footerHints: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    activeRunId: null,
    preferences: {
      ...DEFAULT_PREFERENCES,
      language,
      asciiMode,
    },
    ...extra,
  });
}

function clearStoreToasts() {
  const st = useTuiStore.getState();
  for (const toast of [...st.toasts]) {
    st.dismissToast(toast.id);
  }
}

function createVirtualTty(cols = 120, rows = 36) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 24;

  const stderr = new PassThrough();
  stderr.isTTY = true;
  stderr.columns = cols;
  stderr.rows = rows;

  const term = new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    convertEol: true,
  });

  let pendingWrites = Promise.resolve();
  let firstFrameResolve = null;
  let firstFrameSettled = false;
  const firstFramePromise = new Promise((resolveFn) => {
    firstFrameResolve = resolveFn;
  });

  stdout.on('data', (chunk) => {
    const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    pendingWrites = pendingWrites.then(
      () =>
        new Promise((resolveWrite) => {
          term.write(str, () => {
            if (!firstFrameSettled) {
              firstFrameSettled = true;
              firstFrameResolve?.();
            }
            resolveWrite();
          });
        }),
    );
  });

  async function flush() {
    await sleep(30);
    await pendingWrites;
  }

  function readLines() {
    const buf = term.buffer.active;
    const lines = [];
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  function readScreen() {
    return readLines().join('\n');
  }

  function send(data) {
    stdin.write(data);
  }

  async function waitFor(predicate, { timeoutMs = 10_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await flush();
      const screen = readScreen();
      if (predicate(screen)) return screen;
      await sleep(30);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function assertHealthyScreen(screen, expectedCols, expectedRows, label) {
    const lines = screen.split('\n');
    assert.ok(lines.length <= expectedRows, `${label}: row count ${lines.length} > ${expectedRows}`);
    assert.ok(!screen.includes('页面渲染异常') && !screen.includes('View Error'), `${label}: error boundary triggered`);
    assert.ok(!screen.includes('TypeError:') && !screen.includes('ReferenceError:'), `${label}: runtime JS error`);
    assert.ok(!/\bNaN\b/.test(screen), `${label}: raw NaN leaked`);
    assert.ok(!/\bundefined\b/.test(screen), `${label}: raw undefined leaked`);
    assert.ok(!screen.includes('[object Object]'), `${label}: raw [object Object] leaked`);
    assert.ok(!screen.includes('\uFFFD'), `${label}: replacement char U+FFFD leaked`);
    for (let i = 0; i < lines.length; i += 1) {
      const w = displayWidth(lines[i]);
      assert.ok(w <= expectedCols, `${label}: row ${i} width ${w} > ${expectedCols}: ${JSON.stringify(lines[i])}`);
    }
    const buf = term.buffer.active;
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      if (line) {
        assert.equal(
          line.isWrapped,
          false,
          `${label}: xterm soft-wrapped row ${y}: ${JSON.stringify(line.translateToString(true))}`,
        );
      }
    }
  }

  function assertAsciiPure(screen, label) {
    const matches = screen.match(UNICODE_UI_CHROME_RE);
    assert.ok(!matches, `${label}: leaked non-ASCII UI chrome: ${JSON.stringify([...new Set(matches || [])])}\n${screen}`);
  }

  return {
    stdin,
    stdout,
    stderr,
    firstFramePromise,
    flush,
    readScreen,
    send,
    waitFor,
    assertHealthyScreen,
    assertAsciiPure,
    dispose: () => {
      term.dispose();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

function buildSampleDoc(tag) {
  const paras = Array.from(
    { length: 8 },
    (_, i) => `Section ${i + 1} (${tag}): Distributed consensus relies on quorum overlap and monotonic term numbers.`,
  );
  return `# Notes ${tag}\n\n${paras.join('\n\n')}\n`;
}

function createDeferredStub() {
  const entered = [];
  const gates = [];

  const complete = async (_system, prompt, execution = {}) => {
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    let parsed = null;
    try {
      parsed = JSON.parse(p);
    } catch {
      return JSON.stringify({ cards: [] });
    }
    if (!Array.isArray(parsed?.passages)) {
      return JSON.stringify({ ok: true });
    }
    const idx = entered.length + 1;
    let resolveGate = null;
    const gate = new Promise((resolve) => {
      resolveGate = resolve;
      execution.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    gates.push(resolveGate);
    entered.push({ idx, jobId: execution.jobId });
    await gate;
    execution.signal?.throwIfAborted?.();
    return JSON.stringify({
      translations: parsed.passages.map((passage) => ({
        id: passage.id,
        text: `译文(${passage.id})`,
      })),
    });
  };

  return {
    complete,
    getEnteredCount: () => entered.length,
    getEntered: () => [...entered],
    releaseAll: () => {
      while (gates.length > 0) gates.shift()?.();
    },
  };
}

async function pollUntil(predicate, { timeoutMs = 8000, intervalMs = 30, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function createMockJobsHost(innerHost, initialJobs, { zhNote = true } = {}) {
  const jobs = initialJobs.map((j) => structuredClone(j));
  const parallelCalls = [];

  const wrapResult = (res) => {
    if (!res?.ok || !res.value || typeof res.value !== 'object') return res;
    return {
      ...res,
      value: {
        ...res.value,
        jobs: jobs.map((j) => structuredClone(j)),
      },
    };
  };

  const wrappedHost = {
    ...innerHost,
    refreshSnapshot: async (args = {}) => {
      const snap = await innerHost.refreshSnapshot(args);
      return {
        ...snap,
        snapshot: snap.snapshot
          ? {
              ...snap.snapshot,
              jobs: jobs.map((j) => structuredClone(j)),
            }
          : snap.snapshot,
      };
    },
    call: async (action, args = {}) => {
      if (action === 'snapshot') {
        const res = await innerHost.call(action, args);
        return wrapResult(res);
      }
      if (action === 'job.live.list') {
        return {
          ok: true,
          value: { jobs: jobs.map((j) => structuredClone(j)) },
        };
      }
      if (action === 'job.output') {
        return { ok: true, value: { supported: false, text: '' } };
      }
      if (action === 'job.trace') {
        return { ok: true, value: { calls: [] } };
      }
      if (action === 'job.parallel') {
        parallelCalls.push({ jobId: args?.jobId });
        const target = jobs.find((j) => j.id === args?.jobId || j.contract?.jobId === args?.jobId);
        if (!target) {
          return { ok: false, error: { code: 'NOT_FOUND', message: `Study job not found: ${args?.jobId}` } };
        }
        if (target.status !== 'queued') {
          return {
            ok: false,
            error: {
              code: 'job-ended',
              message: zhNote
                ? '这个任务已经结束，不能再要求并行。'
                : 'This job has already ended and cannot be started in parallel.',
            },
          };
        }
        target.status = 'running';
        target.phase = zhNote ? '并行执行中' : 'Running in parallel';
        if (target.contract) {
          target.contract.status = 'running';
          target.contract.actions = {
            ...target.contract.actions,
            parallel: { available: false, reason: { code: 'already-parallel' } },
          };
        }
        return {
          ok: true,
          value: {
            jobId: target.id,
            attemptId: target.id,
            action: 'parallel',
            parallel: true,
            status: 'running',
            ...(zhNote ? { note: '已要求并行：这个任务现在就开始，不再等前面的任务。' } : {}),
          },
        };
      }
      return innerHost.call(action, args);
    },
  };

  return {
    host: wrappedHost,
    parallelCalls,
  };
}

describe('Round 63 Track 1: TasksView [P] job.parallel integration & PTY E2E', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration (0 real model calls): unknown jobId error + real queued job promotion via job.parallel', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    const stub = createDeferredStub();

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: stub.complete,
      skipAutoProbe: true,
      language: 'zh',
    });

    try {
      // 1a. Normalized error for unknown / missing jobId (0 stub calls)
      const unknownRes = await host.call('job.parallel', { jobId: 'unknown-job-r63' });
      assert.equal(unknownRes.ok, false);
      assert.ok(unknownRes.error?.message && unknownRes.error.message.toLowerCase().includes('not found'));
      assert.equal(stub.getEnteredCount(), 0);

      const emptyRes = await host.call('job.parallel', {});
      assert.equal(emptyRes.ok, false);
      assert.ok(typeof emptyRes.error?.message === 'string' && emptyRes.error.message.length > 0);
      assert.equal(stub.getEnteredCount(), 0);

      // 1b. Seed two documents & enqueue two translation jobs so job2 sits queued behind job1
      const imp1 = await host.call('materials.document.import', {
        filename: 'doc1.md',
        dataBase64: Buffer.from(buildSampleDoc('doc1')).toString('base64'),
      });
      assert.equal(imp1.ok, true, imp1.error?.message);

      const imp2 = await host.call('materials.document.import', {
        filename: 'doc2.md',
        dataBase64: Buffer.from(buildSampleDoc('doc2')).toString('base64'),
      });
      assert.equal(imp2.ok, true, imp2.error?.message);

      const start1 = await host.call('generation.translation.start', {
        documentId: imp1.value.documentId,
        scope: { sourceIds: [imp1.value.document.sources[0].id] },
        target: 'zh',
        concurrency: 1,
      });
      assert.equal(start1.ok, true, start1.error?.message);
      const job1Id = start1.value.jobId;

      await pollUntil(() => stub.getEnteredCount() >= 1, { label: 'job1 enters deferred stub' });

      const start2 = await host.call('generation.translation.start', {
        documentId: imp2.value.documentId,
        scope: { sourceIds: [imp2.value.document.sources[0].id] },
        target: 'zh',
        concurrency: 1,
      });
      assert.equal(start2.ok, true, start2.error?.message);
      const job2Id = start2.value.jobId;

      const queuedSnap = await pollUntil(
        async () => {
          const s = await host.call('snapshot', {});
          const row = (s.value?.jobs || []).find((j) => j.id === job2Id || j.contract?.jobId === job2Id);
          return row?.status === 'queued' && row?.contract?.actions?.parallel?.available === true ? row : null;
        },
        { label: 'job2 queued with actions.parallel.available=true' },
      );
      assert.equal(queuedSnap.contract.actions.parallel.available, true);
      assert.equal(stub.getEnteredCount(), 1, 'queued job2 must not start before job.parallel');

      // Running job1 must be refused cleanly
      const refuseRunning = await host.call('job.parallel', { jobId: job1Id });
      assert.equal(refuseRunning.ok, false);
      assert.ok(refuseRunning.error?.message && refuseRunning.error.message.includes('已经开始'));

      // Promote queued job2 with real job.parallel
      const promoted = await host.call('job.parallel', { jobId: job2Id });
      assert.equal(promoted.ok, true, promoted.error?.message);
      assert.equal(promoted.value.jobId, job2Id);
      assert.equal(promoted.value.parallel, true);
      assert.equal(promoted.value.status, 'running');
      assert.ok(typeof promoted.value.note === 'string' && promoted.value.note.includes('并行'));

      await pollUntil(() => stub.getEnteredCount() >= 2, { label: 'job2 starts immediately in parallel' });

      // Cancel and release cleanly so no dangling promises remain before dispose
      await host.call('job.cancel', { jobId: job1Id });
      await host.call('job.cancel', { jobId: job2Id });
      stub.releaseAll();
      await sleep(50);
    } finally {
      stub.releaseAll();
      await host.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): TasksView [P] promotes queued job & warns gracefully on completed job', async () => {
    const base = await makeTempDir('pty-zh');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: false });
    resetDistStore('zh', false);

    let modelCalls = 0;
    const rawHost = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Must not call model in PTY E2E');
      },
      skipAutoProbe: true,
      language: 'zh',
    });

    const sampleRes = await rawHost.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, sampleRes.error?.message);

    // Note: TasksView reverses activeAndRecent, so last item is selected first (index 0)
    const { host, parallelCalls } = createMockJobsHost(
      rawHost,
      [
        {
          id: 'job-done-1',
          title: 'R63 已完成任务',
          type: 'generation',
          status: 'complete',
          progress: 1,
          phase: '已完成',
          startedAt: '2026-11-22T10:00:00.000Z',
          finishedAt: '2026-11-22T10:01:00.000Z',
          calls: [],
          contract: {
            jobId: 'job-done-1',
            status: 'complete',
            actions: { parallel: { available: false, reason: { code: 'job-ended' } } },
          },
        },
        {
          id: 'job-queued-1',
          title: 'R63 排队出题任务',
          type: 'generation',
          status: 'queued',
          progress: 0,
          phase: '排队等待中',
          startedAt: '2026-11-22T10:02:00.000Z',
          calls: [],
          contract: {
            jobId: 'job-queued-1',
            status: 'queued',
            actions: { parallel: { available: true } },
          },
        },
      ],
      { zhNote: true },
    );

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('学习库') || s.includes('Memento'), { label: 'Initial zh render' });

      tty.send('t');
      const tasksScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'tasks' &&
          s.includes('R63 排队出题任务') &&
          s.includes('立即并行'),
        { label: 'TasksView zh with queued job and [P] 立即并行 hint' },
      );
      tty.assertHealthyScreen(tasksScreen, 120, 36, 'TasksView zh queued 120x36');

      // Press 'P' on selected queued job -> invokes job.parallel with exact jobId & renders success toast
      clearStoreToasts();
      tty.send('P');
      const successScreen = await tty.waitFor(
        (s) =>
          parallelCalls.some((c) => c.jobId === 'job-queued-1') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已要求并行')) &&
          s.includes('已要求并行'),
        { label: 'TasksView zh [P] success toast' },
      );
      tty.assertHealthyScreen(successScreen, 120, 36, 'TasksView zh after [P] success');

      // Move selection down ('j') to completed job -> press 'P' -> graceful warning toast without crashing
      clearStoreToasts();
      tty.send('j');
      await sleep(80);
      tty.send('P');
      const warnScreen = await tty.waitFor(
        (s) =>
          parallelCalls.some((c) => c.jobId === 'job-done-1') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'warning' && toast.text.includes('不能再要求并行')) &&
          s.includes('不能再要求并行'),
        { label: 'TasksView zh [P] completed job warning toast' },
      );
      tty.assertHealthyScreen(warnScreen, 120, 36, 'TasksView zh after [P] warning');
      assert.equal(modelCalls, 0);
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await rawHost.dispose();
    }
  });

  test('3) @xterm/headless PTY E2E (80x24 --ascii en): TasksView [P] promotes queued job with pure ASCII output', async () => {
    const base = await makeTempDir('pty-ascii-en');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'en', asciiMode: true });
    resetDistStore('en', true);

    let modelCalls = 0;
    const rawHost = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Must not call model in ASCII PTY E2E');
      },
      skipAutoProbe: true,
      language: 'en',
    });

    const sampleRes = await rawHost.call('sample.load', { language: 'en' });
    assert.equal(sampleRes.ok, true, sampleRes.error?.message);

    const { host, parallelCalls } = createMockJobsHost(
      rawHost,
      [
        {
          id: 'job-queued-en',
          title: 'R63 Queued Gen Job',
          type: 'generation',
          status: 'queued',
          progress: 0,
          phase: 'Waiting in queue',
          startedAt: '2026-11-22T10:02:00.000Z',
          calls: [],
          contract: {
            jobId: 'job-queued-en',
            status: 'queued',
            actions: { parallel: { available: true } },
          },
        },
      ],
      { zhNote: false },
    );

    const tty = createVirtualTty(80, 24);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: true }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('Library') || s.includes('StudyHub'), { label: 'Initial ASCII en render' });

      tty.send('t');
      const tasksAscii = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'tasks' &&
          s.includes('R63 Queued Gen Job') &&
          s.includes('Parallel'),
        { label: 'TasksView ASCII en 80x24 with queued job' },
      );
      tty.assertHealthyScreen(tasksAscii, 80, 24, 'TasksView ASCII en 80x24');
      tty.assertAsciiPure(tasksAscii, 'TasksView ASCII en 80x24');

      clearStoreToasts();
      tty.send('P');
      const promotedAscii = await tty.waitFor(
        (s) =>
          parallelCalls.some((c) => c.jobId === 'job-queued-en') &&
          useTuiStore.getState().toasts.some(
            (toast) => toast.tone === 'success' && toast.text.includes('Job promoted to run in parallel'),
          ) &&
          s.includes('Job promoted to run') &&
          s.includes('Active'),
        { label: 'TasksView ASCII en [P] promoted toast' },
      );
      tty.assertHealthyScreen(promotedAscii, 80, 24, 'TasksView ASCII en after [P]');
      tty.assertAsciiPure(promotedAscii, 'TasksView ASCII en after [P]');
      assert.equal(modelCalls, 0);
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await rawHost.dispose();
    }
  });
});
