// Round 23 Features E2E verification: node --test tests/round23-e2e.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
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

let H = null;
let R = null;
let S = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('store-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
    if (!S && typeof mod.useTuiStore?.getState === 'function') S = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');
assert.ok(S?.useTuiStore, 'dist/ must export useTuiStore');

const { useTuiStore } = S;

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round23-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const UNICODE_BOX_RE = /[\u2500-\u257f]/g;
const UNICODE_BLOCK_RE = /[\u2580-\u259f]/g;
const UNICODE_BRAILLE_RE = /[\u2800-\u28ff]/g;

/**
 * Creates a real Ink-compatible virtual TTY backed by `@xterm/headless`.
 */
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
    assert.ok(
      lines.length <= expectedRows,
      `${contextLabel}: Screen rows exceeded (${lines.length} > ${expectedRows})`,
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
    const boxMatch = screen.match(UNICODE_BOX_RE);
    assert.equal(
      boxMatch,
      null,
      `${contextLabel}: Unicode box-drawing chars leaked in --ascii mode: ${JSON.stringify(boxMatch ? [...new Set(boxMatch)] : [])}\n${screen}`,
    );
    const blockMatch = screen.match(UNICODE_BLOCK_RE);
    assert.equal(
      blockMatch,
      null,
      `${contextLabel}: Unicode block elements leaked in --ascii mode: ${JSON.stringify(blockMatch ? [...new Set(blockMatch)] : [])}\n${screen}`,
    );
    const brailleMatch = screen.match(UNICODE_BRAILLE_RE);
    assert.equal(
      brailleMatch,
      null,
      `${contextLabel}: Unicode Braille chars leaked in --ascii mode: ${JSON.stringify(brailleMatch ? [...new Set(brailleMatch)] : [])}\n${screen}`,
    );
  }

  return {
    stdin,
    stdout,
    stderr,
    term,
    firstFramePromise,
    flush,
    readLines,
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

function createRound23StubComplete() {
  return async (_system, prompt, execution = {}) => {
    if (String(prompt || '').includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const reply = JSON.stringify({ status: 'ok' });
    execution.onOutput?.(reply);
    return reply;
  };
}

function hasBookEditEmptyState(screen) {
  return (
    screen.includes('这门课还没有复习全书') ||
    screen.includes('No review book for this course yet') ||
    screen.includes('请先选择一门课程') ||
    screen.includes('Select a course first')
  );
}

describe('StudyHub TUI Round 23 Features E2E', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let tty;
  let inkInstance;
  let disposed = false;
  const extraCleanups = [];

  async function cleanupAll() {
    if (disposed) return;
    disposed = true;
    for (const fn of extraCleanups.splice(0)) {
      await fn();
    }
    try {
      inkInstance?.unmount();
    } catch {
      // Ignore unmount errors during primary teardown
    }
    await host?.dispose();
    tty?.dispose();
  }

  before(async () => {
    boxDir = await makeTempDir('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;

    host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: createRound23StubComplete(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    tty = createVirtualTty(120, 36);
    inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        autoLaunchpad: true,
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
    await tty.firstFramePromise;
  });

  after(async () => {
    try {
      await cleanupAll();
    } finally {
      if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = PREV_DSH_HOME;
      await Promise.all(
        tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
      );
    }
  });

  test('1) BookView BookEditModal (7 -> e): opens cleanly at 120x36 & 80x24 with empty state, Esc closes cleanly', async () => {
    await tty.waitFor(
      (s) => s.includes('载入示例课程体验') || s.includes('Load the sample course'),
      { label: 'Launchpad render' },
    );

    // Load sample course via 's'
    tty.send('s');
    await tty.waitFor(
      (s) =>
        !s.includes('载入示例课程体验') &&
        s.includes('示例 · Memento 与 Bridge') &&
        s.includes('示例案例 · 墨笺笔记'),
      { timeoutMs: 12_000, label: 'Library after sample load' },
    );
    await sleep(80);
    await tty.flush();

    // Navigate to BookView ('7') and wait for BookView-unique footer ('精选问答' / 'Pinned QA')
    tty.send('7');
    const bookScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'book' &&
        (s.includes('精选问答') || s.includes('Pinned QA')) &&
        !s.includes('正在加载页面') &&
        !s.includes('正在打开复习全书'),
      { timeoutMs: 10_000, label: 'BookView rendered with footer 精选问答 / Pinned QA' },
    );
    tty.assertHealthyScreen(bookScreen, 120, 36, 'BookView at 120x36');

    // Press 'e' to open BookEditModal
    tty.send('e');
    const editWide = await tty.waitFor(
      (s) =>
        (s.includes('编辑复习全书') || s.includes('Edit Review Book')) &&
        !s.includes('正在读取本节文件') &&
        !s.includes('Loading section file') &&
        hasBookEditEmptyState(s),
      { timeoutMs: 10_000, label: 'BookEditModal empty state opened at 120x36' },
    );
    tty.assertHealthyScreen(editWide, 120, 36, 'BookEditModal at 120x36');

    // Verify clean layout at 80x24
    tty.resize(80, 24);
    const editNarrow = await tty.waitFor(
      (s) =>
        (s.includes('编辑复习全书') || s.includes('Edit Review Book')) &&
        hasBookEditEmptyState(s) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'BookEditModal at 80x24' },
    );
    tty.assertHealthyScreen(editNarrow, 80, 24, 'BookEditModal at 80x24');

    // Restore 120x36
    tty.resize(120, 36);
    await tty.waitFor(
      (s) =>
        (s.includes('编辑复习全书') || s.includes('Edit Review Book')) &&
        hasBookEditEmptyState(s),
      { timeoutMs: 8_000, label: 'BookEditModal restored to 120x36' },
    );

    // Close cleanly via Esc
    tty.send('\x1b');
    const afterClose = await tty.waitFor(
      (s) =>
        !s.includes('编辑复习全书') &&
        !s.includes('Edit Review Book') &&
        (s.includes('精选问答') || s.includes('Pinned QA')),
      { timeoutMs: 8_000, label: 'BookEditModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterClose, 120, 36, 'BookView after Esc closed BookEditModal');
  });

  test('2) SourcesView Upgraded CompanionsModal (2 -> C): [v] scope toggle, [b] Companion Build form at 120x36 & 80x24, Esc back & close', async () => {
    // Navigate to SourcesView via '2' and wait for SourcesView-unique content
    tty.send('2');
    const sourcesScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'sources' &&
        (s.includes('学习资料库') || s.includes('Study Materials')) &&
        (s.includes('示例 · 设计模式讲义') || s.includes('示例案例 · 墨笺笔记')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'SourcesView rendered' },
    );
    tty.assertHealthyScreen(sourcesScreen, 120, 36, 'SourcesView at 120x36');

    // Press 'C' to open CompanionsModal
    tty.send('C');
    const browseScreen = await tty.waitFor(
      (s) =>
        (s.includes('交互伴学页 (Companions)') || s.includes('Interactive Companions')) &&
        !s.includes('加载中') &&
        !s.includes('Loading') &&
        (s.includes('伴学页') || s.includes('Companions')),
      { timeoutMs: 10_000, label: 'CompanionsModal browse opened at 120x36' },
    );
    tty.assertHealthyScreen(browseScreen, 120, 36, 'CompanionsModal browse at 120x36');

    // Verify [v] scope toggle works cleanly
    assert.ok(
      browseScreen.includes('范围') || browseScreen.includes('Scope'),
      `Expected [v] scope hint when defaultCourse is active:\n${browseScreen}`,
    );
    const initiallyAllCourses = browseScreen.includes('全部课程') || browseScreen.includes('All Courses');
    tty.send('v');
    const toggledScreen = await tty.waitFor(
      (s) =>
        (s.includes('交互伴学页 (Companions)') || s.includes('Interactive Companions')) &&
        !s.includes('加载中') &&
        !s.includes('Loading') &&
        (s.includes('全部课程') || s.includes('All Courses')) !== initiallyAllCourses,
      { timeoutMs: 8_000, label: 'CompanionsModal [v] scope toggled' },
    );
    tty.assertHealthyScreen(toggledScreen, 120, 36, 'CompanionsModal after first [v] toggle');

    tty.send('v');
    const restoredScopeScreen = await tty.waitFor(
      (s) =>
        (s.includes('交互伴学页 (Companions)') || s.includes('Interactive Companions')) &&
        !s.includes('加载中') &&
        !s.includes('Loading') &&
        (s.includes('全部课程') || s.includes('All Courses')) === initiallyAllCourses,
      { timeoutMs: 8_000, label: 'CompanionsModal [v] scope toggled back' },
    );
    tty.assertHealthyScreen(restoredScopeScreen, 120, 36, 'CompanionsModal after second [v] toggle');

    // Press 'b' to open Companion Build form (generation.companion.build)
    tty.send('b');
    const buildWide = await tty.waitFor(
      (s) =>
        (s.includes('4 阶段构建') || s.includes('4-Stage Build')) &&
        (s.includes('1. 所属课程') || s.includes('1. Course')) &&
        (s.includes('2. 核心主题') || s.includes('2. Topic')) &&
        (s.includes('4. 交互母版') || s.includes('4. Archetype')) &&
        (s.includes('5. 题库联动') || s.includes('5. Mount')),
      { timeoutMs: 8_000, label: 'CompanionsModal Build form opened at 120x36' },
    );
    tty.assertHealthyScreen(buildWide, 120, 36, 'CompanionsModal Build form at 120x36');

    // Verify clean layout at 80x24
    tty.resize(80, 24);
    const buildNarrow = await tty.waitFor(
      (s) =>
        (s.includes('4 阶段构建') || s.includes('4-Stage Build')) &&
        (s.includes('1. 所属课程') || s.includes('1. Course')) &&
        (s.includes('2. 核心主题') || s.includes('2. Topic')) &&
        (s.includes('4. 交互母版') || s.includes('4. Archetype')) &&
        (s.includes('5. 题库联动') || s.includes('5. Mount')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'CompanionsModal Build form at 80x24' },
    );
    tty.assertHealthyScreen(buildNarrow, 80, 24, 'CompanionsModal Build form at 80x24');

    // Restore 120x36
    tty.resize(120, 36);
    await tty.waitFor(
      (s) =>
        (s.includes('4 阶段构建') || s.includes('4-Stage Build')) &&
        (s.includes('5. 题库联动') || s.includes('5. Mount')),
      { timeoutMs: 8_000, label: 'CompanionsModal Build form restored to 120x36' },
    );

    // Press Esc to return to browse
    tty.send('\x1b');
    const backToBrowse = await tty.waitFor(
      (s) =>
        !s.includes('4 阶段构建') &&
        !s.includes('4-Stage Build') &&
        (s.includes('交互伴学页 (Companions)') || s.includes('Interactive Companions')) &&
        (s.includes('伴学页') || s.includes('Companions')),
      { timeoutMs: 8_000, label: 'CompanionsModal Esc back from build to browse' },
    );
    tty.assertHealthyScreen(backToBrowse, 120, 36, 'CompanionsModal back to browse');

    // Press Esc to close CompanionsModal cleanly
    tty.send('\x1b');
    const afterClose = await tty.waitFor(
      (s) =>
        !s.includes('交互伴学页 (Companions)') &&
        !s.includes('Interactive Companions') &&
        (s.includes('学习资料库') || s.includes('Study Materials')),
      { timeoutMs: 8_000, label: 'CompanionsModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterClose, 120, 36, 'SourcesView after Esc closed CompanionsModal');

    // Unmount primary Ink instance before dedicated --ascii check in Test 3
    inkInstance.unmount();
    inkInstance = null;
    tty.dispose();
    tty = null;
  });

  test('3) BookEditModal & CompanionsModal ([b] build form) --ascii Zero-Unicode-Leak Check', async () => {
    const asciiDir = await makeTempDir('ascii');
    const asciiDshHome = join(asciiDir, 'dsh-home');
    const asciiLibRoot = join(asciiDir, 'library');

    await H.saveTuiPreferences({ language: 'zh', asciiMode: true }, { env: { DSH_HOME: asciiDshHome } });

    const asciiHost = await H.createTuiHost({
      env: { DSH_HOME: asciiDshHome },
      home: join(asciiDir, 'home'),
      libraryRoot: asciiLibRoot,
      injectedComplete: createRound23StubComplete(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const sampleRes = await asciiHost.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, 'sample.load must succeed for ASCII test');

    const asciiTty = createVirtualTty(120, 36);
    let asciiInk = null;
    let asciiCleaned = false;

    const cleanupAscii = async () => {
      if (asciiCleaned) return;
      asciiCleaned = true;
      try {
        asciiInk?.unmount();
      } catch {
        // Ignore unmount errors during ASCII teardown
      }
      await asciiHost.dispose();
      asciiTty.dispose();
    };
    extraCleanups.push(cleanupAscii);

    try {
      asciiInk = render(
        React.createElement(StudyHubTuiApp, {
          host: asciiHost,
          initialPage: 'book',
          initialLanguage: 'zh',
          initialAsciiMode: true,
          autoLaunchpad: false,
          onExit: () => asciiInk?.unmount(),
        }),
        {
          stdin: asciiTty.stdin,
          stdout: asciiTty.stdout,
          stderr: asciiTty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await asciiTty.firstFramePromise;

      // 3a) BookView -> BookEditModal (e) in --ascii mode
      const bookAscii = await asciiTty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'book' &&
          (s.includes('精选问答') || s.includes('Pinned QA')) &&
          !s.includes('正在加载页面') &&
          !s.includes('正在打开复习全书'),
        { timeoutMs: 10_000, label: 'ASCII BookView rendered' },
      );
      asciiTty.assertHealthyScreen(bookAscii, 120, 36, 'ASCII BookView');
      asciiTty.assertAsciiPure(bookAscii, 'ASCII BookView');

      asciiTty.send('e');
      const bookEditAscii = await asciiTty.waitFor(
        (s) =>
          (s.includes('编辑复习全书') || s.includes('Edit Review Book')) &&
          !s.includes('正在读取本节文件') &&
          !s.includes('Loading section file') &&
          hasBookEditEmptyState(s),
        { timeoutMs: 10_000, label: 'ASCII BookEditModal rendered' },
      );
      asciiTty.assertHealthyScreen(bookEditAscii, 120, 36, 'ASCII BookEditModal');
      asciiTty.assertAsciiPure(bookEditAscii, 'ASCII BookEditModal');

      asciiTty.send('\x1b');
      await asciiTty.waitFor(
        (s) => !s.includes('编辑复习全书') && !s.includes('Edit Review Book'),
        { timeoutMs: 6_000, label: 'ASCII BookEditModal closed' },
      );

      // 3b) Navigate to SourcesView ('2') -> CompanionsModal ('C') -> Build form ('b') in --ascii mode
      asciiTty.send('2');
      const sourcesAscii = await asciiTty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'sources' &&
          (s.includes('学习资料库') || s.includes('Study Materials')) &&
          (s.includes('示例 · 设计模式讲义') || s.includes('示例案例 · 墨笺笔记')) &&
          !s.includes('正在加载页面'),
        { timeoutMs: 10_000, label: 'ASCII SourcesView rendered' },
      );
      asciiTty.assertHealthyScreen(sourcesAscii, 120, 36, 'ASCII SourcesView');
      asciiTty.assertAsciiPure(sourcesAscii, 'ASCII SourcesView');

      asciiTty.send('C');
      const companionsBrowseAscii = await asciiTty.waitFor(
        (s) =>
          (s.includes('交互伴学页 (Companions)') || s.includes('Interactive Companions')) &&
          !s.includes('加载中') &&
          !s.includes('Loading') &&
          (s.includes('伴学页') || s.includes('Companions')),
        { timeoutMs: 10_000, label: 'ASCII CompanionsModal browse rendered' },
      );
      asciiTty.assertHealthyScreen(companionsBrowseAscii, 120, 36, 'ASCII CompanionsModal browse');
      asciiTty.assertAsciiPure(companionsBrowseAscii, 'ASCII CompanionsModal browse');

      asciiTty.send('b');
      const companionsBuildAscii = await asciiTty.waitFor(
        (s) =>
          (s.includes('4 阶段构建') || s.includes('4-Stage Build')) &&
          (s.includes('1. 所属课程') || s.includes('1. Course')) &&
          (s.includes('2. 核心主题') || s.includes('2. Topic')) &&
          (s.includes('4. 交互母版') || s.includes('4. Archetype')) &&
          (s.includes('5. 题库联动') || s.includes('5. Mount')),
        { timeoutMs: 8_000, label: 'ASCII CompanionsModal Build form rendered' },
      );
      asciiTty.assertHealthyScreen(companionsBuildAscii, 120, 36, 'ASCII CompanionsModal Build form');
      asciiTty.assertAsciiPure(companionsBuildAscii, 'ASCII CompanionsModal Build form');

      asciiTty.send('\x1b');
      await asciiTty.waitFor(
        (s) =>
          !s.includes('4 阶段构建') &&
          !s.includes('4-Stage Build') &&
          (s.includes('交互伴学页 (Companions)') || s.includes('Interactive Companions')),
        { timeoutMs: 6_000, label: 'ASCII CompanionsModal back to browse' },
      );

      asciiTty.send('\x1b');
      await asciiTty.waitFor(
        (s) => !s.includes('交互伴学页 (Companions)') && !s.includes('Interactive Companions'),
        { timeoutMs: 6_000, label: 'ASCII CompanionsModal closed' },
      );
    } finally {
      await cleanupAscii();
    }
  });
});
