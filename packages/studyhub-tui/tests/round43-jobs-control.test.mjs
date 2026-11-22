// Round 43 TasksView Job Queue Control (p: pause/resume, +/-: concurrency) Integration & PTY E2E:
// `node --test tests/round43-jobs-control.test.mjs`
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

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let createTuiHost = null;
let saveTuiPreferences = null;
let displayWidth = null;
let useTuiStore = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('chunk-') || f.startsWith('store-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useTuiStore, 'dist/ must export useTuiStore');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round43-jobs-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const UNICODE_UI_CHROME_RE = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;

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

  function resize(newCols, newRows) {
    stdout.columns = newCols;
    stdout.rows = newRows;
    stderr.columns = newCols;
    stderr.rows = newRows;
    term.resize(newCols, newRows);
    stdout.emit('resize');
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
    resize,
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

function buildLongMarkdown() {
  const lines = Array.from(
    { length: 48 },
    (_, i) => `Paragraph ${i + 1} explains an architectural principle and trade-off in distributed systems design.`,
  );
  return `# Distributed Notes\n\n${lines.join('\n\n')}\n`;
}

function createControllableTranslationStub() {
  let heldFirst = true;
  let holdAfterResume = false;
  let releaseFirstFn = null;
  let resolveFirstEntered = null;
  const firstEntered = new Promise((resolve) => {
    resolveFirstEntered = resolve;
  });
  let callCount = 0;
  const waiters = [];

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
    callCount += 1;
    if (callCount === 1) {
      resolveFirstEntered?.();
      if (heldFirst) {
        await new Promise((resolve) => {
          releaseFirstFn = resolve;
          execution.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
    } else if (holdAfterResume) {
      await new Promise((resolve) => {
        waiters.push(resolve);
        execution.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
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
    getCallCount: () => callCount,
    waitForFirstCall: () => firstEntered,
    releaseFirst: () => {
      heldFirst = false;
      releaseFirstFn?.();
      releaseFirstFn = null;
    },
    setHoldAfterResume: (v) => {
      holdAfterResume = v;
    },
    releaseAll: () => {
      heldFirst = false;
      holdAfterResume = false;
      releaseFirstFn?.();
      releaseFirstFn = null;
      while (waiters.length > 0) waiters.shift()?.();
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

describe('Round 43: TasksView job queue control (pause/resume & concurrency)', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: job.control pause -> resume -> set { concurrency } -> invalid patch error -> restore', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    const stub = createControllableTranslationStub();

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: stub.complete,
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const imp = await host.call('materials.document.import', {
        filename: 'notes.md',
        dataBase64: Buffer.from(buildLongMarkdown()).toString('base64'),
      });
      assert.equal(imp.ok, true, imp.error?.message);
      const documentId = imp.value.documentId;
      const sourceId = imp.value.document.sources[0].id;

      const started = await host.call('generation.translation.start', {
        documentId,
        scope: { sourceIds: [sourceId] },
        target: 'zh',
        concurrency: 1,
      });
      assert.equal(started.ok, true, started.error?.message);
      const jobId = started.value.jobId;
      assert.ok(jobId, 'translation jobId must be returned');

      await stub.waitForFirstCall();

      const snapInit = await host.call('snapshot', {});
      assert.equal(snapInit.ok, true);
      const jobRow = (snapInit.value.jobs || []).find((j) => j.id === jobId || j.contract?.jobId === jobId);
      assert.ok(jobRow, 'running translation job must appear in snapshot');
      assert.equal(jobRow.contract?.actions?.pause?.available, true);
      assert.equal(jobRow.contract?.actions?.set?.available, true);
      const concSetting = (jobRow.contract?.actions?.set?.settings || []).find((s) => s.key === 'concurrency');
      assert.ok(concSetting, 'concurrency setting must be exposed in contract');
      assert.equal(concSetting.value, 1);
      assert.equal(concSetting.min, 1);
      assert.equal(concSetting.max, 3);

      // Pause while wave 1 is in flight -> pausing, then release wave 1 -> paused
      const pauseRes = await host.call('job.control', { jobId, action: 'pause' });
      assert.equal(pauseRes.ok, true, pauseRes.error?.message);
      assert.equal(pauseRes.value.action, 'pause');
      assert.equal(pauseRes.value.applied?.paused, true);

      stub.releaseFirst();
      const pausedRow = await pollUntil(
        async () => {
          const s = await host.call('snapshot', {});
          const row = (s.value?.jobs || []).find((j) => j.id === jobId || j.contract?.jobId === jobId);
          return row?.contract?.status === 'paused' ? row : null;
        },
        { label: 'job to reach paused checkpoint' },
      );
      assert.equal(pausedRow.contract.actions.resume.available, true);

      // Resume -> hold subsequent wave so job stays running while we test set + invalid patches
      stub.setHoldAfterResume(true);
      const resumeRes = await host.call('job.control', { jobId, action: 'resume' });
      assert.equal(resumeRes.ok, true, resumeRes.error?.message);
      assert.equal(resumeRes.value.action, 'resume');
      assert.equal(resumeRes.value.applied?.paused, false);

      const resumedRow = await pollUntil(
        async () => {
          const s = await host.call('snapshot', {});
          const row = (s.value?.jobs || []).find((j) => j.id === jobId || j.contract?.jobId === jobId);
          return row?.contract?.status === 'running' ? row : null;
        },
        { label: 'job to resume running' },
      );
      assert.equal(resumedRow.contract.actions.pause.available, true);

      // Set concurrency -> 3
      const setRes = await host.call('job.control', {
        jobId,
        action: 'set',
        patch: { concurrency: 3 },
      });
      assert.equal(setRes.ok, true, setRes.error?.message);
      assert.equal(setRes.value.action, 'set');
      assert.deepEqual(setRes.value.applied, { concurrency: 3 });
      assert.equal(setRes.value.values?.concurrency, 3);

      // Invalid patch errors
      const outOfBounds = await host.call('job.control', {
        jobId,
        action: 'set',
        patch: { concurrency: 99 },
      });
      assert.equal(outOfBounds.ok, false, 'out-of-bounds concurrency must fail');
      assert.match(outOfBounds.error?.message ?? '', /concurrency/i);

      const pausedInSet = await host.call('job.control', {
        jobId,
        action: 'set',
        patch: { paused: true },
      });
      assert.equal(pausedInSet.ok, false, 'paused inside set patch must fail');
      assert.equal(pausedInSet.error?.code, 'unknown-setting');

      const missingPatch = await host.call('job.control', {
        jobId,
        action: 'set',
      });
      assert.equal(missingPatch.ok, false, 'missing patch must fail');

      // Restore concurrency -> 2
      const restoreRes = await host.call('job.control', {
        jobId,
        action: 'set',
        patch: { concurrency: 2 },
      });
      assert.equal(restoreRes.ok, true, restoreRes.error?.message);
      assert.equal(restoreRes.value.values?.concurrency, 2);

      const snapAfter = await host.call('snapshot', {});
      const rowAfter = (snapAfter.value.jobs || []).find((j) => j.id === jobId || j.contract?.jobId === jobId);
      const settingAfter = (rowAfter?.contract?.actions?.set?.settings || []).find((s) => s.key === 'concurrency');
      assert.equal(settingAfter?.value, 2);

      await host.call('job.control', { jobId, action: 'cancel' });
      stub.releaseAll();
      await sleep(50);
    } finally {
      stub.releaseAll();
      await host.dispose();
    }
  });

  test('2) PTY E2E (zh default): TasksView [p] pause/resume & [+]/[-] concurrency at 120x36 & 80x24', async () => {
    const base = await makeTempDir('pty-zh');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    const stub = createControllableTranslationStub();

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: stub.complete,
      skipAutoProbe: true,
      language: 'zh',
    });

    const imp = await host.call('materials.document.import', {
      filename: 'notes-zh.md',
      dataBase64: Buffer.from(buildLongMarkdown()).toString('base64'),
    });
    assert.equal(imp.ok, true, imp.error?.message);

    const started = await host.call('generation.translation.start', {
      documentId: imp.value.documentId,
      scope: { sourceIds: [imp.value.document.sources[0].id] },
      target: 'zh',
      concurrency: 1,
    });
    assert.equal(started.ok, true, started.error?.message);
    const jobId = started.value.jobId;
    await stub.waitForFirstCall();

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
      await tty.waitFor((s) => s.includes('学习库') || s.includes('Library'), { label: 'Initial render' });

      tty.send('t');
      const activeScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'tasks' &&
          s.includes('后台任务') &&
          s.includes('活跃') &&
          s.includes('1x'),
        { label: 'TasksView active job with 活跃 pill and 1x badge' },
      );
      tty.assertHealthyScreen(activeScreen, 120, 36, 'TasksView zh active 120x36');

      // Press 'p' to pause while wave 1 is in flight, then release wave 1 so it reaches paused
      tty.send('p');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('已暂停任务队列')),
        { label: 'Pause toast in zh' },
      );
      stub.releaseFirst();

      const pausedWide = await tty.waitFor(
        (s) => s.includes('已暂停') && s.includes('1x'),
        { label: 'TasksView paused state at 120x36' },
      );
      tty.assertHealthyScreen(pausedWide, 120, 36, 'TasksView zh paused 120x36');

      // Resize to 80x24 while paused
      tty.resize(80, 24);
      const pausedNarrow = await tty.waitFor(
        (s) => s.includes('已暂停') && s.includes('1x') && s.split('\n').length <= 24,
        { label: 'TasksView paused state at 80x24' },
      );
      tty.assertHealthyScreen(pausedNarrow, 80, 24, 'TasksView zh paused 80x24');

      // Hold post-resume calls so wave 2 stays running while testing concurrency controls
      stub.setHoldAfterResume(true);

      // Press 'p' to resume at 80x24
      tty.send('p');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('已恢复任务队列')),
        { label: 'Resume toast in zh' },
      );
      await tty.waitFor((s) => s.includes('活跃') && s.includes('1x'), { label: 'Resumed active pill at 80x24' });

      // Resize back to 120x36 and adjust concurrency with '+' and '-'
      tty.resize(120, 36);
      await tty.waitFor((s) => s.includes('监控后台任务'), { label: 'Restored 120x36' });

      tty.send('+');
      await tty.waitFor(
        (s) =>
          s.includes('2x') &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('并发数已调整为 2x')),
        { label: 'Concurrency increased to 2x' },
      );
      tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'TasksView zh 2x 120x36');

      tty.send('-');
      await tty.waitFor(
        (s) =>
          s.includes('1x') &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('并发数已调整为 1x')),
        { label: 'Concurrency decreased to 1x' },
      );

      // Boundary toast at min (1x)
      tty.send('-');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('并发数已达下限 (1x)')),
        { label: 'Min concurrency boundary toast in zh' },
      );
      tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'TasksView zh min boundary 120x36');

      await host.call('job.control', { jobId, action: 'cancel' });
      stub.releaseAll();
    } finally {
      stub.releaseAll();
      inkInstance?.unmount();
      await sleep(30);
      tty.dispose();
      await host.dispose();
    }
  });

  test('3) PTY E2E (--ascii en): TasksView [p] pause/resume & [+]/[-] concurrency at 120x36 & 80x24', async () => {
    const base = await makeTempDir('pty-ascii');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    const stub = createControllableTranslationStub();

    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: stub.complete,
      skipAutoProbe: true,
      language: 'en',
    });

    const imp = await host.call('materials.document.import', {
      filename: 'notes-en.md',
      dataBase64: Buffer.from(buildLongMarkdown()).toString('base64'),
    });
    assert.equal(imp.ok, true, imp.error?.message);

    const started = await host.call('generation.translation.start', {
      documentId: imp.value.documentId,
      scope: { sourceIds: [imp.value.document.sources[0].id] },
      target: 'zh',
      concurrency: 1,
    });
    assert.equal(started.ok, true, started.error?.message);
    const jobId = started.value.jobId;
    await stub.waitForFirstCall();

    const tty = createVirtualTty(120, 36);
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
      await tty.waitFor((s) => s.includes('Library'), { label: 'Initial ASCII en render' });

      tty.send('t');
      const activeAscii = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'tasks' &&
          s.includes('Monitor jobs') &&
          s.includes('Active') &&
          s.includes('1x'),
        { label: 'ASCII TasksView active with 1x badge' },
      );
      tty.assertHealthyScreen(activeAscii, 120, 36, 'ASCII TasksView active 120x36');
      tty.assertAsciiPure(activeAscii, 'ASCII TasksView active 120x36');

      // Pause via 'p'
      tty.send('p');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Job queue paused')),
        { label: 'ASCII Pause toast' },
      );
      stub.releaseFirst();

      const pausedAscii = await tty.waitFor(
        (s) => s.includes('Paused') && s.includes('1x'),
        { label: 'ASCII TasksView Paused pill at 120x36' },
      );
      tty.assertHealthyScreen(pausedAscii, 120, 36, 'ASCII TasksView paused 120x36');
      tty.assertAsciiPure(pausedAscii, 'ASCII TasksView paused 120x36');

      // Resize to 80x24 and verify ASCII purity + zero overflow
      tty.resize(80, 24);
      const pausedNarrow = await tty.waitFor(
        (s) => s.includes('Paused') && s.includes('1x') && s.split('\n').length <= 24,
        { label: 'ASCII TasksView Paused at 80x24' },
      );
      tty.assertHealthyScreen(pausedNarrow, 80, 24, 'ASCII TasksView paused 80x24');
      tty.assertAsciiPure(pausedNarrow, 'ASCII TasksView paused 80x24');

      // Hold post-resume calls so wave 2 stays running while testing concurrency controls
      stub.setHoldAfterResume(true);

      // Resume via 'p' at 80x24
      tty.send('p');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Job queue resumed')),
        { label: 'ASCII Resume toast' },
      );
      const resumedNarrow = await tty.waitFor(
        (s) => s.includes('Active') && s.includes('1x'),
        { label: 'ASCII Active pill after resume at 80x24' },
      );
      tty.assertHealthyScreen(resumedNarrow, 80, 24, 'ASCII TasksView resumed 80x24');
      tty.assertAsciiPure(resumedNarrow, 'ASCII TasksView resumed 80x24');

      // '+' -> 2x, '-' -> 1x, '-' -> min boundary toast
      tty.send('+');
      await tty.waitFor(
        (s) =>
          s.includes('2x') &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('Concurrency updated to 2x')),
        { label: 'ASCII Concurrency 2x' },
      );
      tty.assertAsciiPure(tty.readScreen(), 'ASCII TasksView 2x 80x24');

      tty.send('-');
      await tty.waitFor(
        (s) =>
          s.includes('1x') &&
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('Concurrency updated to 1x')),
        { label: 'ASCII Concurrency 1x' },
      );

      tty.send('-');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Concurrency already at minimum (1x)')),
        { label: 'ASCII Min concurrency boundary toast' },
      );
      tty.assertHealthyScreen(tty.readScreen(), 80, 24, 'ASCII TasksView min boundary 80x24');
      tty.assertAsciiPure(tty.readScreen(), 'ASCII TasksView min boundary 80x24');

      await host.call('job.control', { jobId, action: 'cancel' });
      stub.releaseAll();
    } finally {
      stub.releaseAll();
      inkInstance?.unmount();
      await sleep(30);
      tty.dispose();
      await host.dispose();
    }
  });
});
