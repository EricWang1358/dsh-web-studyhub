// Round 66 Track 1: BoardView `/` live keyword filter, `[x]` atomic Markdown Kanban export,
// and SGR 1006 mouse wheel scrolling (`useSgrMouseWheel`).
// `node --test --test-concurrency=1 tests/round66-board-ux.test.mjs`
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

const [{ formatBoardMarkdown }, { saveBoard, todayLocalYmd }] = await Promise.all([
  tsImport('../src/views/board/BoardView.tsx', import.meta.url),
  tsImport('../src/views/board/board-store.ts', import.meta.url),
]);
assert.equal(typeof formatBoardMarkdown, 'function', 'BoardView must export formatBoardMarkdown');

const PREV_DSH_HOME = process.env.DSH_HOME;
const UNICODE_UI_CHROME_RE =
  /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF\u2800-\u28FF\u2190-\u21FF\u2022\u2026\u2039\u203A]/g;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-r66-${label}-`));
  tempDirs.push(d);
  return d;
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

function resetStore({ language = 'zh', asciiMode = false, page = 'library' } = {}) {
  const prev = useTuiStore.getState();
  useTuiStore.setState({
    page,
    history: [],
    pageContext: {},
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    toasts: [],
    preferences: {
      ...prev.preferences,
      language,
      asciiMode,
      sidebarCollapsed: false,
      showKeyHints: true,
    },
  });
}

after(async () => {
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe('Round 66 Track 1: BoardView filter, Markdown export, and SGR mouse wheel', () => {
  test('1. Pure formatBoardMarkdown generates GFM Markdown in zh and en with checkboxes, metadata, and Pomodoro stats', () => {
    const sampleDoc = {
      version: 1,
      cards: [
        {
          id: 'c1',
          title: 'Review Eigenvalues',
          column: 'todo',
          course: 'Linear Algebra',
          dueDate: '2026-11-30',
          priority: 'high',
          tags: ['math', 'midterm'],
          description: 'Prove spectral theorem for symmetric matrices.',
          createdAt: '2026-11-22T01:00:00.000Z',
          updatedAt: '2026-11-22T01:00:00.000Z',
        },
        {
          id: 'c2',
          title: 'Implement B-Tree Split',
          column: 'doing',
          course: 'Database',
          dueDate: '2026-11-25',
          priority: 'medium',
          tags: ['storage'],
          description: 'Handle leaf and internal node splits cleanly.',
          createdAt: '2026-11-22T02:00:00.000Z',
          updatedAt: '2026-11-22T02:00:00.000Z',
        },
        {
          id: 'c3',
          title: 'Setup Lab Environment',
          column: 'done',
          course: 'Systems',
          createdAt: '2026-11-22T03:00:00.000Z',
          updatedAt: '2026-11-22T03:00:00.000Z',
        },
      ],
      focusStats: {
        date: '2026-11-22',
        completedPomodoros: 3,
        focusedMinutes: 75,
      },
      updatedAt: '2026-11-22T04:00:00.000Z',
    };

    const enMd = formatBoardMarkdown(sampleDoc, 'en');
    assert.ok(enMd.includes('# StudyHub Kanban Board'));
    assert.ok(enMd.includes('Pomodoro: 3 (75m)'));
    assert.ok(enMd.includes('## Todo'));
    assert.ok(enMd.includes('## Doing'));
    assert.ok(enMd.includes('## Done'));
    assert.ok(enMd.includes('- [ ] Review Eigenvalues'));
    assert.ok(enMd.includes('priority:high'));
    assert.ok(enMd.includes('course:Linear Algebra'));
    assert.ok(enMd.includes('due:2026-11-30'));
    assert.ok(enMd.includes('tags:#math #midterm'));
    assert.ok(enMd.includes('Prove spectral theorem for symmetric matrices.'));
    assert.ok(enMd.includes('- [ ] Implement B-Tree Split'));
    assert.ok(enMd.includes('- [x] Setup Lab Environment'));

    const zhMd = formatBoardMarkdown(sampleDoc, 'zh');
    assert.ok(zhMd.includes('# StudyHub Kanban Board'));
    assert.ok(zhMd.includes('番茄专注: 3 次 (75 分钟)'));
    assert.ok(zhMd.includes('## 待办 Todo'));
    assert.ok(zhMd.includes('## 进行中 Doing'));
    assert.ok(zhMd.includes('## 已完成 Done'));
    assert.ok(zhMd.includes('- [ ] Review Eigenvalues'));
    assert.ok(zhMd.includes('优先级:high'));
    assert.ok(zhMd.includes('课程:Linear Algebra'));
    assert.ok(zhMd.includes('截止:2026-11-30'));
    assert.ok(zhMd.includes('- [x] Setup Lab Environment'));
  });

  test('2. @xterm/headless PTY E2E (120x36 zh): / live filter, x atomic export, Esc clear, and SGR 1006 mouse wheel', async () => {
    const box = await makeTempDir('e2e-zh');
    const dshHome = join(box, 'dsh-home');
    const libraryRoot = join(box, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    await saveBoard(libraryRoot, {
      version: 1,
      cards: [
        {
          id: 'r66-c1',
          title: 'Alpha Algebra Review',
          column: 'todo',
          course: 'LinearMath',
          dueDate: '2026-12-01',
          createdAt: '2026-11-22T01:00:00.000Z',
          updatedAt: '2026-11-22T01:00:00.000Z',
        },
        {
          id: 'r66-c2',
          title: 'Beta Systems Lab',
          column: 'todo',
          course: 'OSKernel',
          dueDate: '2026-12-02',
          createdAt: '2026-11-22T02:00:00.000Z',
          updatedAt: '2026-11-22T02:00:00.000Z',
        },
        {
          id: 'r66-c3',
          title: 'Gamma Neural Nets',
          column: 'todo',
          course: 'DeepLearn',
          dueDate: '2026-12-03',
          createdAt: '2026-11-22T03:00:00.000Z',
          updatedAt: '2026-11-22T03:00:00.000Z',
        },
      ],
      focusStats: {
        date: todayLocalYmd(),
        completedPomodoros: 2,
        focusedMinutes: 50,
      },
      updatedAt: '2026-11-22T04:00:00.000Z',
    });

    await H.saveTuiPreferences({ language: 'zh', asciiMode: false });
    const host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(box, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 25,
    });

    resetStore({ language: 'zh', asciiMode: false, page: 'library' });
    const tty = createVirtualTty(120, 36);
    let inst = null;
    try {
      inst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          autoLaunchpad: false,
          onExit: () => inst?.unmount(),
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
      await tty.waitFor((s) => !s.includes('正在打开学习库'), { label: 'LibraryView ready (zh)' });

      tty.send('b');
      const initialBoard = await tty.waitFor(
        (s) =>
          s.includes('待办 Todo') &&
          s.includes('Alpha Algebra Review') &&
          s.includes('Beta Systems Lab') &&
          s.includes('Gamma Neural Nets') &&
          s.includes('正在专注: Alpha Algebra Review'),
        { label: 'BoardView rendered with 3 seeded cards (120x36 zh)' },
      );
      tty.assertHealthyScreen(initialBoard, 120, 36, 'BoardView initial 120x36 zh');

      // Press `/` to open live keyword filter and type 'Beta'
      tty.send('/');
      await tty.waitFor((s) => s.includes('[过滤 3/3]'), { label: 'Inline filter bar opened' });
      tty.send('Beta');
      const filteredEditing = await tty.waitFor(
        (s) =>
          s.includes('[过滤 1/3]') &&
          s.includes('Beta Systems Lab') &&
          !s.includes('Alpha Algebra Review') &&
          !s.includes('Gamma Neural Nets') &&
          s.includes('正在专注: Beta Systems Lab'),
        { label: 'Live keyword filter narrowed to Beta Systems Lab' },
      );
      tty.assertHealthyScreen(filteredEditing, 120, 36, 'BoardView filter editing');

      // Press Enter to confirm filter (keeps filter active with badge & count)
      tty.send('\r');
      const filteredConfirmed = await tty.waitFor(
        (s) => s.includes('[已过滤 1/3]') && s.includes('Beta Systems Lab') && !s.includes('Alpha Algebra Review'),
        { label: 'Enter confirmed filter bar' },
      );
      tty.assertHealthyScreen(filteredConfirmed, 120, 36, 'BoardView filter confirmed');

      // Press `x` to export Markdown atomically
      tty.send('x');
      const exportToastScreen = await tty.waitFor(
        (s) => s.includes('已导出 3 张卡片'),
        { label: 'Markdown export success toast (zh)' },
      );
      tty.assertHealthyScreen(exportToastScreen, 120, 36, 'BoardView after export');

      const expectedExportPath = join(libraryRoot, 'backups', `studyhub-board-${todayLocalYmd()}.md`);
      const exportedMd = await readFile(expectedExportPath, 'utf8');
      assert.ok(exportedMd.includes('# StudyHub Kanban Board'));
      assert.ok(exportedMd.includes('- [ ] Alpha Algebra Review'));
      assert.ok(exportedMd.includes('- [ ] Beta Systems Lab'));
      assert.ok(exportedMd.includes('- [ ] Gamma Neural Nets'));

      // Press `Esc` in normal mode to clear active filter
      tty.send('\u001b');
      const clearedScreen = await tty.waitFor(
        (s) =>
          !s.includes('[已过滤') &&
          s.includes('Alpha Algebra Review') &&
          s.includes('Beta Systems Lab') &&
          s.includes('Gamma Neural Nets') &&
          s.includes('正在专注: Alpha Algebra Review'),
        { label: 'Esc cleared active filter cleanly' },
      );
      tty.assertHealthyScreen(clearedScreen, 120, 36, 'BoardView filter cleared');

      // SGR 1006 mouse wheel down moves selection card 0 -> card 1
      tty.send('\x1b[<65;10;10M');
      const wheelDown1 = await tty.waitFor(
        (s) => s.includes('正在专注: Beta Systems Lab'),
        { label: 'SGR wheel down moved selection to Beta Systems Lab' },
      );
      tty.assertHealthyScreen(wheelDown1, 120, 36, 'BoardView wheel down 1');

      // SGR 1006 mouse wheel down again moves selection card 1 -> card 2
      tty.send('\x1b[<65;10;10M');
      const wheelDown2 = await tty.waitFor(
        (s) => s.includes('正在专注: Gamma Neural Nets'),
        { label: 'SGR wheel down moved selection to Gamma Neural Nets' },
      );
      tty.assertHealthyScreen(wheelDown2, 120, 36, 'BoardView wheel down 2');

      // SGR 1006 mouse wheel up moves selection back card 2 -> card 1
      tty.send('\x1b[<64;10;10M');
      const wheelUp = await tty.waitFor(
        (s) => s.includes('正在专注: Beta Systems Lab'),
        { label: 'SGR wheel up moved selection back to Beta Systems Lab' },
      );
      tty.assertHealthyScreen(wheelUp, 120, 36, 'BoardView wheel up');
    } finally {
      try {
        inst?.unmount();
      } catch {
        // Ignore unmount error
      }
      tty.dispose();
      await host.dispose();
    }
  });

  test('3. @xterm/headless PTY E2E (80x24 --ascii en): Board (b) -> / filter -> x export -> assertHealthyScreen + assertAsciiPure', async () => {
    const box = await makeTempDir('e2e-ascii-en');
    const dshHome = join(box, 'dsh-home');
    const libraryRoot = join(box, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = dshHome;

    await saveBoard(libraryRoot, {
      version: 1,
      cards: [
        {
          id: 'a-c1',
          title: 'First Graph Task',
          column: 'todo',
          course: 'Algorithms',
          dueDate: '2026-12-05',
          createdAt: '2026-11-22T01:00:00.000Z',
          updatedAt: '2026-11-22T01:00:00.000Z',
        },
        {
          id: 'a-c2',
          title: 'Second Cache Design',
          column: 'todo',
          course: 'Architecture',
          dueDate: '2026-12-06',
          createdAt: '2026-11-22T02:00:00.000Z',
          updatedAt: '2026-11-22T02:00:00.000Z',
        },
        {
          id: 'a-c3',
          title: 'Third Finished Item',
          column: 'done',
          course: 'Networking',
          createdAt: '2026-11-22T03:00:00.000Z',
          updatedAt: '2026-11-22T03:00:00.000Z',
        },
      ],
      updatedAt: '2026-11-22T04:00:00.000Z',
    });

    await H.saveTuiPreferences({ language: 'en', asciiMode: true });
    const host = await H.createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(box, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'en',
      eventDebounceMs: 25,
    });

    resetStore({ language: 'en', asciiMode: true, page: 'library' });
    const tty = createVirtualTty(80, 24);
    let inst = null;
    try {
      inst = render(
        React.createElement(StudyHubTuiApp, {
          host,
          autoLaunchpad: false,
          onExit: () => inst?.unmount(),
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
      await tty.waitFor((s) => !s.includes('Opening library'), { label: 'LibraryView ready (en ascii)' });

      tty.send('b');
      const boardScreen = await tty.waitFor(
        (s) => s.includes('Todo') && s.includes('First Graph Task') && s.includes('Focus: First Graph Task'),
        { label: 'BoardView rendered at 80x24 --ascii en' },
      );
      tty.assertHealthyScreen(boardScreen, 80, 24, 'BoardView 80x24 ascii en');
      tty.assertAsciiPure(boardScreen, 'BoardView 80x24 ascii en');

      // Filter by 'Cache'
      tty.send('/');
      await tty.waitFor((s) => s.includes('[Filter 3/3]'), { label: 'Ascii filter bar opened' });
      tty.send('Cache');
      const filteredScreen = await tty.waitFor(
        (s) =>
          s.includes('[Filter 1/3]') &&
          s.includes('Second Cache Design') &&
          !s.includes('First Graph Task') &&
          s.includes('Focus: Second Cache Design'),
        { label: 'Ascii filter narrowed to Second Cache Design' },
      );
      tty.assertHealthyScreen(filteredScreen, 80, 24, 'BoardView 80x24 ascii filter');
      tty.assertAsciiPure(filteredScreen, 'BoardView 80x24 ascii filter');

      tty.send('\r');
      const confirmedScreen = await tty.waitFor(
        (s) => s.includes('[Filtered 1/3]') && s.includes('Second Cache Design'),
        { label: 'Ascii filter confirmed' },
      );
      tty.assertHealthyScreen(confirmedScreen, 80, 24, 'BoardView 80x24 ascii filter confirmed');
      tty.assertAsciiPure(confirmedScreen, 'BoardView 80x24 ascii filter confirmed');

      // Export via `x`
      tty.send('x');
      const exportedScreen = await tty.waitFor(
        (s) => s.includes('Exported 3 cards ->'),
        { label: 'Ascii export toast rendered' },
      );
      tty.assertHealthyScreen(exportedScreen, 80, 24, 'BoardView 80x24 ascii export toast');
      tty.assertAsciiPure(exportedScreen, 'BoardView 80x24 ascii export toast');

      const expectedExportPath = join(libraryRoot, 'backups', `studyhub-board-${todayLocalYmd()}.md`);
      const exportedMd = await readFile(expectedExportPath, 'utf8');
      assert.ok(exportedMd.includes('- [ ] First Graph Task'));
      assert.ok(exportedMd.includes('- [ ] Second Cache Design'));
      assert.ok(exportedMd.includes('- [x] Third Finished Item'));
    } finally {
      try {
        inst?.unmount();
      } catch {
        // Ignore unmount error
      }
      tty.dispose();
      await host.dispose();
    }
  });
});
