// Round 8 Features E2E verification: node --test tests/round8-e2e.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
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
for (const f of distFiles) {
  if (f.startsWith('host-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round8-${label}-`));
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

  function assertHealthyScreen(screen, expectedCols, contextLabel) {
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

  return {
    stdin,
    stdout,
    stderr,
    term,
    firstFramePromise,
    flush,
    readLines,
    readScreen,
    send,
    waitFor,
    assertHealthyScreen,
    dispose: () => {
      term.dispose();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

/** Deterministic model stub supporting teach.retell verdict JSON and streaming responses. */
function createRound8StubComplete() {
  return async (system, prompt, execution = {}) => {
    const s = String(system || '');
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';

    if (s.includes('The learner explains a study point in their own words')) {
      const req = JSON.parse(p);
      assert.ok(String(req.learnerExplanation || '').trim().length > 0, 'teach.retell payload must include learnerExplanation');
      const citationsCount = Number(req.citations || 0);
      return JSON.stringify({
        passed: true,
        right: ['Accurately captured Memento state snapshots and encapsulation.'],
        missed: [],
        wrong: [],
        cite: citationsCount > 0 ? 0 : null,
      });
    }

    const chunks = ['[AI Tutor] ', 'Stub ', 'response.'];
    for (const chunk of chunks) {
      execution.signal?.throwIfAborted?.();
      execution.onOutput?.(chunk);
      await sleep(8);
    }
    return chunks.join('');
  };
}

describe('StudyHub TUI Round 8 Features E2E', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let tty;
  let inkInstance;
  let disposed = false;

  async function cleanupAll() {
    if (disposed) return;
    disposed = true;
    try {
      inkInstance?.unmount();
    } catch {
      // Ignore unmount errors during teardown
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
      injectedComplete: createRound8StubComplete(),
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
    await cleanupAll();
    if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = PREV_DSH_HOME;
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
    );
  });

  test('1) Board Pomodoro Focus Timer (P / + / - / M / R)', async () => {
    await tty.waitFor(
      (s) => s.includes('载入示例课程体验') || s.includes('Load the sample course'),
      { label: 'Launchpad render' },
    );

    // Load sample course via 's'
    tty.send('s');
    await tty.waitFor(
      (s) =>
        !s.includes('载入示例课程体验') &&
        (s.includes('示例 · Memento 与 Bridge') || s.includes('Sample · Memento')),
      { timeoutMs: 12_000, label: 'Library after sample load' },
    );
    await sleep(150);
    await tty.flush();

    // Navigate to Board ('b')
    tty.send('b');
    const boardInit = await tty.waitFor(
      (s) =>
        (s.includes('待办 Todo') || s.includes('Todo')) &&
        s.includes('25:00') &&
        s.includes('⏸') &&
        (s.includes('专注 Focus') || s.includes('Focus')),
      { timeoutMs: 8_000, label: 'Board initial render with PomodoroBar 25:00 paused' },
    );
    tty.assertHealthyScreen(boardInit, 120, 'Board Pomodoro initial');

    // Press '+' -> cycles 25:00 -> 45:00
    tty.send('+');
    const dur45 = await tty.waitFor(
      (s) => s.includes('45:00') && s.includes('⏸'),
      { label: 'Pomodoro duration cycled to 45:00 via +' },
    );
    tty.assertHealthyScreen(dur45, 120, 'Board Pomodoro + (45:00)');

    // Press '-' -> cycles 45:00 -> 25:00, then '+' back to 45:00
    tty.send('-');
    const dur25 = await tty.waitFor(
      (s) => s.includes('25:00') && s.includes('⏸'),
      { label: 'Pomodoro duration cycled back to 25:00 via -' },
    );
    tty.assertHealthyScreen(dur25, 120, 'Board Pomodoro - (25:00)');

    tty.send('+');
    await tty.waitFor(
      (s) => s.includes('45:00') && s.includes('⏸'),
      { label: 'Pomodoro duration back to 45:00' },
    );

    // Press 'P' -> timer starts (▶) and ticks down
    tty.send('P');
    const runningScreen = await tty.waitFor(
      (s) => s.includes('▶') && (s.includes('专注 Focus') || s.includes('Focus')),
      { label: 'Pomodoro started (▶)' },
    );
    tty.assertHealthyScreen(runningScreen, 120, 'Board Pomodoro running');

    const tickedScreen = await tty.waitFor(
      (s) => s.includes('▶') && (s.includes('44:59') || s.includes('44:58')),
      { timeoutMs: 4_000, label: 'Pomodoro countdown ticked from 45:00' },
    );
    tty.assertHealthyScreen(tickedScreen, 120, 'Board Pomodoro ticked');

    // Press 'P' -> pauses (⏸)
    tty.send('P');
    const pausedScreen = await tty.waitFor(
      (s) => s.includes('⏸') && !s.includes('▶'),
      { label: 'Pomodoro paused (⏸)' },
    );
    tty.assertHealthyScreen(pausedScreen, 120, 'Board Pomodoro paused');

    // Press 'M' -> toggles to Break mode (短休 / 05:00)
    tty.send('M');
    const breakScreen = await tty.waitFor(
      (s) => (s.includes('短休') || s.includes('Break')) && s.includes('05:00') && s.includes('⏸'),
      { label: 'Pomodoro toggled to Break mode (05:00)' },
    );
    tty.assertHealthyScreen(breakScreen, 120, 'Board Pomodoro break mode');

    // Start Break timer briefly so elapsed > 0, then press 'R' to verify clean reset to 05:00 paused
    tty.send('P');
    await tty.waitFor(
      (s) => s.includes('▶') && (s.includes('04:59') || s.includes('04:58')),
      { timeoutMs: 4_000, label: 'Break timer ticked to 04:59' },
    );

    tty.send('R');
    const resetScreen = await tty.waitFor(
      (s) => s.includes('05:00') && s.includes('⏸') && !s.includes('▶'),
      { label: 'Pomodoro reset to 05:00 paused via R' },
    );
    tty.assertHealthyScreen(resetScreen, 120, 'Board Pomodoro reset');
  });

  test('2) Settings Workspace Library Backup Export (x)', async () => {
    // Navigate to Settings (',')
    tty.send(',');
    const settingsInit = await tty.waitFor(
      (s) => (s.includes('模型配置') || s.includes('Models')) && (s.includes('学习库与工作区') || s.includes('Workspace')),
      { timeoutMs: 8_000, label: 'Settings view rendered' },
    );
    tty.assertHealthyScreen(settingsInit, 120, 'Settings initial');

    // Switch to Tab 2 Workspace ('2')
    tty.send('2');
    const workspaceTab = await tty.waitFor(
      (s) =>
        (s.includes('学习库路径与工作区') || s.includes('Library Root & Workspace')) &&
        (s.includes('导出学习库备份') || s.includes('Export backup')),
      { timeoutMs: 8_000, label: 'Settings Workspace tab rendered' },
    );
    tty.assertHealthyScreen(workspaceTab, 120, 'Settings Workspace tab');

    // Press 'x' -> Export Backup modal opens with default studyhub-backup-YYYY-MM-DD.json path
    const expectedStem = `studyhub-backup-${todayLocalYmd()}`;
    const expectedFilename = `${expectedStem}.json`;
    tty.send('x');
    const exportModal = await tty.waitFor(
      (s) =>
        (s.includes('导出学习库备份') || s.includes('Export Library Backup')) &&
        s.includes(expectedStem),
      { timeoutMs: 8_000, label: `Export Backup modal with ${expectedFilename}` },
    );
    tty.assertHealthyScreen(exportModal, 120, 'Export Backup modal');

    // Press Enter -> exports JSON to <libraryRoot>/backups/
    tty.send('\r');
    const afterExport = await tty.waitFor(
      (s) =>
        !s.includes('输入备份文件路径') &&
        !s.includes('Enter backup file path') &&
        (s.includes('已导出备份') || s.includes('Exported backup')),
      { timeoutMs: 10_000, label: 'Backup export success toast' },
    );
    tty.assertHealthyScreen(afterExport, 120, 'Settings Workspace after export');

    // Verify backup file on disk inside <libraryRoot>/backups/ and valid JSON with decks/cards
    const backupsDir = join(libraryRoot, 'backups');
    const backupFiles = await readdir(backupsDir);
    assert.ok(
      backupFiles.includes(expectedFilename),
      `Expected ${expectedFilename} in ${backupsDir}, found: ${JSON.stringify(backupFiles)}`,
    );
    const rawBackup = await readFile(join(backupsDir, expectedFilename), 'utf8');
    const parsedBackup = JSON.parse(rawBackup);
    assert.ok(Array.isArray(parsedBackup.decks) && parsedBackup.decks.length > 0, 'Backup JSON must contain non-empty decks array');
    const totalCards = parsedBackup.decks.reduce(
      (sum, deck) => sum + (Array.isArray(deck?.cards) ? deck.cards.length : 0),
      0,
    );
    assert.ok(totalCards > 0, `Backup JSON decks must contain cards (got ${totalCards})`);
  });

  test('3) Review Feynman Retell (F)', async () => {
    // Navigate back to Library via '6' (Dashboard) -> '1' (Library), since Settings claims '1'-'4'
    tty.send('6');
    const dashScreen = await tty.waitFor(
      (s) => (s.includes('学习统计与掌握度') || s.includes('Stats')) && !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'Dashboard view before Library' },
    );
    tty.assertHealthyScreen(dashScreen, 120, 'Dashboard view');

    tty.send('1');
    const libScreen = await tty.waitFor(
      (s) => (s.includes('题组列表') || s.includes('Decks')) && !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'Library view' },
    );
    tty.assertHealthyScreen(libScreen, 120, 'Library view');

    // Enter Review ('r')
    tty.send('r');
    const reviewScreen = await tty.waitFor(
      (s) =>
        (s.includes('[F]复述') || s.includes('[F]Retell')) &&
        !s.includes('正在加载页面') &&
        !s.includes('正在准备复习队列'),
      { timeoutMs: 10_000, label: 'Review active card' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 'Review initial card');

    // Press 'F' -> RetellModal opens
    tty.send('F');
    const retellOpen = await tty.waitFor(
      (s) =>
        (s.includes('用自己的话讲一遍') || s.includes('Feynman Retell')) &&
        (s.includes('用自己的话复述核心原理') || s.includes('Explain the core idea in your own words')),
      { timeoutMs: 8_000, label: 'RetellModal opened' },
    );
    tty.assertHealthyScreen(retellOpen, 120, 'RetellModal input');

    // Type explanation and submit with Ctrl+S (\x13)
    const explanation = 'Memento captures state snapshots without breaking encapsulation.';
    tty.send(explanation);
    await tty.waitFor(
      (s) => s.includes('Memento captures state snapshots'),
      { label: 'Explanation typed in RetellModal' },
    );

    tty.send('\x13');
    const verdictScreen = await tty.waitFor(
      (s) =>
        (s.includes('通过 · Pass') || s.includes('+ Pass')) &&
        (s.includes('讲对了') || s.includes('What You Got Right')) &&
        s.includes('Accurately captured Memento') &&
        !s.includes('正在评估你的费曼复述'),
      { timeoutMs: 8_000, label: 'RetellModal verdict rendered' },
    );
    tty.assertHealthyScreen(verdictScreen, 120, 'RetellModal verdict');

    // Press Esc to close RetellModal
    tty.send('\x1b');
    const reviewAfterClose = await tty.waitFor(
      (s) => !s.includes('用自己的话讲一遍') && !s.includes('Feynman Retell'),
      { timeoutMs: 8_000, label: 'RetellModal closed via Esc' },
    );
    tty.assertHealthyScreen(reviewAfterClose, 120, 'Review after RetellModal closed');
  });
});
