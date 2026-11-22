// Round 16 Features E2E verification: node --test tests/round16-e2e.test.mjs
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
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-round16-${label}-`));
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

function createRound16StubComplete() {
  return async (_system, prompt, execution = {}) => {
    const p = String(prompt || '');
    if (p.includes('OK?')) return 'OK';
    execution.signal?.throwIfAborted?.();
    const reply = JSON.stringify({ status: 'ok' });
    execution.onOutput?.(reply);
    return reply;
  };
}

describe('StudyHub TUI Round 16 Features E2E', () => {
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
      injectedComplete: createRound16StubComplete(),
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

  test('1) ExamPrepView StudyPlanModal (0 -> P): Tab 1 Plan & Tab 2 Readiness at 120x36 & 80x24, Esc closes', async () => {
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

    // Navigate to ExamPrepView via '0' (wait for ExamPrepView-unique content, not sidebar label)
    tty.send('0');
    const examPrepInit = await tty.waitFor(
      (s) =>
        (s.includes('1:考纲重点进度') || s.includes('1:Focus Progress')) &&
        (s.includes('[P] 备考计划') || s.includes('[P] Plan')) &&
        !s.includes('正在加载备考重点') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'ExamPrepView rendered' },
    );
    tty.assertHealthyScreen(examPrepInit, 120, 36, 'ExamPrepView initial');

    // Open StudyPlanModal via 'P'
    tty.send('P');
    const planTabWide = await tty.waitFor(
      (s) =>
        (s.includes('课程备考计划 & 章节就绪度') || s.includes('Study Plan & Chapter Readiness')) &&
        (s.includes('1:备考计划') || s.includes('1:Study Plan')) &&
        !s.includes('正在加载备考计划') &&
        !s.includes('Loading study plan') &&
        (s.includes('近期日程') ||
          s.includes('Upcoming Schedule') ||
          s.includes('尚未') ||
          s.includes('No study plan') ||
          s.includes('No review book') ||
          s.includes('No exam date')),
      { timeoutMs: 10_000, label: 'StudyPlanModal Tab 1 rendered at 120x36' },
    );
    tty.assertHealthyScreen(planTabWide, 120, 36, 'StudyPlanModal Tab 1 at 120x36');

    // Switch to Tab 2 (章节就绪度 / Readiness) via '2'
    tty.send('2');
    const readinessTabWide = await tty.waitFor(
      (s) =>
        (s.includes('2:章节就绪度') || s.includes('2:Readiness')) &&
        !s.includes('正在分析章节就绪度与估算') &&
        !s.includes('Loading chapter readiness') &&
        (s.includes('粗估消耗') || s.includes('Rough est.')) &&
        (s.includes('章节就绪度 (') || s.includes('Chapter Readiness (')),
      { timeoutMs: 10_000, label: 'StudyPlanModal Tab 2 Readiness rendered at 120x36' },
    );
    tty.assertHealthyScreen(readinessTabWide, 120, 36, 'StudyPlanModal Tab 2 at 120x36');

    // Verify 80x24 layout on StudyPlanModal
    tty.resize(80, 24);
    const readinessTabNarrow = await tty.waitFor(
      (s) =>
        (s.includes('课程备考计划 & 章节就绪度') || s.includes('Study Plan & Chapter Readiness')) &&
        (s.includes('粗估消耗') || s.includes('Rough est.')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'StudyPlanModal Tab 2 at 80x24' },
    );
    tty.assertHealthyScreen(readinessTabNarrow, 80, 24, 'StudyPlanModal Tab 2 at 80x24');

    // Restore 120x36
    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('课程备考计划 & 章节就绪度') || s.includes('Study Plan & Chapter Readiness'),
      { timeoutMs: 8_000, label: 'StudyPlanModal restored to 120x36' },
    );

    // Esc closes StudyPlanModal cleanly back to ExamPrepView
    tty.send('\x1b');
    const backToExamPrep = await tty.waitFor(
      (s) =>
        !s.includes('课程备考计划 & 章节就绪度') &&
        !s.includes('Study Plan & Chapter Readiness') &&
        (s.includes('1:考纲重点进度') || s.includes('1:Focus Progress')),
      { timeoutMs: 8_000, label: 'StudyPlanModal closed via Esc' },
    );
    tty.assertHealthyScreen(backToExamPrep, 120, 36, 'ExamPrepView after StudyPlanModal closed');
  });

  test('2) TasksView WorkflowHistoryModal (t -> w) at 120x36 & 80x24, plus safe o / a / r handling', async () => {
    // Navigate to TasksView via 't' (wait for TasksView-unique header/footer)
    tty.send('t');
    const tasksInit = await tty.waitFor(
      (s) =>
        (s.includes('监控后台任务') || s.includes('Monitor jobs')) &&
        (s.includes('1. 运行中') || s.includes('1. Running')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'TasksView rendered' },
    );
    tty.assertHealthyScreen(tasksInit, 120, 36, 'TasksView initial');

    // Open WorkflowHistoryModal via 'w'
    tty.send('w');
    const wfWide = await tty.waitFor(
      (s) =>
        (s.includes('历史学习流记录 (只读)') || s.includes('Workflow History (Read-Only)')) &&
        !s.includes('正在读取历史学习流') &&
        !s.includes('Loading workflow history'),
      { timeoutMs: 10_000, label: 'WorkflowHistoryModal rendered at 120x36' },
    );
    tty.assertHealthyScreen(wfWide, 120, 36, 'WorkflowHistoryModal at 120x36');

    // Test 'r' refresh inside WorkflowHistoryModal
    tty.send('r');
    const wfRefreshed = await tty.waitFor(
      (s) =>
        (s.includes('历史学习流记录 (只读)') || s.includes('Workflow History (Read-Only)')) &&
        !s.includes('正在读取历史学习流'),
      { timeoutMs: 8_000, label: 'WorkflowHistoryModal after r refresh' },
    );
    tty.assertHealthyScreen(wfRefreshed, 120, 36, 'WorkflowHistoryModal after r refresh');

    // Verify 80x24 layout on WorkflowHistoryModal
    tty.resize(80, 24);
    const wfNarrow = await tty.waitFor(
      (s) =>
        (s.includes('历史学习流记录 (只读)') || s.includes('Workflow History (Read-Only)')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 8_000, label: 'WorkflowHistoryModal at 80x24' },
    );
    tty.assertHealthyScreen(wfNarrow, 80, 24, 'WorkflowHistoryModal at 80x24');

    // Restore 120x36 and close cleanly via Esc
    tty.resize(120, 36);
    await tty.waitFor(
      (s) => s.includes('历史学习流记录 (只读)') || s.includes('Workflow History (Read-Only)'),
      { timeoutMs: 8_000, label: 'WorkflowHistoryModal restored to 120x36' },
    );

    tty.send('\x1b');
    const backToTasks = await tty.waitFor(
      (s) =>
        !s.includes('历史学习流记录 (只读)') &&
        !s.includes('Workflow History (Read-Only)') &&
        (s.includes('监控后台任务') || s.includes('Monitor jobs')),
      { timeoutMs: 8_000, label: 'WorkflowHistoryModal closed via Esc' },
    );
    tty.assertHealthyScreen(backToTasks, 120, 36, 'TasksView after WorkflowHistoryModal closed');

    // Verify o and a handle empty job list safely without crashing
    tty.send('o');
    const afterEmptyO = await tty.waitFor(
      (s) =>
        (s.includes('请先选择一个任务') || s.includes('Select a job first') || s.includes('任务输出:')) &&
        (s.includes('监控后台任务') || s.includes('Monitor jobs')),
      { timeoutMs: 5_000, label: 'TasksView o on empty job list' },
    );
    tty.assertHealthyScreen(afterEmptyO, 120, 36, 'TasksView after o (empty)');

    tty.send('a');
    await sleep(60);
    await tty.flush();
    tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'TasksView after a (empty)');

    // Create a populated job via sample course source so JobOutputModal ('o'), refresh ('r'), and archive ('a') run for real
    const snapRes = await host.call('snapshot', {});
    assert.equal(snapRes.ok, true, 'snapshot must succeed');
    const sources = snapRes.value?.sources ?? [];
    const activeSource = sources.find((s) => !s.archived) ?? sources[0];
    const activeCourse =
      activeSource?.course || activeSource?.courses?.[0] || snapRes.value?.courses?.[0]?.name || '示例 · Memento 与 Bridge';
    if (activeSource) {
      const genRes = await host.call('generate', {
        course: activeCourse,
        sourceIds: [activeSource.id],
        count: 5,
        kind: 'quiz',
        title: 'R16 E2E Job',
      });
      assert.equal(
        genRes.ok,
        true,
        `generate job for TasksView should succeed: ${genRes.error?.message || JSON.stringify(genRes)}`,
      );
      await sleep(150);
      // Trigger Ctrl+R so AppShell pulls the updated snapshot containing the job
      tty.send('\x12');

      // Wait for populated job to appear in TasksView list
      const populatedTasks = await tty.waitFor(
        (s) =>
          (s.includes('R16 E2E Job') || s.includes('2. 全部 (1)') || s.includes('2. All (1)')) &&
          !s.includes('当前筛选下无任务'),
        { timeoutMs: 10_000, label: 'Populated job visible in TasksView' },
      );
      tty.assertHealthyScreen(populatedTasks, 120, 36, 'TasksView populated job');

      // Open JobOutputModal via 'o'
      tty.send('o');
      const outputModal = await tty.waitFor(
        (s) =>
          (s.includes('任务输出:') || s.includes('Job Output:')) &&
          !s.includes('正在获取任务输出') &&
          !s.includes('Loading job output'),
        { timeoutMs: 8_000, label: 'JobOutputModal opened on populated job' },
      );
      tty.assertHealthyScreen(outputModal, 120, 36, 'JobOutputModal opened');

      // Refresh output inside JobOutputModal via 'r'
      tty.send('r');
      const outputRefreshed = await tty.waitFor(
        (s) =>
          (s.includes('任务输出:') || s.includes('Job Output:')) &&
          !s.includes('正在获取任务输出') &&
          !s.includes('Loading job output'),
        { timeoutMs: 8_000, label: 'JobOutputModal refreshed via r' },
      );
      tty.assertHealthyScreen(outputRefreshed, 120, 36, 'JobOutputModal after r');

      // Close JobOutputModal cleanly via Esc
      tty.send('\x1b');
      const backAfterOutput = await tty.waitFor(
        (s) => !s.includes('任务输出:') && !s.includes('Job Output:'),
        { timeoutMs: 8_000, label: 'JobOutputModal closed via Esc' },
      );
      tty.assertHealthyScreen(backAfterOutput, 120, 36, 'TasksView after JobOutputModal closed');

      // Exercise 'a' (archive/skip) safely on the selected job without crashing
      tty.send('a');
      await sleep(120);
      await tty.flush();
      tty.assertHealthyScreen(tty.readScreen(), 120, 36, 'TasksView after a on populated job');
    }

    // Unmount primary Ink instance before running dedicated --ascii render in Test 3
    inkInstance.unmount();
    inkInstance = null;
    tty.dispose();
    tty = null;
  });

  test('3) StudyPlanModal & WorkflowHistoryModal --ascii Zero-Unicode-Leak Check', async () => {
    const asciiDir = await makeTempDir('ascii');
    const asciiDshHome = join(asciiDir, 'dsh-home');
    const asciiLibRoot = join(asciiDir, 'library');

    await H.saveTuiPreferences({ language: 'zh', asciiMode: true }, { env: { DSH_HOME: asciiDshHome } });

    const asciiHost = await H.createTuiHost({
      env: { DSH_HOME: asciiDshHome },
      home: join(asciiDir, 'home'),
      libraryRoot: asciiLibRoot,
      injectedComplete: createRound16StubComplete(),
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
          initialPage: 'examprep',
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

      const prepAscii = await asciiTty.waitFor(
        (s) =>
          (s.includes('1:考纲重点进度') || s.includes('1:Focus Progress')) &&
          !s.includes('正在加载备考重点') &&
          !s.includes('正在加载页面'),
        { timeoutMs: 10_000, label: 'ASCII ExamPrepView rendered' },
      );
      asciiTty.assertHealthyScreen(prepAscii, 120, 36, 'ASCII ExamPrepView');
      asciiTty.assertAsciiPure(prepAscii, 'ASCII ExamPrepView');

      // Open StudyPlanModal ('P') -> Tab 1
      asciiTty.send('P');
      const planAscii1 = await asciiTty.waitFor(
        (s) =>
          (s.includes('课程备考计划 & 章节就绪度') || s.includes('Study Plan & Chapter Readiness')) &&
          !s.includes('正在加载备考计划') &&
          !s.includes('Loading study plan'),
        { timeoutMs: 10_000, label: 'ASCII StudyPlanModal Tab 1 rendered' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(planAscii1, 120, 36, 'ASCII StudyPlanModal Tab 1');
      asciiTty.assertAsciiPure(planAscii1, 'ASCII StudyPlanModal Tab 1');

      // Switch to Tab 2 ('2')
      asciiTty.send('2');
      const planAscii2 = await asciiTty.waitFor(
        (s) =>
          (s.includes('粗估消耗') || s.includes('Rough est.')) &&
          !s.includes('正在分析章节就绪度与估算') &&
          !s.includes('Loading chapter readiness'),
        { timeoutMs: 10_000, label: 'ASCII StudyPlanModal Tab 2 rendered' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(planAscii2, 120, 36, 'ASCII StudyPlanModal Tab 2');
      asciiTty.assertAsciiPure(planAscii2, 'ASCII StudyPlanModal Tab 2');

      // Close StudyPlanModal ('Esc')
      asciiTty.send('\x1b');
      await asciiTty.waitFor(
        (s) => !s.includes('课程备考计划 & 章节就绪度') && !s.includes('Study Plan & Chapter Readiness'),
        { timeoutMs: 8_000, label: 'ASCII StudyPlanModal closed' },
      );

      // Navigate to TasksView ('t')
      asciiTty.send('t');
      const tasksAscii = await asciiTty.waitFor(
        (s) =>
          (s.includes('监控后台任务') || s.includes('Monitor jobs')) &&
          !s.includes('正在加载页面'),
        { timeoutMs: 10_000, label: 'ASCII TasksView rendered' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(tasksAscii, 120, 36, 'ASCII TasksView');
      asciiTty.assertAsciiPure(tasksAscii, 'ASCII TasksView');

      // Open WorkflowHistoryModal ('w')
      asciiTty.send('w');
      const wfAscii = await asciiTty.waitFor(
        (s) =>
          (s.includes('历史学习流记录 (只读)') || s.includes('Workflow History (Read-Only)')) &&
          !s.includes('正在读取历史学习流') &&
          !s.includes('Loading workflow history'),
        { timeoutMs: 10_000, label: 'ASCII WorkflowHistoryModal rendered' },
      );
      await asciiTty.flush();
      asciiTty.assertHealthyScreen(wfAscii, 120, 36, 'ASCII WorkflowHistoryModal');
      asciiTty.assertAsciiPure(wfAscii, 'ASCII WorkflowHistoryModal');

      // Close WorkflowHistoryModal ('Esc')
      asciiTty.send('\x1b');
      await asciiTty.waitFor(
        (s) => !s.includes('历史学习流记录 (只读)') && !s.includes('Workflow History (Read-Only)'),
        { timeoutMs: 8_000, label: 'ASCII WorkflowHistoryModal closed' },
      );
    } finally {
      await cleanupAscii();
      extraCleanups.pop();
    }
  });
});
