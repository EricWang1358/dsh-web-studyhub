// Round 19 Features E2E verification: node --test tests/round19-e2e.test.mjs
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round19-${label}-`));
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

function createRound19StubComplete() {
  return async (_system, prompt, execution = {}) => {
    if (String(prompt || '').includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const reply = JSON.stringify({ status: 'ok' });
    execution.onOutput?.(reply);
    return reply;
  };
}

describe('StudyHub TUI Round 19 Features E2E', () => {
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
    while (extraCleanups.length > 0) {
      const fn = extraCleanups.pop();
      try {
        await fn();
      } catch {
        // Ignore teardown errors from secondary test handles
      }
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
      injectedComplete: createRound19StubComplete(),
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

  test('1) BookView BookExportModal (7 -> x): estimate or empty state, [q]/[k] toggles if enabled, 120x36 & 80x24, Esc closes', async () => {
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
    await sleep(100);
    await tty.flush();

    // Navigate to BookView via '7' and wait for BookView-unique footer
    tty.send('7');
    const bookInit = await tty.waitFor(
      (s) =>
        (s.includes('精选问答') || s.includes('Pinned QA')) &&
        !s.includes('正在打开复习全书') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'BookView rendered' },
    );
    tty.assertHealthyScreen(bookInit, 120, 36, 'BookView initial at 120x36');

    // Open BookExportModal via 'x'
    tty.send('x');
    const exportScreen = await tty.waitFor(
      (s) =>
        (s.includes('导出可打印复习全书') || s.includes('Export Printable Review Book')) &&
        !s.includes('正在读取复习全书并估算页数') &&
        !s.includes('Loading book and estimating pages') &&
        (s.includes('A4 预估') ||
          s.includes('Est. A4:') ||
          s.includes('该课程还没有复习全书') ||
          s.includes('No review book for this course yet') ||
          s.includes('请先选择一门课程') ||
          s.includes('Select a course first')),
      { timeoutMs: 10_000, label: 'BookExportModal loaded at 120x36' },
    );
    tty.assertHealthyScreen(exportScreen, 120, 36, 'BookExportModal initial at 120x36');

    const exportEnabled = exportScreen.includes('A4 预估') || exportScreen.includes('Est. A4:');
    if (exportEnabled) {
      // Cycle [q] questions mode: linked -> all -> none
      tty.send('q');
      const qAllScreen = await tty.waitFor(
        (s) =>
          (s.includes('导出可打印复习全书') || s.includes('Export Printable Review Book')) &&
          !s.includes('正在更新 A4 页数估算') &&
          !s.includes('Updating A4 estimate') &&
          (s.includes('全部 all') || s.includes('All')),
        { timeoutMs: 8_000, label: 'BookExportModal [q] cycled to all' },
      );
      tty.assertHealthyScreen(qAllScreen, 120, 36, 'BookExportModal [q] -> all');

      tty.send('q');
      const qNoneScreen = await tty.waitFor(
        (s) =>
          (s.includes('导出可打印复习全书') || s.includes('Export Printable Review Book')) &&
          !s.includes('正在更新 A4 页数估算') &&
          !s.includes('Updating A4 estimate') &&
          (s.includes('不含 none') || s.includes('None')),
        { timeoutMs: 8_000, label: 'BookExportModal [q] cycled to none' },
      );
      tty.assertHealthyScreen(qNoneScreen, 120, 36, 'BookExportModal [q] -> none');

      // Toggle [k] answerKey: OFF -> ON
      tty.send('k');
      const kOnScreen = await tty.waitFor(
        (s) =>
          (s.includes('导出可打印复习全书') || s.includes('Export Printable Review Book')) &&
          !s.includes('正在更新 A4 页数估算') &&
          !s.includes('Updating A4 estimate') &&
          s.includes('ON') &&
          (s.includes('文末附带答案与解析') || s.includes('append answers & explanations')),
        { timeoutMs: 8_000, label: 'BookExportModal [k] toggled ON' },
      );
      tty.assertHealthyScreen(kOnScreen, 120, 36, 'BookExportModal [k] -> ON');
    }

    // Verify healthy layout at 80x24
    tty.resize(80, 24);
    const exportNarrow = await tty.waitFor(
      (s) =>
        (s.includes('导出可打印复习全书') || s.includes('Export Printable Review Book')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'BookExportModal rendered at 80x24' },
    );
    tty.assertHealthyScreen(exportNarrow, 80, 24, 'BookExportModal at 80x24');

    // Restore 120x36 and close cleanly via Esc
    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('导出可打印复习全书') || s.includes('Export Printable Review Book'),
      { timeoutMs: 8_000, label: 'BookExportModal restored to 120x36' },
    );

    tty.send('\x1b');
    const backToBook = await tty.waitFor(
      (s) =>
        !s.includes('导出可打印复习全书') &&
        !s.includes('Export Printable Review Book') &&
        (s.includes('精选问答') || s.includes('Pinned QA')),
      { timeoutMs: 8_000, label: 'BookExportModal closed via Esc' },
    );
    tty.assertHealthyScreen(backToBook, 120, 36, 'BookView after BookExportModal closed');
  });

  test('2) CardToolsModal Undo Revert ([7] card.revert) & Prerequisite Links ([8] card.link)', async () => {
    // Navigate to LibraryView via '1'
    tty.send('1');
    await tty.waitFor(
      (s) =>
        s.includes('示例 · Memento 与 Bridge') &&
        (s.includes('题组列表') || s.includes('Decks')) &&
        !s.includes('正在打开学习库') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'LibraryView rendered' },
    );
    await tty.flush();

    // Open ReviewView on the first sample deck via Enter
    tty.send('\r');
    const reviewInit = await tty.waitFor(
      (s) =>
        (s.includes('[D]工具') || s.includes('[D]Tools')) &&
        !s.includes('正在准备复习队列') &&
        !s.includes('正在加载页面') &&
        /\b1\/\d+/.test(s),
      { timeoutMs: 10_000, label: 'ReviewView rendered on first sample deck' },
    );
    tty.assertHealthyScreen(reviewInit, 120, 36, 'ReviewView initial');

    // Capture authoritative current card prompt before editing
    const beforeCardRes = await host.call('card.current', {});
    assert.equal(beforeCardRes.ok, true, 'card.current must succeed');
    const currentCardId = beforeCardRes.value?.card?.id;
    const originalPrompt = String(beforeCardRes.value?.card?.prompt || '').trim();
    assert.ok(currentCardId && originalPrompt.length > 0, 'Active card must have id and prompt');
    const originalPromptSnippet = originalPrompt.slice(0, Math.min(18, originalPrompt.length));
    assert.ok(
      reviewInit.includes(originalPromptSnippet),
      `ReviewView should render original prompt snippet "${originalPromptSnippet}"`,
    );

    // Part A: Edit -> Save (Ctrl+S) -> Reopen D -> Assert [7] 1 rev -> Revert ([7])
    tty.send('D');
    const toolsMenu1 = await tty.waitFor(
      (s) =>
        (s.includes('题目工具箱') || s.includes('Card Tools')) &&
        (s.includes('撤销上次修改') || s.includes('Undo Last Edit')) &&
        (s.includes('无历史') || s.includes('None')),
      { timeoutMs: 8_000, label: 'CardToolsModal opened before edit' },
    );
    tty.assertHealthyScreen(toolsMenu1, 120, 36, 'CardToolsModal menu before edit');
    await sleep(60);
    await tty.flush();

    // Press '1' to edit the card
    tty.send('1');
    await tty.waitFor(
      (s) => s.includes('1. 题干 (prompt)') || s.includes('1. Stem (prompt)'),
      { timeoutMs: 8_000, label: 'CardToolsModal edit form opened' },
    );
    await tty.flush();

    const editTag = ' [R19EDIT]';
    tty.send(editTag);
    await tty.waitFor(
      (s) => s.includes('[R19EDIT]'),
      { timeoutMs: 5_000, label: 'Edit tag typed in prompt input' },
    );

    // Save via Ctrl+S
    tty.send('\x13');
    const reviewAfterEdit = await tty.waitFor(
      (s) =>
        !s.includes('题目工具箱') &&
        !s.includes('Card Tools') &&
        s.includes('[R19EDIT]'),
      { timeoutMs: 10_000, label: 'ReviewView updated after card edit' },
    );
    tty.assertHealthyScreen(reviewAfterEdit, 120, 36, 'ReviewView after card edit');

    // Reopen 'D' and assert [7] shows revision badge ('1 版' or '1 rev')
    tty.send('D');
    const toolsAfterEdit = await tty.waitFor(
      (s) =>
        (s.includes('题目工具箱') || s.includes('Card Tools')) &&
        (s.includes('1 版') || s.includes('1 rev')),
      { timeoutMs: 8_000, label: 'CardToolsModal shows 1 rev badge on [7]' },
    );
    tty.assertHealthyScreen(toolsAfterEdit, 120, 36, 'CardToolsModal after edit with 1 rev');

    // Press '7' to revert (card.revert)
    tty.send('7');
    const reviewAfterRevert = await tty.waitFor(
      (s) =>
        !s.includes('题目工具箱') &&
        !s.includes('Card Tools') &&
        (s.includes('已撤销上次修改') || s.includes('Reverted last edit')),
      { timeoutMs: 10_000, label: 'CardToolsModal closed with revert confirmation toast' },
    );
    tty.assertHealthyScreen(reviewAfterRevert, 120, 36, 'ReviewView after card.revert');

    const revertedCardRes = await host.call('card.get', { cardId: currentCardId });
    assert.equal(revertedCardRes.ok, true, 'card.get after revert must succeed');
    assert.equal(
      String(revertedCardRes.value?.card?.prompt || '').trim(),
      originalPrompt,
      'card.revert must restore exact original prompt',
    );
    assert.equal(
      revertedCardRes.value?.revisions?.length ?? 0,
      0,
      'card.revert must consume the revision entry',
    );

    // Part B: Reopen 'D' -> verify [7] is back to None/无历史 and edit form shows original prompt -> '8' (Prerequisite Links)
    tty.send('D');
    const toolsAfterRevert = await tty.waitFor(
      (s) =>
        (s.includes('题目工具箱') || s.includes('Card Tools')) &&
        (s.includes('无历史') || s.includes('None')) &&
        (s.includes('前置题目关联') || s.includes('Prerequisite Links')),
      { timeoutMs: 8_000, label: 'CardToolsModal reopened after revert showing 0 revisions' },
    );
    tty.assertHealthyScreen(toolsAfterRevert, 120, 36, 'CardToolsModal after revert');
    await sleep(60);
    await tty.flush();

    // Verify in edit form that UI promptDraft hydrated back to the original prompt without [R19EDIT]
    tty.send('1');
    const editAfterRevert = await tty.waitFor(
      (s) => {
        const lines = s.split('\n');
        const startIdx = lines.findIndex((l) => l.includes('1. 题干 (prompt)') || l.includes('1. Stem (prompt)'));
        const endIdx = lines.findIndex(
          (l) =>
            l.includes('2. 参考答案 (answer)') ||
            l.includes('2. Reference Answer') ||
            l.includes('2. 解析 (explanation)') ||
            l.includes('2. Explanation'),
        );
        const stemSlice = startIdx >= 0 && endIdx > startIdx ? lines.slice(startIdx, endIdx).join('\n') : '';
        return stemSlice.includes(originalPromptSnippet) && !stemSlice.includes('[R19EDIT]');
      },
      { timeoutMs: 8_000, label: 'CardToolsModal edit form shows reverted original prompt' },
    );
    tty.assertHealthyScreen(editAfterRevert, 120, 36, 'CardToolsModal edit form after revert');

    // Return to CardToolsModal menu via Esc, then open Prerequisite Links ('8')
    tty.send('\x1b');
    await tty.waitFor(
      (s) => s.includes('前置题目关联') || s.includes('Prerequisite Links'),
      { timeoutMs: 8_000, label: 'Returned to CardToolsModal menu from edit form' },
    );

    tty.send('8');
    const prereqsEmpty = await tty.waitFor(
      (s) =>
        (s.includes('前置题目关联') || s.includes('Prerequisite Links')) &&
        !s.includes('正在加载前置题目') &&
        !s.includes('Loading prerequisites') &&
        (s.includes('当前题目暂无前置依赖') || s.includes('No prerequisites linked yet') || /已关联 \d+ 题|\d+ linked/.test(s)),
      { timeoutMs: 8_000, label: 'CardToolsModal Prerequisite Links view opened' },
    );
    tty.assertHealthyScreen(prereqsEmpty, 120, 36, 'CardToolsModal Prerequisite Links initial');

    // Press 'a' to enter search mode and search "Bridge"
    tty.send('a');
    await tty.waitFor(
      (s) => s.includes('输入关键词搜索前置题') || s.includes('Search cards to link'),
      { timeoutMs: 5_000, label: 'Prerequisite search input activated' },
    );

    tty.send('Bridge');
    const searchHitsScreen = await tty.waitFor(
      (s) =>
        (/搜索结果 [1-9]\d* 题/.test(s) || /[1-9]\d* hits/.test(s)) &&
        !s.includes('正在搜索题库') &&
        !s.includes('Searching cards'),
      { timeoutMs: 8_000, label: 'Prerequisite search hits rendered for "Bridge"' },
    );
    tty.assertHealthyScreen(searchHitsScreen, 120, 36, 'CardToolsModal Prerequisite search hits');

    // Focus results list via Enter, then press Enter again to link the highlighted hit
    tty.send('\r');
    await tty.waitFor(
      (s) => s.includes('▸ ') || s.includes('> '),
      { timeoutMs: 5_000, label: 'Prerequisite search hit focused' },
    );

    tty.send('\r');
    const linkedScreen = await tty.waitFor(
      (s) =>
        !s.includes('输入关键词搜索前置题') &&
        !s.includes('Search cards to link') &&
        (s.includes('已关联 1 题') || s.includes('1 linked')) &&
        s.includes('1. '),
      { timeoutMs: 8_000, label: 'Linked prerequisite rendered in list' },
    );
    tty.assertHealthyScreen(linkedScreen, 120, 36, 'CardToolsModal Prerequisite linked');

    // Unlink via 'd'
    tty.send('d');
    const unlinkedScreen = await tty.waitFor(
      (s) =>
        (s.includes('已关联 0 题') || s.includes('0 linked')) &&
        (s.includes('当前题目暂无前置依赖') || s.includes('No prerequisites linked yet')),
      { timeoutMs: 8_000, label: 'Prerequisite unlinked cleanly' },
    );
    tty.assertHealthyScreen(unlinkedScreen, 120, 36, 'CardToolsModal Prerequisite after unlink');

    // Esc returns to menu, second Esc closes CardToolsModal cleanly
    tty.send('\x1b');
    await tty.waitFor(
      (s) => s.includes('编辑题目') || s.includes('Edit Question'),
      { timeoutMs: 8_000, label: 'Esc returned from Prerequisite Links to menu' },
    );

    tty.send('\x1b');
    const backToReview = await tty.waitFor(
      (s) =>
        !s.includes('题目工具箱') &&
        !s.includes('Card Tools') &&
        (s.includes('[D]工具') || s.includes('[D]Tools')),
      { timeoutMs: 8_000, label: 'CardToolsModal closed cleanly via Esc' },
    );
    tty.assertHealthyScreen(backToReview, 120, 36, 'ReviewView after CardToolsModal closed');

    // Unmount primary Ink instance before running dedicated --ascii render in Test 3
    inkInstance.unmount();
    inkInstance = null;
    tty.dispose();
    tty = null;
  });

  test('3) BookExportModal & CardToolsModal Prereqs --ascii Zero-Unicode-Leak Check', async () => {
    const asciiDir = await makeTempDir('ascii');
    const asciiDshHome = join(asciiDir, 'dsh-home');
    const asciiLibRoot = join(asciiDir, 'library');

    await H.saveTuiPreferences({ language: 'zh', asciiMode: true }, { env: { DSH_HOME: asciiDshHome } });

    const asciiHost = await H.createTuiHost({
      env: { DSH_HOME: asciiDshHome },
      home: join(asciiDir, 'home'),
      libraryRoot: asciiLibRoot,
      injectedComplete: createRound19StubComplete(),
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
    });

    const sampleRes = await asciiHost.call('sample.load', { language: 'zh' });
    assert.equal(sampleRes.ok, true, 'sample.load must succeed for ASCII test');

    const asciiTty = createVirtualTty(120, 36);
    let asciiInk = null;

    const cleanupAscii = async () => {
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

      // 3a) BookView -> BookExportModal ('x') in --ascii mode
      const bookAscii = await asciiTty.waitFor(
        (s) =>
          (s.includes('精选问答') || s.includes('Pinned QA')) &&
          !s.includes('正在打开复习全书') &&
          !s.includes('正在加载页面'),
        { timeoutMs: 10_000, label: 'ASCII BookView rendered' },
      );
      asciiTty.assertHealthyScreen(bookAscii, 120, 36, 'ASCII BookView');
      asciiTty.assertAsciiPure(bookAscii, 'ASCII BookView');

      asciiTty.send('x');
      const exportAscii = await asciiTty.waitFor(
        (s) =>
          (s.includes('导出可打印复习全书') || s.includes('Export Printable Review Book')) &&
          !s.includes('正在读取复习全书并估算页数') &&
          !s.includes('Loading book and estimating pages') &&
          (s.includes('A4 预估') ||
            s.includes('Est. A4:') ||
            s.includes('该课程还没有复习全书') ||
            s.includes('No review book for this course yet') ||
            s.includes('请先选择一门课程') ||
            s.includes('Select a course first')),
        { timeoutMs: 10_000, label: 'ASCII BookExportModal rendered' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(exportAscii, 120, 36, 'ASCII BookExportModal');
      asciiTty.assertAsciiPure(exportAscii, 'ASCII BookExportModal');

      asciiTty.send('\x1b');
      await asciiTty.waitFor(
        (s) => !s.includes('导出可打印复习全书') && !s.includes('Export Printable Review Book'),
        { timeoutMs: 8_000, label: 'ASCII BookExportModal closed' },
      );

      // 3b) Library ('1') -> Enter -> ReviewView -> CardToolsModal ('D') -> Prereqs ('8') in --ascii mode
      asciiTty.send('1');
      await asciiTty.waitFor(
        (s) =>
          s.includes('示例 · Memento 与 Bridge') &&
          !s.includes('正在打开学习库') &&
          !s.includes('正在加载页面'),
        { timeoutMs: 10_000, label: 'ASCII LibraryView rendered' },
      );
      await asciiTty.flush();

      asciiTty.send('\r');
      const reviewAscii = await asciiTty.waitFor(
        (s) =>
          (s.includes('[D]工具') || s.includes('[D]Tools')) &&
          !s.includes('正在准备复习队列') &&
          !s.includes('正在加载页面'),
        { timeoutMs: 10_000, label: 'ASCII ReviewView rendered' },
      );
      asciiTty.assertHealthyScreen(reviewAscii, 120, 36, 'ASCII ReviewView');
      asciiTty.assertAsciiPure(reviewAscii, 'ASCII ReviewView');

      asciiTty.send('D');
      await asciiTty.waitFor(
        (s) =>
          (s.includes('题目工具箱') || s.includes('Card Tools')) &&
          (s.includes('前置题目关联') || s.includes('Prerequisite Links')),
        { timeoutMs: 8_000, label: 'ASCII CardToolsModal opened' },
      );

      asciiTty.send('8');
      const prereqsAscii = await asciiTty.waitFor(
        (s) =>
          (s.includes('前置题目关联') || s.includes('Prerequisite Links')) &&
          !s.includes('正在加载前置题目') &&
          !s.includes('Loading prerequisites'),
        { timeoutMs: 8_000, label: 'ASCII CardToolsModal Prereqs list rendered' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(prereqsAscii, 120, 36, 'ASCII CardToolsModal Prereqs');
      asciiTty.assertAsciiPure(prereqsAscii, 'ASCII CardToolsModal Prereqs');

      // Also check prereq search UI in --ascii mode
      asciiTty.send('a');
      await asciiTty.waitFor(
        (s) => s.includes('输入关键词搜索前置题') || s.includes('Search cards to link'),
        { timeoutMs: 5_000, label: 'ASCII CardToolsModal Prereqs search opened' },
      );
      asciiTty.send('Bridge');
      const prereqSearchAscii = await asciiTty.waitFor(
        (s) =>
          (/搜索结果 [1-9]\d* 题/.test(s) || /[1-9]\d* hits/.test(s)) &&
          !s.includes('正在搜索题库') &&
          !s.includes('Searching cards'),
        { timeoutMs: 8_000, label: 'ASCII CardToolsModal Prereqs search results rendered' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(prereqSearchAscii, 120, 36, 'ASCII CardToolsModal Prereqs search');
      asciiTty.assertAsciiPure(prereqSearchAscii, 'ASCII CardToolsModal Prereqs search');
    } finally {
      await cleanupAscii();
      extraCleanups.pop();
    }
  });
});
