// Round 12 Features E2E verification: node --test tests/round12-e2e.test.mjs
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
  if (f === 'host.mjs' || f.startsWith('host-') || f.startsWith('tui-') || f.startsWith('chunk-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function' && typeof mod.saveTuiPreferences === 'function') H = mod;
    if (!R && typeof mod.displayWidth === 'function') R = mod;
  }
}
assert.ok(H?.createTuiHost, 'dist/ must export createTuiHost');
assert.ok(R?.displayWidth, 'dist/ must export displayWidth');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round12-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
    resize,
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

/**
 * Deterministic model stub handling JSON contracts for source.organize.suggest,
 * plus fallback responses for probes and generation/repair prompts.
 */
function createRound12StubComplete() {
  return async (system, prompt, execution = {}) => {
    const s = String(system || '');
    const p = String(prompt || '');

    if (p.includes('OK?')) return 'OK';

    if (s.includes('Organize study sources into courses')) {
      const req = JSON.parse(p);
      const sources = Array.isArray(req.sources) ? req.sources : [];
      const fallbackCourse =
        Array.isArray(req.courses) && req.courses.length > 0 ? req.courses[0] : '示例课程 · 设计模式';
      return JSON.stringify({
        proposals: sources.map((src) => ({
          id: src.id,
          courses: Array.isArray(src.courses) && src.courses.length > 0 ? src.courses : [fallbackCourse],
          reason: '讲义内容涉及 Memento 与 Bridge 设计模式',
        })),
      });
    }

    const reply = JSON.stringify({ status: 'ok' });
    execution.onOutput?.(reply);
    return reply;
  };
}

