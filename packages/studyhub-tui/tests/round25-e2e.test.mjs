// Round 25 Features E2E verification: node --test tests/round25-e2e.test.mjs
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
let displayWidth = null;
let useTuiStore = null;
for (const f of distFiles) {
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('chunk-') || f.startsWith('store-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!createTuiHost && typeof mod.createTuiHost === 'function') createTuiHost = mod.createTuiHost;
    if (!displayWidth && typeof mod.displayWidth === 'function') displayWidth = mod.displayWidth;
    if (!useTuiStore && typeof mod.useTuiStore?.getState === 'function') useTuiStore = mod.useTuiStore;
  }
}
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(displayWidth, 'dist/ must export displayWidth');
assert.ok(useTuiStore, 'dist/ must export useTuiStore');
const H = { createTuiHost };
const R = { displayWidth };

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round25-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const UNICODE_BOX_RE = /[\u2500-\u257f]/g;
const UNICODE_BLOCK_RE = /[\u2580-\u259f]/g;
const UNICODE_BRAILLE_RE = /[\u2800-\u28ff]/g;
const UNICODE_ARROW_RE = /[\u2190-\u21ff\u25b8\u276f]/g;
const UNICODE_CHROME_ARROW_RE = /[\u2190\u2191\u2193\u25b8\u276f]/g;

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

  function assertAsciiPure(screen, contextLabel, { allowRightArrowInHint = false } = {}) {
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
    const arrowRe = allowRightArrowInHint ? UNICODE_CHROME_ARROW_RE : UNICODE_ARROW_RE;
    const arrowMatch = screen.match(arrowRe);
    assert.equal(
      arrowMatch,
      null,
      `${contextLabel}: Unicode arrow chars leaked in --ascii mode: ${JSON.stringify(arrowMatch ? [...new Set(arrowMatch)] : [])}\n${screen}`,
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

function createRound25StubComplete() {
  return async (_system, prompt, execution = {}) => {
    if (String(prompt || '').includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const reply = JSON.stringify({ status: 'ok' });
    execution.onOutput?.(reply);
    return reply;
  };
}

function hasScopeHintBar(screen) {
  return (
    (screen.includes('/ 命令') &&
      screen.includes('# 题目') &&
      screen.includes('? 片段') &&
      screen.includes('@ 课程') &&
      screen.includes(': 页面')) ||
    (screen.includes('/ cmd') &&
      screen.includes('# card') &&
      screen.includes('? passage') &&
      screen.includes('@ course') &&
      screen.includes(': page'))
  );
}

describe('StudyHub TUI Round 25 Features E2E', () => {
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
      injectedComplete: createRound25StubComplete(),
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

  test('1) CommandPalette v3 scoped prefixes (/#?@:) & recentCommands persistence, 120x36 & 80x24, --ascii purity', async () => {
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

    // Open CommandPalette with Ctrl+K (\x0b)
    tty.send('\x0b');
    const paletteOpen = await tty.waitFor(
      (s) => (s.includes('命令面板') || s.includes('Command Palette')) && hasScopeHintBar(s),
      { timeoutMs: 6_000, label: 'CommandPalette opened with scope hint bar' },
    );
    tty.assertHealthyScreen(paletteOpen, 120, 36, 'CommandPalette initial at 120x36');

    // #Memento -> live card search hit
    tty.send('#Memento');
    await sleep(240);
    const cardHitScreen = await tty.waitFor(
      (s) =>
        !s.includes('正在全文检索') &&
        !s.includes('Searching') &&
        (s.includes('题库') || s.includes('Card')) &&
        s.includes('Memento'),
      { timeoutMs: 8_000, label: 'CommandPalette #Memento live card search hit' },
    );
    tty.assertHealthyScreen(cardHitScreen, 120, 36, 'CommandPalette #Memento');
    const cardScopeRows = tty
      .readLines()
      .filter((l) => l.includes('│') && !l.includes(': 页面') && !l.includes(': page'));
    assert.ok(
      !cardScopeRows.some((l) => l.includes(' 页面 ') || l.includes(' Page ')),
      `# scope must exclude page items:\n${cardHitScreen}`,
    );

    // Clear input (Ctrl+U = \x15) and test ?Bridge -> live passage hit
    tty.send('\x15');
    await tty.waitFor(
      (s) => s.includes('搜索页面、课程') || s.includes('Search pages'),
      { timeoutMs: 5_000, label: 'CommandPalette cleared before ?Bridge' },
    );
    tty.send('?Bridge');
    await sleep(240);
    const passageHitScreen = await tty.waitFor(
      (s) =>
        !s.includes('正在全文检索') &&
        !s.includes('Searching') &&
        (s.includes('原文') || s.includes('Passage')),
      { timeoutMs: 8_000, label: 'CommandPalette ?Bridge live passage hit' },
    );
    tty.assertHealthyScreen(passageHitScreen, 120, 36, 'CommandPalette ?Bridge');
    const passageScopeRows = tty
      .readLines()
      .filter((l) => l.includes('│') && !l.includes(': 页面') && !l.includes(': page'));
    assert.ok(
      !passageScopeRows.some((l) => l.includes(' 题库 ') || l.includes(' Card ')),
      `? scope must exclude card items:\n${passageHitScreen}`,
    );

    // Clear and test @示例 -> course filter
    tty.send('\x15');
    await tty.waitFor(
      (s) => s.includes('搜索页面、课程') || s.includes('Search pages'),
      { timeoutMs: 5_000, label: 'CommandPalette cleared before @示例' },
    );
    tty.send('@示例');
    const courseFilterScreen = await tty.waitFor(
      (s) =>
        (s.includes('课程') || s.includes('Course')) &&
        s.includes('示例课程 · 设计模式'),
      { timeoutMs: 6_000, label: 'CommandPalette @示例 course filter' },
    );
    tty.assertHealthyScreen(courseFilterScreen, 120, 36, 'CommandPalette @示例');

    // Clear and test :设置 -> page filter
    tty.send('\x15');
    await tty.waitFor(
      (s) => s.includes('搜索页面、课程') || s.includes('Search pages'),
      { timeoutMs: 5_000, label: 'CommandPalette cleared before :设置' },
    );
    tty.send(':设置');
    const pageFilterScreen = await tty.waitFor(
      (s) =>
        (s.includes('页面') || s.includes('Page')) &&
        (s.includes('设置') || s.includes('Settings')),
      { timeoutMs: 6_000, label: 'CommandPalette :设置 page filter' },
    );
    tty.assertHealthyScreen(pageFilterScreen, 120, 36, 'CommandPalette :设置');

    // Clear and test /theme -> execute command so it records in recentCommands
    tty.send('\x15');
    await tty.waitFor(
      (s) => s.includes('搜索页面、课程') || s.includes('Search pages'),
      { timeoutMs: 5_000, label: 'CommandPalette cleared before /theme' },
    );
    tty.send('/theme');
    const themeFilterScreen = await tty.waitFor(
      (s) => s.includes('/theme') && (s.includes('命令') || s.includes('Action')),
      { timeoutMs: 6_000, label: 'CommandPalette /theme command filter' },
    );
    tty.assertHealthyScreen(themeFilterScreen, 120, 36, 'CommandPalette /theme');

    const prevTheme = useTuiStore.getState().preferences.theme;
    tty.send('\r');
    await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        !s.includes('Command Palette') &&
        useTuiStore.getState().preferences.theme !== prevTheme,
      { timeoutMs: 6_000, label: 'CommandPalette /theme executed' },
    );

    const recent = useTuiStore.getState().preferences.recentCommands;
    assert.ok(Array.isArray(recent) && recent.includes('cmd:theme'), `Expected recentCommands to include cmd:theme, got ${JSON.stringify(recent)}`);

    // Re-open Ctrl+K with empty query -> verify Recent item renders at top + 80x24 + --ascii purity
    tty.send('\x0b');
    const reopened = await tty.waitFor(
      (s) =>
        (s.includes('命令面板') || s.includes('Command Palette')) &&
        (s.includes('最近') || s.includes('Recent')) &&
        s.includes('/theme'),
      { timeoutMs: 6_000, label: 'CommandPalette reopened showing Recent /theme' },
    );
    tty.assertHealthyScreen(reopened, 120, 36, 'CommandPalette reopened with recentCommands');

    // 80x24 layout check
    tty.resize(80, 24);
    const narrowPalette = await tty.waitFor(
      (s) =>
        (s.includes('命令面板') || s.includes('Command Palette')) &&
        hasScopeHintBar(s) &&
        s.split('\n').length <= 24,
      { timeoutMs: 6_000, label: 'CommandPalette at 80x24' },
    );
    tty.assertHealthyScreen(narrowPalette, 80, 24, 'CommandPalette at 80x24');

    // Restore 120x36
    tty.resize(120, 36);
    await tty.waitFor(
      (s) => (s.includes('命令面板') || s.includes('Command Palette')) && hasScopeHintBar(s),
      { timeoutMs: 6_000, label: 'CommandPalette restored to 120x36' },
    );

    // Verify --ascii purity on CommandPalette
    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      const asciiPalette = await tty.waitFor(
        (s) => s.includes('Up/Dn') && !s.includes('╭') && !s.includes('❯') && !s.includes('⌘'),
        { timeoutMs: 5_000, label: 'ASCII CommandPalette rendered' },
      );
      tty.assertHealthyScreen(asciiPalette, 120, 36, 'ASCII CommandPalette');
      tty.assertAsciiPure(asciiPalette, 'ASCII CommandPalette', { allowRightArrowInHint: true });
    } finally {
      useTuiStore.getState().setPreferences({ asciiMode: false });
      await tty.waitFor(
        (s) => s.includes('╭') && s.includes('⌘'),
        { timeoutMs: 5_000, label: 'Unicode mode restored on CommandPalette' },
      );
    }

    // Close CommandPalette via Esc
    tty.send('\x1b');
    const afterEsc = await tty.waitFor(
      (s) => !s.includes('命令面板') && !s.includes('Command Palette'),
      { timeoutMs: 6_000, label: 'CommandPalette closed via Esc' },
    );
    tty.assertHealthyScreen(afterEsc, 120, 36, 'LibraryView after CommandPalette Esc');
  });

  test('2) LibraryView [R] RoundConfigModal (1 -> R): 120x36 & 80x24, --ascii purity, adjust filter/size/focus, Enter starts ReviewView', async () => {
    if (useTuiStore.getState().page !== 'library') {
      tty.send('1');
    }
    const libScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'library' &&
        (s.includes('题组列表') || s.includes('Decks')) &&
        s.includes('示例 · Memento 与 Bridge'),
      { timeoutMs: 8_000, label: 'LibraryView active for RoundConfigModal' },
    );
    tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView before [R]');

    // Open RoundConfigModal via 'R'
    tty.send('R');
    const modalOpen = await tty.waitFor(
      (s) => s.includes('定制本轮练习') || s.includes('Configure Practice Round'),
      { timeoutMs: 8_000, label: 'RoundConfigModal opened via R' },
    );
    tty.assertHealthyScreen(modalOpen, 120, 36, 'RoundConfigModal at 120x36');

    // Adjust round size with '-', filter with '2' then '1', focusOnly toggle with 'f' then back with 'f'
    tty.send('-');
    await tty.waitFor(
      (s) => s.includes('15 题') || s.includes('15 cards'),
      { timeoutMs: 5_000, label: 'RoundConfigModal size decremented to 15' },
    );

    tty.send('2');
    await tty.waitFor(
      (s) => s.includes('仅到期') && (s.includes('就绪: 仅到期') || s.includes('Ready: Due Only')),
      { timeoutMs: 5_000, label: 'RoundConfigModal filter set to due via 2' },
    );

    tty.send('1');
    await tty.waitFor(
      (s) => s.includes('就绪: 智能混合') || s.includes('Ready: Smart Mix'),
      { timeoutMs: 5_000, label: 'RoundConfigModal filter restored to all via 1' },
    );

    tty.send('f');
    await tty.waitFor(
      (s) => s.includes('仅考纲重点') || s.includes('Focus only'),
      { timeoutMs: 5_000, label: 'RoundConfigModal focusOnly toggled ON via f' },
    );

    tty.send('f');
    await tty.waitFor(
      (s) => s.includes('全部难度') || s.includes('All cards'),
      { timeoutMs: 5_000, label: 'RoundConfigModal focusOnly toggled OFF via f' },
    );

    // 80x24 layout check
    tty.resize(80, 24);
    const modalNarrow = await tty.waitFor(
      (s) =>
        (s.includes('定制本轮练习') || s.includes('Configure Practice Round')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 6_000, label: 'RoundConfigModal at 80x24' },
    );
    tty.assertHealthyScreen(modalNarrow, 80, 24, 'RoundConfigModal at 80x24');

    // Restore 120x36
    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('定制本轮练习') || s.includes('Configure Practice Round'),
      { timeoutMs: 6_000, label: 'RoundConfigModal restored to 120x36' },
    );

    // --ascii purity check on RoundConfigModal
    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      const modalAscii = await tty.waitFor(
        (s) =>
          (s.includes('定制本轮练习') || s.includes('Configure Practice Round')) &&
          s.includes('<-/->') &&
          !s.includes('╭'),
        { timeoutMs: 5_000, label: 'ASCII RoundConfigModal rendered' },
      );
      tty.assertHealthyScreen(modalAscii, 120, 36, 'ASCII RoundConfigModal');
      tty.assertAsciiPure(modalAscii, 'ASCII RoundConfigModal');
    } finally {
      useTuiStore.getState().setPreferences({ asciiMode: false });
      await tty.waitFor(
        (s) => s.includes('╭') && s.includes('←/→'),
        { timeoutMs: 5_000, label: 'Unicode mode restored on RoundConfigModal' },
      );
    }

    // Press Enter to start the configured round -> ReviewView with active card
    tty.send('\r');
    const reviewScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'review' &&
        !s.includes('定制本轮练习') &&
        !s.includes('正在准备复习队列') &&
        !s.includes('Preparing review queue') &&
        (s.includes('[h]AI讲解') || s.includes('[h]AI Help') || s.includes('1/')),
      { timeoutMs: 10_000, label: 'ReviewView started from RoundConfigModal' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView started from RoundConfigModal');
  });

  test('3) ReviewView [u] review.undo: rate/answer card then undo rating cleanly', async () => {
    const runId = useTuiStore.getState().activeRunId;
    assert.ok(runId, 'Expected activeRunId in ReviewView from Test 2');
    const beforeRes = await host.call('review.get', { runId });
    assert.equal(beforeRes.ok, true, 'review.get before answering must succeed');
    const cardKind = String(beforeRes.value?.card?.kind || '').toLowerCase();

    // Answer or reveal + grade based on card kind so an attempt & undoable state are recorded
    if (cardKind === 'flashcard' || cardKind === 'open' || cardKind === 'short_answer' || cardKind === 'case') {
      tty.send(' ');
      await tty.waitFor(
        (s) => s.includes('FSRS-6 记忆评分') || s.includes('FSRS-6 Rating'),
        { timeoutMs: 8_000, label: 'Card revealed for FSRS rating' },
      );
      tty.send('2');
    } else if (cardKind === 'multiple') {
      tty.send('1');
      await tty.flush();
      tty.send('\r');
    } else if (cardKind === 'cloze' || cardKind === 'fill_blank') {
      tty.send('i');
      await tty.flush();
      tty.send('Originator');
      await tty.flush();
      tty.send('\r');
    } else {
      // single / quiz / true_false
      tty.send('1');
    }

    const gradedScreen = await tty.waitFor(
      (s) =>
        s.includes('回答正确') ||
        s.includes('回答有误') ||
        s.includes('已自报') ||
        s.includes('Correct') ||
        s.includes('Incorrect') ||
        s.includes('Self-reported'),
      { timeoutMs: 8_000, label: 'Feedback rendered after answering/rating card' },
    );
    tty.assertHealthyScreen(gradedScreen, 120, 36, 'ReviewView after rating card');

    const midRes = await host.call('review.get', { runId });
    assert.equal(midRes.ok, true, 'review.get after rating must succeed');
    assert.ok(midRes.value?.undoable, 'Expected run.undoable to be present after rating card');

    // Press 'u' to trigger review.undo
    tty.send('u');
    const undoneScreen = await tty.waitFor(
      (s) =>
        (s.includes('已撤销上一题评分') || s.includes('Undid last rating')) &&
        (s.includes('答案与解析') || s.includes('Answer & Explanation')) &&
        !s.includes('回答正确') &&
        !s.includes('回答有误') &&
        !s.includes('已自报'),
      { timeoutMs: 8_000, label: 'ReviewView after [u] review.undo' },
    );
    tty.assertHealthyScreen(undoneScreen, 120, 36, 'ReviewView after [u] review.undo');

    const afterRes = await host.call('review.get', { runId });
    assert.equal(afterRes.ok, true, 'review.get after undo must succeed');
    assert.equal(Boolean(afterRes.value?.undoable), false, 'run.undoable must clear after undoing');
    assert.equal(afterRes.value?.revealed, true, 'Undone card must remain in revealed state');
  });
});
