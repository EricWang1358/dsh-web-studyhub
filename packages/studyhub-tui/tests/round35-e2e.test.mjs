// Round 35 TasksView Trace Export (e) & Purge (D) E2E verification:
// node --test tests/round35-e2e.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import { tsImport } from 'tsx/esm/api';

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
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
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

const { exportJobTraceToFile } = await tsImport('../src/views/tasks/TasksView.tsx', import.meta.url);
assert.equal(typeof exportJobTraceToFile, 'function', 'TasksView.tsx must export exportJobTraceToFile');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round35-${label}-`));
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

function createTraceStubComplete() {
  return async (_system, prompt, execution = {}) => {
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const reply = JSON.stringify({
      cards: [
        {
          kind: 'flashcard',
          front: 'What is Memento pattern?',
          back: 'Captures and externalizes internal state for later restoration.',
        },
      ],
    });
    execution.onOutput?.(reply);
    return reply;
  };
}

async function pollTraceUntilRecorded(host, jobId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await host.call('job.trace.export', { jobId });
    if (res.ok && Array.isArray(res.value?.calls) && res.value.calls.some((c) => c.retained)) {
      return res;
    }
    await sleep(40);
  }
  return host.call('job.trace.export', { jobId });
}

describe('Round 35: TasksView trace export (e) & trace purge (D) E2E', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) exportJobTraceToFile unit: creates exports/, sanitizes traversal jobIds, writes valid JSON', async () => {
    const root = await makeTempDir('unit-export');
    const exportsDir = resolve(join(root, 'exports'));
    const payload = {
      format: 'studyhub-request-trace-v1',
      jobId: '../../../etc/passwd',
      calls: [{ callId: 'c1', stage: 'generate', model: 'stub', retained: true }],
    };

    const saved = await exportJobTraceToFile(root, '../../../etc/passwd', payload);
    assert.equal(dirname(saved), exportsDir, 'must write strictly inside <libraryRoot>/exports');
    assert.match(basename(saved), /^trace-etc-passwd-\d{8}-\d{6}\.json$/);

    const parsed = JSON.parse(await readFile(saved, 'utf8'));
    assert.deepEqual(parsed, payload);

    const savedWinTraversal = await exportJobTraceToFile(root, '..\\..\\secret/job:id?*', { ok: true });
    assert.equal(dirname(savedWinTraversal), exportsDir, 'must block Windows-style traversal too');
    assert.match(basename(savedWinTraversal), /^trace-secret-job-id-\d{8}-\d{6}\.json$/);
    const dirStat = await stat(exportsDir);
    assert.equal(dirStat.isDirectory(), true);

    const fallbackSaved = await exportJobTraceToFile('', 'job-fallback', { fallback: true });
    try {
      assert.equal(dirname(fallbackSaved), resolve(join(tmpdir(), 'exports')));
      assert.deepEqual(JSON.parse(await readFile(fallbackSaved, 'utf8')), { fallback: true });
    } finally {
      await rm(fallbackSaved, { force: true });
    }
  });

  test('2) createTuiHost integration: job.trace.export & job.trace.delete error + valid schema lifecycle', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: createTraceStubComplete(),
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      // Unknown job errors
      const missingExport = await host.call('job.trace.export', { jobId: 'missing-job-35' });
      assert.equal(missingExport.ok, false);
      assert.match(missingExport.error?.message ?? '', /Study job not found/i);

      const missingDelete = await host.call('job.trace.delete', { jobId: 'missing-job-35' });
      assert.equal(missingDelete.ok, false);
      assert.match(missingDelete.error?.message ?? '', /Study job not found/i);

      // Load sample course and start a real generate job to record request traces
      const sampleRes = await host.call('sample.load', { language: 'en' });
      assert.equal(sampleRes.ok, true, sampleRes.error?.message);
      const snap = await host.call('snapshot', {});
      assert.equal(snap.ok, true);
      const activeSource = (snap.value?.sources ?? []).find((s) => !s.archived) ?? snap.value?.sources?.[0];
      assert.ok(activeSource, 'expected an active sample source');
      const course = activeSource.course || activeSource.courses?.[0] || snap.value?.courses?.[0]?.name;

      const genRes = await host.call('generate', {
        course,
        sourceIds: [activeSource.id],
        count: 1,
        kind: 'flashcard',
        title: 'R35 Trace Host Job',
      });
      assert.equal(genRes.ok, true, genRes.error?.message);
      const jobId = genRes.value?.jobId || genRes.value?.id;
      assert.ok(jobId, 'generate must return jobId');

      const exported = await pollTraceUntilRecorded(host, jobId);
      assert.equal(exported.ok, true, exported.error?.message);
      assert.equal(exported.value.format, 'studyhub-request-trace-v1');
      assert.equal(typeof exported.value.exportedAt, 'string');
      assert.equal(exported.value.jobId, jobId);
      assert.equal(exported.value.includesSolutions, false);
      assert.ok(Array.isArray(exported.value.messages));
      assert.ok(Array.isArray(exported.value.calls) && exported.value.calls.length >= 1, 'expected at least 1 trace call');
      assert.equal(exported.value.calls.some((c) => c.retained), true, 'expected retained trace entry');

      const writtenPath = await exportJobTraceToFile(libraryRoot, jobId, exported.value);
      const diskPayload = JSON.parse(await readFile(writtenPath, 'utf8'));
      assert.equal(diskPayload.format, 'studyhub-request-trace-v1');
      assert.equal(diskPayload.jobId, jobId);

      // Purge traces -> job record stays intact
      const purged = await host.call('job.trace.delete', { jobId });
      assert.equal(purged.ok, true, purged.error?.message);
      assert.equal(purged.value.jobId, jobId);
      assert.ok(typeof purged.value.removed === 'number' && purged.value.removed >= 1);

      const afterPurgeTrace = await host.call('job.trace', { jobId });
      assert.equal(afterPurgeTrace.ok, true, 'job record must remain intact after trace delete');
      assert.equal(afterPurgeTrace.value.calls.every((c) => c.retained === false && c.deleted === true), true);

      const purgedAgain = await host.call('job.trace.delete', { jobId });
      assert.equal(purgedAgain.ok, true);
      assert.equal(purgedAgain.value.removed, 0);
    } finally {
      await host.dispose();
    }
  });

  test('3) PTY E2E: TasksView [e] Export & [D] Purge at 120x36 & 80x24 + --ascii mode', async () => {
    const base = await makeTempDir('pty');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    let host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: createTraceStubComplete(),
      skipAutoProbe: true,
      language: 'zh',
    });

    const sampleRes = await host.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, sampleRes.error?.message);

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
      await tty.waitFor((s) => s.includes('学习库') || s.includes('Memento'), { label: 'Initial app render' });

      // Navigate to TasksView ('t') while empty
      tty.send('t');
      const emptyWide = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'tasks' &&
          s.includes('后台任务') &&
          s.includes('[e]') &&
          s.includes('[D]'),
        { label: 'TasksView empty at 120x36 with e/D hints' },
      );
      tty.assertHealthyScreen(emptyWide, 120, 36, 'TasksView empty 120x36');

      // Check 80x24 layout with e/D hints
      tty.resize(80, 24);
      const emptyNarrow = await tty.waitFor(
        (s) => s.includes('后台任务') && s.includes('[e]') && s.includes('[D]') && s.split('\n').length <= 24,
        { label: 'TasksView empty at 80x24 with e/D hints' },
      );
      tty.assertHealthyScreen(emptyNarrow, 80, 24, 'TasksView empty 80x24');

      tty.resize(120, 36);
      await tty.waitFor((s) => s.includes('监控后台任务'), { label: 'TasksView restored 120x36' });

      // Press 'e' and 'D' on empty job list -> clean info toasts, no crash
      tty.send('e');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('请先选择一个任务')),
        { label: 'Empty list e info toast' },
      );
      tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'TasksView after empty e');

      tty.send('D');
      await sleep(60);
      await tty.flush();
      tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'TasksView after empty D');

      // Create a populated job with retained trace
      const snapRes = await host.call('snapshot', {});
      const activeSource = (snapRes.value?.sources ?? []).find((s) => !s.archived) ?? snapRes.value?.sources?.[0];
      assert.ok(activeSource);
      const course = activeSource.course || activeSource.courses?.[0] || snapRes.value?.courses?.[0]?.name;

      const genRes = await host.call('generate', {
        course,
        sourceIds: [activeSource.id],
        count: 1,
        kind: 'flashcard',
        title: 'R35 PTY Trace Job',
      });
      assert.equal(genRes.ok, true, genRes.error?.message);
      const jobId = genRes.value?.jobId || genRes.value?.id;
      assert.ok(jobId);

      await pollTraceUntilRecorded(host, jobId);
      const afterGenSnap = await host.call('snapshot', {});
      useTuiStore.getState().setSnapshot(afterGenSnap.value);

      await tty.waitFor(
        (s) => s.includes('R35 PTY Trace Job') && !s.includes('当前筛选下无任务'),
        { label: 'Populated job visible in TasksView' },
      );

      // Press 'e' -> exports trace file to <libraryRoot>/exports/ and shows success toast
      tty.send('e');
      await tty.waitFor(
        () =>
          useTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'success' && toast.text.includes('轨迹已导出到')),
        { label: 'Trace export success toast' },
      );
      const exportFiles = await readdir(join(libraryRoot, 'exports'));
      assert.ok(
        exportFiles.some((f) => f.startsWith('trace-') && f.endsWith('.json')),
        `Expected exported trace-*.json in exports/, found ${JSON.stringify(exportFiles)}`,
      );
      tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'TasksView after export');

      // Press 'D' -> ConfirmDialog opens explaining job record stays intact; 'n' cancels cleanly
      tty.send('D');
      const purgeDialog = await tty.waitFor(
        (s) => s.includes('清空请求轨迹') && s.includes('任务记录与草稿保持不变'),
        { label: 'Purge ConfirmDialog opened' },
      );
      tty.assertHealthyScreen(purgeDialog, 120, 36, 'Purge ConfirmDialog');

      tty.send('n');
      await tty.waitFor((s) => !s.includes('清空请求轨迹') && s.includes('R35 PTY Trace Job'), {
        label: 'Purge ConfirmDialog canceled with n',
      });

      // Press 'D' then 'y' -> purges trace, refreshes trace view, keeps job record
      tty.send('D');
      await tty.waitFor((s) => s.includes('清空请求轨迹'), { label: 'Purge ConfirmDialog reopened' });
      tty.send('y');
      await tty.waitFor(
        () =>
          useTuiStore
            .getState()
            .toasts.some(
              (toast) => toast.text.includes('条调用轨迹（任务记录保留）') || toast.text.includes('暂无可清空'),
            ),
        { label: 'Purge trace toast shown' },
      );
      const afterPurgeScreen = await tty.waitFor(
        (s) => !s.includes('清空请求轨迹') && s.includes('R35 PTY Trace Job'),
        { label: 'Job record still present after purge' },
      );
      tty.assertHealthyScreen(afterPurgeScreen, 120, 36, 'TasksView after purge');

      inkInstance.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();

      // Dedicated --ascii mode check at 120x36 & 80x24
      await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
      host = await createTuiHost({
        libraryRoot,
        env,
        home: base,
        documentsDir: base,
        injectedComplete: createTraceStubComplete(),
        skipAutoProbe: true,
        language: 'en',
      });
      const asciiTty = createVirtualTty(120, 36);
      try {
        inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: true }), {
          stdin: asciiTty.stdin,
          stdout: asciiTty.stdout,
          stderr: asciiTty.stderr,
          exitOnCtrlC: false,
          patchConsole: false,
        });
        await asciiTty.firstFramePromise;
        await asciiTty.waitFor((s) => s.includes('Library') || s.includes('Memento'), { label: 'ASCII app load' });

        asciiTty.send('t');
        const asciiWide = await asciiTty.waitFor(
          (s) =>
            useTuiStore.getState().page === 'tasks' &&
            s.includes('Background Jobs') &&
            s.includes('[e]') &&
            s.includes('[D]'),
          { label: 'ASCII TasksView 120x36' },
        );
        asciiTty.assertHealthyScreen(asciiWide, 120, 36, 'ASCII TasksView 120x36');
        asciiTty.assertAsciiPure(asciiWide, 'ASCII TasksView 120x36');

        asciiTty.resize(80, 24);
        const asciiNarrow = await asciiTty.waitFor(
          (s) => s.includes('Background Jobs') && s.includes('[e]') && s.includes('[D]') && s.split('\n').length <= 24,
          { label: 'ASCII TasksView 80x24' },
        );
        asciiTty.assertHealthyScreen(asciiNarrow, 80, 24, 'ASCII TasksView 80x24');
        asciiTty.assertAsciiPure(asciiNarrow, 'ASCII TasksView 80x24');

        asciiTty.resize(120, 36);
        await asciiTty.waitFor((s) => s.includes('Monitor jobs'), { label: 'ASCII TasksView restored 120x36' });

        // Empty-list e and D in --ascii mode
        asciiTty.send('e');
        await asciiTty.waitFor(
          () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('Select a job first')),
          { label: 'ASCII empty e toast' },
        );
        asciiTty.assertAsciiPure(asciiTty.readScreen(), 'ASCII TasksView after empty e');

        // Seed a job and check JobOutputModal + Purge ConfirmDialog ASCII purity
        const snapEn = await host.call('snapshot', {});
        const srcEn = (snapEn.value?.sources ?? []).find((s) => !s.archived) ?? snapEn.value?.sources?.[0];
        const courseEn = srcEn.course || srcEn.courses?.[0] || snapEn.value?.courses?.[0]?.name;
        const genEn = await host.call('generate', {
          course: courseEn,
          sourceIds: [srcEn.id],
          count: 1,
          kind: 'flashcard',
          title: 'R35 ASCII Job',
        });
        assert.equal(genEn.ok, true);
        const snapAfterEn = await host.call('snapshot', {});
        useTuiStore.getState().setSnapshot(snapAfterEn.value);

        await asciiTty.waitFor((s) => s.includes('R35 ASCII Job'), { label: 'ASCII job visible' });

        asciiTty.send('o');
        const asciiOutputModal = await asciiTty.waitFor(
          (s) => s.includes('Job Output:') && !s.includes('Loading job output'),
          { label: 'ASCII JobOutputModal' },
        );
        asciiTty.assertHealthyScreen(asciiOutputModal, 120, 36, 'ASCII JobOutputModal');
        asciiTty.assertAsciiPure(asciiOutputModal, 'ASCII JobOutputModal');
        asciiTty.send('\x1b');
        await asciiTty.waitFor((s) => !s.includes('Job Output:'), { label: 'ASCII JobOutputModal closed' });

        asciiTty.send('D');
        const asciiPurge = await asciiTty.waitFor(
          (s) => s.includes('Purge Request Traces') && s.includes('job record itself stays intact'),
          { label: 'ASCII Purge ConfirmDialog' },
        );
        asciiTty.assertHealthyScreen(asciiPurge, 120, 36, 'ASCII Purge ConfirmDialog');
        asciiTty.assertAsciiPure(asciiPurge, 'ASCII Purge ConfirmDialog');
        asciiTty.send('n');
        await asciiTty.waitFor((s) => !s.includes('Purge Request Traces'), { label: 'ASCII Purge closed' });
      } finally {
        inkInstance?.unmount();
        asciiTty.dispose();
      }
    } finally {
      inkInstance?.unmount();
      tty.dispose();
      await host.dispose();
    }
  });
});
