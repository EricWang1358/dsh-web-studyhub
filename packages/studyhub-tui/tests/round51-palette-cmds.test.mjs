// Round 51 CommandPalette slash commands & HelpOverlay sync tests:
// `node --test --test-concurrency=1 tests/round51-palette-cmds.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path, { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
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

// Bundle CommandPalette + HelpOverlay pure helpers for unit verification
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-r51-palette-'));
const bundleFile = path.join(bundleDir, 'palette.mjs');
await build({
  stdin: {
    contents: [
      `export { buildPaletteItems, parsePaletteScope } from './src/shell/CommandPalette.tsx';`,
      `export { fuzzyFilter } from './src/shell/fuzzy.ts';`,
      `export { featureShortcuts } from './src/shell/HelpOverlay.tsx';`,
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
const PaletteMod = await import(pathToFileURL(bundleFile).href);

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [bundleDir];

async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdirPath(), `studyhub-r51-${label}-`));
  tempDirs.push(d);
  return d;
}

function tmpdirPath() {
  return os.tmpdir();
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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

  function resize(nextCols, nextRows) {
    stdout.columns = nextCols;
    stdout.rows = nextRows;
    stderr.columns = nextCols;
    stderr.rows = nextRows;
    term.resize(nextCols, nextRows);
    stdout.emit('resize');
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
    term,
    firstFramePromise,
    flush,
    resize,
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

describe('Round 51 Task 3: CommandPalette Slash Commands & HelpOverlay Sync', () => {
  test('1) buildPaletteItems exposes /ascii, /math, /recover & direct page slash commands with 0 model calls and 0 duplicate IDs', async () => {
    const dshHome = await makeTempDir('unit-dsh');
    process.env.DSH_HOME = dshHome;

    let modelCalls = 0;
    const hostCalls = [];
    const refreshed = [];
    const navigated = [];
    const prefPatches = [];
    const notifications = [];

    const mockHost = {
      dshHome,
      async call(action, args) {
        hostCalls.push({ action, args });
        if (action === 'coverage.recover') {
          return { ok: true, value: { recovered: 2 } };
        }
        return { ok: true, value: {} };
      },
      subscribeEvents() {
        return () => {};
      },
      getLibraryRoot() {
        return dshHome;
      },
      getConfig() {
        return null;
      },
      async streamComplete() {
        modelCalls += 1;
        return '';
      },
      async dispose() {},
    };

    const mockState = {
      snapshot: null,
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
      activeRunId: 'run-42',
      navigate: (page, ctx) => navigated.push({ page, ctx }),
      setTheme: () => {},
      setLanguage: () => {},
      toggleSidebar: () => {},
      setHelpOpen: () => {},
      setVoicePackOpen: () => {},
      setCoursePickerOpen: () => {},
      setInboxOpen: () => {},
      setPreferences: (patch) => prefPatches.push(patch),
      notify: (text, tone) => notifications.push({ text, tone }),
      goBack: () => {},
    };

    const mockActions = {
      refresh: async () => {
        refreshed.push(true);
      },
      loadSample: async () => {},
      importSource: () => {},
      openModelSettings: () => {},
      setCourse: async () => {},
      createCourse: async () => {},
      quit: () => {},
    };

    const items = PaletteMod.buildPaletteItems(mockState, mockActions, [], mockHost);
    const ids = items.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, 'buildPaletteItems must have zero duplicate IDs');

    const expectedCommands = [
      ['cmd:ascii', '/ascii'],
      ['cmd:math', '/math'],
      ['cmd:recover', '/recover'],
      ['cmd:page:review', '/review'],
      ['cmd:page:book', '/book'],
      ['cmd:page:exam', '/exam'],
      ['cmd:page:skeleton', '/skeleton'],
      ['cmd:page:wrongbook', '/wrongbook'],
      ['cmd:page:tasks', '/tasks'],
      ['cmd:page:audio', '/audio'],
      ['cmd:page:settings', '/settings'],
    ];

    for (const [id, label] of expectedCommands) {
      const found = items.find((i) => i.id === id);
      assert.ok(found, `Missing palette item ${id}`);
      assert.equal(found.label, label, `Unexpected label for ${id}`);
    }

    // Verify parsePaletteScope('/recover') + cmd pool matching
    const parsedRecover = PaletteMod.parsePaletteScope('/recover');
    assert.equal(parsedRecover.scope, 'cmd');
    assert.equal(parsedRecover.term, 'recover');
    const cmdPool = items.filter((i) => i.id.startsWith('cmd:') || i.label.startsWith('/'));
    const filtered = PaletteMod.fuzzyFilter(
      cmdPool,
      parsedRecover.term,
      (i) => i.label,
      (i) => [...(i.keywords ?? []), i.hint ?? ''],
    );
    assert.equal(filtered[0]?.item.id, 'cmd:recover', '/recover must match cmd:recover first');

    // Execute /recover -> calls coverage.recover {} + refresh + notify, 0 model calls
    const recoverItem = items.find((i) => i.id === 'cmd:recover');
    await recoverItem.action();
    assert.deepEqual(hostCalls, [{ action: 'coverage.recover', args: {} }]);
    assert.equal(refreshed.length, 1);
    assert.ok(notifications.some((n) => n.text.includes('已恢复 2 个中断任务') && n.tone === 'success'));
    assert.equal(modelCalls, 0, '/recover must execute with 0 model calls');

    // Execute /ascii and /math
    await items.find((i) => i.id === 'cmd:ascii').action();
    assert.deepEqual(prefPatches[0], { asciiMode: true });
    await items.find((i) => i.id === 'cmd:math').action();
    assert.deepEqual(prefPatches[1], { mathUnicode: false });

    // Execute direct page slash commands (/review resumes activeRunId, others navigate directly)
    for (const pid of ['review', 'book', 'exam', 'skeleton', 'wrongbook', 'tasks', 'audio', 'settings']) {
      await items.find((i) => i.id === `cmd:page:${pid}`).action();
    }
    assert.deepEqual(navigated, [
      { page: 'review', ctx: { runId: 'run-42' } },
      { page: 'book', ctx: undefined },
      { page: 'exam', ctx: undefined },
      { page: 'skeleton', ctx: undefined },
      { page: 'wrongbook', ctx: undefined },
      { page: 'tasks', ctx: undefined },
      { page: 'audio', ctx: undefined },
      { page: 'settings', ctx: undefined },
    ]);

    // HelpOverlay 15-section invariant & Round 51 entries
    for (const lang of ['zh', 'en']) {
      const sections = PaletteMod.featureShortcuts(lang);
      assert.equal(sections.length, 15, `HelpOverlay must keep exactly 15 sections (${lang})`);
      const sourcesSec = sections.find((s) => s.title.includes('Sources'));
      const tasksAudioSec = sections.find((s) => s.title.includes('Tasks') && s.title.includes('Audio'));
      const paletteSec = sections.find((s) => s.title.includes('Palette'));
      assert.ok(sourcesSec?.items.some((i) => i.key === 't'), `Missing t in Sources & Reader (${lang})`);
      assert.ok(tasksAudioSec?.items.some((i) => i.key === 'c'), `Missing c in Tasks & Audio (${lang})`);
      assert.ok(paletteSec?.items.some((i) => i.key === '/ascii /math /recover'), `Missing /ascii /math /recover in Palette (${lang})`);
    }
  });

  test('2) @xterm/headless E2E (zh, 120x36 & 80x24): /recover toast, /ascii toggle, /math, /book, Ctrl+N/P, and HelpOverlay', async () => {
    const boxDir = await makeTempDir('e2e-zh');
    const dshHome = join(boxDir, 'dsh-home');
    const libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;

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
        { label: 'Launchpad render' },
      );

      tty.send('s');
      await tty.waitFor(
        (s) => !s.includes('载入示例课程体验') && (s.includes('示例 · Memento') || s.includes('Sample · Memento')),
        { timeoutMs: 12_000, label: 'Library after sample load' },
      );
      await sleep(80);
      await tty.flush();

      // Open Ctrl+K -> type /recover + Enter -> toast appears
      tty.send('\x0b');
      await tty.waitFor(
        (s) => s.includes('命令面板'),
        { timeoutMs: 6_000, label: 'CommandPalette open for /recover' },
      );
      tty.send('/recover');
      const recoverFiltered = await tty.waitFor(
        (s) => s.includes('/recover') && s.includes('恢复中断'),
        { timeoutMs: 6_000, label: '/recover item visible' },
      );
      tty.assertHealthyScreen(recoverFiltered, 120, 36, 'CommandPalette /recover (zh)');
      tty.send('\r');
      const recoverToast = await tty.waitFor(
        (s) => !s.includes('命令面板') && (s.includes('当前没有可恢复的中断任务') || s.includes('已恢复')),
        { timeoutMs: 6_000, label: '/recover notification toast' },
      );
      tty.assertHealthyScreen(recoverToast, 120, 36, 'After /recover toast (zh)');

      // Open Ctrl+K -> test Ctrl+N (\x0e) and Ctrl+P (\x10) selection movement -> type /ascii + Enter
      tty.send('\x0b');
      await tty.waitFor(
        (s) => s.includes('命令面板'),
        { timeoutMs: 6_000, label: 'CommandPalette open for Ctrl+N/P & /ascii' },
      );
      tty.send('\x0e'); // Ctrl+N
      await tty.flush();
      tty.send('\x10'); // Ctrl+P
      await tty.flush();
      tty.send('/ascii');
      const asciiFiltered = await tty.waitFor(
        (s) => s.includes('/ascii') && s.includes('ASCII'),
        { timeoutMs: 6_000, label: '/ascii item visible' },
      );
      tty.assertHealthyScreen(asciiFiltered, 120, 36, 'CommandPalette /ascii (zh)');
      tty.send('\r');
      const asciiToast = await tty.waitFor(
        (s) => !s.includes('命令面板') && useTuiStore.getState().preferences.asciiMode === true && s.includes('ASCII'),
        { timeoutMs: 6_000, label: '/ascii toggled live' },
      );
      tty.assertHealthyScreen(asciiToast, 120, 36, 'After /ascii toggle (zh)');
      tty.assertAsciiPure(asciiToast, 'After /ascii toggle (zh)');

      // Open Ctrl+K -> type /book + Enter at 80x24
      tty.resize(80, 24);
      tty.send('\x0b');
      const narrowPalette = await tty.waitFor(
        (s) => s.includes('命令面板'),
        { timeoutMs: 6_000, label: 'CommandPalette open at 80x24' },
      );
      tty.assertHealthyScreen(narrowPalette, 80, 24, 'CommandPalette at 80x24');
      tty.send('/book');
      await tty.waitFor(
        (s) => s.includes('/book'),
        { timeoutMs: 6_000, label: '/book filtered at 80x24' },
      );
      tty.send('\r');
      const bookScreen = await tty.waitFor(
        (s) => !s.includes('命令面板') && useTuiStore.getState().page === 'book',
        { timeoutMs: 6_000, label: '/book navigated at 80x24' },
      );
      tty.assertHealthyScreen(bookScreen, 80, 24, 'BookView via /book at 80x24');

      // Open HelpOverlay (?) and scroll to verify Round 51 entries render cleanly
      tty.resize(120, 36);
      tty.send('?');
      const helpScreen = await tty.waitFor(
        (s) => s.includes('快捷键'),
        { timeoutMs: 6_000, label: 'HelpOverlay open' },
      );
      tty.assertHealthyScreen(helpScreen, 120, 36, 'HelpOverlay (zh, ascii)');
      tty.assertAsciiPure(helpScreen, 'HelpOverlay (zh, ascii)');
      // Scroll down to bottom of HelpOverlay via G
      tty.send('G');
      const helpBottom = await tty.waitFor(
        (s) => s.includes('双语翻译') || s.includes('复核音频') || s.includes('/ascii'),
        { timeoutMs: 6_000, label: 'HelpOverlay Round 51 entries visible' },
      );
      tty.assertHealthyScreen(helpBottom, 120, 36, 'HelpOverlay bottom Round 51 entries');
      tty.assertAsciiPure(helpBottom, 'HelpOverlay bottom Round 51 entries');
      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('快捷键'), { timeoutMs: 5_000, label: 'HelpOverlay closed' });

      assert.equal(modelCalls, 0, 'All Round 51 palette commands must make 0 model calls');
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

  test('3) @xterm/headless E2E (--ascii en, 120x36 & 80x24): /recover, /ascii, /math, and HelpOverlay in English', async () => {
    const boxDir = await makeTempDir('e2e-en-ascii');
    const dshHome = join(boxDir, 'dsh-home');
    const libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;
    await H.saveTuiPreferences({ language: 'en', asciiMode: true }, { env: { DSH_HOME: dshHome } });

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

    const tty = createVirtualTty(120, 36);
    useTuiStore.setState({
      page: 'library',
      navContext: {},
      history: [],
      toasts: [],
      commandPaletteOpen: false,
      helpOpen: false,
      showLaunchpad: false,
      snapshot: null,
      loading: true,
    });
    const inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        initialPage: 'library',
        initialLanguage: 'en',
        initialAsciiMode: true,
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
        (s) => s.includes('Load the sample course'),
        { label: 'Launchpad en --ascii render' },
      );

      tty.send('s');
      await tty.waitFor(
        (s) => !s.includes('Load the sample course') && s.includes('Sample'),
        { timeoutMs: 12_000, label: 'Library en after sample load' },
      );

      // /recover in English --ascii
      tty.send('\x0b');
      await tty.waitFor((s) => s.includes('Command Palette'), { timeoutMs: 6_000, label: 'CommandPalette open (en)' });
      tty.send('/recover');
      const enRecover = await tty.waitFor(
        (s) => s.includes('/recover') && s.includes('Recover interrupted'),
        { timeoutMs: 6_000, label: '/recover item in en' },
      );
      tty.assertHealthyScreen(enRecover, 120, 36, 'CommandPalette /recover (en)');
      tty.assertAsciiPure(enRecover, 'CommandPalette /recover (en)');
      tty.send('\r');
      const enRecoverToast = await tty.waitFor(
        (s) => !s.includes('Command Palette') && s.includes('No interrupted jobs to recover'),
        { timeoutMs: 6_000, label: 'English /recover toast' },
      );
      tty.assertHealthyScreen(enRecoverToast, 120, 36, 'After /recover (en)');
      tty.assertAsciiPure(enRecoverToast, 'After /recover (en)');

      // /math in English --ascii at 80x24
      tty.resize(80, 24);
      tty.send('\x0b');
      await tty.waitFor((s) => s.includes('Command Palette'), { timeoutMs: 6_000, label: 'CommandPalette 80x24 (en)' });
      tty.send('/math');
      await tty.waitFor((s) => s.includes('/math'), { timeoutMs: 6_000, label: '/math visible at 80x24' });
      tty.send('\r');
      const mathToast = await tty.waitFor(
        (s) => !s.includes('Command Palette') && useTuiStore.getState().preferences.mathUnicode === false,
        { timeoutMs: 6_000, label: '/math toggled in en' },
      );
      tty.assertHealthyScreen(mathToast, 80, 24, 'After /math at 80x24 (en)');
      tty.assertAsciiPure(mathToast, 'After /math at 80x24 (en)');

      // HelpOverlay in English --ascii
      tty.resize(120, 36);
      tty.send('?');
      await tty.waitFor((s) => s.includes('Keyboard Shortcuts'), { timeoutMs: 6_000, label: 'HelpOverlay (en)' });
      tty.send('G');
      const enHelpBottom = await tty.waitFor(
        (s) => s.includes('Bilingual translate') || s.includes('Review audio') || s.includes('ASCII / Math'),
        { timeoutMs: 6_000, label: 'HelpOverlay Round 51 entries (en)' },
      );
      tty.assertHealthyScreen(enHelpBottom, 120, 36, 'HelpOverlay Round 51 entries (en)');
      tty.assertAsciiPure(enHelpBottom, 'HelpOverlay Round 51 entries (en)');

      assert.equal(modelCalls, 0, 'All Round 51 palette commands must make 0 model calls (en)');
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
