// Round 20/21 Features E2E verification: node --test tests/round20-e2e.test.mjs
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round20-${label}-`));
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

function createRound20StubComplete() {
  return async (_system, prompt, execution = {}) => {
    if (String(prompt || '').includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const reply = JSON.stringify({ status: 'ok' });
    execution.onOutput?.(reply);
    return reply;
  };
}

describe('StudyHub TUI Round 20/21 Features E2E', () => {
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
      injectedComplete: createRound20StubComplete(),
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

  test('1) RoundSummary interactive review.lookBack browser, j/k & Enter preview, 120x36 & 80x24, --ascii purity, and [w] weak-retry', async () => {
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

    // Pick 2 flashcard cards from the sample deck for a deterministic 2-card run
    const snapRes = await host.call('snapshot', {});
    assert.equal(snapRes.ok, true, 'snapshot must succeed');
    const sampleDeck = (snapRes.value?.decks || []).find((d) => d.id === 'sample-deck-patterns') || snapRes.value?.decks?.[0];
    assert.ok(sampleDeck?.id, 'Sample deck must exist');

    const deckDetailRes = await host.call('deck.get', { id: sampleDeck.id });
    assert.equal(deckDetailRes.ok, true, 'deck.get must succeed');
    const flashcards = (deckDetailRes.value?.cards || []).filter((c) => c.kind === 'flashcard');
    assert.ok(flashcards.length >= 2, 'Sample deck must have at least 2 flashcards');
    const card1 = flashcards[0];
    const card2 = flashcards[1];

    const startRes = await host.call('review.start', {
      mode: 'path',
      scope: [
        { deckId: sampleDeck.id, cardId: card1.id },
        { deckId: sampleDeck.id, cardId: card2.id },
      ],
      fresh: true,
    });
    assert.equal(startRes.ok, true, 'review.start 2-card run must succeed');
    const runId = startRes.value?.id;
    assert.ok(runId, 'review.start must return a runId');

    useTuiStore.getState().navigate('review', { runId });

    // Card 1: wait for ReviewView, reveal with Space, rate '1' (Again) -> queues tail retry
    const c1PromptSnippet = String(card1.prompt || '').slice(0, 14);
    await tty.waitFor(
      (s) =>
        s.includes(c1PromptSnippet) &&
        (s.includes('按 [Space] 或 [Enter] 翻开答案') || s.includes('Press [Space] or [Enter] to flip card')),
      { timeoutMs: 10_000, label: 'Card 1 rendered in ReviewView' },
    );

    tty.send(' ');
    await tty.waitFor(
      (s) => s.includes('答案与解析') && s.includes('重来'),
      { timeoutMs: 8_000, label: 'Card 1 revealed with FSRS rating bar' },
    );

    tty.send('1');
    await tty.waitFor(
      (s) => s.includes('下一题') && !s.includes('按 [Space] 或 [Enter] 翻开答案'),
      { timeoutMs: 8_000, label: 'Card 1 rated Again (1)' },
    );

    // Advance to Card 2 via Enter
    tty.send('\r');
    const c2PromptSnippet = String(card2.prompt || '').slice(0, 14);
    await tty.waitFor(
      (s) =>
        s.includes(c2PromptSnippet) &&
        (s.includes('按 [Space] 或 [Enter] 翻开答案') || s.includes('Press [Space] or [Enter] to flip card')),
      { timeoutMs: 8_000, label: 'Card 2 rendered in ReviewView' },
    );

    // Card 2: reveal with Space, rate '5' (Easy -> passing grade 5, auto-advances to tail retry)
    tty.send(' ');
    await tty.waitFor(
      (s) => s.includes('答案与解析') && s.includes('简单'),
      { timeoutMs: 8_000, label: 'Card 2 revealed with FSRS rating bar' },
    );

    tty.send('5');
    // Tail retry of Card 1 appears ('再练' / 'Retry' badge)
    await tty.waitFor(
      (s) =>
        s.includes(c1PromptSnippet) &&
        (s.includes('再练') || s.includes('Retry')) &&
        (s.includes('按 [Space] 或 [Enter] 翻开答案') || s.includes('Press [Space] or [Enter] to flip card')),
      { timeoutMs: 8_000, label: 'Card 1 tail retry rendered' },
    );

    // Complete tail retry of Card 1 with passing rating (' ' then '3' Good) to finish round naturally
    tty.send(' ');
    await tty.waitFor(
      (s) => s.includes('答案与解析') && s.includes('良好'),
      { timeoutMs: 8_000, label: 'Tail retry revealed' },
    );
    tty.send('3');

    // Verify RoundSummary renders review.lookBack list cleanly at 120x36
    const summaryInit = await tty.waitFor(
      (s) =>
        (s.includes('本轮练习总结') || s.includes('Round Summary')) &&
        (s.includes('本轮题目回顾') || s.includes('Round Look-Back')) &&
        !s.includes('加载本轮回顾') &&
        !s.includes('Loading look-back') &&
        s.includes('#1') &&
        s.includes('#2') &&
        (s.includes('[重来]') || s.includes('[Again]')),
      { timeoutMs: 10_000, label: 'RoundSummary lookBack rendered at 120x36' },
    );
    tty.assertHealthyScreen(summaryInit, 120, 36, 'RoundSummary initial at 120x36');
    assert.ok(
      summaryInit.includes('需巩固') || summaryInit.includes('Missed'),
      'Initial selection on first weak card #1 must display Missed/需巩固 badge',
    );

    // Navigate down with 'j' to #2 and verify right detail pane updates
    tty.send('j');
    const summaryRow2 = await tty.waitFor(
      (s) =>
        (s.includes('答对') || s.includes('Correct')) &&
        (s.includes('简单') || s.includes('Easy')) &&
        s.includes(c2PromptSnippet.slice(0, 10)),
      { timeoutMs: 6_000, label: 'RoundSummary navigated to #2 via j' },
    );
    tty.assertHealthyScreen(summaryRow2, 120, 36, 'RoundSummary row #2 at 120x36');

    // Navigate back up with 'k' to #1
    tty.send('k');
    const summaryRow1 = await tty.waitFor(
      (s) =>
        (s.includes('需巩固') || s.includes('Missed')) &&
        (s.includes('重来') || s.includes('Again')) &&
        s.includes(c1PromptSnippet.slice(0, 10)),
      { timeoutMs: 6_000, label: 'RoundSummary navigated back to #1 via k' },
    );
    tty.assertHealthyScreen(summaryRow1, 120, 36, 'RoundSummary back to row #1 at 120x36');

    // Press Enter to toggle inline answer & explanation preview ON
    tty.send('\r');
    const summaryExpanded = await tty.waitFor(
      (s) =>
        (s.includes('参考答案') || s.includes('Reference Answer')) &&
        (s.includes('解析') || s.includes('Explanation')) &&
        (s.includes('收起参考答案与解析') || s.includes('Hide Answer & Explanation')),
      { timeoutMs: 6_000, label: 'RoundSummary Enter toggled preview ON at 120x36' },
    );
    tty.assertHealthyScreen(summaryExpanded, 120, 36, 'RoundSummary preview expanded at 120x36');

    // Press Enter again to collapse preview back OFF
    tty.send('\r');
    const summaryCollapsed = await tty.waitFor(
      (s) =>
        !s.includes('参考答案:') &&
        (s.includes('展开参考答案与解析') || s.includes('Show Reference Answer & Explanation')),
      { timeoutMs: 6_000, label: 'RoundSummary Enter toggled preview OFF at 120x36' },
    );
    tty.assertHealthyScreen(summaryCollapsed, 120, 36, 'RoundSummary preview collapsed at 120x36');

    // Resize to 80x24 and verify healthy layout (both list & expanded detail)
    tty.resize(80, 24);
    const summaryNarrowList = await tty.waitFor(
      (s) =>
        (s.includes('本轮练习总结') || s.includes('Round Summary')) &&
        (s.includes('本轮题目回顾') || s.includes('Round Look-Back')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'RoundSummary at 80x24 list pane' },
    );
    tty.assertHealthyScreen(summaryNarrowList, 80, 24, 'RoundSummary list at 80x24');

    tty.send('\r');
    const summaryNarrowDetail = await tty.waitFor(
      (s) =>
        (s.includes('参考答案') || s.includes('Reference Answer')) &&
        (s.includes('收起返回列表') || s.includes('Collapse')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 6_000, label: 'RoundSummary at 80x24 expanded detail pane' },
    );
    tty.assertHealthyScreen(summaryNarrowDetail, 80, 24, 'RoundSummary detail at 80x24');

    // Collapse back in narrow mode via Esc
    tty.send('\x1b');
    await tty.waitFor(
      (s) =>
        (s.includes('本轮题目回顾') || s.includes('Round Look-Back')) &&
        !s.includes('收起返回列表'),
      { timeoutMs: 6_000, label: 'RoundSummary collapsed from narrow detail via Esc' },
    );

    // Restore 120x36 and verify --ascii purity on RoundSummary
    tty.resize(120, 36);
    await tty.waitFor(
      (s) => (s.includes('本轮练习总结') || s.includes('Round Summary')) && s.includes('[w]'),
      { timeoutMs: 8_000, label: 'RoundSummary restored to 120x36' },
    );

    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      const summaryAscii = await tty.waitFor(
        (s) =>
          s.includes('* 本轮练习总结') &&
          s.includes('>x #1') &&
          s.includes(' + #2'),
        { timeoutMs: 6_000, label: 'RoundSummary rendered in --ascii mode' },
      );
      tty.assertHealthyScreen(summaryAscii, 120, 36, 'RoundSummary --ascii at 120x36');
      tty.assertAsciiPure(summaryAscii, 'RoundSummary --ascii at 120x36');
    } finally {
      // Restore unicode mode before weak retry & Test 2
      useTuiStore.getState().setPreferences({ asciiMode: false });
    }
    await tty.waitFor(
      (s) => s.includes('★ 本轮练习总结') && s.includes('#1'),
      { timeoutMs: 6_000, label: 'RoundSummary restored to Unicode mode' },
    );

    // Press 'w' to launch weak-cards retry round -> ReviewView opens cleanly with missed card #1
    tty.send('w');
    const weakRetryScreen = await tty.waitFor(
      (s) =>
        !s.includes('本轮练习总结') &&
        !s.includes('Round Summary') &&
        s.includes('1/1') &&
        s.includes(c1PromptSnippet) &&
        (s.includes('[D]工具') || s.includes('[D]Tools')),
      { timeoutMs: 10_000, label: 'Weak retry round opened in ReviewView with missed card' },
    );
    tty.assertHealthyScreen(weakRetryScreen, 120, 36, 'ReviewView after [w] weak retry');
  });

  test('2) CommandPalette full slash-command sweep (/theme nord, /lang, /inbox, /help, /course, /sidebar)', async () => {
    // Return to LibraryView before running the palette sweep
    useTuiStore.getState().navigate('library');
    const libScreen = await tty.waitFor(
      (s) =>
        s.includes('示例 · Memento 与 Bridge') &&
        (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 8_000, label: 'LibraryView ready for CommandPalette sweep' },
    );
    tty.assertHealthyScreen(libScreen, 120, 36, 'LibraryView before CommandPalette sweep');

    const openPaletteAndSelect = async (cmdText, matchPredicate, label) => {
      tty.send('\x0b'); // Ctrl+K
      await tty.waitFor(
        (s) => s.includes('命令面板') || s.includes('Command Palette'),
        { timeoutMs: 6_000, label: `CommandPalette opened for ${label}` },
      );
      await tty.flush();
      tty.send(cmdText);
      const filtered = await tty.waitFor(
        matchPredicate,
        { timeoutMs: 6_000, label: `CommandPalette filtered for ${label}` },
      );
      tty.assertHealthyScreen(filtered, 120, 36, `CommandPalette (${cmdText})`);
      tty.send('\r');
    };

    // 1. /theme nord -> verifies preferences.theme === 'nord'
    await openPaletteAndSelect(
      '/theme nord',
      (s) => s.includes('/theme nord') && s.includes('Nord'),
      '/theme nord',
    );
    await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        !s.includes('Command Palette') &&
        useTuiStore.getState().preferences.theme === 'nord',
      { timeoutMs: 6_000, label: 'Theme switched to nord' },
    );
    assert.equal(useTuiStore.getState().preferences.theme, 'nord', 'Theme must switch to nord');
    await tty.flush();
    tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'After /theme nord');

    // 2. /lang -> toggles zh -> en and back en -> zh cleanly
    assert.equal(useTuiStore.getState().preferences.language, 'zh', 'Initial language must be zh');
    await openPaletteAndSelect(
      '/lang',
      (s) => s.includes('/lang') && s.includes('Switch to English'),
      '/lang zh -> en',
    );
    const enScreen = await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        useTuiStore.getState().preferences.language === 'en' &&
        s.includes('Library') &&
        s.includes('Decks'),
      { timeoutMs: 6_000, label: 'Language toggled to en' },
    );
    assert.equal(useTuiStore.getState().preferences.language, 'en', 'Language must be en');
    tty.assertHealthyScreen(enScreen, 120, 36, 'After /lang -> en');

    await openPaletteAndSelect(
      '/lang',
      (s) => s.includes('/lang') && s.includes('切换到中文'),
      '/lang en -> zh',
    );
    const zhScreen = await tty.waitFor(
      (s) =>
        !s.includes('Command Palette') &&
        useTuiStore.getState().preferences.language === 'zh' &&
        s.includes('学习库') &&
        s.includes('题组列表'),
      { timeoutMs: 6_000, label: 'Language toggled back to zh' },
    );
    assert.equal(useTuiStore.getState().preferences.language, 'zh', 'Language must be back to zh');
    tty.assertHealthyScreen(zhScreen, 120, 36, 'After /lang -> zh');

    // 3. /inbox -> InboxModal opens -> Esc closes
    await openPaletteAndSelect(
      '/inbox',
      (s) => s.includes('/inbox') && (s.includes('收件箱与通知') || s.includes('Notification Inbox')),
      '/inbox',
    );
    const inboxScreen = await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        (s.includes('收件箱与通知') || s.includes('Notification Inbox')) &&
        (s.includes('全部') || s.includes('All')),
      { timeoutMs: 8_000, label: 'InboxModal opened via /inbox' },
    );
    tty.assertHealthyScreen(inboxScreen, 120, 36, 'InboxModal via /inbox');
    tty.send('\x1b');
    const afterInbox = await tty.waitFor(
      (s) => !s.includes('收件箱与通知') && !s.includes('Notification Inbox'),
      { timeoutMs: 6_000, label: 'InboxModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterInbox, 120, 36, 'After InboxModal closed');

    // 4. /help -> HelpOverlay opens -> Esc closes
    await openPaletteAndSelect(
      '/help',
      (s) => s.includes('/help') && (s.includes('快捷键帮助') || s.includes('Keyboard help')),
      '/help',
    );
    const helpScreen = await tty.waitFor(
      (s) =>
        !s.includes('搜索页面') &&
        (s.includes('? 快捷键') || s.includes('? Keyboard Shortcuts')) &&
        (s.includes('全局') || s.includes('Global')),
      { timeoutMs: 6_000, label: 'HelpOverlay opened via /help' },
    );
    tty.assertHealthyScreen(helpScreen, 120, 36, 'HelpOverlay via /help');
    tty.send('\x1b');
    const afterHelp = await tty.waitFor(
      (s) => !s.includes('? 快捷键') && !s.includes('? Keyboard Shortcuts'),
      { timeoutMs: 6_000, label: 'HelpOverlay closed via Esc' },
    );
    tty.assertHealthyScreen(afterHelp, 120, 36, 'After HelpOverlay closed');

    // 5. /course -> CoursePickerModal opens -> Esc closes
    await openPaletteAndSelect(
      '/course',
      (s) => s.includes('/course') && (s.includes('切换课程焦点') || s.includes('Switch course')),
      '/course',
    );
    const courseScreen = await tty.waitFor(
      (s) =>
        !s.includes('切换课程焦点') &&
        (s.includes('◎ 切换课程') || s.includes('◎ Switch Course')) &&
        (s.includes('全部课程') || s.includes('All courses')),
      { timeoutMs: 6_000, label: 'CoursePickerModal opened via /course' },
    );
    tty.assertHealthyScreen(courseScreen, 120, 36, 'CoursePickerModal via /course');
    tty.send('\x1b');
    const afterCourse = await tty.waitFor(
      (s) => !s.includes('◎ 切换课程') && !s.includes('◎ Switch Course'),
      { timeoutMs: 6_000, label: 'CoursePickerModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterCourse, 120, 36, 'After CoursePickerModal closed');

    // 6. /sidebar -> collapses & toggles back cleanly with zero overflows
    assert.equal(useTuiStore.getState().preferences.sidebarCollapsed, false, 'Sidebar starts expanded');
    await openPaletteAndSelect(
      '/sidebar',
      (s) => s.includes('/sidebar') && (s.includes('折叠/展开侧栏') || s.includes('Toggle sidebar')),
      '/sidebar collapse',
    );
    const collapsedScreen = await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        useTuiStore.getState().preferences.sidebarCollapsed === true &&
        !s.includes('每日 Daily'),
      { timeoutMs: 6_000, label: 'Sidebar collapsed via /sidebar' },
    );
    assert.equal(useTuiStore.getState().preferences.sidebarCollapsed, true, 'Sidebar must be collapsed');
    tty.assertHealthyScreen(collapsedScreen, 120, 36, 'Sidebar collapsed via /sidebar');

    await openPaletteAndSelect(
      '/sidebar',
      (s) => s.includes('/sidebar') && (s.includes('折叠/展开侧栏') || s.includes('Toggle sidebar')),
      '/sidebar expand',
    );
    const expandedScreen = await tty.waitFor(
      (s) =>
        !s.includes('命令面板') &&
        useTuiStore.getState().preferences.sidebarCollapsed === false &&
        s.includes('每日 Daily'),
      { timeoutMs: 6_000, label: 'Sidebar expanded back via /sidebar' },
    );
    assert.equal(useTuiStore.getState().preferences.sidebarCollapsed, false, 'Sidebar must be expanded again');
    tty.assertHealthyScreen(expandedScreen, 120, 36, 'Sidebar expanded via /sidebar');
  });
});