describe('StudyHub TUI Round 12 Features E2E', () => {
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
      injectedComplete: createRound12StubComplete(),
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

  test('1) Sources AI Organize ([G]) & Citation/Section Coverage ([V] at 120x36 and 80x24)', async () => {
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
    await sleep(120);
    await tty.flush();

    // Navigate to SourcesView ('2')
    tty.send('2');
    const sourcesScreen = await tty.waitFor(
      (s) =>
        (s.includes('示例 · 设计模式讲义') || s.includes('Sample · Design Patterns')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'SourcesView rendered with sample material' },
    );
    tty.assertHealthyScreen(sourcesScreen, 120, 'SourcesView initial');

    // Open SourceCoverageModal ('V') at 120x36
    tty.send('V');
    const covWide = await tty.waitFor(
      (s) =>
        (s.includes('资料引用与章节覆盖率') || s.includes('Source Coverage')) &&
        !s.includes('正在统计章节与引用覆盖率') &&
        (s.includes('章节') || s.includes('Sections') || s.includes('直接引用来源') || s.includes('Direct cited')),
      { timeoutMs: 8_000, label: 'SourceCoverageModal rendered at 120x36' },
    );
    tty.assertHealthyScreen(covWide, 120, 'SourceCoverageModal 120x36');

    // Resize to 80x24 and verify clean rendering
    tty.resize(80, 24);
    const covNarrow = await tty.waitFor(
      (s) =>
        (s.includes('资料引用与章节覆盖率') || s.includes('Source Coverage')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'SourceCoverageModal resized to 80x24' },
    );
    tty.assertHealthyScreen(covNarrow, 80, 'SourceCoverageModal 80x24');

    // Restore 120x36 and close SourceCoverageModal with Esc
    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('资料引用与章节覆盖率') || s.includes('Source Coverage'),
      { timeoutMs: 8_000, label: 'SourceCoverageModal restored to 120x36' },
    );
    tty.send('\x1b');
    const afterCovClose = await tty.waitFor(
      (s) => !s.includes('资料引用与章节覆盖率') && !s.includes('Source Coverage'),
      { timeoutMs: 8_000, label: 'SourceCoverageModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterCovClose, 120, 'SourcesView after SourceCoverageModal');

    // Open OrganizeSourcesModal ('G')
    tty.send('G');
    const organizeScreen = await tty.waitFor(
      (s) =>
        (s.includes('AI 智能整理课程归属') || s.includes('AI Organize Courses')) &&
        !s.includes('正在分析') &&
        (s.includes('建议 ') ||
          s.includes('Proposals ') ||
          s.includes('暂无课程整理建议') ||
          s.includes('No organization suggestions')),
      { timeoutMs: 8_000, label: 'OrganizeSourcesModal rendered proposals' },
    );
    tty.assertHealthyScreen(organizeScreen, 120, 'OrganizeSourcesModal');

    // Close OrganizeSourcesModal with Esc
    tty.send('\x1b');
    const afterOrgClose = await tty.waitFor(
      (s) => !s.includes('AI 智能整理课程归属') && !s.includes('AI Organize Courses'),
      { timeoutMs: 8_000, label: 'OrganizeSourcesModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterOrgClose, 120, 'SourcesView after OrganizeSourcesModal');
  });

  test('2) DraftEditor Similar Check ([S]) & Repair ([R])', async () => {
    // Navigate to LibraryView ('1') -> Tab to Drafts & Jobs -> Enter to open sample draft
    tty.send('1');
    const libScreen = await tty.waitFor(
      (s) =>
        (s.includes('示例草稿 · 选对设计模式') || s.includes('Sample Draft')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'LibraryView with sample draft' },
    );
    tty.assertHealthyScreen(libScreen, 120, 'LibraryView before opening draft');

    tty.send('\t');
    await tty.flush();
    tty.send('\r');

    const editorScreen = await tty.waitFor(
      (s) =>
        (s.includes('示例草稿 · 选对设计模式') || s.includes('Sample Draft')) &&
        (s.includes('[S] 查重') || s.includes('[S] Similar')) &&
        !s.includes('加载草稿'),
      { timeoutMs: 8_000, label: 'DraftEditor opened for sample draft' },
    );
    tty.assertHealthyScreen(editorScreen, 120, 'DraftEditor initial');

    // Press 'S' -> Near-Duplicate Check modal opens cleanly
    tty.send('S');
    const similarModal = await tty.waitFor(
      (s) =>
        (s.includes('相似 / 重复题检测') || s.includes('Near-Duplicate Check')) &&
        (s.includes('无明显重复题') || s.includes('No near-duplicates') || s.includes('处高相似') || s.includes('flagged')),
      { timeoutMs: 8_000, label: 'DraftEditor Similar modal rendered' },
    );
    tty.assertHealthyScreen(similarModal, 120, 'DraftEditor Similar modal');

    // Esc closes Similar modal
    tty.send('\x1b');
    const afterSimilar = await tty.waitFor(
      (s) => !s.includes('相似 / 重复题检测') && !s.includes('Near-Duplicate Check'),
      { timeoutMs: 8_000, label: 'DraftEditor Similar modal closed via Esc' },
    );
    tty.assertHealthyScreen(afterSimilar, 120, 'DraftEditor after Similar modal');

    // Press 'R' -> draft.repair executes cleanly (shows toast/status without crashing)
    tty.send('R');
    const afterRepair = await tty.waitFor(
      (s) =>
        !s.includes('修题中') &&
        (s.includes('没有待处理的题目') ||
          s.includes('已启动修题任务') ||
          s.includes('草稿已修复并刷新') ||
          s.includes('Draft repair')),
      { timeoutMs: 8_000, label: 'DraftEditor repair executed cleanly' },
    );
    tty.assertHealthyScreen(afterRepair, 120, 'DraftEditor after Repair');

    // Esc (no-op in top-level editor) then Backspace leaves editor back to LibraryView
    tty.send('\x1b');
    await tty.flush();
    tty.send('\x7f');
    const backToLib = await tty.waitFor(
      (s) =>
        (s.includes('示例 · Memento 与 Bridge') || s.includes('Sample · Memento')) &&
        !s.includes('审校草稿题干'),
      { timeoutMs: 8_000, label: 'Returned to LibraryView from DraftEditor' },
    );
    tty.assertHealthyScreen(backToLib, 120, 'LibraryView after DraftEditor');
  });

  test('3) DeckManageModal Card Kind Convert ([k]) & Direct Supplement ([+])', async () => {
    // Ensure we are on LibraryView with first ordinary deck selected
    tty.send('1');
    await tty.waitFor(
      (s) =>
        (s.includes('示例 · Memento 与 Bridge') || s.includes('Sample · Memento')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'LibraryView ready for DeckManageModal' },
    );
    await tty.flush();

    // Open DeckManageModal ('m')
    tty.send('m');
    const manageScreen = await tty.waitFor(
      (s) =>
        (s.includes('题组管理') || s.includes('Manage Deck')) &&
        !s.includes('正在读取题组卡片') &&
        s.includes('Memento'),
      { timeoutMs: 8_000, label: 'DeckManageModal opened' },
    );
    tty.assertHealthyScreen(manageScreen, 120, 'DeckManageModal browse');

    // Press 'k' to enter Convert Card Kind sub-mode
    tty.send('k');
    const convertScreen = await tty.waitFor(
      (s) =>
        (s.includes('转换题型') || s.includes('Convert Card Kind')) &&
        (s.includes('原题型:') || s.includes('From:')),
      { timeoutMs: 8_000, label: 'DeckManageModal convert sub-mode opened' },
    );
    tty.assertHealthyScreen(convertScreen, 120, 'DeckManageModal convert initial');

    // Cycle target kind via Tab to 'open' (简答), then submit with Enter
    tty.send('\t');
    const openTargetScreen = await tty.waitFor(
      (s) => s.includes('-> 简答') || s.includes('-> Open') || s.includes('patch.rubric'),
      { timeoutMs: 5_000, label: 'Convert target switched to open' },
    );
    tty.assertHealthyScreen(openTargetScreen, 120, 'DeckManageModal convert target open');

    tty.send('\r');
    const afterConvert = await tty.waitFor(
      (s) =>
        !s.includes('转换题型') &&
        !s.includes('Convert Card Kind') &&
        (s.includes('[简答]') || s.includes('[Open]') || s.includes('已转换为')),
      { timeoutMs: 8_000, label: 'card.convert completed and deck reloaded' },
    );
    tty.assertHealthyScreen(afterConvert, 120, 'DeckManageModal after convert');

    // Press '+' to enter Direct Supplement sub-mode
    tty.send('+');
    const supplementScreen = await tty.waitFor(
      (s) =>
        (s.includes('题组补题') || s.includes('Supplement Deck')) &&
        (s.includes('题数: 5') || s.includes('Count: 5')) &&
        (s.includes('题型: 混合') || s.includes('Kind: Mixed')) &&
        (s.includes('示例 · 设计模式讲义') || s.includes('Sample · Design Patterns')),
      { timeoutMs: 8_000, label: 'DeckManageModal supplement sub-mode opened' },
    );
    tty.assertHealthyScreen(supplementScreen, 120, 'DeckManageModal supplement sub-mode');

    // Verify count/kind/selection controls respond cleanly without submitting a real job
    tty.send(' ');
    await tty.flush();
    tty.send('+');
    await tty.flush();
    tty.send('\t');
    const suppUpdated = await tty.waitFor(
      (s) =>
        (s.includes('题数: 10') || s.includes('Count: 10')) &&
        (s.includes('题型: 单选') || s.includes('Kind: MCQ')) &&
        s.includes('1 页已选'),
      { timeoutMs: 5_000, label: 'Supplement controls updated cleanly' },
    );
    tty.assertHealthyScreen(suppUpdated, 120, 'DeckManageModal supplement controls updated');

    // Esc back to browse mode, then Esc closes DeckManageModal
    tty.send('\x1b');
    const backBrowse = await tty.waitFor(
      (s) =>
        !s.includes('题组补题') &&
        !s.includes('Supplement Deck') &&
        (s.includes('题组管理') || s.includes('Manage Deck')),
      { timeoutMs: 8_000, label: 'Returned to DeckManageModal browse mode via Esc' },
    );
    tty.assertHealthyScreen(backBrowse, 120, 'DeckManageModal back to browse');

    tty.send('\x1b');
    const afterClose = await tty.waitFor(
      (s) => !s.includes('题组管理') && !s.includes('Manage Deck'),
      { timeoutMs: 8_000, label: 'DeckManageModal closed via Esc' },
    );
    tty.assertHealthyScreen(afterClose, 120, 'LibraryView after DeckManageModal closed');
  });
});
