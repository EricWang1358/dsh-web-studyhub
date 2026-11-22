// Round 21 Features E2E verification: node --test tests/round21-e2e.test.mjs
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
  if (f.startsWith('host-') || f.startsWith('chunk-') || f.startsWith('store-')) {
    const mod = await import(pathToFileURL(join(distDir, f)).href);
    if (!H && typeof mod.createTuiHost === 'function') H = mod;
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round21-${label}-`));
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

function createRound21StubComplete() {
  return async (_system, prompt, execution = {}) => {
    if (String(prompt || '').includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const reply = JSON.stringify({ status: 'ok' });
    execution.onOutput?.(reply);
    return reply;
  };
}

describe('StudyHub TUI Round 21 Features E2E', () => {
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
      injectedComplete: createRound21StubComplete(),
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

  test('1) Case Exam (5) side-by-side scenario at 120x36, [H] highlight, narrow [s] toggle at 80x24, Ctrl+S submit & Case ExamReportView', async () => {
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

    // Navigate to ExamView via '5'
    tty.send('5');
    const setupScreen = await tty.waitFor(
      (s) => s.includes('组卷设置') && s.includes('2:案例卷'),
      { timeoutMs: 8_000, label: 'ExamSetup rendered' },
    );
    tty.assertHealthyScreen(setupScreen, 120, 36, 'ExamSetup at 120x36');

    // Select Case Exam tab/mode ('2') and start it ('Enter')
    tty.send('2');
    await tty.waitFor(
      (s) => s.includes('示例案例 · 墨笺笔记') && s.includes('案例卷按题组全卷作答'),
      { timeoutMs: 6_000, label: 'Case Exam mode selected in ExamSetup' },
    );
    tty.send('\r');

    // Wait for Case ExamRunner to start
    await tty.waitFor(
      (s) => s.includes('案例卷 · 1/2') && (s.includes('第 1 题') || s.includes('Memento')),
      { timeoutMs: 10_000, label: 'Case ExamRunner opened' },
    );

    // Collapse sidebar at 120x36 so contentW >= WIDE_CASE_BREAKPOINT (104) and side-by-side scenario renders
    tty.send('\\');
    const sideBySide = await tty.waitFor(
      (s) =>
        s.includes('[P1]') &&
        s.includes('墨笺是一家为学生做笔记应用的小公司') &&
        s.includes('案例卷 · 1/2') &&
        s.includes('第 1 题'),
      { timeoutMs: 8_000, label: 'Case side-by-side scenario rendered at 120x36' },
    );
    tty.assertHealthyScreen(sideBySide, 120, 36, 'Case side-by-side scenario at 120x36');

    // Press 'H' to toggle paragraph 1 highlight (review.highlights)
    tty.send('H');
    const highlighted = await tty.waitFor(
      (s) => s.includes('[P1 ★]') && s.includes('1★'),
      { timeoutMs: 8_000, label: 'Paragraph 1 highlighted via [H]' },
    );
    tty.assertHealthyScreen(highlighted, 120, 36, 'Case Exam after [H] highlight at 120x36');

    // Resize to 80x24 and test narrow [s] scenario overlay toggle
    tty.resize(80, 24);
    const narrowQuestion = await tty.waitFor(
      (s) =>
        s.includes('案例卷 · 1/2') &&
        !s.includes('墨笺是一家为学生做笔记应用的小公司') &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'Case question pane at 80x24' },
    );
    tty.assertHealthyScreen(narrowQuestion, 80, 24, 'Case Exam narrow question at 80x24');

    tty.send('s');
    const narrowOverlay = await tty.waitFor(
      (s) =>
        s.includes('[P1 ★]') &&
        s.includes('墨笺是一家为学生做笔记应用的小公司') &&
        s.includes('s 返回'),
      { timeoutMs: 6_000, label: 'Narrow scenario overlay opened via [s]' },
    );
    tty.assertHealthyScreen(narrowOverlay, 80, 24, 'Case Exam narrow [s] overlay at 80x24');

    tty.send('s');
    const narrowBack = await tty.waitFor(
      (s) =>
        s.includes('案例卷 · 1/2') &&
        !s.includes('墨笺是一家为学生做笔记应用的小公司'),
      { timeoutMs: 6_000, label: 'Narrow scenario overlay closed via [s]' },
    );
    tty.assertHealthyScreen(narrowBack, 80, 24, 'Case Exam back from [s] overlay at 80x24');

    // Submit exam via Ctrl+S -> 'y'
    tty.send('\x13');
    await tty.waitFor(
      (s) => s.includes('确认交卷') || s.includes('Submit Exam'),
      { timeoutMs: 6_000, label: 'Submit confirmation dialog' },
    );
    tty.send('y');

    const narrowReport = await tty.waitFor(
      (s) =>
        (s.includes('案例评估报告') || s.includes('Case Exam Report')) &&
        s.includes('0/10') &&
        s.includes('Q1') &&
        s.includes('Q2'),
      { timeoutMs: 10_000, label: 'Case ExamReportView rendered at 80x24' },
    );
    tty.assertHealthyScreen(narrowReport, 80, 24, 'Case ExamReportView at 80x24');

    // Restore 120x36 + expanded sidebar and verify submitted report & pre-graded sample case criteria breakdown
    tty.resize(120, 36);
    tty.send('\\');
    const wideReport = await tty.waitFor(
      (s) =>
        (s.includes('案例评估报告') || s.includes('Case Exam Report')) &&
        s.includes('Q1 (0/6') &&
        s.includes('各题评分 (2)'),
      { timeoutMs: 8_000, label: 'Case ExamReportView restored to 120x36' },
    );
    tty.assertHealthyScreen(wideReport, 120, 36, 'Case ExamReportView at 120x36');

    // Exit back to ExamSetup via 'b', open the pre-graded sample case attempt to verify score/criteria breakdown
    tty.send('b');
    await tty.waitFor(
      (s) => s.includes('组卷设置') && s.includes('历史考卷'),
      { timeoutMs: 6_000, label: 'Returned to ExamSetup via [b]' },
    );
    tty.send('l');
    await tty.flush();
    tty.send('j');
    await tty.flush();
    tty.send('\r');
    const gradedReport = await tty.waitFor(
      (s) =>
        (s.includes('案例评估报告') || s.includes('Case Exam Report')) &&
        s.includes('薄弱评分维度') &&
        s.includes('评分维度明细') &&
        s.includes('运用 Memento 给出建议'),
      { timeoutMs: 8_000, label: 'Graded sample Case ExamReportView with criteria breakdown' },
    );
    tty.assertHealthyScreen(gradedReport, 120, 36, 'Graded sample Case ExamReportView at 120x36');

    // Exit report cleanly back to ExamSetup
    tty.send('b');
    const backSetup = await tty.waitFor(
      (s) => s.includes('组卷设置') && !s.includes('案例评估报告'),
      { timeoutMs: 6_000, label: 'Exited Case ExamReportView cleanly' },
    );
    tty.assertHealthyScreen(backSetup, 120, 36, 'ExamSetup after Case report exit');
  });

  test('2) SkeletonView [L] Skeleton Structural Lint (8 -> L) at 120x36, 80x24, --ascii purity & Esc close', async () => {
    tty.send('8');
    const skelScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'skeleton' &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')) &&
        (s.includes('释义:') || s.includes('Description:') || s.includes('节点检视器') || s.includes('Node Inspector')) &&
        !s.includes('正在加载知识骨架'),
      { timeoutMs: 10_000, label: 'SkeletonView rendered at 120x36' },
    );
    tty.assertHealthyScreen(skelScreen, 120, 36, 'SkeletonView at 120x36');

    // Press 'L' to open Skeleton Structural Lint modal
    tty.send('L');
    const lintWide = await tty.waitFor(
      (s) =>
        (s.includes('骨架结构自检') || s.includes('Skeleton Lint')) &&
        !s.includes('正在检查骨架与题目结构') &&
        (s.includes('骨架结构健康') || s.includes('结构提示') || s.includes('structural finding')),
      { timeoutMs: 8_000, label: 'Skeleton Lint modal rendered at 120x36' },
    );
    tty.assertHealthyScreen(lintWide, 120, 36, 'Skeleton Lint modal at 120x36');

    // Resize to 80x24 and verify healthy rendering
    tty.resize(80, 24);
    const lintNarrow = await tty.waitFor(
      (s) =>
        (s.includes('骨架结构自检') || s.includes('Skeleton Lint')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'Skeleton Lint modal at 80x24' },
    );
    tty.assertHealthyScreen(lintNarrow, 80, 24, 'Skeleton Lint modal at 80x24');

    // Restore 120x36 and verify --ascii purity (zero Unicode box/block/Braille leaks)
    tty.resize(120, 36);
    await tty.waitFor(
      (s) => (s.includes('骨架结构自检') || s.includes('Skeleton Lint')) && s.includes('知识层级树'),
      { timeoutMs: 8_000, label: 'Skeleton Lint modal restored to 120x36' },
    );

    useTuiStore.getState().setPreferences({ asciiMode: true });
    try {
      const lintAscii = await tty.waitFor(
        (s) => s.includes('! 骨架结构自检') && s.includes('esc x'),
        { timeoutMs: 6_000, label: 'Skeleton Lint modal rendered in --ascii mode' },
      );
      tty.assertHealthyScreen(lintAscii, 120, 36, 'Skeleton Lint modal --ascii at 120x36');
      tty.assertAsciiPure(lintAscii, 'Skeleton Lint modal --ascii at 120x36');
    } finally {
      useTuiStore.getState().setPreferences({ asciiMode: false });
    }
    await tty.waitFor(
      (s) => s.includes('⚑ 骨架结构自检'),
      { timeoutMs: 6_000, label: 'Skeleton Lint modal restored to Unicode mode' },
    );

    // Esc closes Lint modal cleanly
    tty.send('\x1b');
    const afterLint = await tty.waitFor(
      (s) =>
        !s.includes('骨架结构自检') &&
        !s.includes('Skeleton Lint') &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')),
      { timeoutMs: 6_000, label: 'Skeleton Lint modal closed via Esc' },
    );
    tty.assertHealthyScreen(afterLint, 120, 36, 'SkeletonView after Esc closed lint modal');
  });

  test('3) NotesView [o] linked-card direct jump (n -> create card-linked note -> o -> ReviewView)', async () => {
    tty.send('n');
    const notesInit = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'notes' &&
        (s.includes('Unicode Math') || s.includes('Raw LaTeX') || s.includes('选择一篇笔记阅读') || s.includes('Select a note to read')) &&
        (s.includes('a  新建') || s.includes('a  New')) &&
        !s.includes('载入笔记中'),
      { timeoutMs: 8_000, label: 'NotesView rendered' },
    );
    tty.assertHealthyScreen(notesInit, 120, 36, 'NotesView at 120x36');
    await tty.flush();

    // Press 'a' to open NoteEditorModal; wait until preselected linked card (1/30) is loaded
    tty.send('a');
    const editorOpen = await tty.waitFor(
      (s) =>
        (s.includes('新建学习笔记') || s.includes('New Study Note')) &&
        (s.includes('已选 1/30') || s.includes('1/30')) &&
        !s.includes('搜索中'),
      { timeoutMs: 8_000, label: 'NoteEditorModal opened with preselected linked card' },
    );
    tty.assertHealthyScreen(editorOpen, 120, 36, 'NoteEditorModal open at 120x36');

    // Enter note title and save via Ctrl+S
    const noteTitle = 'R21 Linked Card Note';
    tty.send(noteTitle);
    await tty.waitFor(
      (s) => s.includes(noteTitle),
      { timeoutMs: 6_000, label: 'Note title typed into NoteEditorModal' },
    );
    tty.send('\x13'); // Ctrl+S

    // Wait for modal close and linked-card banner '[o] 关联题卡:' in NotesView
    const notesSaved = await tty.waitFor(
      (s) =>
        !s.includes('新建学习笔记') &&
        s.includes(noteTitle) &&
        (s.includes('[o] 关联题卡:') || s.includes('[o] Card:')),
      { timeoutMs: 8_000, label: 'Saved linked note displayed with [o] Card reference' },
    );
    tty.assertHealthyScreen(notesSaved, 120, 36, 'NotesView after saving card-linked note');

    // Press 'o' to jump directly into ReviewView with the linked card rendered
    tty.send('o');
    const reviewScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'review' &&
        s.includes('1/1') &&
        (s.includes('按 [Space] 或 [Enter] 翻开答案') ||
          s.includes('Press [Space] or [Enter] to flip card') ||
          s.includes('[1/a]') ||
          s.includes('选择提交')) &&
        (s.includes('[D]工具') || s.includes('[D]Tools')),
      { timeoutMs: 10_000, label: 'ReviewView opened directly via [o] from linked note' },
    );
    assert.equal(useTuiStore.getState().page, 'review', 'Store page must switch to review');
    tty.assertHealthyScreen(reviewScreen, 120, 36, 'ReviewView after [o] jump from NotesView');
  });
});
