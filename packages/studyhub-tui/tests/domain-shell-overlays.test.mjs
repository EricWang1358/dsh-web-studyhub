// Consolidated Shell Overlays Domain Suite (CommandPalette, HelpOverlay, SelectList & InboxModal):
// Merged from: round51-palette-cmds, round64-palette-slash, round65-select-inbox
// `node --test tests/domain-shell-overlays.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path, { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import {
  cloneSampleLibrary,
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  findExportedBackupFile,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost, saveTuiPreferences, loadTuiPreferences, hostMod } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(loadTuiPreferences, 'dist/ must export loadTuiPreferences');
assert.ok(hostMod?.tuiPreferencesPath, 'dist/host.mjs must export tuiPreferencesPath');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const storeFile = distFiles.find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const storeMod = await import(pathToFileURL(join(distDir, storeFile)).href);
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;
assert.ok(useTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-tui-dom-overlays-');

// Bundle CommandPalette, HelpOverlay, SelectList, PAGE_REGISTRY & store once for unit/component verification
const bundleDir = await temps.make('bundle');
const bundleFile = join(bundleDir, 'overlays.mjs');
await build({
  stdin: {
    contents: [
      `export { buildPaletteItems, filterPaletteItems, parsePaletteScope } from './src/shell/CommandPalette.tsx';`,
      `export { fuzzyFilter } from './src/shell/fuzzy.ts';`,
      `export { featureShortcuts } from './src/shell/HelpOverlay.tsx';`,
      `export { SelectList } from './src/components/SelectList.tsx';`,
      `export { PAGE_REGISTRY } from './src/types/contracts.ts';`,
      `export { useTuiStore as UnitStore, DEFAULT_PREFERENCES as UNIT_DEFAULT_PREFERENCES } from './src/state/store.ts';`,
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
const OverlayMod = await import(pathToFileURL(bundleFile).href);
assert.ok(OverlayMod.buildPaletteItems, 'bundle must export buildPaletteItems');
assert.ok(OverlayMod.filterPaletteItems, 'bundle must export filterPaletteItems');
assert.ok(OverlayMod.parsePaletteScope, 'bundle must export parsePaletteScope');
assert.ok(OverlayMod.fuzzyFilter, 'bundle must export fuzzyFilter');
assert.ok(OverlayMod.featureShortcuts, 'bundle must export featureShortcuts');
assert.ok(OverlayMod.SelectList, 'bundle must export SelectList');
assert.ok(Array.isArray(OverlayMod.PAGE_REGISTRY), 'bundle must export PAGE_REGISTRY');
const { PAGE_REGISTRY } = OverlayMod;

function resetTuiStore(language = 'zh', asciiMode = false, extra = {}) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    desktopConfig: null,
    loading: true,
    refreshing: false,
    lastError: null,
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
      recentCommands: [...DEFAULT_PREFERENCES.recentCommands],
      language,
      asciiMode,
    },
    ...extra,
  });
}

function todayLocalYmd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function waitForPersistedPref(dshHome, tty, predicate, label) {
  const deadline = Date.now() + 4_000;
  const tuiJsonPath = hostMod.tuiPreferencesPath({ env: { DSH_HOME: dshHome } });
  let lastPrefs = null;
  while (Date.now() < deadline) {
    if (fs.existsSync(tuiJsonPath)) {
      try {
        lastPrefs = JSON.parse(fs.readFileSync(tuiJsonPath, 'utf8'));
        if (predicate(lastPrefs)) return lastPrefs;
      } catch {
        // Retry while atomic rename settles
      }
    }
    await tty.flush(20);
  }
  throw new Error(`Timed out waiting for persisted tui.json (${label}); last=${JSON.stringify(lastPrefs)}`);
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
  const frameListeners = new Set();
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim().length > 0) {
      frames.push(plain);
      for (const fn of [...frameListeners]) fn();
    }
  });

  const inst = render(element, {
    stdout,
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  async function flushTicks() {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  async function waitForFrame(predicate, label = 'frame', timeoutMs = 2_000) {
    if (predicate(frames.at(-1) ?? '')) return frames.at(-1) ?? '';
    return new Promise((resolveWait, rejectWait) => {
      let settled = false;
      const onFrame = () => {
        if (settled) return;
        const f = frames.at(-1) ?? '';
        if (predicate(f)) {
          settled = true;
          frameListeners.delete(onFrame);
          clearTimeout(timer);
          resolveWait(f);
        }
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        frameListeners.delete(onFrame);
        rejectWait(new Error(`Timed out waiting for ${label}; lastFrame:\n${frames.at(-1) ?? ''}`));
      }, timeoutMs);
      frameListeners.add(onFrame);
      setImmediate(onFrame);
    });
  }

  async function send(seq, predicate) {
    stdin.write(seq);
    if (predicate) {
      const frame = await waitForFrame(predicate, `SelectList ${JSON.stringify(seq)}`);
      await flushTicks();
      return frame;
    }
    await flushTicks();
    return frames.at(-1) ?? '';
  }

  function lastFrame() {
    return frames.at(-1) ?? '';
  }

  function cleanup() {
    frameListeners.clear();
    inst.unmount();
    stdin.destroy();
    stdout.destroy();
  }

  return { send, waitForFrame, flushTicks, lastFrame, cleanup };
}

after(async () => {
  resetTuiStore('zh', false);
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

describe('Domain Shell Overlays: CommandPalette, HelpOverlay, SelectList & InboxModal', () => {
  describe('CommandPalette Slash Commands & HelpOverlay Sync (Round 51)', () => {
    test('1) buildPaletteItems exposes /ascii, /math, /recover & direct page slash commands with 0 model calls and 0 duplicate IDs', async () => {
      const dshHome = await temps.make('r51-unit-dsh');
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

      const items = OverlayMod.buildPaletteItems(mockState, mockActions, [], mockHost);
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

      const parsedRecover = OverlayMod.parsePaletteScope('/recover');
      assert.equal(parsedRecover.scope, 'cmd');
      assert.equal(parsedRecover.term, 'recover');
      const cmdPool = items.filter((i) => i.id.startsWith('cmd:') || i.label.startsWith('/'));
      const filtered = OverlayMod.fuzzyFilter(
        cmdPool,
        parsedRecover.term,
        (i) => i.label,
        (i) => [...(i.keywords ?? []), i.hint ?? ''],
      );
      assert.equal(filtered[0]?.item.id, 'cmd:recover', '/recover must match cmd:recover first');

      const recoverItem = items.find((i) => i.id === 'cmd:recover');
      await recoverItem.action();
      assert.deepEqual(hostCalls, [{ action: 'coverage.recover', args: {} }]);
      assert.equal(refreshed.length, 1);
      assert.ok(notifications.some((n) => n.text.includes('已恢复 2 个中断任务') && n.tone === 'success'));
      assert.equal(modelCalls, 0, '/recover must execute with 0 model calls');

      await items.find((i) => i.id === 'cmd:ascii').action();
      assert.deepEqual(prefPatches[0], { asciiMode: true });
      await items.find((i) => i.id === 'cmd:math').action();
      assert.deepEqual(prefPatches[1], { mathUnicode: false });

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

      for (const lang of ['zh', 'en']) {
        const sections = OverlayMod.featureShortcuts(lang);
        assert.equal(sections.length, 15, `HelpOverlay must keep exactly 15 sections (${lang})`);
        const sourcesSec = sections.find((s) => s.title.includes('Sources'));
        const tasksAudioSec = sections.find((s) => s.title.includes('Tasks') && s.title.includes('Audio'));
        const paletteSec = sections.find((s) => s.title.includes('Palette'));
        assert.ok(sourcesSec?.items.some((i) => i.key === 't'), `Missing t in Sources & Reader (${lang})`);
        assert.ok(tasksAudioSec?.items.some((i) => i.key === 'c'), `Missing c in Tasks & Audio (${lang})`);
        assert.ok(paletteSec?.items.some((i) => i.key === '/ascii /math /recover'), `Missing /ascii /math /recover in Palette (${lang})`);
        assert.ok(paletteSec?.items.some((i) => i.key === '/due /theme /lang'), `Missing /due /theme /lang in Palette (${lang})`);
      }
    });

    test('2) PTY E2E (zh, 120x36 & 80x24): /recover toast, /ascii toggle, /book, Ctrl+N/P, and HelpOverlay', async () => {
      const boxDir = await temps.make('r51-e2e-zh');
      const dshHome = join(boxDir, 'dsh-home');
      const libraryRoot = join(boxDir, 'library');
      process.env.DSH_HOME = dshHome;
      resetTuiStore('zh', false);

      let modelCalls = 0;
      await cloneSampleLibrary('zh', libraryRoot);
      const host = await createTuiHost({
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
      let inkInstance = null;
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          autoLaunchpad: false,
          onExit: () => inkInstance?.unmount(),
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
          (s) => !useTuiStore.getState().loading && (s.includes('示例 · Memento') || s.includes('Sample · Memento')),
          { timeoutMs: 25_000, label: 'Library after sample load' },
        );
        await tty.flush(20);

        // Open Ctrl+K -> type /recover + Enter -> toast appears
        tty.send('\x0b');
        await tty.waitFor(
          (s) => s.includes('命令面板'),
          { timeoutMs: 6_000, label: 'CommandPalette open for /recover' },
        );
        assert.equal(useTuiStore.getState().commandPaletteOpen, true);
        tty.send('/recover');
        const recoverFiltered = await tty.waitFor(
          (s) => s.includes('/recover') && s.includes('恢复中断'),
          { timeoutMs: 6_000, label: '/recover item visible' },
        );
        tty.assertHealthyScreen(recoverFiltered, 120, 36, 'CommandPalette /recover (zh)');
        assert.ok(recoverFiltered.includes('/recover'));
        tty.send('\r');
        const recoverToast = await tty.waitFor(
          (s) => !s.includes('命令面板') && (s.includes('当前没有可恢复的中断任务') || s.includes('已恢复')),
          { timeoutMs: 6_000, label: '/recover notification toast' },
        );
        tty.assertHealthyScreen(recoverToast, 120, 36, 'After /recover toast (zh)');
        assert.ok(recoverToast.includes('当前没有可恢复的中断任务') || recoverToast.includes('已恢复'));
        assert.equal(useTuiStore.getState().commandPaletteOpen, false);

        // Open Ctrl+K -> test Ctrl+N (\x0e) and Ctrl+P (\x10) selection movement -> type /ascii + Enter
        tty.send('\x0b');
        await tty.waitFor(
          (s) => s.includes('命令面板'),
          { timeoutMs: 6_000, label: 'CommandPalette open for Ctrl+N/P & /ascii' },
        );
        tty.send('\x0e');
        await tty.flush(20);
        tty.send('\x10');
        await tty.flush(20);
        tty.send('/ascii');
        const asciiFiltered = await tty.waitFor(
          (s) => s.includes('/ascii') && s.includes('开启 ASCII'),
          { timeoutMs: 6_000, label: '/ascii item visible' },
        );
        tty.assertHealthyScreen(asciiFiltered, 120, 36, 'CommandPalette /ascii (zh)');
        await tty.flush(20);
        tty.send('\r');
        const asciiToast = await tty.waitFor(
          (s) => !s.includes('命令面板') && useTuiStore.getState().preferences.asciiMode === true && s.includes('ASCII'),
          { timeoutMs: 6_000, label: '/ascii toggled live' },
        );
        tty.assertHealthyScreen(asciiToast, 120, 36, 'After /ascii toggle (zh)');
        tty.assertAsciiPure(asciiToast, 'After /ascii toggle (zh)');
        assert.ok(asciiToast.includes('ASCII'));
        assert.equal(useTuiStore.getState().preferences.asciiMode, true);

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
        assert.equal(useTuiStore.getState().page, 'book');
        assert.equal(useTuiStore.getState().commandPaletteOpen, false);

        // Open Ctrl+K -> type /math + Enter at 80x24 (while asciiMode is active)
        tty.send('\x0b');
        await tty.waitFor((s) => s.includes('命令面板'), { timeoutMs: 6_000, label: 'CommandPalette open for /math at 80x24' });
        tty.send('/math');
        await tty.waitFor((s) => s.includes('/math'), { timeoutMs: 6_000, label: '/math visible at 80x24' });
        tty.send('\r');
        const mathToast = await tty.waitFor(
          (s) => !s.includes('命令面板') && useTuiStore.getState().preferences.mathUnicode === false,
          { timeoutMs: 6_000, label: '/math toggled live at 80x24' },
        );
        tty.assertHealthyScreen(mathToast, 80, 24, 'After /math at 80x24 (zh, ascii)');
        tty.assertAsciiPure(mathToast, 'After /math at 80x24 (zh, ascii)');
        assert.equal(useTuiStore.getState().preferences.mathUnicode, false);
        assert.equal(useTuiStore.getState().commandPaletteOpen, false);
        const persistedR51 = await waitForPersistedPref(
          dshHome,
          tty,
          (p) => p.asciiMode === true && p.mathUnicode === false,
          'asciiMode === true && mathUnicode === false',
        );
        assert.equal(persistedR51.asciiMode, true);
        assert.equal(persistedR51.mathUnicode, false);

        // Open HelpOverlay (?) and scroll to verify Round 51 entries render cleanly
        tty.resize(120, 36);
        tty.send('?');
        const helpScreen = await tty.waitFor(
          (s) => s.includes('快捷键'),
          { timeoutMs: 6_000, label: 'HelpOverlay open' },
        );
        tty.assertHealthyScreen(helpScreen, 120, 36, 'HelpOverlay (zh, ascii)');
        tty.assertAsciiPure(helpScreen, 'HelpOverlay (zh, ascii)');
        tty.send('G');
        const helpBottom = await tty.waitFor(
          (s) => s.includes('双语翻译') || s.includes('复核音频') || s.includes('/ascii'),
          { timeoutMs: 6_000, label: 'HelpOverlay Round 51 entries visible' },
        );
        tty.assertHealthyScreen(helpBottom, 120, 36, 'HelpOverlay bottom Round 51 entries');
        tty.assertAsciiPure(helpBottom, 'HelpOverlay bottom Round 51 entries');
        assert.equal(useTuiStore.getState().helpOpen, true);
        tty.send('\x1b');
        await tty.waitFor((s) => !s.includes('快捷键'), { timeoutMs: 5_000, label: 'HelpOverlay closed' });
        assert.equal(useTuiStore.getState().helpOpen, false);

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
  });

  describe('CommandPalette 16/16 View Slash Commands, Toggles & SGR Mouse Wheel (Round 64)', () => {
    test('1) buildPaletteItems covers all 16/16 views with bilingual slash queries and live /compact, /hints, /sidebar toggles', async () => {
      const dshHome = await temps.make('r64-unit-dsh');
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

      const items = OverlayMod.buildPaletteItems(mockState, mockActions, [], mockHost);
      const ids = items.map((i) => i.id);
      assert.equal(new Set(ids).size, ids.length, 'buildPaletteItems must have zero duplicate IDs');

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

      const matchFirst = (rawQuery) => {
        const parsed = OverlayMod.parsePaletteScope(rawQuery);
        assert.equal(parsed.scope, 'cmd');
        return OverlayMod.filterPaletteItems(items, parsed, [], 'zh')[0];
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

      await items.find((i) => i.id === 'cmd:compact').action();
      assert.deepEqual(prefPatches.at(-1), { compactMode: true });
      assert.equal(notifications.at(-1)?.text, '紧凑布局已开启');

      await items.find((i) => i.id === 'cmd:hints').action();
      assert.deepEqual(prefPatches.at(-1), { showKeyHints: false });
      assert.equal(notifications.at(-1)?.text, '底部快捷键提示已隐藏');

      await items.find((i) => i.id === 'cmd:sidebar').action();
      assert.deepEqual(prefPatches.at(-1), { sidebarCollapsed: true });
      assert.equal(notifications.at(-1)?.text, '侧边栏已收起');

      const itemsZhOff = OverlayMod.buildPaletteItems(mockState, mockActions, [], mockHost);
      await itemsZhOff.find((i) => i.id === 'cmd:compact').action();
      assert.deepEqual(prefPatches.at(-1), { compactMode: false });
      assert.equal(notifications.at(-1)?.text, '紧凑布局已关闭');

      await itemsZhOff.find((i) => i.id === 'cmd:hints').action();
      assert.deepEqual(prefPatches.at(-1), { showKeyHints: true });
      assert.equal(notifications.at(-1)?.text, '底部快捷键提示已显示');

      await itemsZhOff.find((i) => i.id === 'cmd:sidebar').action();
      assert.deepEqual(prefPatches.at(-1), { sidebarCollapsed: false });
      assert.equal(notifications.at(-1)?.text, '侧边栏已展开');

      prefs.language = 'en';
      const itemsEn = OverlayMod.buildPaletteItems(mockState, mockActions, [], mockHost);
      await itemsEn.find((i) => i.id === 'cmd:compact').action();
      assert.equal(notifications.at(-1)?.text, 'Compact mode enabled');
      await itemsEn.find((i) => i.id === 'cmd:hints').action();
      assert.equal(notifications.at(-1)?.text, 'Footer key hints hidden');
      await itemsEn.find((i) => i.id === 'cmd:sidebar').action();
      assert.equal(notifications.at(-1)?.text, 'Sidebar collapsed');

      const itemsEnBack = OverlayMod.buildPaletteItems(mockState, mockActions, [], mockHost);
      await itemsEnBack.find((i) => i.id === 'cmd:compact').action();
      assert.equal(notifications.at(-1)?.text, 'Compact mode disabled');
      await itemsEnBack.find((i) => i.id === 'cmd:hints').action();
      assert.equal(notifications.at(-1)?.text, 'Footer key hints shown');
      await itemsEnBack.find((i) => i.id === 'cmd:sidebar').action();
      assert.equal(notifications.at(-1)?.text, 'Sidebar expanded');

      const themeChanges = [];
      const langChanges = [];
      const hostLangChanges = [];
      const hostCalls = [];
      let dueDecksInSnapshot = [
        { id: 'deck-low', title: 'Low Due Deck', course: 'OS', due: 1, archived: false },
        { id: 'deck-top', title: 'Top Due Deck', course: 'OS', due: 6, archived: false },
      ];
      const mockHostWithTrackers = {
        ...mockHost,
        setLanguage: (l) => hostLangChanges.push(l),
        call: async (action, payload) => {
          hostCalls.push({ action, payload });
          if (action === 'snapshot') {
            return { ok: true, value: { decks: dueDecksInSnapshot, progress: {} } };
          }
          if (action === 'review.start' && payload?.mode === 'due' && payload?.deckId === 'deck-top') {
            return { ok: true, value: { id: 'run-due-80' } };
          }
          return { ok: true, value: {} };
        },
      };
      mockState.setTheme = (th) => {
        prefs.theme = th;
        themeChanges.push(th);
      };
      mockState.setLanguage = (l) => {
        prefs.language = l;
        langChanges.push(l);
      };
      mockState.snapshot = { decks: dueDecksInSnapshot, progress: {}, course: 'OS' };

      const itemsR80 = OverlayMod.buildPaletteItems(mockState, mockActions, [], mockHostWithTrackers);
      await itemsR80.find((i) => i.id === 'cmd:theme').action();
      assert.equal(themeChanges.at(-1), 'warm-paper');
      assert.match(notifications.at(-1)?.text ?? '', /warm-paper/);

      await itemsR80.find((i) => i.id === 'cmd:theme:nord').action();
      assert.equal(themeChanges.at(-1), 'nord');
      assert.match(notifications.at(-1)?.text ?? '', /nord/);

      await itemsR80.find((i) => i.id === 'cmd:lang').action();
      assert.equal(langChanges.at(-1), 'zh');
      assert.equal(hostLangChanges.at(-1), 'zh', '/lang must sync host.setLanguage');
      assert.equal(notifications.at(-1)?.text, '界面语言：简体中文');

      await itemsR80.find((i) => i.id === 'cmd:due').action();
      assert.deepEqual(hostCalls.at(-1), {
        action: 'review.start',
        payload: { mode: 'due', deckId: 'deck-top' },
      });
      assert.deepEqual(navigated.at(-1), { page: 'review', ctx: { runId: 'run-due-80', deckId: 'deck-top' } });

      // Empty due queue must NOT call review.start and must show an actionable info toast
      dueDecksInSnapshot = [{ id: 'deck-done', title: 'Done Deck', course: 'OS', due: 0, archived: false }];
      mockState.snapshot = { decks: dueDecksInSnapshot, progress: {}, course: 'OS' };
      const callCountBeforeEmptyDue = hostCalls.length;
      const itemsEmptyDue = OverlayMod.buildPaletteItems(mockState, mockActions, [], mockHostWithTrackers);
      await itemsEmptyDue.find((i) => i.id === 'cmd:due').action();
      assert.equal(hostCalls.length, callCountBeforeEmptyDue, 'Empty due queue must not call review.start');
      assert.equal(notifications.at(-1)?.tone, 'info');
      assert.match(notifications.at(-1)?.text ?? '', /没有到期|No cards are due/i);

      for (const existingId of ['cmd:theme', 'cmd:lang', 'cmd:ascii', 'cmd:math', 'cmd:recover', 'cmd:due']) {
        assert.ok(items.some((i) => i.id === existingId), `Existing command ${existingId} must remain intact`);
      }
    });

    test('2) PTY E2E (120x36 zh): /compact persists to tui.json, /notes jumps to notes, and SGR 1006 wheel scrolls selection', async () => {
      const boxDir = await temps.make('r64-e2e-zh');
      const dshHome = join(boxDir, 'dsh-home');
      const libraryRoot = join(boxDir, 'library');
      process.env.DSH_HOME = dshHome;
      resetTuiStore('zh', false);

      await cloneSampleLibrary('zh', libraryRoot);
      const host = await createTuiHost({
        env: { DSH_HOME: dshHome },
        home: join(boxDir, 'home'),
        libraryRoot,
        injectedComplete: async () => 'Stub',
        skipAutoProbe: true,
        language: 'zh',
        eventDebounceMs: 30,
      });

      const tty = createVirtualTty(120, 36);
      let inkInstance = null;
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          autoLaunchpad: false,
          onExit: () => inkInstance?.unmount(),
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
          (s) => !useTuiStore.getState().loading && (s.includes('示例 · Memento') || s.includes('Sample · Memento')),
          { timeoutMs: 25_000, label: 'Library after sample load' },
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
          tty,
          (p) => p.compactMode === true,
          'compactMode === true',
        );
        assert.equal(persistedAfterCompact.compactMode, true);
        assert.equal(useTuiStore.getState().preferences.compactMode, true);

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
        assert.equal(useTuiStore.getState().page, 'notes');

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

        tty.send('\x1b[<64;10;10M');
        const afterWheelUpScreen = await tty.waitFor(
          () => {
            const cur = findSelectedRow();
            return cur.row === initialSel.row && cur.line === initialSel.line;
          },
          { timeoutMs: 6_000, label: 'SGR wheel up moved highlight back to top' },
        );
        tty.assertHealthyScreen(afterWheelUpScreen, 120, 36, 'Palette after SGR wheel up (zh)');

        tty.send('\x1b[<64;10;10M');
        await tty.flush(15);
        assert.deepEqual(findSelectedRow(), initialSel, 'SGR wheel up at top must clamp at index 0');

        tty.send('\x1b');
        await tty.waitFor((s) => !s.includes('命令面板'), { timeoutMs: 5_000, label: 'Palette closed' });
        assert.equal(useTuiStore.getState().commandPaletteOpen, false);

        // 4) Resize 80x24 -> /sidebar persists to tui.json & /board jumps to board
        tty.resize(80, 24);
        tty.send('\x0b');
        const paletteNarrow = await tty.waitFor(
          (s) => s.includes('命令面板'),
          { timeoutMs: 6_000, label: 'Palette open 80x24 (zh)' },
        );
        tty.assertHealthyScreen(paletteNarrow, 80, 24, 'Palette open 80x24 (zh)');

        tty.send('/sidebar');
        await tty.waitFor(
          (s) => s.includes('/sidebar') && s.includes('侧栏'),
          { timeoutMs: 6_000, label: '/sidebar visible 80x24 (zh)' },
        );
        tty.send('\r');
        const afterSidebar = await tty.waitFor(
          (s) =>
            !s.includes('命令面板') &&
            useTuiStore.getState().preferences.sidebarCollapsed === true &&
            s.includes('侧边栏已收起'),
          { timeoutMs: 6_000, label: '/sidebar toggled 80x24 (zh)' },
        );
        tty.assertHealthyScreen(afterSidebar, 80, 24, 'After /sidebar at 80x24 (zh)');
        assert.equal(useTuiStore.getState().preferences.sidebarCollapsed, true);

        const persistedSidebar = await waitForPersistedPref(
          dshHome,
          tty,
          (p) => p.sidebarCollapsed === true,
          'sidebarCollapsed === true',
        );
        assert.equal(persistedSidebar.sidebarCollapsed, true);

        tty.send('\x0b');
        await tty.waitFor((s) => s.includes('命令面板'), { timeoutMs: 6_000, label: 'Palette open for /board 80x24 (zh)' });
        tty.send('/board');
        const boardFiltered = await tty.waitFor(
          (s) => s.includes('/board') && s.includes('待办看板'),
          { timeoutMs: 6_000, label: '/board visible 80x24 (zh)' },
        );
        tty.assertHealthyScreen(boardFiltered, 80, 24, 'Palette /board at 80x24 (zh)');
        tty.send('\r');

        const boardScreen = await tty.waitFor(
          (s) => !s.includes('命令面板') && useTuiStore.getState().page === 'board',
          { timeoutMs: 6_000, label: 'Navigated to board via /board 80x24 (zh)' },
        );
        tty.assertHealthyScreen(boardScreen, 80, 24, 'BoardView via /board at 80x24 (zh)');
        assert.equal(useTuiStore.getState().page, 'board');
        assert.equal(useTuiStore.getState().commandPaletteOpen, false);
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

  describe('SelectList SGR Wheel + Page Nav & InboxModal Search/Export (Round 65)', () => {
    test('1) SelectList supports SGR 1006 mouse wheel down/up, Ctrl+D/Ctrl+U/PageUp/PageDown, skips disabled options cleanly, and clamps without wrapping', async () => {
      const disabledSet = new Set([1, 4, 7, 12, 13]);
      const options = Array.from({ length: 14 }, (_, i) => ({
        value: `opt-${i}`,
        label: `Option-${String(i).padStart(2, '0')}`,
        disabled: disabledSet.has(i),
      }));

      for (const ascii of [false, true]) {
        OverlayMod.UnitStore.setState({
          preferences: {
            ...OverlayMod.UNIT_DEFAULT_PREFERENCES,
            language: 'en',
            asciiMode: ascii,
          },
        });

        const seenChanges = [];
        const seenSelects = [];
        const h = createInkHarness(
          React.createElement(OverlayMod.SelectList, {
            options,
            maxHeight: 6,
            width: 36,
            onChange: (opt, idx) => seenChanges.push({ value: opt.value, idx }),
            onSelect: (opt, idx) => seenSelects.push({ value: opt.value, idx }),
          }),
        );

        try {
          const leadChar = ascii ? '>' : '❯';
          await h.waitForFrame((f) => f.includes(`${leadChar} 1 Option-00`), 'initial Option-00');
          await h.flushTicks();
          assert.ok(h.lastFrame().includes(`${leadChar} 1 Option-00`), `expected Option-00 initially selected:\n${h.lastFrame()}`);

          await h.send('\x1b[<65;5;5M', (f) => f.includes(`${leadChar} 6 Option-05`));
          assert.equal(seenChanges.at(-1)?.idx, 5);
          assert.ok(h.lastFrame().includes(`${leadChar} 6 Option-05`));

          await h.send('\x1b[<65;5;5M', (f) => f.includes(`${leadChar}   Option-09`));
          assert.equal(seenChanges.at(-1)?.idx, 9);

          await h.send('\x1b[<65;5;5M', (f) => f.includes(`${leadChar}   Option-11`));
          assert.equal(seenChanges.at(-1)?.idx, 11);

          const countAtBottom = seenChanges.length;
          await h.send('\x1b[<65;5;5M');
          assert.equal(seenChanges.length, countAtBottom);
          assert.equal(seenChanges.at(-1)?.idx, 11);

          await h.send('\x1b[<64;5;5M', (f) => f.includes(`${leadChar} 9 Option-08`));
          assert.equal(seenChanges.at(-1)?.idx, 8);

          await h.send('\x04', (f) => f.includes(`${leadChar}   Option-11`));
          assert.equal(seenChanges.at(-1)?.idx, 11);

          await h.send('\x15', (f) => f.includes(`${leadChar} 9 Option-08`));
          assert.equal(seenChanges.at(-1)?.idx, 8);

          await h.send('\x15', (f) => f.includes(`${leadChar} 4 Option-03`));
          assert.equal(seenChanges.at(-1)?.idx, 3);

          await h.send('\x15', (f) => f.includes(`${leadChar} 1 Option-00`));
          assert.equal(seenChanges.at(-1)?.idx, 0);

          const countAtTop = seenChanges.length;
          await h.send('\x1b[<64;5;5M');
          assert.equal(seenChanges.length, countAtTop);

          await h.send('\x1b[6~', (f) => f.includes(`${leadChar} 6 Option-05`));
          assert.equal(seenChanges.at(-1)?.idx, 5);
          await h.send('\x1b[5~', (f) => f.includes(`${leadChar} 1 Option-00`));
          assert.equal(seenChanges.at(-1)?.idx, 0);

          await h.send('j', (f) => f.includes(`${leadChar} 3 Option-02`));
          assert.equal(seenChanges.at(-1)?.idx, 2);
          await h.send('\r', () => seenSelects.at(-1)?.idx === 2);
          assert.deepEqual(seenSelects.at(-1), { value: 'opt-2', idx: 2 });
        } finally {
          h.cleanup();
        }
      }
    });

    test('2) PTY E2E (120x36 zh): InboxModal / filter -> Enter -> [e] atomic inbox.raw export -> Esc closes (0 model calls)', async () => {
      const boxDir = await temps.make('r65-pty-zh');
      const dshHome = join(boxDir, 'dsh-home');
      const libraryRoot = join(boxDir, 'library');
      process.env.DSH_HOME = dshHome;
      resetTuiStore('zh', false);

      let modelCalls = 0;
      await cloneSampleLibrary('zh', libraryRoot);
      const host = await createTuiHost({
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
      let inkInstance = null;
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          autoLaunchpad: false,
          onExit: () => inkInstance?.unmount(),
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
          (s) => !useTuiStore.getState().loading && (s.includes('示例 · Memento') || s.includes('Sample · Memento')),
          { timeoutMs: 12_000, label: 'Library after sample load (zh)' },
        );
        await tty.flush(40);

        tty.send('I');
        const inboxInit = await tty.waitFor(
          (s) => s.includes('收件箱与通知') && s.includes('全部 (5)') && !s.includes('同步'),
          { timeoutMs: 8_000, label: 'InboxModal open (zh)' },
        );
        tty.assertHealthyScreen(inboxInit, 120, 36, 'InboxModal open (zh)');
        assert.equal(useTuiStore.getState().inboxOpen, true);
        assert.ok(inboxInit.includes('全部 (5)'));

        tty.send('/');
        await tty.flush();
        tty.send('grade');
        const filteredScreen = await tty.waitFor(
          (s) => s.includes('2/5') && s.includes('[批改完成]') && !s.includes('[笔记草稿]'),
          { timeoutMs: 6_000, label: 'Inbox filtered to 2/5 by grade (zh)' },
        );
        tty.assertHealthyScreen(filteredScreen, 120, 36, 'InboxModal filtered (zh)');
        assert.ok(filteredScreen.includes('2/5'));

        tty.send('\r');
        const afterEnterScreen = await tty.waitFor(
          (s) => s.includes('2/5') && s.includes('导出'),
          { timeoutMs: 6_000, label: 'Search blurred on Enter (zh)' },
        );
        tty.assertHealthyScreen(afterEnterScreen, 120, 36, 'InboxModal after Enter (zh)');

        const backupsDir = join(libraryRoot, 'backups');
        tty.send('e');
        const afterExport = await tty.waitFor(
          (s) => s.includes('已导出 5 条通知'),
          { timeoutMs: 8_000, label: 'Export toast & file on disk (zh)' },
        );
        tty.assertHealthyScreen(afterExport, 120, 36, 'InboxModal after export (zh)');

        const inboxExport = await findExportedBackupFile(backupsDir, 'studyhub-inbox', 'json', todayLocalYmd());
        assert.ok(inboxExport, `expected studyhub-inbox-${todayLocalYmd()}-HHmmss.json in ${backupsDir}`);
        const exportedRaw = JSON.parse(await readFile(inboxExport.path, 'utf8'));
        assert.equal(Array.isArray(exportedRaw), true, 'exported inbox.raw file must be a JSON array');
        assert.equal(exportedRaw.length, 5, 'exported inbox.raw JSON array must contain all 5 items');
        assert.ok(exportedRaw.every((item) => item && typeof item === 'object' && Object.keys(item).length > 0));
        assert.ok(afterExport.includes('已导出 5 条通知') || useTuiStore.getState().toasts.length >= 1);

        tty.send('c');
        await tty.waitFor(
          (s) => !s.includes('2/5') && s.includes('[笔记草稿]'),
          { timeoutMs: 6_000, label: 'Filter cleared with c (zh)' },
        );

        // Verify 80x24 viewport rendering before closing
        tty.resize(80, 24);
        const inboxNarrow = await tty.waitFor(
          (s) => s.includes('收件箱与通知') && s.split('\n').length <= 24,
          { timeoutMs: 6_000, label: 'InboxModal 80x24 (zh)' },
        );
        tty.assertHealthyScreen(inboxNarrow, 80, 24, 'InboxModal 80x24 (zh)');

        tty.send('\x1b');
        const afterClose = await tty.waitFor(
          (s) => !s.includes('收件箱与通知') && useTuiStore.getState().inboxOpen === false,
          { timeoutMs: 6_000, label: 'InboxModal closed (zh)' },
        );
        tty.assertHealthyScreen(afterClose, 80, 24, 'Library after InboxModal close (80x24 zh)');
        assert.equal(useTuiStore.getState().inboxOpen, false);
        assert.equal(useTuiStore.getState().page, 'library');
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
  });
});
