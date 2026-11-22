// Round 17 Features & Cross-Platform CLI E2E verification: node --test tests/round17-e2e.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
const cliBinPath = resolve(pkgRoot, 'bin', 'studyhub-tui.mjs');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);

let H = null;
let R = null;
for (const f of distFiles) {
  if (f.startsWith('host-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(H?.saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round17-${label}-`));
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

function createRound17StubComplete() {
  return async (_system, prompt, execution = {}) => {
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const reply = JSON.stringify({ status: 'ok' });
    execution.onOutput?.(reply);
    return reply;
  };
}

function runCliSubprocess(args, extraEnv = {}, timeoutMs = 5_000) {
  return new Promise((resolveFn, rejectFn) => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, [cliBinPath, ...args], {
      cwd: pkgRoot,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rejectFn(new Error(`CLI subprocess timed out after ${timeoutMs}ms: ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectFn(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveFn({
        code,
        stdout,
        stderr,
        durationMs: performance.now() - startedAt,
      });
    });
  });
}

describe('StudyHub TUI Round 17 E2E & Cross-Platform CLI Matrix', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let activeTty = null;
  let activeInk = null;
  let disposed = false;

  async function unmountActiveApp() {
    const ink = activeInk;
    const tty = activeTty;
    activeInk = null;
    activeTty = null;
    try {
      ink?.unmount();
    } catch {
      // Ignore unmount errors during test teardown
    }
    tty?.dispose();
  }

  async function mountApp({ initialPage = 'library', asciiMode = false, language = 'zh' } = {}) {
    await unmountActiveApp();
    await H.saveTuiPreferences({ language, asciiMode }, { env: { DSH_HOME: dshHome } });
    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    inkInstance = render(
      React.createElement(StudyHubTuiApp, {
        host,
        initialPage,
        initialLanguage: language,
        initialAsciiMode: asciiMode,
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
    activeTty = tty;
    activeInk = inkInstance;
    await tty.firstFramePromise;
    return tty;
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
      injectedComplete: createRound17StubComplete(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const sampleRes = await host.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, `sample.load must succeed: ${sampleRes.error?.message || ''}`);
  });

  after(async () => {
    if (disposed) return;
    disposed = true;
    try {
      await unmountActiveApp();
      await host?.dispose();
    } finally {
      if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = PREV_DSH_HOME;
      await Promise.all(
        tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
      );
    }
  });

  test('1) BoardView StudyHub Backend Sync Bridge ([S] + board.card.add -> BoardView -> move L -> board.get, 80x24/120x36 & --ascii)', async () => {
    const taskTitle = 'Synced Daily Plan Task R17';
    const initialBoard = await host.call('board.get', {});
    assert.equal(initialBoard.ok, true, `board.get must succeed: ${initialBoard.error?.message || ''}`);

    const addRes = await host.call('board.card.add', {
      revision: initialBoard.value?.revision ?? 0,
      title: taskTitle,
    });
    assert.equal(addRes.ok, true, `board.card.add must succeed: ${addRes.error?.message || ''}`);

    const upstreamEntries = Object.entries(addRes.value?.cards || {});
    const createdEntry = upstreamEntries.find(([, card]) => card?.title === taskTitle);
    assert.ok(createdEntry, 'Created upstream card must exist in board.card.add result');
    const [upstreamCardId] = createdEntry;

    // Mount TUI on LibraryView and navigate via 'b' to BoardView
    const tty = await mountApp({ initialPage: 'library', asciiMode: false, language: 'zh' });
    await tty.waitFor(
      (s) => s.includes('示例 · Memento 与 Bridge') && !s.includes('正在打开学习库'),
      { timeoutMs: 10_000, label: 'LibraryView rendered before BoardView nav' },
    );

    tty.send('b');
    await tty.waitFor(
      (s) =>
        (s.includes('待办 Todo') || s.includes('Todo')) &&
        (s.includes('进行中 Doing') || s.includes('Doing')) &&
        !s.includes('正在加载页面') &&
        !s.includes('载入看板'),
      { timeoutMs: 10_000, label: 'BoardView rendered' },
    );

    // Trigger explicit [S] StudyHub backend sync
    tty.send('S');
    const syncedWide = await tty.waitFor(
      (s) => s.includes(taskTitle) && s.includes('◈ SH'),
      { timeoutMs: 8_000, label: 'Synced card with StudyHub badge rendered at 120x36' },
    );
    tty.assertHealthyScreen(syncedWide, 120, 36, 'BoardView synced 120x36');

    // Verify 80x24 layout health
    tty.resize(80, 24);
    const syncedNarrow = await tty.waitFor(
      (s) => s.includes(taskTitle) && s.includes('SH') && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'BoardView synced rendered at 80x24' },
    );
    tty.assertHealthyScreen(syncedNarrow, 80, 24, 'BoardView synced 80x24');

    // Restore 120x36 before moving card
    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes(taskTitle) && s.includes('◈ SH') && s.includes('进行中 Doing'),
      { timeoutMs: 8_000, label: 'BoardView restored to 120x36' },
    );

    // Move the selected card from todo -> doing using Shift+L ('L' = moveCard right)
    tty.send('L');

    // Wait for best-effort upstream board.card.move to update the StudyHub board
    let movedUpstream = false;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      await sleep(80);
      const boardAfter = await host.call('board.get', {});
      assert.equal(boardAfter.ok, true, 'board.get after move must succeed');
      const doingCol = boardAfter.value?.columns?.find((c) => c.id === 'doing');
      if (Array.isArray(doingCol?.cardIds) && doingCol.cardIds.includes(upstreamCardId)) {
        movedUpstream = true;
        break;
      }
    }
    assert.equal(movedUpstream, true, 'Upstream card must move into "doing" column after pressing L');
    await tty.flush();
    tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'BoardView after moving synced card to doing');

    // Verify --ascii purity & 120x36 / 80x24 health on BoardView with the synced card
    const asciiTty = await mountApp({ initialPage: 'board', asciiMode: true, language: 'zh' });
    await asciiTty.waitFor(
      (s) =>
        s.includes('Synced Daily Plan Ta') &&
        s.includes('SH') &&
        !s.includes('正在加载页面') &&
        !s.includes('载入看板'),
      { timeoutMs: 10_000, label: 'ASCII BoardView rendered at 120x36' },
    );
    // Focus the 'doing' column via 'l' so both wide & narrow views focus the moved card
    asciiTty.send('l');
    const asciiWide = await asciiTty.waitFor(
      (s) => s.includes(taskTitle) && s.includes('SH'),
      { timeoutMs: 8_000, label: 'ASCII BoardView focused doing column at 120x36' },
    );
    await asciiTty.flush();
    asciiTty.assertHealthyScreen(asciiWide, 120, 36, 'ASCII BoardView 120x36');
    asciiTty.assertAsciiPure(asciiWide, 'ASCII BoardView 120x36');

    asciiTty.resize(80, 24);
    const asciiNarrow = await asciiTty.waitFor(
      (s) => s.includes('Synced Daily Plan Ta') && s.includes('SH') && s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'ASCII BoardView rendered at 80x24' },
    );
    await asciiTty.flush();
    asciiTty.assertHealthyScreen(asciiNarrow, 80, 24, 'ASCII BoardView 80x24');
    asciiTty.assertAsciiPure(asciiNarrow, 'ASCII BoardView 80x24');

    await unmountActiveApp();
  });

  test('2) NoteEditorModal Direct Ctrl+S on Body Field Single-Create Regression', async () => {
    const tty = await mountApp({ initialPage: 'library', asciiMode: false, language: 'zh' });
    await tty.waitFor(
      (s) => s.includes('示例 · Memento 与 Bridge') && !s.includes('正在打开学习库'),
      { timeoutMs: 10_000, label: 'LibraryView ready before NotesView nav' },
    );

    tty.send('n');
    const notesInit = await tty.waitFor(
      (s) =>
        (s.includes('Unicode Math') || s.includes('Raw LaTeX') || s.includes('笔记正文') || s.includes('Note Reader')) &&
        !s.includes('载入笔记中') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'NotesView rendered' },
    );
    tty.assertHealthyScreen(notesInit, 120, 36, 'NotesView initial');

    const beforeRes = await host.call('note.list', {});
    assert.equal(beforeRes.ok, true, `note.list before create must succeed: ${beforeRes.error?.message || ''}`);
    const beforeCount = Array.isArray(beforeRes.value?.notes) ? beforeRes.value.notes.length : 0;

    // Open NoteEditorModal via 'a'
    tty.send('a');
    const createModal = await tty.waitFor(
      (s) =>
        (s.includes('新建学习笔记') || s.includes('New Study Note')) &&
        (s.includes('已选 1/30') || s.includes('Linked Cards (1/30)')),
      { timeoutMs: 8_000, label: 'NoteEditorModal create opened with preselected card' },
    );
    tty.assertHealthyScreen(createModal, 120, 36, 'NoteEditorModal opened');

    const noteTitle = 'Direct CtrlS Regression';
    const noteBody = 'Saved directly from body';

    tty.send(noteTitle);
    await tty.waitFor((s) => s.includes(noteTitle), { timeoutMs: 5_000, label: 'Note title typed' });

    // Tab 3 times: title -> query -> cards -> multiline markdown body
    for (let i = 0; i < 3; i += 1) {
      tty.send('\t');
      await sleep(40);
    }
    await tty.flush();

    tty.send(noteBody);
    const bodyTypedScreen = await tty.waitFor(
      (s) => s.includes(noteBody),
      { timeoutMs: 5_000, label: 'Note body typed directly in markdown field' },
    );
    assert.ok(
      bodyTypedScreen.includes('输入关键词按 Enter 搜索题目') || bodyTypedScreen.includes('Type keywords + Enter to search'),
      'Query field must remain untouched (proving focus moved to markdown body)',
    );

    // Press Ctrl+S (\x13) DIRECTLY while focused on markdown body (do NOT tab back to title)
    tty.send('\x13');
    await tty.waitFor(
      (s) => !s.includes('新建学习笔记') && !s.includes('New Study Note'),
      { timeoutMs: 8_000, label: 'NoteEditorModal closed after direct Ctrl+S on body' },
    );

    // Wait for background note.list / snapshot refresh to settle (~450ms)
    await sleep(450);
    await tty.flush();

    const afterRes = await host.call('note.list', {});
    assert.equal(afterRes.ok, true, `note.list after create must succeed: ${afterRes.error?.message || ''}`);
    const afterNotes = Array.isArray(afterRes.value?.notes) ? afterRes.value.notes : [];
    assert.equal(
      afterNotes.length,
      beforeCount + 1,
      `Expected exactly 1 created note (before=${beforeCount}, after=${afterNotes.length})`,
    );
    const matchingNotes = afterNotes.filter((n) => n.title === noteTitle);
    assert.equal(matchingNotes.length, 1, 'Direct Ctrl+S on body must not double-create notes');

    const settledScreen = await tty.waitFor(
      (s) => s.includes(noteTitle) && s.includes(noteBody),
      { timeoutMs: 6_000, label: 'Created note rendered in NotesView' },
    );
    tty.assertHealthyScreen(settledScreen, 120, 36, 'NotesView settled after direct Ctrl+S');

    // Cleanly delete the test note via 'd' + 'y'
    tty.send('d');
    const deleteDialog = await tty.waitFor(
      (s) => s.includes('删除笔记') || s.includes('Delete Note'),
      { timeoutMs: 8_000, label: 'Delete note confirmation dialog opened' },
    );
    tty.assertHealthyScreen(deleteDialog, 120, 36, 'NotesView delete dialog');

    tty.send('y');
    const afterDeleteScreen = await tty.waitFor(
      (s) => !s.includes('删除笔记') && !s.includes('Delete Note') && !s.includes(noteTitle),
      { timeoutMs: 8_000, label: 'Test note deleted from NotesView' },
    );
    tty.assertHealthyScreen(afterDeleteScreen, 120, 36, 'NotesView after delete');

    const finalRes = await host.call('note.list', {});
    assert.equal(finalRes.ok, true, 'note.list after delete must succeed');
    assert.equal(finalRes.value?.notes?.length, beforeCount, 'note.list count must return to beforeCount');

    await unmountActiveApp();
  });

  test('3) Real Subprocess CLI Cross-Platform Matrix (bin/studyhub-tui.mjs)', async () => {
    // 3a) --version with NO_COLOR=1 & TERM=dumb: exit 0, no ANSI escapes, latency < 1000ms
    const verRes = await runCliSubprocess(['--version'], { NO_COLOR: '1', TERM: 'dumb' });
    assert.equal(verRes.code, 0, `--version should exit 0, stderr: ${verRes.stderr}`);
    assert.match(verRes.stdout, /studyhub-tui\s+\d+\.\d+\.\d+/);
    assert.equal(verRes.stdout.includes('\x1b'), false, 'stdout must contain no ESC ANSI sequences');
    assert.equal(verRes.stdout.includes('\u009b'), false, 'stdout must contain no CSI ANSI sequences');
    assert.ok(verRes.durationMs < 1000, `--version fast-path took ${verRes.durationMs.toFixed(1)}ms (>= 1000ms)`);

    // 3b) --help with STUDYHUB_TUI_ASCII=1: exit 0, documents --ascii, --theme, --lang, agy
    const helpAsciiRes = await runCliSubprocess(['--help'], { STUDYHUB_TUI_ASCII: '1' });
    assert.equal(helpAsciiRes.code, 0, `--help should exit 0, stderr: ${helpAsciiRes.stderr}`);
    for (const token of ['--ascii', '--theme', '--lang', 'agy']) {
      assert.ok(helpAsciiRes.stdout.includes(token), `--help output must document "${token}"`);
    }

    // 3c) --theme nord --lang en --root "/tmp/path with spaces" --help: exit 0, clean arg parsing with spaces
    const spacedRes = await runCliSubprocess([
      '--theme',
      'nord',
      '--lang',
      'en',
      '--root',
      '/tmp/path with spaces',
      '--help',
    ]);
    assert.equal(spacedRes.code, 0, `spaced --root --help should exit 0, stderr: ${spacedRes.stderr}`);
    assert.ok(spacedRes.stdout.includes('StudyHub TUI'), 'spaced --root --help must print help text');
    assert.equal(spacedRes.stderr, '', 'spaced --root --help must produce empty stderr');

    // 3d) Invalid --theme unknown-theme: exit 2, clear stderr error message
    const badThemeRes = await runCliSubprocess(['--theme', 'unknown-theme']);
    assert.equal(badThemeRes.code, 2, `invalid --theme should exit 2, got ${badThemeRes.code}`);
    assert.match(badThemeRes.stderr, /Invalid --theme "unknown-theme"/);
  });
});
