// Round 64 Track 2: CommandPalette 16/16 view slash commands, /compact & /hints & /sidebar toggles, and SGR 1006 mouse wheel scrolling
// `node --test --test-concurrency=1 tests/round64-palette-slash.test.mjs`
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

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let R = null;
let S = null;
let C = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
    if (!S && mod.useTuiStore) S = mod;
    if (!C && Array.isArray(mod.PAGE_REGISTRY)) C = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(H?.loadTuiPreferences, 'dist/ must export loadTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');
assert.ok(S?.useTuiStore, 'dist/ must export useTuiStore');
assert.ok(C?.PAGE_REGISTRY, 'dist/ must export PAGE_REGISTRY');
const { useTuiStore } = S;
const { PAGE_REGISTRY } = C;

// Bundle CommandPalette + fuzzyFilter for unit verification
const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-r64-palette-'));
const bundleFile = path.join(bundleDir, 'palette.mjs');
await build({
  stdin: {
    contents: [
      `export { buildPaletteItems, filterPaletteItems, parsePaletteScope } from './src/shell/CommandPalette.tsx';`,
      `export { fuzzyFilter } from './src/shell/fuzzy.ts';`,
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
  const d = await mkdtemp(join(os.tmpdir(), `studyhub-r64-${label}-`));
  tempDirs.push(d);
  return d;
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

async function waitForPersistedPref(dshHome, predicate, label) {
  const deadline = Date.now() + 4_000;
  const tuiJsonPath = H.tuiPreferencesPath({ env: { DSH_HOME: dshHome } });
  let lastPrefs = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(tuiJsonPath)) {
      try {
        lastPrefs = JSON.parse(fs.readFileSync(tuiJsonPath, 'utf8'));
        if (predicate(lastPrefs)) return lastPrefs;
      } catch {
        // retry while atomic rename settles
      }
    }
    await sleep(30);
  }
  throw new Error(`Timed out waiting for persisted tui.json (${label}); last=${JSON.stringify(lastPrefs)}`);
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

describe('Round 64 Track 2: CommandPalette 16/16 View Slash Commands, Toggles & SGR Mouse Wheel', () => {
  test('1) buildPaletteItems covers all 16/16 views with bilingual slash queries and live /compact, /hints, /sidebar toggles', async () => {
    const dshHome = await makeTempDir('unit-dsh');
    process.env.DSH_HOME = dshHome;

    const navigated = [];
    const prefPatches = [];
    const notifications = [];

    const mockHost = {
      dshHome,
      async call() {
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
      async dispose() {},
    };

    const prefs = {
      theme: 'dsh-dark',
      language: 'zh',
      sidebarCollapsed: false,
      mathUnicode: true,
      compactMode: false,
      showKeyHints: true,
      asciiMode: false,
      recentCommands: [],
    };

    const mockState = {
      snapshot: null,
      preferences: prefs,
      activeRunId: 'run-64',
      navigate: (page, ctx) => navigated.push({ page, ctx }),
      setTheme: () => {},
      setLanguage: () => {},
      toggleSidebar: () => {},
      setHelpOpen: () => {},
      setVoicePackOpen: () => {},
      setCoursePickerOpen: () => {},
      setInboxOpen: () => {},
      setPreferences: (patch) => {
        Object.assign(prefs, patch);
        prefPatches.push(patch);
      },
      notify: (text, tone) => notifications.push({ text, tone }),
      goBack: () => {},
    };

    const mockActions = {
      refresh: async () => {},
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

    // All 16/16 views from PAGE_REGISTRY must have cmd:page:<pid>
    assert.equal(PAGE_REGISTRY.length, 16, 'Expected 16 pages in PAGE_REGISTRY');
    const expectedSlashLabels = {
      library: '/library',
      sources: '/sources',
      generate: '/generate',
      wrongbook: '/wrongbook',
      exam: '/exam',
      dashboard: '/dashboard',
      book: '/book',
      skeleton: '/skeleton',
      examcoach: '/coach',
      examprep: '/prep',
      notes: '/notes',
      board: '/board',
      tasks: '/tasks',
      audio: '/audio',
      settings: '/settings',
      review: '/review',
    };

    for (const pageMeta of PAGE_REGISTRY) {
      const cmdId = `cmd:page:${pageMeta.id}`;
      const found = items.find((i) => i.id === cmdId);
      assert.ok(found, `Missing slash command for view ${pageMeta.id}`);
      assert.equal(found.label, expectedSlashLabels[pageMeta.id], `Unexpected slash label for ${cmdId}`);
    }

    // Bilingual slash query matching via filterPaletteItems
    const matchFirst = (rawQuery) => {
      const parsed = PaletteMod.parsePaletteScope(rawQuery);
      assert.equal(parsed.scope, 'cmd');
      return PaletteMod.filterPaletteItems(items, parsed, [], 'zh')[0];
    };

    for (const [query, expectedId] of [
      ['/library', 'cmd:page:library'],
      ['/sources', 'cmd:page:sources'],
      ['/generate', 'cmd:page:generate'],
      ['/wrongbook', 'cmd:page:wrongbook'],
      ['/exam', 'cmd:page:exam'],
      ['/dashboard', 'cmd:page:dashboard'],
      ['/book', 'cmd:page:book'],
      ['/skeleton', 'cmd:page:skeleton'],
      ['/coach', 'cmd:page:examcoach'],
      ['/examcoach', 'cmd:page:examcoach'],
      ['/prep', 'cmd:page:examprep'],
      ['/examprep', 'cmd:page:examprep'],
      ['/notes', 'cmd:page:notes'],
      ['/笔记', 'cmd:page:notes'],
      ['/board', 'cmd:page:board'],
      ['/看板', 'cmd:page:board'],
      ['/tasks', 'cmd:page:tasks'],
      ['/audio', 'cmd:page:audio'],
      ['/settings', 'cmd:page:settings'],
      ['/review', 'cmd:page:review'],
      ['/compact', 'cmd:compact'],
      ['/hints', 'cmd:hints'],
      ['/sidebar', 'cmd:sidebar'],
    ]) {
      const hit = matchFirst(query);
      assert.equal(hit?.id, expectedId, `Query ${query} should match ${expectedId}, got ${hit?.id}`);
    }

    // Executing all 16 view slash commands navigates cleanly
    for (const pageMeta of PAGE_REGISTRY) {
      await items.find((i) => i.id === `cmd:page:${pageMeta.id}`).action();
    }
    assert.equal(navigated.length, 16);
    for (const pageMeta of PAGE_REGISTRY) {
      const entry = navigated.find((n) => n.page === pageMeta.id);
      assert.ok(entry, `Navigation missing for ${pageMeta.id}`);
      if (pageMeta.id === 'review') {
        assert.deepEqual(entry.ctx, { runId: 'run-64' });
      }
    }

    // Test /compact, /hints, /sidebar toggles in zh and en
    await items.find((i) => i.id === 'cmd:compact').action();
    assert.deepEqual(prefPatches.at(-1), { compactMode: true });
    assert.equal(notifications.at(-1)?.text, '紧凑布局已开启');

    await items.find((i) => i.id === 'cmd:hints').action();
    assert.deepEqual(prefPatches.at(-1), { showKeyHints: false });
    assert.equal(notifications.at(-1)?.text, '底部快捷键提示已隐藏');

    await items.find((i) => i.id === 'cmd:sidebar').action();
    assert.deepEqual(prefPatches.at(-1), { sidebarCollapsed: true });
    assert.equal(notifications.at(-1)?.text, '侧边栏已收起');

    // Rebuild in zh with toggled states -> toggle back
    const itemsZhOff = PaletteMod.buildPaletteItems(mockState, mockActions, [], mockHost);
    await itemsZhOff.find((i) => i.id === 'cmd:compact').action();
    assert.deepEqual(prefPatches.at(-1), { compactMode: false });
    assert.equal(notifications.at(-1)?.text, '紧凑布局已关闭');

    await itemsZhOff.find((i) => i.id === 'cmd:hints').action();
    assert.deepEqual(prefPatches.at(-1), { showKeyHints: true });
    assert.equal(notifications.at(-1)?.text, '底部快捷键提示已显示');

    await itemsZhOff.find((i) => i.id === 'cmd:sidebar').action();
    assert.deepEqual(prefPatches.at(-1), { sidebarCollapsed: false });
    assert.equal(notifications.at(-1)?.text, '侧边栏已展开');

    // Rebuild in en -> toggle on & off
    prefs.language = 'en';
    const itemsEn = PaletteMod.buildPaletteItems(mockState, mockActions, [], mockHost);
    await itemsEn.find((i) => i.id === 'cmd:compact').action();
    assert.equal(notifications.at(-1)?.text, 'Compact mode enabled');
    await itemsEn.find((i) => i.id === 'cmd:hints').action();
    assert.equal(notifications.at(-1)?.text, 'Footer key hints hidden');
    await itemsEn.find((i) => i.id === 'cmd:sidebar').action();
    assert.equal(notifications.at(-1)?.text, 'Sidebar collapsed');

    const itemsEnBack = PaletteMod.buildPaletteItems(mockState, mockActions, [], mockHost);
    await itemsEnBack.find((i) => i.id === 'cmd:compact').action();
    assert.equal(notifications.at(-1)?.text, 'Compact mode disabled');
    await itemsEnBack.find((i) => i.id === 'cmd:hints').action();
    assert.equal(notifications.at(-1)?.text, 'Footer key hints shown');
    await itemsEnBack.find((i) => i.id === 'cmd:sidebar').action();
    assert.equal(notifications.at(-1)?.text, 'Sidebar expanded');

    // Verify existing commands remain intact
    for (const existingId of ['cmd:theme', 'cmd:lang', 'cmd:ascii', 'cmd:math', 'cmd:recover']) {
      assert.ok(items.some((i) => i.id === existingId), `Existing command ${existingId} must remain intact`);
    }
  });

  test('2) PTY E2E (120x36 zh): /compact persists to tui.json, /notes jumps to notes, and SGR 1006 wheel scrolls selection', async () => {
    const boxDir = await makeTempDir('e2e-zh');
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

    const host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: async () => 'Stub',
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
      await tty.flush();

      // 1) Ctrl+K -> /compact + Enter -> toggles compactMode & persists to tui.json
      tty.send('\x0b');
      await tty.waitFor((s) => s.includes('命令面板'), { timeoutMs: 6_000, label: 'Palette open for /compact' });
      tty.send('/compact');
      const compactMatch = await tty.waitFor(
        (s) => s.includes('/compact') && s.includes('紧凑布局'),
        { timeoutMs: 6_000, label: '/compact visible' },
      );
      tty.assertHealthyScreen(compactMatch, 120, 36, 'Palette /compact (zh)');
      tty.send('\r');
      const afterCompact = await tty.waitFor(
        (s) => !s.includes('命令面板') && useTuiStore.getState().preferences.compactMode === true && s.includes('紧凑布局已开启'),
        { timeoutMs: 6_000, label: '/compact toggled live' },
      );
      tty.assertHealthyScreen(afterCompact, 120, 36, 'After /compact toggle (zh)');
      const persistedAfterCompact = await waitForPersistedPref(
        dshHome,
        (p) => p.compactMode === true,
        'compactMode === true',
      );
      assert.equal(persistedAfterCompact.compactMode, true);

      // 2) Ctrl+K -> /notes + Enter -> jumps directly to notes
      tty.send('\x0b');
      await tty.waitFor((s) => s.includes('命令面板'), { timeoutMs: 6_000, label: 'Palette open for /notes' });
      tty.send('/notes');
      const notesMatch = await tty.waitFor(
        (s) => s.includes('/notes') && s.includes('学习笔记'),
        { timeoutMs: 6_000, label: '/notes visible' },
      );
      tty.assertHealthyScreen(notesMatch, 120, 36, 'Palette /notes (zh)');
      tty.send('\r');
      const notesScreen = await tty.waitFor(
        (s) => !s.includes('命令面板') && useTuiStore.getState().page === 'notes',
        { timeoutMs: 6_000, label: 'Navigated to notes via /notes' },
      );
      tty.assertHealthyScreen(notesScreen, 120, 36, 'NotesView via /notes (zh)');

      // 3) Ctrl+K -> SGR 1006 mouse wheel down/up moves highlighted row cleanly
      tty.send('\x0b');
      await tty.waitFor((s) => s.includes('命令面板'), { timeoutMs: 6_000, label: 'Palette open for SGR mouse wheel' });
      await tty.waitFor(
        () => tty.readLines().some((l) => l.includes('❯ ')),
        { timeoutMs: 6_000, label: 'Highlighted row visible' },
      );

      const findSelectedRow = () => {
        const lines = tty.readLines();
        const modalTop = lines.findIndex((l) => l.includes('命令面板'));
        const modalBottom = lines.findIndex((l, idx) => idx > modalTop && l.includes('Enter 执行'));
        for (let row = Math.max(0, modalTop + 1); row < (modalBottom > 0 ? modalBottom : lines.length); row += 1) {
          if (lines[row].includes('❯ ')) {
            return { row, line: lines[row].trim() };
          }
        }
        return { row: -1, line: '' };
      };

      const initialSel = findSelectedRow();
      assert.ok(initialSel.row >= 0, 'Initial selected row must be visible');

      // Wheel down (\x1b[<65;10;10M -> +3)
      tty.send('\x1b[<65;10;10M');
      const afterWheelDownScreen = await tty.waitFor(
        () => {
          const cur = findSelectedRow();
          return cur.row > initialSel.row && cur.line !== initialSel.line;
        },
        { timeoutMs: 6_000, label: 'SGR wheel down moved highlight down' },
      );
      tty.assertHealthyScreen(afterWheelDownScreen, 120, 36, 'Palette after SGR wheel down (zh)');
      const downSel = findSelectedRow();
      assert.equal(downSel.row - initialSel.row, 3, 'SGR wheel down should advance selection by 3 rows');

      // Wheel up (\x1b[<64;10;10M -> -3)
      tty.send('\x1b[<64;10;10M');
      const afterWheelUpScreen = await tty.waitFor(
        () => {
          const cur = findSelectedRow();
          return cur.row === initialSel.row && cur.line === initialSel.line;
        },
        { timeoutMs: 6_000, label: 'SGR wheel up moved highlight back to top' },
      );
      tty.assertHealthyScreen(afterWheelUpScreen, 120, 36, 'Palette after SGR wheel up (zh)');

      // Wheel up at index 0 stays clamped cleanly
      tty.send('\x1b[<64;10;10M');
      await tty.flush();
      assert.deepEqual(findSelectedRow(), initialSel, 'SGR wheel up at top must clamp at index 0');

      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('命令面板'), { timeoutMs: 5_000, label: 'Palette closed' });
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

  test('3) PTY E2E (80x24 --ascii en): /sidebar and /board work with assertHealthyScreen + assertAsciiPure', async () => {
    const boxDir = await makeTempDir('e2e-en-ascii');
    const dshHome = join(boxDir, 'dsh-home');
    const libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;
    await H.saveTuiPreferences({ language: 'en', asciiMode: true }, { env: { DSH_HOME: dshHome } });

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

    const host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: async () => 'Stub',
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(80, 24);
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
        { label: 'Launchpad en --ascii 80x24' },
      );

      tty.send('s');
      await tty.waitFor(
        (s) => !s.includes('Load the sample course') && s.includes('Sample'),
        { timeoutMs: 12_000, label: 'Library en after sample load' },
      );

      // Ctrl+K -> /sidebar + Enter
      tty.send('\x0b');
      const paletteSidebar = await tty.waitFor(
        (s) => s.includes('Command Palette'),
        { timeoutMs: 6_000, label: 'Palette open 80x24 (en)' },
      );
      tty.assertHealthyScreen(paletteSidebar, 80, 24, 'Palette open 80x24 (en)');
      tty.assertAsciiPure(paletteSidebar, 'Palette open 80x24 (en)');

      tty.send('/sidebar');
      await tty.waitFor(
        (s) => s.includes('/sidebar') && s.includes('Toggle sidebar'),
        { timeoutMs: 6_000, label: '/sidebar visible 80x24 (en)' },
      );
      tty.send('\r');
      const afterSidebar = await tty.waitFor(
        (s) =>
          !s.includes('Command Palette') &&
          useTuiStore.getState().preferences.sidebarCollapsed === true &&
          s.includes('Sidebar collapsed'),
        { timeoutMs: 6_000, label: '/sidebar toggled 80x24 (en)' },
      );
      tty.assertHealthyScreen(afterSidebar, 80, 24, 'After /sidebar at 80x24 (en)');
      tty.assertAsciiPure(afterSidebar, 'After /sidebar at 80x24 (en)');

      const persistedSidebar = await waitForPersistedPref(
        dshHome,
        (p) => p.sidebarCollapsed === true,
        'sidebarCollapsed === true',
      );
      assert.equal(persistedSidebar.sidebarCollapsed, true);

      // Ctrl+K -> /board + Enter
      tty.send('\x0b');
      await tty.waitFor(
        (s) => s.includes('Command Palette'),
        { timeoutMs: 6_000, label: 'Palette open for /board 80x24 (en)' },
      );
      tty.send('/board');
      const boardFiltered = await tty.waitFor(
        (s) => s.includes('/board') && s.includes('Board'),
        { timeoutMs: 6_000, label: '/board visible 80x24 (en)' },
      );
      tty.assertHealthyScreen(boardFiltered, 80, 24, 'Palette /board at 80x24 (en)');
      tty.assertAsciiPure(boardFiltered, 'Palette /board at 80x24 (en)');
      tty.send('\r');

      const boardScreen = await tty.waitFor(
        (s) => !s.includes('Command Palette') && useTuiStore.getState().page === 'board',
        { timeoutMs: 6_000, label: 'Navigated to board via /board 80x24 (en)' },
      );
      tty.assertHealthyScreen(boardScreen, 80, 24, 'BoardView via /board at 80x24 (en)');
      tty.assertAsciiPure(boardScreen, 'BoardView via /board at 80x24 (en)');
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
