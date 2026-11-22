// Round 24 Features E2E verification: node --test tests/round24-e2e.test.mjs
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

let createTuiHost = null;
let saveTuiPreferences = null;
let displayWidth = null;
let useTuiStore = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('chunk-') || f.startsWith('store-')) {
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
const H = { createTuiHost, saveTuiPreferences };
const R = { displayWidth };

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round24-${label}-`));
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

function createRound24StubComplete() {
  return async (_system, prompt, execution = {}) => {
    if (String(prompt || '').includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const reply = JSON.stringify({ status: 'ok' });
    execution.onOutput?.(reply);
    return reply;
  };
}

function hasCustomWizardOptions(screen) {
  return (
    (screen.includes('深度定制向导') || screen.includes('Custom Plan Wizard')) &&
    (screen.includes('学习目的') || screen.includes('Purpose')) &&
    (screen.includes('覆盖范围') || screen.includes('Scope')) &&
    (screen.includes('全书讲解') || screen.includes('Explanations')) &&
    (screen.includes('出题强度') || screen.includes('Q Strength')) &&
    (screen.includes('每日时长') || screen.includes('Min / Day'))
  );
}

function hasCustomEstimate(screen) {
  return (
    !screen.includes('正在重算零成本估算') &&
    !screen.includes('Updating zero-cost estimate') &&
    (screen.includes('粗估(非计费):') ||
      screen.includes('Rough est.(no price):') ||
      screen.includes('粗估:') ||
      screen.includes('Est:'))
  );
}

describe('StudyHub TUI Round 24 Features E2E', () => {
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
      injectedComplete: createRound24StubComplete(),
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

  test('1) StudyPlanModal Tab 3 Custom Plan Wizard (0 -> P -> 3): options, live preview, save without clobbering exam date, 120x36 & 80x24, --ascii purity, Esc close', async () => {
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

    const courseName = '示例课程 · 设计模式';
    const beforeCourse = await host.call('course.get', { name: courseName });
    assert.equal(beforeCourse.ok, true, 'course.get before saving custom plan must succeed');
    assert.ok(beforeCourse.value?.exam?.date, 'Sample course must have an initial exam date');

    // Navigate to ExamPrepView ('0') and wait for ExamPrepView-unique content
    tty.send('0');
    const examPrepScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'examprep' &&
        (s.includes('备考补习') || s.includes('Exam Prep')) &&
        (s.includes('考纲重点进度') || s.includes('Focus Progress')) &&
        !s.includes('正在加载页面') &&
        !s.includes('正在加载备考重点'),
      { timeoutMs: 10_000, label: 'ExamPrepView rendered' },
    );
    tty.assertHealthyScreen(examPrepScreen, 120, 36, 'ExamPrepView at 120x36');

    // Press 'P' to open StudyPlanModal
    tty.send('P');
    await tty.waitFor(
      (s) => s.includes('课程备考计划 & 章节就绪度') || s.includes('Study Plan & Chapter Readiness'),
      { timeoutMs: 10_000, label: 'StudyPlanModal opened' },
    );

    // Press '3' to open Tab 3 (3:深度定制 / 3:Custom)
    tty.send('3');
    const tab3Initial = await tty.waitFor(
      (s) =>
        (s.includes('3:深度定制') || s.includes('3:Custom')) &&
        !s.includes('正在加载深度定制配置') &&
        !s.includes('Loading custom plan') &&
        !s.includes('正在初始化向导') &&
        hasCustomWizardOptions(s) &&
        hasCustomEstimate(s),
      { timeoutMs: 10_000, label: 'StudyPlanModal Tab 3 Custom Wizard rendered with live estimate' },
    );
    tty.assertHealthyScreen(tab3Initial, 120, 36, 'StudyPlanModal Tab 3 at 120x36');

    const initialMinMatch = tab3Initial.match(/(\d+)(?:分\/天|m\/d)/);
    assert.ok(initialMinMatch, `Expected Minutes/Day value in Tab 3:\n${tab3Initial}`);
    const initialMins = Number(initialMinMatch[1]);

    // Move down to Scope row ('j') and toggle ('Space')
    tty.send('j');
    await tty.waitFor(
      (s) => s.includes('覆盖当前课程全部可学习章节') || s.includes('Covers all teachable chapters'),
      { timeoutMs: 5_000, label: 'Cursor moved to Scope row' },
    );

    tty.send(' ');
    await tty.waitFor(
      (s) => (s.includes('考纲范围') || s.includes('Exam Scope')) && hasCustomEstimate(s),
      { timeoutMs: 8_000, label: 'Scope toggled to Exam Scope and live preview updated' },
    );

    // Move back up to Purpose row ('k') and cycle ('Space'), then bump Minutes/Day ('+')
    tty.send('k');
    await tty.waitFor(
      (s) => s.includes('学习目的:') || s.includes('Purpose:'),
      { timeoutMs: 5_000, label: 'Cursor moved back to Purpose row' },
    );

    tty.send(' ');
    await tty.waitFor(
      (s) => s.includes('开卷速查') || s.includes('Open-book') || s.includes('课前预习') || s.includes('Preview'),
      { timeoutMs: 8_000, label: 'Purpose cycled via Space' },
    );

    tty.send('+');
    const expectedMins = Math.min(240, initialMins + 15);
    const tab3Edited = await tty.waitFor(
      (s) =>
        (s.includes(`${expectedMins}分/天`) || s.includes(`${expectedMins}m/d`)) &&
        hasCustomEstimate(s),
      { timeoutMs: 8_000, label: 'Minutes/Day adjusted via + and live estimate settled' },
    );
    tty.assertHealthyScreen(tab3Edited, 120, 36, 'StudyPlanModal Tab 3 after edits');

    // Press 's' to save custom plan via course.save
    tty.send('s');
    const tab3Saved = await tty.waitFor(
      (s) =>
        !s.includes('正在保存定制方案') &&
        !s.includes('Saving custom plan') &&
        !s.includes('草稿(未存)') &&
        !s.includes('已修改(未存)') &&
        (s.includes('已保存') || s.includes('Saved')) &&
        (s.includes('深度定制方案') || s.includes('Saved custom plan')),
      { timeoutMs: 10_000, label: 'StudyPlanModal Tab 3 saved toast and badge' },
    );
    tty.assertHealthyScreen(tab3Saved, 120, 36, 'StudyPlanModal Tab 3 after save');

    const afterCourse = await host.call('course.get', { name: courseName });
    assert.equal(afterCourse.ok, true, 'course.get after saving custom plan must succeed');
    assert.deepEqual(
      afterCourse.value?.exam,
      beforeCourse.value?.exam,
      'Saving custom plan must not clobber existing course exam date or exam profile',
    );
    assert.ok(afterCourse.value?.custom, 'course.custom must be persisted after [s]');

    // Verify clean layout at 80x24
    tty.resize(80, 24);
    const tab3Narrow = await tty.waitFor(
      (s) =>
        (s.includes('深度定制向导') || s.includes('Custom Plan Wizard')) &&
        hasCustomEstimate(s) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'StudyPlanModal Tab 3 at 80x24' },
    );
    tty.assertHealthyScreen(tab3Narrow, 80, 24, 'StudyPlanModal Tab 3 at 80x24');

    // Restore 120x36
    tty.resize(120, 36);
    await tty.waitFor(
      (s) => (s.includes('深度定制向导') || s.includes('Custom Plan Wizard')) && hasCustomWizardOptions(s),
      { timeoutMs: 8_000, label: 'StudyPlanModal Tab 3 restored to 120x36' },
    );

    // Close via Esc
    tty.send('\x1b');
    const afterEsc = await tty.waitFor(
      (s) =>
        !s.includes('深度定制向导') &&
        !s.includes('课程备考计划') &&
        (s.includes('备考补习') || s.includes('Exam Prep')),
      { timeoutMs: 8_000, label: 'StudyPlanModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterEsc, 120, 36, 'ExamPrepView after Esc closed StudyPlanModal');

    // Verify --ascii purity for StudyPlanModal Tab 3 via store asciiMode toggle
    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      await tty.waitFor(
        (s) => s.includes('[SH] StudyHub') && !s.includes('╭'),
        { timeoutMs: 5_000, label: 'ASCII mode enabled on ExamPrepView' },
      );

      tty.send('P');
      await tty.waitFor(
        (s) => s.includes('课程备考计划 & 章节就绪度') || s.includes('Study Plan & Chapter Readiness'),
        { timeoutMs: 10_000, label: 'ASCII StudyPlanModal opened' },
      );

      tty.send('3');
      const tab3Ascii = await tty.waitFor(
        (s) =>
          !s.includes('正在加载深度定制配置') &&
          !s.includes('Loading custom plan') &&
          hasCustomWizardOptions(s) &&
          hasCustomEstimate(s) &&
          s.includes('Space/<->'),
        { timeoutMs: 10_000, label: 'ASCII StudyPlanModal Tab 3 rendered' },
      );
      tty.assertHealthyScreen(tab3Ascii, 120, 36, 'ASCII StudyPlanModal Tab 3');
      tty.assertAsciiPure(tab3Ascii, 'ASCII StudyPlanModal Tab 3');

      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('深度定制向导') && !s.includes('课程备考计划'),
        { timeoutMs: 6_000, label: 'ASCII StudyPlanModal closed' },
      );
    } finally {
      useTuiStore.getState().setPreferences({ asciiMode: false });
      await tty.waitFor(
        (s) => s.includes('╭') && !s.includes('[SH] StudyHub'),
        { timeoutMs: 5_000, label: 'Unicode mode restored after ASCII check' },
      );
    }
  });

  test('2) DeckManageModal Multi-Select Batch Focus (1 -> m -> Space -> F): select 2 cards, batch Focus updates markers, x clears selection, Esc closes', async () => {
    // Navigate back to LibraryView (ExamPrepView claims '1'/'2' for its subtabs, so Backspace returns to LibraryView first, or verify '1' once back)
    if (useTuiStore.getState().page !== 'library') {
      tty.send('\x7f');
      await tty.waitFor(
        () => useTuiStore.getState().page === 'library',
        { timeoutMs: 6_000, label: 'Returned from ExamPrepView to LibraryView' },
      );
    }
    tty.send('1');
    const libraryScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'library' &&
        (s.includes('题组列表') || s.includes('Decks')) &&
        s.includes('示例 · Memento 与 Bridge') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'LibraryView rendered' },
    );
    tty.assertHealthyScreen(libraryScreen, 120, 36, 'LibraryView at 120x36');

    // Open DeckManageModal via 'm' on first sample deck
    tty.send('m');
    const manageInitial = await tty.waitFor(
      (s) =>
        (s.includes('题组管理') || s.includes('Manage Deck')) &&
        !s.includes('正在读取题组卡片') &&
        !s.includes('Loading deck cards') &&
        s.includes(' 1.') &&
        s.includes(' 2.'),
      { timeoutMs: 10_000, label: 'DeckManageModal opened' },
    );
    tty.assertHealthyScreen(manageInitial, 120, 36, 'DeckManageModal initial at 120x36');
    assert.equal(
      (manageInitial.match(/★/g) ?? []).length,
      0,
      `Expected no initial Focus stars before batch toggle:\n${manageInitial}`,
    );

    // Select 2 cards via Space, j, Space (flush between keys so Ink parses discrete events)
    tty.send(' ');
    await tty.waitFor(
      (s) => s.includes('[已选 1]') || s.includes('[1 sel]'),
      { timeoutMs: 5_000, label: 'DeckManageModal 1st card selected' },
    );
    tty.send('j');
    await tty.flush();
    tty.send(' ');
    const selectedScreen = await tty.waitFor(
      (s) =>
        (s.includes('[已选 2]') || s.includes('[2 sel]')) &&
        (s.includes('[F]重点') || s.includes('[F]Focus')),
      { timeoutMs: 8_000, label: 'DeckManageModal 2 cards selected' },
    );
    tty.assertHealthyScreen(selectedScreen, 120, 36, 'DeckManageModal with 2 cards selected');

    // Press 'F' to batch-toggle Focus
    tty.send('F');
    const focusedScreen = await tty.waitFor(
      (s) =>
        (s.match(/★/g) ?? []).length >= 2 &&
        (s.includes('已将 2 题标为重点') || s.includes('Marked 2 card(s) as Focus')),
      { timeoutMs: 8_000, label: 'DeckManageModal batch Focus applied' },
    );
    tty.assertHealthyScreen(focusedScreen, 120, 36, 'DeckManageModal after batch Focus');

    // Press 'x' to clear selection
    tty.send('x');
    const clearedScreen = await tty.waitFor(
      (s) =>
        !s.includes('[已选') &&
        !s.includes('sel]') &&
        !s.includes('已选 2') &&
        !s.includes('2 sel') &&
        (s.match(/★/g) ?? []).length >= 2,
      { timeoutMs: 8_000, label: 'DeckManageModal selection cleared via x' },
    );
    tty.assertHealthyScreen(clearedScreen, 120, 36, 'DeckManageModal after clearing selection');

    // Press Esc to close DeckManageModal
    tty.send('\x1b');
    const afterClose = await tty.waitFor(
      (s) =>
        !s.includes('题组管理') &&
        !s.includes('Manage Deck') &&
        (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 8_000, label: 'DeckManageModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterClose, 120, 36, 'LibraryView after Esc closed DeckManageModal');
  });

  test('3) WrongBookView Multi-Select Batch Practice (4 -> Space -> B -> ReviewView): selects 1 weak card and launches 1/1 ReviewView', async () => {
    // Navigate to WrongBookView ('4')
    tty.send('4');
    const wrongBookScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'wrongbook' &&
        (s.includes('错题列表') || s.includes('Mistakes')) &&
        !s.includes('正在加载错题本') &&
        !s.includes('Loading mistakes') &&
        (s.includes('Memento') || s.includes('Bridge')),
      { timeoutMs: 10_000, label: 'WrongBookView rendered with weak cards' },
    );
    tty.assertHealthyScreen(wrongBookScreen, 120, 36, 'WrongBookView at 120x36');

    // Press Space on first weak card
    tty.send(' ');
    const selectedWrongScreen = await tty.waitFor(
      (s) =>
        (s.includes('[已选 1]') || s.includes('[1 sel]')) &&
        (s.includes('练已选(1)') || s.includes('Batch(1)')),
      { timeoutMs: 8_000, label: 'WrongBookView 1 weak card selected' },
    );
    tty.assertHealthyScreen(selectedWrongScreen, 120, 36, 'WrongBookView with 1 card selected');

    // Press 'B' to launch batch practice into ReviewView with 1/1 question
    tty.send('B');
    const reviewScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'review' &&
        !s.includes('正在准备复习队列') &&
        !s.includes('Preparing review queue') &&
        s.includes('1/1'),
      { timeoutMs: 10_000, label: 'ReviewView launched from WrongBook [B] with 1/1 question' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView after WrongBook [B] batch practice');
  });
});
