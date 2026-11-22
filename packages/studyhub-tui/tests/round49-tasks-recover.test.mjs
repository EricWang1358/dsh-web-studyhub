// Round 49 TasksView Interrupted Job Recovery ([R]: coverage.recover) Integration & PTY E2E:
// `node --test tests/round49-tasks-recover.test.mjs`
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

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round49-recover-${label}-`));
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

function clearStoreToasts() {
  const st = useTuiStore.getState();
  for (const toast of [...st.toasts]) {
    st.dismissToast(toast.id);
  }
}

describe('Round 49: TasksView interrupted job recovery ([R]: coverage.recover)', () => {
  after(async () => {
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
  });

  test('1) createTuiHost integration: coverage.recover {} returns { recovered: 0 } idempotently with 0 model calls', async () => {
    const base = await makeTempDir('host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    let modelCalls = 0;

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('coverage.recover must not invoke model calls');
      },
      skipAutoProbe: true,
      language: 'en',
    });

    try {
      const first = await host.call('coverage.recover', {});
      assert.equal(first.ok, true, first.error?.message);
      assert.deepEqual(first.value, { recovered: 0 });
      assert.equal(modelCalls, 0);

      const second = await host.call('coverage.recover', {});
      assert.equal(second.ok, true, second.error?.message);
      assert.deepEqual(second.value, { recovered: 0 });
      assert.equal(modelCalls, 0);

      const snap = await host.call('snapshot', {});
      assert.equal(snap.ok, true, snap.error?.message);
      assert.equal(modelCalls, 0);
    } finally {
      await host.dispose();
    }
  });

  test('2) PTY E2E (zh default): TasksView [R] triggers coverage.recover toast cleanly at 120x36 & 80x24', async () => {
    const base = await makeTempDir('pty-zh');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    let modelCalls = 0;

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('0-token recover must not invoke model');
      },
      skipAutoProbe: true,
      language: 'zh',
    });

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
      await tty.waitFor(
        (s) =>
          !useTuiStore.getState().loading &&
          useTuiStore.getState().snapshot !== null &&
          (s.includes('学习库') || s.includes('Library')),
        { label: 'Initial zh render' },
      );
      if (useTuiStore.getState().showLaunchpad) {
        await tty.waitFor((s) => s.includes('Enter'), { label: 'Launchpad mounted' });
        tty.send('\r');
        await tty.waitFor(() => !useTuiStore.getState().showLaunchpad, { label: 'Dismiss Launchpad' });
      }

      tty.send('t');
      const tasksWide = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'tasks' &&
          !useTuiStore.getState().showLaunchpad &&
          s.includes('后台任务') &&
          s.includes('[R] 恢复'),
        { label: 'TasksView zh 120x36 with [R] hint' },
      );
      tty.assertHealthyScreen(tasksWide, 120, 36, 'TasksView zh 120x36');

      clearStoreToasts();
      tty.send('R');
      const toastWide = await tty.waitFor(
        (s) =>
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('当前没有可恢复的中断任务')) &&
          s.includes('当前没有可恢复的中断任务'),
        { label: 'TasksView zh [R] recover toast at 120x36' },
      );
      tty.assertHealthyScreen(toastWide, 120, 36, 'TasksView zh recover toast 120x36');

      clearStoreToasts();
      tty.resize(80, 24);
      const tasksNarrow = await tty.waitFor(
        (s) => s.includes('后台任务') && s.split('\n').length <= 24,
        { label: 'TasksView zh 80x24' },
      );
      tty.assertHealthyScreen(tasksNarrow, 80, 24, 'TasksView zh 80x24');

      tty.send('R');
      const toastNarrow = await tty.waitFor(
        (s) =>
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('当前没有可恢复的中断任务')) &&
          s.includes('当前没有可恢复的中断任务'),
        { label: 'TasksView zh [R] recover toast at 80x24' },
      );
      tty.assertHealthyScreen(toastNarrow, 80, 24, 'TasksView zh recover toast 80x24');
      assert.equal(modelCalls, 0);
    } finally {
      inkInstance?.unmount();
      await sleep(30);
      tty.dispose();
      await host.dispose();
    }
  });

  test('3) PTY E2E (--ascii en): TasksView [R] triggers coverage.recover toast cleanly at 120x36 & 80x24', async () => {
    const base = await makeTempDir('pty-ascii');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    const libraryRoot = join(base, 'library');
    let modelCalls = 0;

    await saveTuiPreferences({ language: 'en', asciiMode: true }, { env });
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('0-token recover must not invoke model');
      },
      skipAutoProbe: true,
      language: 'en',
    });

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
      await tty.waitFor(
        (s) => !useTuiStore.getState().loading && useTuiStore.getState().snapshot !== null && s.includes('Library'),
        { label: 'Initial ASCII en render' },
      );
      if (useTuiStore.getState().showLaunchpad) {
        await tty.waitFor((s) => s.includes('Enter'), { label: 'ASCII Launchpad mounted' });
        tty.send('\r');
        await tty.waitFor(() => !useTuiStore.getState().showLaunchpad, { label: 'Dismiss ASCII Launchpad' });
      }

      tty.send('t');
      const tasksWide = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'tasks' &&
          !useTuiStore.getState().showLaunchpad &&
          s.includes('Background Jobs') &&
          s.includes('[R] Recover'),
        { label: 'ASCII TasksView 120x36 with [R] Recover' },
      );
      tty.assertHealthyScreen(tasksWide, 120, 36, 'ASCII TasksView 120x36');
      tty.assertAsciiPure(tasksWide, 'ASCII TasksView 120x36');

      clearStoreToasts();
      tty.send('R');
      const toastWide = await tty.waitFor(
        (s) =>
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('No interrupted jobs to recover')) &&
          s.includes('No interrupted jobs to recover'),
        { label: 'ASCII TasksView [R] recover toast at 120x36' },
      );
      tty.assertHealthyScreen(toastWide, 120, 36, 'ASCII TasksView recover toast 120x36');
      tty.assertAsciiPure(toastWide, 'ASCII TasksView recover toast 120x36');

      clearStoreToasts();
      tty.resize(80, 24);
      const tasksNarrow = await tty.waitFor(
        (s) => s.includes('Background Jobs') && s.split('\n').length <= 24,
        { label: 'ASCII TasksView 80x24' },
      );
      tty.assertHealthyScreen(tasksNarrow, 80, 24, 'ASCII TasksView 80x24');
      tty.assertAsciiPure(tasksNarrow, 'ASCII TasksView 80x24');

      tty.send('R');
      const toastNarrow = await tty.waitFor(
        (s) =>
          useTuiStore.getState().toasts.some((toast) => toast.text.includes('No interrupted jobs to recover')) &&
          s.includes('No interrupted jobs'),
        { label: 'ASCII TasksView [R] recover toast at 80x24' },
      );
      tty.assertHealthyScreen(toastNarrow, 80, 24, 'ASCII TasksView recover toast 80x24');
      tty.assertAsciiPure(toastNarrow, 'ASCII TasksView recover toast 80x24');
      assert.equal(modelCalls, 0);
    } finally {
      inkInstance?.unmount();
      await sleep(30);
      tty.dispose();
      await host.dispose();
    }
  });
});
