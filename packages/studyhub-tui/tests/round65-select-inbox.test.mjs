// Round 65 Track 1: SelectList SGR 1006 mouse wheel + PageUp/PageDown/Ctrl+D/U,
// and InboxModal `/` keyword filter + `[e]` atomic `inbox.raw` JSON export.
// `node --test --test-concurrency=1 tests/round65-select-inbox.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let R = null;
let S = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
    if (!S && mod.useTuiStore) S = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');
assert.ok(S?.useTuiStore, 'dist/ must export useTuiStore');
const { useTuiStore } = S;

// Bundle SelectList + store for isolated component unit/PTY verification
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-r65-select-'));
const bundleFile = path.join(bundleDir, 'select-list.mjs');
await build({
  stdin: {
    contents: [
      `export { SelectList } from './src/components/SelectList.tsx';`,
      `export { useTuiStore, DEFAULT_PREFERENCES } from './src/state/store.ts';`,
    ].join('\n'),
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile: bundleFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(bundleDir, 'node_modules'), 'junction');
const SelectMod = await import(pathToFileURL(bundleFile).href);

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [bundleDir];

async function makeTempDir(label) {
  const d = await mkdtemp(join(os.tmpdir(), `studyhub-r65-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function todayLocalYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function createInkHarness(element, { cols = 60, rows = 16 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 1;

  const frames = [];
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim().length > 0) {
      frames.push(plain);
    }
  });

  const inst = render(element, {
    stdout,
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  async function send(seq, waitMs = 35) {
    stdin.write(seq);
    await sleep(waitMs);
  }

  function lastFrame() {
    return frames.at(-1) ?? '';
  }

  function cleanup() {
    inst.unmount();
    stdin.destroy();
    stdout.destroy();
  }

  return { send, lastFrame, cleanup };
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
    await sleep(35);
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

  async function waitFor(predicate, { timeoutMs = 8_000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await flush();
      const screen = readScreen();
      if (predicate(screen)) return screen;
      await sleep(35);
    }
    const finalScreen = readScreen();
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.\n--- SCREEN ---\n${finalScreen}\n--------------`);
  }

  function assertHealthyScreen(screen, expectedCols, expectedRows, contextLabel) {
    const lines = screen.split('\n');
    assert.ok(lines.length <= expectedRows, `${contextLabel}: row count ${lines.length} > ${expectedRows}`);
    assert.ok(
      !screen.includes('页面渲染异常') && !screen.includes('View Error'),
      `${contextLabel}: ViewErrorBoundary triggered!\n${screen}`,
    );
    assert.ok(
      !screen.includes('TypeError:') && !screen.includes('ReferenceError:'),
      `${contextLabel}: Runtime JS error rendered!\n${screen}`,
    );
    assert.ok(!screen.includes('\uFFFD'), `${contextLabel}: Replacement char U+FFFD found!\n${screen}`);
    assert.ok(
      !screen.includes('\x1b'),
      `${contextLabel}: Unparsed escape sequence leaked into xterm buffer!\n${screen}`,
    );
    for (let i = 0; i < lines.length; i += 1) {
      const w = R.displayWidth(lines[i]);
      assert.ok(
        w <= expectedCols,
        `${contextLabel}: Row ${i} exceeds cols (${w} > ${expectedCols}): ${JSON.stringify(lines[i])}`,
      );
    }
    const buf = term.buffer.active;
    for (let y = 0; y < term.rows; y += 1) {
      const line = buf.getLine(buf.viewportY + y);
      if (line) {
        assert.equal(
          line.isWrapped,
          false,
          `${contextLabel}: xterm soft-wrapped row ${y}: ${JSON.stringify(line.translateToString(true))}`,
        );
      }
    }
  }

  function assertAsciiPure(screen, contextLabel) {
    const unicodeUi = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/;
    assert.equal(unicodeUi.test(screen), false, `${contextLabel}: found Unicode UI chrome in ASCII mode:\n${screen}`);
  }

  return {
    stdin,
    stdout,
    stderr,
    firstFramePromise,
    flush,
    readLines,
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

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe('Round 65 Track 1: SelectList SGR Wheel + Page Nav & InboxModal Search/Export', () => {
  test('1) SelectList supports SGR 1006 mouse wheel down/up, Ctrl+D/Ctrl+U/PageUp/PageDown, skips disabled options cleanly, and clamps without wrapping', async () => {
    const disabledSet = new Set([1, 4, 7, 12, 13]);
    const options = Array.from({ length: 14 }, (_, i) => ({
      value: `opt-${i}`,
      label: `Option-${String(i).padStart(2, '0')}`,
      disabled: disabledSet.has(i),
    }));

    for (const ascii of [false, true]) {
      SelectMod.useTuiStore.setState({
        preferences: {
          ...SelectMod.DEFAULT_PREFERENCES,
          language: 'en',
          asciiMode: ascii,
        },
      });

      const seenChanges = [];
      const seenSelects = [];
      const h = createInkHarness(
        React.createElement(SelectMod.SelectList, {
          options,
          maxHeight: 6,
          width: 36,
          onChange: (opt, idx) => seenChanges.push({ value: opt.value, idx }),
          onSelect: (opt, idx) => seenSelects.push({ value: opt.value, idx }),
        }),
      );

      try {
        await sleep(35);
        const leadChar = ascii ? '>' : '❯';
        assert.ok(h.lastFrame().includes(`${leadChar} 1 Option-00`), `expected Option-00 initially selected:\n${h.lastFrame()}`);

        // SGR wheel down (\x1b[<65;5;5M -> +3 non-disabled steps: 0 -> skip 1 -> 2 -> 3 -> skip 4 -> 5)
        await h.send('\x1b[<65;5;5M');
        assert.equal(seenChanges.at(-1)?.idx, 5);
        assert.ok(h.lastFrame().includes(`${leadChar} 6 Option-05`));

        // SGR wheel down again (+3 non-disabled steps: 5 -> 6 -> skip 7 -> 8 -> 9)
        await h.send('\x1b[<65;5;5M');
        assert.equal(seenChanges.at(-1)?.idx, 9);

        // SGR wheel down again -> clamps at last non-disabled option (11), skipping 12 & 13 without wrapping
        await h.send('\x1b[<65;5;5M');
        assert.equal(seenChanges.at(-1)?.idx, 11);

        // SGR wheel down at bottom must remain clamped at 11 (never wrap to 0)
        const countAtBottom = seenChanges.length;
        await h.send('\x1b[<65;5;5M');
        assert.equal(seenChanges.length, countAtBottom);
        assert.equal(seenChanges.at(-1)?.idx, 11);

        // SGR wheel up (\x1b[<64;5;5M -> -3 non-disabled steps: 11 -> 10 -> 9 -> 8)
        await h.send('\x1b[<64;5;5M');
        assert.equal(seenChanges.at(-1)?.idx, 8);

        // Ctrl+D (\x04): half-page jump (pageStep(6, 'half') === 3) -> 8 -> 9 -> 10 -> 11
        await h.send('\x04');
        assert.equal(seenChanges.at(-1)?.idx, 11);

        // Ctrl+U (\x15): half-page jump up (3) -> 11 -> 10 -> 9 -> 8
        await h.send('\x15');
        assert.equal(seenChanges.at(-1)?.idx, 8);

        // Ctrl+U (\x15): 8 -> skip 7 -> 6 -> 5 -> skip 4 -> 3
        await h.send('\x15');
        assert.equal(seenChanges.at(-1)?.idx, 3);

        // Ctrl+U (\x15): 3 -> 2 -> skip 1 -> 0 (clamped at top)
        await h.send('\x15');
        assert.equal(seenChanges.at(-1)?.idx, 0);

        // SGR wheel up at top must stay clamped at 0 (never wrap)
        const countAtTop = seenChanges.length;
        await h.send('\x1b[<64;5;5M');
        assert.equal(seenChanges.length, countAtTop);

        // PageDown (\x1b[6~) & PageUp (\x1b[5~)
        await h.send('\x1b[6~');
        assert.equal(seenChanges.at(-1)?.idx, 5);
        await h.send('\x1b[5~');
        assert.equal(seenChanges.at(-1)?.idx, 0);

        // Existing j/k + Enter behavior intact and skips disabled Option-01
        await h.send('j');
        assert.equal(seenChanges.at(-1)?.idx, 2);
        await h.send('\r');
        assert.deepEqual(seenSelects.at(-1), { value: 'opt-2', idx: 2 });
      } finally {
        h.cleanup();
      }
    }
  });

  test('2) @xterm/headless PTY E2E (120x36 zh): InboxModal / filter -> Enter -> [e] atomic inbox.raw export -> Esc closes (0 model calls)', async () => {
    const boxDir = await makeTempDir('pty-zh');
    const dshHome = join(boxDir, 'dsh-home');
    const libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;

    useTuiStore.setState({
      page: 'library',
      navContext: {},
      history: [],
      toasts: [],
      commandPaletteOpen: false,
      helpOpen: false,
      coursePickerOpen: false,
      inboxOpen: false,
      showLaunchpad: false,
      snapshot: null,
      loading: true,
      preferences: {
        theme: 'dsh-dark',
        language: 'zh',
        sidebarCollapsed: false,
        mathUnicode: true,
        compactMode: false,
        showKeyHints: true,
        asciiMode: false,
        recentCommands: [],
      },
    });

    let modelCalls = 0;
    const host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'Stub';
      },
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: true,
        onExit: () => inkInstance.unmount(),
      }),
      {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await tty.firstFramePromise;
      await tty.waitFor(
        (s) => s.includes('载入示例课程体验') || s.includes('Load the sample course'),
        { label: 'Launchpad render (zh)' },
      );

      // Load sample course via 's' (populates 5 inbox items, 0 model calls)
      tty.send('s');
      await tty.waitFor(
        (s) => !s.includes('载入示例课程体验') && (s.includes('示例 · Memento') || s.includes('Sample · Memento')),
        { timeoutMs: 12_000, label: 'Library after sample load (zh)' },
      );
      await sleep(150);
      await tty.flush();

      // Open InboxModal ('I')
      tty.send('I');
      const inboxInit = await tty.waitFor(
        (s) => s.includes('收件箱与通知') && s.includes('全部 (5)') && !s.includes('同步'),
        { timeoutMs: 8_000, label: 'InboxModal open (zh)' },
      );
      tty.assertHealthyScreen(inboxInit, 120, 36, 'InboxModal open (zh)');

      // Press '/' to focus keyword filter input, type 'grade' (contains 'r' and 'e' to verify single-key shortcuts are paused)
      tty.send('/');
      await tty.flush();
      tty.send('grade');
      const filteredScreen = await tty.waitFor(
        (s) => s.includes('2/5') && s.includes('[批改完成]') && !s.includes('[笔记草稿]'),
        { timeoutMs: 6_000, label: 'Inbox filtered to 2/5 by grade (zh)' },
      );
      tty.assertHealthyScreen(filteredScreen, 120, 36, 'InboxModal filtered (zh)');

      // Press Enter to confirm/blur search input while keeping filter active
      tty.send('\r');
      const afterEnterScreen = await tty.waitFor(
        (s) => s.includes('2/5') && s.includes('导出'),
        { timeoutMs: 6_000, label: 'Search blurred on Enter (zh)' },
      );
      tty.assertHealthyScreen(afterEnterScreen, 120, 36, 'InboxModal after Enter (zh)');

      // Press 'e' to export inbox.raw atomically to <libraryRoot>/backups/studyhub-inbox-YYYY-MM-DD.json
      const expectedPath = join(libraryRoot, 'backups', `studyhub-inbox-${todayLocalYmd()}.json`);
      tty.send('e');
      const afterExport = await tty.waitFor(
        (s) => s.includes('已导出 5 条通知') && fs.existsSync(expectedPath),
        { timeoutMs: 8_000, label: 'Export toast & file on disk (zh)' },
      );
      tty.assertHealthyScreen(afterExport, 120, 36, 'InboxModal after export (zh)');

      const exportedRaw = JSON.parse(await readFile(expectedPath, 'utf8'));
      assert.equal(Array.isArray(exportedRaw), true, 'exported inbox.raw file must be a JSON array');
      assert.equal(exportedRaw.length, 5, 'exported inbox.raw JSON array must contain all 5 items');

      // Press 'c' to clear search filter cleanly
      tty.send('c');
      await tty.waitFor(
        (s) => !s.includes('2/5') && s.includes('[笔记草稿]'),
        { timeoutMs: 6_000, label: 'Filter cleared with c (zh)' },
      );

      // Press Esc to close InboxModal cleanly
      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('收件箱与通知') && useTuiStore.getState().inboxOpen === false,
        { timeoutMs: 6_000, label: 'InboxModal closed (zh)' },
      );
      assert.equal(modelCalls, 0, 'InboxModal search and export must invoke 0 model calls');
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // ignore
      }
      await host.dispose();
      tty.dispose();
    }
  });

  test('3) @xterm/headless PTY E2E (80x24 --ascii en): InboxModal / filter -> [e] export -> assertHealthyScreen + assertAsciiPure -> Esc closes', async () => {
    const boxDir = await makeTempDir('pty-ascii-en');
    const dshHome = join(boxDir, 'dsh-home');
    const libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;

    await H.saveTuiPreferences(
      {
        theme: 'dsh-dark',
        language: 'en',
        asciiMode: true,
      },
      { env: { DSH_HOME: dshHome } },
    );

    useTuiStore.setState({
      page: 'library',
      navContext: {},
      history: [],
      toasts: [],
      commandPaletteOpen: false,
      helpOpen: false,
      coursePickerOpen: false,
      inboxOpen: false,
      showLaunchpad: false,
      snapshot: null,
      loading: true,
      preferences: {
        theme: 'dsh-dark',
        language: 'en',
        sidebarCollapsed: false,
        mathUnicode: true,
        compactMode: false,
        showKeyHints: true,
        asciiMode: true,
        recentCommands: [],
      },
    });

    let modelCalls = 0;
    const host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'Stub';
      },
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(80, 24);
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: true,
        onExit: () => inkInstance.unmount(),
      }),
      {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await tty.firstFramePromise;
      await tty.waitFor(
        (s) => s.includes('Load the sample course') || s.includes('载入示例课程体验'),
        { label: 'Launchpad render (en ascii)' },
      );

      tty.send('s');
      await tty.waitFor(
        (s) => !s.includes('Load the sample course') && s.includes('Memento'),
        { timeoutMs: 12_000, label: 'Library after sample load (en ascii)' },
      );
      await sleep(150);
      await tty.flush();

      // Open InboxModal ('I')
      tty.send('I');
      const inboxInit = await tty.waitFor(
        (s) => s.includes('Notification Inbox') && s.includes('All (5)') && !s.includes('Sync'),
        { timeoutMs: 8_000, label: 'InboxModal open (en ascii)' },
      );
      tty.assertHealthyScreen(inboxInit, 80, 24, 'InboxModal open (80x24 ascii en)');
      tty.assertAsciiPure(inboxInit, 'InboxModal open (80x24 ascii en)');

      // '/' filter -> type 'note' -> Enter -> 'e' export
      tty.send('/');
      await tty.flush();
      tty.send('note');
      const filteredScreen = await tty.waitFor(
        (s) => /\b[1-4]\/5\b/.test(s),
        { timeoutMs: 6_000, label: 'Inbox filtered to subset of 5 by note (en ascii)' },
      );
      tty.assertHealthyScreen(filteredScreen, 80, 24, 'InboxModal filtered (80x24 ascii en)');
      tty.assertAsciiPure(filteredScreen, 'InboxModal filtered (80x24 ascii en)');

      tty.send('\r');
      await tty.waitFor(
        (s) => s.includes('Export'),
        { timeoutMs: 6_000, label: 'Search blurred on Enter (en ascii)' },
      );

      const expectedPath = join(libraryRoot, 'backups', `studyhub-inbox-${todayLocalYmd()}.json`);
      tty.send('e');
      const afterExport = await tty.waitFor(
        () =>
          fs.existsSync(expectedPath) &&
          useTuiStore
            .getState()
            .toasts.some(
              (toast) =>
                toast.tone === 'success' &&
                toast.text.includes('Exported 5 inbox item(s)') &&
                toast.text.includes(expectedPath),
            ),
        { timeoutMs: 8_000, label: 'Export toast in store & file on disk (en ascii)' },
      );
      tty.assertHealthyScreen(afterExport, 80, 24, 'InboxModal after export (80x24 ascii en)');
      tty.assertAsciiPure(afterExport, 'InboxModal after export (80x24 ascii en)');

      const exportedRaw = JSON.parse(await readFile(expectedPath, 'utf8'));
      assert.equal(Array.isArray(exportedRaw), true);
      assert.equal(exportedRaw.length, 5);

      // Esc closes InboxModal cleanly
      tty.send('\x1b');
      const afterClose = await tty.waitFor(
        (s) => !s.includes('Notification Inbox') && useTuiStore.getState().inboxOpen === false,
        { timeoutMs: 6_000, label: 'InboxModal closed (en ascii)' },
      );
      tty.assertHealthyScreen(afterClose, 80, 24, 'Library after InboxModal close (80x24 ascii en)');
      tty.assertAsciiPure(afterClose, 'Library after InboxModal close (80x24 ascii en)');
      assert.equal(modelCalls, 0);
    } finally {
      try {
        inkInstance.unmount();
      } catch {
        // ignore
      }
      await host.dispose();
      tty.dispose();
    }
  });
});
