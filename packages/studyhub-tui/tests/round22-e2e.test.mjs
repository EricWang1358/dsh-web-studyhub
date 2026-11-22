// Round 22 Features E2E verification: node --test tests/round22-e2e.test.mjs
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round22-${label}-`));
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

function createRound22StubComplete() {
  return async (_system, prompt, execution = {}) => {
    if (String(prompt || '').includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const reply = JSON.stringify({ status: 'ok' });
    execution.onOutput?.(reply);
    return reply;
  };
}

function parseQueueCount(screen) {
  const m = screen.match(/(\d+)\s*(?:题|cards)\s*[·|]\s*v(\d+)/);
  return m ? { count: Number(m[1]), version: Number(m[2]) } : null;
}

describe('StudyHub TUI Round 22 Features E2E', () => {
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
      injectedComplete: createRound22StubComplete(),
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

  test('1) SourcesView MinerUModal (2 -> M): Tab 1 Plan & Convert at 120x36 & 80x24, missing PDF inline error, Ctrl+T Tab 2 History, Esc close', async () => {
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

    // Press 'M' to open MinerUModal
    tty.send('M');
    const mineruWide = await tty.waitFor(
      (s) =>
        (s.includes('MinerU 扫描/长 PDF 转换') || s.includes('MinerU Scanned / Long PDF')) &&
        (s.includes('[1] 转换长/扫描 PDF') || s.includes('[1] Plan & Convert')) &&
        (s.includes('[2] 转换历史') || s.includes('[2] History')) &&
        (s.includes('PDF 路径') || s.includes('PDF Path')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'MinerUModal Tab 1 opened at 120x36' },
    );
    tty.assertHealthyScreen(mineruWide, 120, 36, 'MinerUModal Tab 1 at 120x36');

    // Verify Tab 1 renders cleanly at 80x24
    tty.resize(80, 24);
    const mineruNarrow = await tty.waitFor(
      (s) =>
        (s.includes('MinerU 扫描/长 PDF 转换') || s.includes('MinerU Scanned / Long PDF')) &&
        (s.includes('PDF 路径') || s.includes('PDF Path')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'MinerUModal Tab 1 at 80x24' },
    );
    tty.assertHealthyScreen(mineruNarrow, 80, 24, 'MinerUModal Tab 1 at 80x24');

    // Restore 120x36
    tty.resize(120, 36);
    await tty.waitFor(
      (s) =>
        (s.includes('MinerU 扫描/长 PDF 转换') || s.includes('MinerU Scanned / Long PDF')) &&
        (s.includes('学习资料库') || s.includes('Study Materials')),
      { timeoutMs: 8_000, label: 'MinerUModal restored to 120x36' },
    );

    // Submit a missing/non-existent PDF path and verify clean inline error without crashing
    const missingPdf = join(boxDir, 'missing-r22.pdf');
    tty.send(missingPdf);
    await tty.waitFor(
      (s) => s.includes('missing-r22.pdf'),
      { timeoutMs: 6_000, label: 'Missing PDF path typed into MinerUModal' },
    );
    tty.send('\r');

    const errorScreen = await tty.waitFor(
      (s) =>
        (s.includes('MinerU 扫描/长 PDF 转换') || s.includes('MinerU Scanned / Long PDF')) &&
        !s.includes('正在本地读取页数与分段计划') &&
        !s.includes('Reading PDF pages') &&
        (s.includes('✕ ') || s.includes('x ')),
      { timeoutMs: 8_000, label: 'MinerUModal inline error rendered for missing PDF' },
    );
    tty.assertHealthyScreen(errorScreen, 120, 36, 'MinerUModal missing PDF inline error at 120x36');

    // Switch to Tab 2 (History) via Ctrl+T ('\x14')
    tty.send('\x14');
    const historyWide = await tty.waitFor(
      (s) =>
        (s.includes('[r] 重试') || s.includes('[r] Retry')) &&
        !s.includes('正在加载 MinerU 转换历史') &&
        (s.includes('暂无 MinerU 转换记录') || s.includes('No MinerU conversions yet') || /记录 \d+|Records \d+/.test(s)),
      { timeoutMs: 8_000, label: 'MinerUModal Tab 2 History rendered at 120x36' },
    );
    tty.assertHealthyScreen(historyWide, 120, 36, 'MinerUModal Tab 2 History at 120x36');

    // Close MinerUModal cleanly via Esc
    tty.send('\x1b');
    const afterClose = await tty.waitFor(
      (s) =>
        !s.includes('MinerU 扫描/长 PDF 转换') &&
        !s.includes('MinerU Scanned / Long PDF') &&
        (s.includes('学习资料库') || s.includes('Study Materials')),
      { timeoutMs: 8_000, label: 'MinerUModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterClose, 120, 36, 'SourcesView after Esc closed MinerUModal');
  });

  test('2) ReviewView QueueModal ([Q] Live review.queue.edit): remove upcoming card [d], search & insert [a], 120x36 & 80x24, Esc close', async () => {
    // Navigate to LibraryView ('1') and start a multi-card review round on the first sample deck ('Enter')
    tty.send('1');
    await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'library' &&
        s.includes('示例 · Memento 与 Bridge') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'LibraryView active before starting review' },
    );
    await tty.flush();

    tty.send('\r');
    const reviewScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'review' &&
        !s.includes('正在加载页面') &&
        !s.includes('正在启动') &&
        (s.includes('[Q]队列') || s.includes('[Q]Queue') || s.includes('[D]工具') || s.includes('[D]Tools')),
      { timeoutMs: 10_000, label: 'ReviewView started for first sample deck' },
    );
    tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView initial at 120x36');

    // Press 'Q' to open QueueModal
    tty.send('Q');
    const queueOpen = await tty.waitFor(
      (s) =>
        (s.includes('本轮复习队列') || s.includes('Review Queue')) &&
        !s.includes('正在读取队列') &&
        !s.includes('Loading queue') &&
        s.includes('[▶]') &&
        s.includes('[ ]'),
      { timeoutMs: 8_000, label: 'QueueModal opened with [▶] and [ ] markers' },
    );
    tty.assertHealthyScreen(queueOpen, 120, 36, 'QueueModal opened at 120x36');

    const initialMeta = parseQueueCount(queueOpen);
    assert.ok(initialMeta && initialMeta.count >= 2, `Expected >=2 cards in queue, got: ${JSON.stringify(initialMeta)}`);
    const initialCount = initialMeta.count;

    // Identify the topic of the 2nd item (upcoming card at index 1) so searching it will match the removed card
    const row2Line = queueOpen.split('\n').find((l) => l.includes(' 2 [ ]')) || '';
    const searchTerm = row2Line.includes('Bridge') ? 'Bridge' : 'Memento';

    // Move down ('j') to upcoming card and press 'd' to remove via review.queue.edit
    tty.send('j');
    await tty.waitFor(
      (s) => s.includes('[d] 可移除') || s.includes('[d] Removable'),
      { timeoutMs: 6_000, label: 'QueueModal cursor moved to removable upcoming card' },
    );

    tty.send('d');
    const afterRemoveScreen = await tty.waitFor(
      (s) => {
        if (s.includes('正在更新本轮队列') || s.includes('Updating round queue')) return false;
        const meta = parseQueueCount(s);
        return Boolean(meta && meta.count === initialCount - 1);
      },
      { timeoutMs: 8_000, label: 'QueueModal count decreased by 1 after [d]' },
    );
    tty.assertHealthyScreen(afterRemoveScreen, 120, 36, 'QueueModal after [d] remove at 120x36');
    const afterRemoveMeta = parseQueueCount(afterRemoveScreen);
    assert.equal(afterRemoveMeta?.count, initialCount - 1, 'Queue count must decrease by 1 after removing upcoming card');

    // Press 'a' to open inline card search, search for Bridge/Memento, select a hit not in queue, and insert via review.queue.edit
    tty.send('a');
    await tty.waitFor(
      (s) =>
        (s.includes('向本轮队列加题') || s.includes('Add Card to Queue')) &&
        (s.includes('输入关键词搜索') || s.includes('Type keywords')),
      { timeoutMs: 6_000, label: 'QueueModal add-card inline search opened' },
    );

    tty.send(searchTerm);
    await tty.waitFor(
      (s) =>
        !s.includes('正在搜索题库') &&
        !s.includes('Searching cards') &&
        !s.includes('输入关键词搜索要加入本轮的题目') &&
        !s.includes('未找到匹配题目') &&
        s.includes(searchTerm),
      { timeoutMs: 8_000, label: `QueueModal search hits rendered for "${searchTerm}"` },
    );

    // Focus hit list with Down arrow
    tty.send('\x1b[B');
    let hitListScreen = await tty.waitFor(
      (s) => s.includes('[p/Tab] 切换位置') || s.includes('[p/Tab] Pos'),
      { timeoutMs: 6_000, label: 'QueueModal hit list focused via Down arrow' },
    );

    // Ensure the selected hit (marked with '▸ ') is not already in queue before pressing Enter
    for (let step = 0; step < 8; step += 1) {
      const selectedLine = hitListScreen.split('\n').find((l) => l.includes('▸ ')) || '';
      if (!selectedLine.includes('[已在队列]') && !selectedLine.includes('[in queue]')) break;
      tty.send('j');
      await tty.flush();
      hitListScreen = tty.readScreen();
    }

    tty.send('\r');
    const afterAddScreen = await tty.waitFor(
      (s) => {
        if (s.includes('向本轮队列加题') || s.includes('Add Card to Queue')) return false;
        if (s.includes('正在更新本轮队列') || s.includes('Updating round queue')) return false;
        const meta = parseQueueCount(s);
        return Boolean(meta && meta.count === initialCount);
      },
      { timeoutMs: 8_000, label: 'QueueModal count increased by 1 after adding card' },
    );
    tty.assertHealthyScreen(afterAddScreen, 120, 36, 'QueueModal after add at 120x36');
    const afterAddMeta = parseQueueCount(afterAddScreen);
    assert.equal(afterAddMeta?.count, initialCount, 'Queue count must increase by 1 after inserting search hit');

    // Verify healthy layout at 80x24
    tty.resize(80, 24);
    const queueNarrow = await tty.waitFor(
      (s) =>
        (s.includes('本轮复习队列') || s.includes('Review Queue')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'QueueModal at 80x24' },
    );
    tty.assertHealthyScreen(queueNarrow, 80, 24, 'QueueModal at 80x24');

    // Restore 120x36 and close cleanly via Esc
    tty.resize(120, 36);
    await tty.waitFor(
      (s) =>
        (s.includes('本轮复习队列') || s.includes('Review Queue')) &&
        s.includes('[▶]'),
      { timeoutMs: 8_000, label: 'QueueModal restored to 120x36' },
    );

    tty.send('\x1b');
    const backToReview = await tty.waitFor(
      (s) =>
        !s.includes('本轮复习队列') &&
        !s.includes('Review Queue') &&
        (s.includes('[D]工具') || s.includes('[D]Tools')),
      { timeoutMs: 8_000, label: 'QueueModal closed via Esc' },
    );
    tty.assertHealthyScreen(backToReview, 120, 36, 'ReviewView after Esc closed QueueModal');

    // Unmount primary Ink instance before dedicated --ascii check in Test 3
    inkInstance.unmount();
    inkInstance = null;
    tty.dispose();
    tty = null;
  });

  test('3) MinerUModal & QueueModal --ascii Zero-Unicode-Leak Check', async () => {
    const asciiDir = await makeTempDir('ascii');
    const asciiDshHome = join(asciiDir, 'dsh-home');
    const asciiLibRoot = join(asciiDir, 'library');

    await H.saveTuiPreferences({ language: 'zh', asciiMode: true }, { env: { DSH_HOME: asciiDshHome } });

    const asciiHost = await H.createTuiHost({
      env: { DSH_HOME: asciiDshHome },
      home: join(asciiDir, 'home'),
      libraryRoot: asciiLibRoot,
      injectedComplete: createRound22StubComplete(),
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
          initialPage: 'sources',
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

      // 3a) SourcesView -> MinerUModal (M) Tab 1 & Tab 2 in --ascii mode
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

      asciiTty.send('M');
      const mineruTab1Ascii = await asciiTty.waitFor(
        (s) =>
          (s.includes('MinerU 扫描/长 PDF 转换') || s.includes('MinerU Scanned / Long PDF')) &&
          (s.includes('[1] 转换长/扫描 PDF') || s.includes('[1] Plan & Convert')) &&
          (s.includes('PDF 路径') || s.includes('PDF Path')),
        { timeoutMs: 10_000, label: 'ASCII MinerUModal Tab 1 rendered' },
      );
      asciiTty.assertHealthyScreen(mineruTab1Ascii, 120, 36, 'ASCII MinerUModal Tab 1');
      asciiTty.assertAsciiPure(mineruTab1Ascii, 'ASCII MinerUModal Tab 1');

      asciiTty.send('\x14'); // Ctrl+T -> History Tab 2
      const mineruTab2Ascii = await asciiTty.waitFor(
        (s) =>
          (s.includes('[r] 重试') || s.includes('[r] Retry')) &&
          !s.includes('正在加载 MinerU 转换历史') &&
          (s.includes('暂无 MinerU 转换记录') || s.includes('No MinerU conversions yet') || /记录 \d+|Records \d+/.test(s)),
        { timeoutMs: 8_000, label: 'ASCII MinerUModal Tab 2 History rendered' },
      );
      asciiTty.assertHealthyScreen(mineruTab2Ascii, 120, 36, 'ASCII MinerUModal Tab 2 History');
      asciiTty.assertAsciiPure(mineruTab2Ascii, 'ASCII MinerUModal Tab 2 History');

      // Close MinerUModal via Esc
      asciiTty.send('\x1b');
      await asciiTty.waitFor(
        (s) => !s.includes('MinerU 扫描/长 PDF 转换') && !s.includes('MinerU Scanned / Long PDF'),
        { timeoutMs: 6_000, label: 'ASCII MinerUModal closed' },
      );

      // 3b) Navigate to Library ('1') -> Enter first deck -> ReviewView -> QueueModal ('Q') in --ascii mode
      asciiTty.send('1');
      await asciiTty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'library' &&
          s.includes('示例 · Memento 与 Bridge') &&
          !s.includes('正在加载页面'),
        { timeoutMs: 8_000, label: 'ASCII LibraryView rendered' },
      );
      await asciiTty.flush();

      asciiTty.send('\r');
      const reviewAscii = await asciiTty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'review' &&
          !s.includes('正在加载页面') &&
          !s.includes('正在启动') &&
          (s.includes('[Q]队列') || s.includes('[Q]Queue') || s.includes('[D]工具') || s.includes('[D]Tools')),
        { timeoutMs: 10_000, label: 'ASCII ReviewView rendered' },
      );
      asciiTty.assertHealthyScreen(reviewAscii, 120, 36, 'ASCII ReviewView');
      asciiTty.assertAsciiPure(reviewAscii, 'ASCII ReviewView');

      asciiTty.send('Q');
      const queueAscii = await asciiTty.waitFor(
        (s) =>
          (s.includes('本轮复习队列') || s.includes('Review Queue')) &&
          !s.includes('正在读取队列') &&
          !s.includes('Loading queue') &&
          s.includes('[>]') &&
          s.includes('[ ]'),
        { timeoutMs: 8_000, label: 'ASCII QueueModal rendered' },
      );
      asciiTty.assertHealthyScreen(queueAscii, 120, 36, 'ASCII QueueModal');
      asciiTty.assertAsciiPure(queueAscii, 'ASCII QueueModal');

      asciiTty.send('\x1b');
      await asciiTty.waitFor(
        (s) => !s.includes('本轮复习队列') && !s.includes('Review Queue'),
        { timeoutMs: 6_000, label: 'ASCII QueueModal closed' },
      );
    } finally {
      await cleanupAscii();
    }
  });
});
