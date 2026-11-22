// Round 71 Track 2: LibraryView `/` Live Deck Search & Filter + Lazy `deck-export.ts` Split:
// `node --test --test-concurrency=1 tests/round71-library-filter.test.mjs`
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
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
let useDistTuiStore = null;
let DEFAULT_PREFERENCES = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!saveTuiPreferences && typeof mod.saveTuiPreferences === 'function') saveTuiPreferences = mod.saveTuiPreferences;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useDistTuiStore && typeof mod.useTuiStore?.getState === 'function') useDistTuiStore = mod.useTuiStore;
    if (!DEFAULT_PREFERENCES && mod.DEFAULT_PREFERENCES) DEFAULT_PREFERENCES = mod.DEFAULT_PREFERENCES;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useDistTuiStore, 'dist/ must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/ must export DEFAULT_PREFERENCES');

function resetDistStore(language = 'zh', asciiMode = false) {
  useDistTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    desktopConfig: null,
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
  });
}

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];

async function makeTempDir(label) {
  const d = await mkdtemp(join(os.tmpdir(), `studyhub-r71-filter-${label}-`));
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
    assert.ok(!screen.includes('\x1b'), `${label}: unparsed escape sequence leaked`);
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

describe('Round 71 Track 2: LibraryView `/` Live Deck Search & Filter', () => {
  test('1) @xterm/headless PTY E2E (120x36 zh): load sample -> `/` type "Bridge" -> verify filtered deck & badge -> Enter -> Esc clears filter (0 model calls)', async () => {
    const base = await makeTempDir('pty-zh');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'zh', asciiMode: false, theme: 'dsh-dark', mathUnicode: true, showHints: true },
      { env: { ...process.env, DSH_HOME: dshHome } },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: { ...process.env, DSH_HOME: dshHome },
      home: join(base, 'home'),
      documentsDir: base,
      skipAutoProbe: true,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'Stub';
      },
      language: 'zh',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(120, 36);
    let inkInst = null;
    try {
      resetDistStore('zh', false);
      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: true,
          onExit: () => inkInst?.unmount(),
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

      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('载入示例课程体验'), { label: 'zh Launchpad' });

      tty.send('s');
      const libScreen = await tty.waitFor(
        (s) =>
          !s.includes('载入示例课程体验') &&
          s.includes('示例 · Memento 与 Bridge') &&
          s.includes('示例案例 · 墨笺笔记') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === '/' && h.label === '筛选'),
        { timeoutMs: 12_000, label: 'zh LibraryView with sample decks & `/` hint' },
      );
      tty.assertHealthyScreen(libScreen, 120, 36, 'zh LibraryView 120x36');

      const totalDecks = (useDistTuiStore.getState().snapshot?.decks ?? []).filter((d) => !d.archived && !d.systemKind).length;
      assert.ok(totalDecks >= 2, `Expected >= 2 sample decks, got ${totalDecks}`);

      // Press '/' to open inline deck filter bar (must NOT open CommandPalette)
      tty.send('/');
      await tty.waitFor(
        (s) => !useDistTuiStore.getState().commandPaletteOpen && s.includes(`[筛选 ${totalDecks}/${totalDecks}]`),
        { timeoutMs: 5_000, label: 'zh LibraryView filter bar opened' },
      );

      // Type 'Bridge' (case-insensitive match across topics & title)
      tty.send('bridge');
      const topicFiltered = await tty.waitFor(
        (s) => s.includes(`[筛选 ${totalDecks}/${totalDecks}]`) && s.includes('示例 · Memento 与 Bridge'),
        { timeoutMs: 5_000, label: 'zh LibraryView topic filter for bridge' },
      );
      tty.assertHealthyScreen(topicFiltered, 120, 36, 'zh LibraryView topic filter');
      assert.equal(useDistTuiStore.getState().page, 'library', 'typing bridge must not navigate away');

      // Press Esc while editing to clear filter, then '/' + 'Memento 与 Bridge' to narrow to 1/2
      tty.send('\x1b');
      await tty.waitFor((s) => !s.includes('[筛选 '), { timeoutMs: 5_000, label: 'zh Esc clears while editing' });

      tty.send('/');
      await tty.waitFor((s) => s.includes(`[筛选 ${totalDecks}/${totalDecks}]`), { timeoutMs: 5_000, label: 'zh re-open filter bar' });
      tty.send('Memento 与 Bridge');
      const filteredEditing = await tty.waitFor(
        (s) =>
          s.includes(`[筛选 1/${totalDecks}]`) &&
          s.includes('示例 · Memento 与 Bridge') &&
          !s.includes('示例案例 · 墨笺笔记'),
        { timeoutMs: 5_000, label: 'zh LibraryView narrowed to 1 deck while editing' },
      );
      tty.assertHealthyScreen(filteredEditing, 120, 36, 'zh LibraryView filtered editing');

      // Press Enter to confirm/blur filter keeping filtered view active (not launching review)
      tty.send('\r');
      const filteredConfirmed = await tty.waitFor(
        (s) =>
          !useDistTuiStore.getState().inputCaptured &&
          s.includes(`[筛选 1/${totalDecks}]`) &&
          s.includes('示例 · Memento 与 Bridge') &&
          !s.includes('示例案例 · 墨笺笔记') &&
          useDistTuiStore.getState().page === 'library',
        { timeoutMs: 5_000, label: 'zh LibraryView filter confirmed on Enter' },
      );
      tty.assertHealthyScreen(filteredConfirmed, 120, 36, 'zh LibraryView filter confirmed');

      // Press Esc in normal mode to clear filter and restore full deck list
      tty.send('\x1b');
      const restoredScreen = await tty.waitFor(
        (s) => !s.includes('[筛选 ') && s.includes('示例案例 · 墨笺笔记') && s.includes('示例 · Memento 与 Bridge'),
        { timeoutMs: 5_000, label: 'zh LibraryView filter cleared on Esc' },
      );
      tty.assertHealthyScreen(restoredScreen, 120, 36, 'zh LibraryView restored');
      assert.equal(modelCalls, 0, 'LibraryView `/` filter must invoke 0 model calls');
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      await host.dispose();
      tty.dispose();
    }
  });

  test('2) @xterm/headless PTY E2E (80x24 --ascii en): LibraryView -> `/` filter -> Enter -> Esc -> assertHealthyScreen + assertAsciiPure', async () => {
    const base = await makeTempDir('pty-ascii-en');
    const dshHome = join(base, 'dsh-home');
    const libraryRoot = join(base, 'library');
    process.env.DSH_HOME = dshHome;

    await saveTuiPreferences(
      { language: 'en', asciiMode: true, theme: 'dsh-dark', mathUnicode: false, showHints: true },
      { env: { ...process.env, DSH_HOME: dshHome } },
    );

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env: { ...process.env, DSH_HOME: dshHome },
      home: join(base, 'home'),
      documentsDir: base,
      skipAutoProbe: true,
      injectedComplete: async () => {
        modelCalls += 1;
        return 'Stub';
      },
      language: 'en',
      eventDebounceMs: 30,
    });

    const tty = createVirtualTty(80, 24);
    let inkInst = null;
    try {
      resetDistStore('en', true);
      inkInst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'en',
          initialAsciiMode: true,
          autoLaunchpad: true,
          onExit: () => inkInst?.unmount(),
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

      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('Load the sample course'), { label: 'en Launchpad' });

      tty.send('s');
      const libScreen = await tty.waitFor(
        (s) =>
          !s.includes('Load the sample course') &&
          s.includes('Memento') &&
          s.includes('Quillpad') &&
          useDistTuiStore.getState().footerHints.some((h) => h.key === '/' && h.label === 'Filter'),
        { timeoutMs: 12_000, label: 'en LibraryView 80x24 with sample deck & `/` hint' },
      );
      tty.assertHealthyScreen(libScreen, 80, 24, 'en LibraryView 80x24');
      tty.assertAsciiPure(libScreen, 'en LibraryView 80x24');

      const totalDecks = (useDistTuiStore.getState().snapshot?.decks ?? []).filter((d) => !d.archived && !d.systemKind).length;
      assert.ok(totalDecks >= 2, `Expected >= 2 sample decks, got ${totalDecks}`);

      tty.send('/');
      await tty.waitFor(
        (s) => !useDistTuiStore.getState().commandPaletteOpen && s.includes(`[Filter ${totalDecks}/${totalDecks}]`),
        { timeoutMs: 5_000, label: 'en LibraryView filter bar opened' },
      );

      tty.send('quillpad');
      const filteredEditing = await tty.waitFor(
        (s) =>
          s.includes(`[Filter 1/${totalDecks}]`) &&
          s.includes('Sample case') &&
          !s.includes('Sample · Memento and Bridge'),
        { timeoutMs: 5_000, label: 'en LibraryView filtered while editing' },
      );
      tty.assertHealthyScreen(filteredEditing, 80, 24, 'en LibraryView filtered editing 80x24');
      tty.assertAsciiPure(filteredEditing, 'en LibraryView filtered editing 80x24');

      tty.send('\r');
      const filteredConfirmed = await tty.waitFor(
        (s) =>
          !useDistTuiStore.getState().inputCaptured &&
          s.includes(`[Filtered 1/${totalDecks}]`) &&
          s.includes('Quillpad') &&
          !s.includes('Sample · Memento and Bridge') &&
          useDistTuiStore.getState().page === 'library',
        { timeoutMs: 5_000, label: 'en LibraryView filter confirmed on Enter' },
      );
      tty.assertHealthyScreen(filteredConfirmed, 80, 24, 'en LibraryView filter confirmed 80x24');
      tty.assertAsciiPure(filteredConfirmed, 'en LibraryView filter confirmed 80x24');

      tty.send('\x1b');
      const restoredScreen = await tty.waitFor(
        (s) =>
          !s.includes('[Filtered ') &&
          !s.includes('[Filter ') &&
          s.includes('Sample · Memento and Bridge') &&
          s.includes('Quillpad'),
        { timeoutMs: 5_000, label: 'en LibraryView filter cleared on Esc' },
      );
      tty.assertHealthyScreen(restoredScreen, 80, 24, 'en LibraryView restored 80x24');
      tty.assertAsciiPure(restoredScreen, 'en LibraryView restored 80x24');
      assert.equal(modelCalls, 0, 'LibraryView `/` filter must invoke 0 model calls');
    } finally {
      try {
        inkInst?.unmount();
      } catch {
        // ignore
      }
      await host.dispose();
      tty.dispose();
    }
  });
});
