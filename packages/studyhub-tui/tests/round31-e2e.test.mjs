// Round 31 Deep Missing-Coverage E2E: node --test tests/round31-e2e.test.mjs
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

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];

async function makeTempDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `studyhub-tui-round31-${label}-`));
  tempDirs.push(dir);
  return dir;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Creates a virtual TTY backed by `@xterm/headless` for Ink E2E tests. */
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
      !screen.includes('\u001b'),
      `${contextLabel}: Unparsed escape sequence leaked into xterm buffer!\n${screen}`,
    );
    assert.ok(
      lines.length <= expectedRows,
      `${contextLabel}: Screen rows exceeded (${lines.length} > ${expectedRows})`,
    );
    for (let i = 0; i < lines.length; i += 1) {
      const w = displayWidth(lines[i]);
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
    firstFramePromise,
    flush,
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

function extractSkeletonItems(listRes) {
  if (!listRes?.ok) return [];
  const v = listRes.value;
  if (Array.isArray(v)) return v;
  if (Array.isArray(v?.skeletons)) return v.skeletons;
  return [];
}

describe('Round 31 Deep Missing-Coverage E2E', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let tty;
  let inkInstance;
  let disposed = false;

  let modelCallCount = 0;
  let skeletonStreamCalls = 0;
  let skeletonStubResponse = 'not json at all';

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

    host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: async (system, prompt, execution = {}) => {
        if (String(prompt || '').includes('OK?')) return 'OK';
        execution.signal?.throwIfAborted?.();
        modelCallCount += 1;

        const sysText = String(system || '');
        const promptText = String(prompt || '');

        if (sysText.includes('Design a hierarchical knowledge skeleton')) {
          skeletonStreamCalls += 1;
          execution.onOutput?.(skeletonStubResponse);
          return skeletonStubResponse;
        }

        if (sysText.includes('Assess a completed technical oral mock interview')) {
          let questions = [];
          try {
            const parsed = JSON.parse(promptText);
            questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
          } catch {
            questions = [];
          }
          const reply = JSON.stringify({
            results: questions.map((q) => ({
              cardId: q.cardId,
              band: 'strong',
              grade: 4,
              fragmentsOnly: false,
              reason: 'Clear mechanism and accurate boundary reasoning.',
            })),
          });
          execution.onOutput?.(reply);
          return reply;
        }

        const fallback = JSON.stringify({ status: 'ok', title: 'Stub', overview: 'Stub', nodes: [], relations: [] });
        execution.onOutput?.(fallback);
        return fallback;
      },
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

    await tty.waitFor(
      (s) => s.includes('载入示例课程体验') || s.includes('Load the sample course'),
      { label: 'Launchpad render' },
    );

    tty.send('s');
    await tty.waitFor(
      (s) =>
        !s.includes('载入示例课程体验') &&
        s.includes('示例 · Memento 与 Bridge') &&
        s.includes('示例案例 · 墨笺笔记'),
      { timeoutMs: 12_000, label: 'LibraryView after loading sample course' },
    );
    await sleep(100);
    await tty.flush();
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

  test('1) Oral Mock Exam E2E (5 -> 3 -> Enter -> answer -> submit -> Oral ExamReportView -> b)', async () => {
    tty.send('5');
    const setupScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'exam' &&
        (s.includes('组卷设置') || s.includes('Exam Setup')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'ExamView setup rendered' },
    );
    tty.assertHealthyScreen(setupScreen, 120, 36, 'ExamSetup initial');

    // Select Oral Mock mode (3)
    tty.send('3');
    const oralSetupScreen = await tty.waitFor(
      (s) =>
        (s.includes('[c] 口试题数') || s.includes('[c] Questions:')) &&
        (s.includes('示例') || s.includes('当前课程') || s.includes('全部激活课程')),
      { timeoutMs: 6_000, label: 'ExamSetup Oral Mock scope choices' },
    );
    assert.ok(
      !oralSetupScreen.includes('暂无可用考题') && !oralSetupScreen.includes('No eligible exam questions'),
      `Oral mode must show real scope choices (P1 #2 count fix), got:\n${oralSetupScreen}`,
    );
    tty.assertHealthyScreen(oralSetupScreen, 120, 36, 'ExamSetup Oral mode');

    // Start Oral Exam via Enter
    tty.send('\r');
    const oralRunner120 = await tty.waitFor(
      (s) =>
        (s.includes('口试模拟') || s.includes('Oral Mock')) &&
        (s.includes('你的回答') || s.includes('Your answer')) &&
        !s.includes('组卷设置'),
      { timeoutMs: 8_000, label: 'Oral ExamRunner at 120x36' },
    );
    tty.assertHealthyScreen(oralRunner120, 120, 36, 'Oral ExamRunner at 120x36');

    // Verify clean layout at 80x24 as well
    tty.resize(80, 24);
    const oralRunner80 = await tty.waitFor(
      (s) =>
        (s.includes('口试模拟') || s.includes('Oral Mock')) &&
        s.split('\n').length <= 24,
      { timeoutMs: 6_000, label: 'Oral ExamRunner at 80x24' },
    );
    tty.assertHealthyScreen(oralRunner80, 80, 24, 'Oral ExamRunner at 80x24');

    tty.resize(120, 36);
    await tty.waitFor(
      (s) =>
        (s.includes('口试模拟') || s.includes('Oral Mock')) &&
        (s.includes('你的回答') || s.includes('Your answer')),
      { timeoutMs: 6_000, label: 'Oral ExamRunner restored to 120x36' },
    );

    // Answer question 1: e -> type short answer -> Ctrl+S save
    tty.send('e');
    await tty.waitFor(
      (s) => s.includes('口述作答') || s.includes('Editing answer'),
      { timeoutMs: 5_000, label: 'Oral answer editor opened' },
    );

    const oralAnswerText = 'Memento captures internal state without exposing representation.';
    tty.send(oralAnswerText);
    await tty.waitFor(
      (s) => s.includes('Memento captures internal state'),
      { timeoutMs: 5_000, label: 'Oral answer typed' },
    );

    tty.send('\x13'); // Ctrl+S save answer
    const afterSave = await tty.waitFor(
      (s) =>
        !s.includes('口述作答') &&
        !s.includes('Editing answer') &&
        s.includes('Memento captures internal state') &&
        (s.includes('已答 1/') || s.includes('Ans 1/')),
      { timeoutMs: 6_000, label: 'Oral answer saved' },
    );
    tty.assertHealthyScreen(afterSave, 120, 36, 'Oral ExamRunner after saving Q1');

    // Submit oral exam via Ctrl+S -> y
    tty.send('\x13');
    await tty.waitFor(
      (s) => s.includes('确认交卷') || s.includes('Submit Exam'),
      { timeoutMs: 5_000, label: 'Oral submit ConfirmDialog' },
    );

    tty.send('y');
    const oralReportScreen = await tty.waitFor(
      (s) =>
        (s.includes('口试评估报告') || s.includes('Oral Report')) &&
        (s.includes('解析与详情') || s.includes('Review Detail')),
      { timeoutMs: 10_000, label: 'Oral ExamReportView rendered' },
    );
    tty.assertHealthyScreen(oralReportScreen, 120, 36, 'Oral ExamReportView');
    assert.ok(
      oralReportScreen.includes('优秀 1') || oralReportScreen.includes('Strong 1') || oralReportScreen.includes('1/'),
      `Expected Oral ExamReportView to show assessed summary, got:\n${oralReportScreen}`,
    );

    // Press b to return to ExamSetup
    tty.send('b');
    const backToSetup = await tty.waitFor(
      (s) =>
        (s.includes('组卷设置') || s.includes('Exam Setup')) &&
        !s.includes('口试评估报告') &&
        !s.includes('Oral Report'),
      { timeoutMs: 6_000, label: 'Return to ExamSetup via b' },
    );
    tty.assertHealthyScreen(backToSetup, 120, 36, 'ExamSetup after oral report');
  });

  test('2) Skeleton Generation Confirm + Invalid-JSON Safe Refusal (8 -> g -> y)', async () => {
    tty.send('8');
    const skelScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'skeleton' &&
        (s.includes('知识层级树') || s.includes('Knowledge Tree')) &&
        !s.includes('正在加载知识骨架') &&
        !s.includes('Loading knowledge skeleton'),
      { timeoutMs: 8_000, label: 'SkeletonView rendered' },
    );
    tty.assertHealthyScreen(skelScreen, 120, 36, 'SkeletonView initial');

    const beforeListRes = await host.call('skeleton.list', {});
    assert.equal(beforeListRes.ok, true, 'skeleton.list must succeed before generation test');
    const beforeItems = extractSkeletonItems(beforeListRes);
    assert.ok(beforeItems.length >= 1, `Sample course must have at least 1 skeleton, got ${beforeItems.length}`);
    const firstBefore = beforeItems[0];

    skeletonStubResponse = 'not json at all';
    const callsBefore = skeletonStreamCalls;

    tty.send('g');
    const confirmScreen = await tty.waitFor(
      (s) => s.includes('确认生成知识骨架') || s.includes('Confirm Skeleton Generation'),
      { timeoutMs: 6_000, label: 'Skeleton generation ConfirmDialog' },
    );
    assert.equal(skeletonStreamCalls, callsBefore, 'Pressing g must open ConfirmDialog without calling streamComplete');
    tty.assertHealthyScreen(confirmScreen, 120, 36, 'Skeleton ConfirmDialog');

    tty.send('y');
    const afterRefusal = await tty.waitFor(
      (s) =>
        skeletonStreamCalls === callsBefore + 1 &&
        !s.includes('确认生成知识骨架') &&
        (s.includes('格式无效') ||
          s.includes('could not be parsed') ||
          useTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'error' && (toast.text.includes('格式无效') || toast.text.includes('could not be parsed')))),
      { timeoutMs: 8_000, label: 'Skeleton invalid-JSON safe refusal feedback' },
    );
    tty.assertHealthyScreen(afterRefusal, 120, 36, 'SkeletonView after invalid-JSON refusal');

    const errorToast = useTuiStore
      .getState()
      .toasts.find((toast) => toast.tone === 'error' && (toast.text.includes('格式无效') || toast.text.includes('could not be parsed')));
    assert.ok(errorToast, 'Expected error toast notifying that invalid skeleton output was not saved');
    assert.ok(
      afterRefusal.includes('知识层级树') || afterRefusal.includes('Knowledge Tree'),
      'Existing skeleton tree view must remain intact after safe refusal',
    );

    const afterListRes = await host.call('skeleton.list', {});
    assert.equal(afterListRes.ok, true);
    const afterItems = extractSkeletonItems(afterListRes);
    assert.equal(
      afterItems.length,
      beforeItems.length,
      `Skeleton count must remain ${beforeItems.length} after invalid JSON refusal, got ${afterItems.length}`,
    );
    assert.equal(afterItems[0]?.id, firstBefore?.id, 'Existing skeleton ID must not be overwritten');
    assert.equal(afterItems[0]?.title, firstBefore?.title, 'Existing skeleton title must not be overwritten');
    assert.equal(
      Array.isArray(afterItems[0]?.nodes) ? afterItems[0].nodes.length : afterItems[0]?.nodes,
      Array.isArray(firstBefore?.nodes) ? firstBefore.nodes.length : firstBefore?.nodes,
      'Existing skeleton nodes must not be replaced by mechanical topic merging',
    );
  });

  test('3) ExamCoach (9) Full Flow: Note save without auto-AI + A ConfirmDialog + Tab 4 Strict Mock', async () => {
    tty.send('9');
    const coachScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'examcoach' &&
        (s.includes('考试教练') || s.includes('Exam Coach')) &&
        (s.includes('校准与考法') || s.includes('Calibration')) &&
        !s.includes('正在加载页面') &&
        !s.includes('Loading view'),
      { timeoutMs: 8_000, label: 'ExamCoachView rendered' },
    );
    tty.assertHealthyScreen(coachScreen, 120, 36, 'ExamCoachView Tab 1');

    const callsBeforeCoach = modelCallCount;

    // Note save (N -> type -> Ctrl+S) must persist without triggering AI analysis
    tty.send('N');
    await tty.waitFor(
      (s) => s.includes('提交往年样卷') || s.includes('Submit Past-Paper'),
      { timeoutMs: 6_000, label: 'ExamCoach Note modal opened' },
    );

    tty.send('2025 Mock focus: Memento state snapshot vs Command undo history.');
    await tty.waitFor(
      (s) => s.includes('2025 Mock focus'),
      { timeoutMs: 5_000, label: 'ExamCoach note text typed' },
    );

    tty.send('\x13'); // Ctrl+S save note
    const afterNoteSave = await tty.waitFor(
      (s) =>
        !s.includes('提交往年样卷') &&
        !s.includes('Submit Past-Paper') &&
        (s.includes('已保存教练笔记') ||
          s.includes('Coach note saved') ||
          useTuiStore
            .getState()
            .toasts.some((toast) => toast.text.includes('已保存教练笔记') || toast.text.includes('Coach note saved'))),
      { timeoutMs: 8_000, label: 'ExamCoach note saved feedback' },
    );
    assert.equal(modelCallCount, callsBeforeCoach, 'Saving coach note must NOT automatically call AI model');
    tty.assertHealthyScreen(afterNoteSave, 120, 36, 'ExamCoachView after note save');

    // Press A -> ConfirmDialog opens without calling model -> press n to cancel
    tty.send('A');
    const aiConfirmScreen = await tty.waitFor(
      (s) => s.includes('确认 AI 深化分析考法') || s.includes('Confirm AI Exam Analysis'),
      { timeoutMs: 6_000, label: 'ExamCoach A ConfirmDialog' },
    );
    assert.equal(modelCallCount, callsBeforeCoach, 'Pressing A must open ConfirmDialog without calling AI model');
    tty.assertHealthyScreen(aiConfirmScreen, 120, 36, 'ExamCoach A ConfirmDialog');

    tty.send('n');
    await tty.waitFor(
      (s) => !s.includes('确认 AI 深化分析考法') && !s.includes('Confirm AI Exam Analysis'),
      { timeoutMs: 6_000, label: 'ExamCoach A ConfirmDialog cancelled' },
    );
    assert.equal(modelCallCount, callsBeforeCoach, 'Cancelling A ConfirmDialog must NOT call AI model');

    // Switch to Tab 4 (Mock Check) and run strict mock composition (m)
    tty.send('4');
    const mockTabScreen = await tty.waitFor(
      (s) =>
        s.includes('按校准配置编译出题与严格同型组卷检查') ||
        s.includes('Compiled Calibration & Strict Mock Check'),
      { timeoutMs: 6_000, label: 'ExamCoach Tab 4 rendered' },
    );
    tty.assertHealthyScreen(mockTabScreen, 120, 36, 'ExamCoach Tab 4 initial');

    tty.send('m');
    const mockResultScreen = await tty.waitFor(
      (s) =>
        s.includes('可完整组成严格同型模拟卷') ||
        s.includes('结构缺口') ||
        s.includes('Ready to compose') ||
        s.includes('structural shortfall'),
      { timeoutMs: 8_000, label: 'ExamCoach Tab 4 strict mock composition result' },
    );
    assert.equal(modelCallCount, callsBeforeCoach, 'Strict mock composition check must remain 0-token');
    tty.assertHealthyScreen(mockResultScreen, 120, 36, 'ExamCoach Tab 4 strict mock result');
  });

  test('4) Board Pomodoro Persistence Across View Switches (b -> P -> 1 -> b)', async () => {
    // Leave ExamCoachView (which claims '1'..'4' and 'b') via '6' (Dashboard) before pressing 'b'
    tty.send('6');
    await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'dashboard' &&
        (s.includes('薄弱点') || s.includes('热力图') || s.includes('Analytics') || s.includes('Weak')) &&
        !s.includes('正在加载页面') &&
        !s.includes('Loading view'),
      { timeoutMs: 6_000, label: 'Navigated to DashboardView before BoardView' },
    );

    tty.send('b');
    const boardInitial = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'board' &&
        (s.includes('专注 Focus') || s.includes('Focus')) &&
        s.includes('25:00'),
      { timeoutMs: 8_000, label: 'BoardView rendered with 25:00 Pomodoro' },
    );
    tty.assertHealthyScreen(boardInitial, 120, 36, 'BoardView initial');

    // Start Pomodoro (P) and wait ~1.2s so timer ticks below 25:00
    tty.send('P');
    await sleep(1250);
    const boardTicked = await tty.waitFor(
      (s) =>
        useTuiStore.getState().pomodoro.running === true &&
        useTuiStore.getState().pomodoro.remainingSec < 25 * 60 &&
        !s.includes('25:00') &&
        /24:5\d/.test(s),
      { timeoutMs: 4_000, label: 'Pomodoro ticked below 25:00' },
    );
    const remBeforeSwitch = useTuiStore.getState().pomodoro.remainingSec;
    tty.assertHealthyScreen(boardTicked, 120, 36, 'BoardView Pomodoro running');

    // Switch away to LibraryView (1), wait ~1.1s, then switch back to BoardView (b)
    tty.send('1');
    await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'library' &&
        (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 6_000, label: 'Switched to LibraryView while Pomodoro running' },
    );

    await sleep(1150);

    tty.send('b');
    const boardReturned = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'board' &&
        (s.includes('专注 Focus') || s.includes('Focus')) &&
        /24:5\d/.test(s),
      { timeoutMs: 6_000, label: 'Returned to BoardView with persisted Pomodoro' },
    );
    const pomAfterReturn = useTuiStore.getState().pomodoro;
    assert.equal(pomAfterReturn.running, true, 'Pomodoro must still be running after switching views');
    assert.notEqual(pomAfterReturn.endsAt, null, 'Pomodoro endsAt must remain set while running');
    assert.ok(
      pomAfterReturn.remainingSec < remBeforeSwitch,
      `Pomodoro must continue counting down across view switches (before=${remBeforeSwitch}, after=${pomAfterReturn.remainingSec})`,
    );
    assert.ok(
      !boardReturned.includes('25:00') && (boardReturned.includes('▶') || boardReturned.includes('> 专注')),
      `BoardView must show running Pomodoro below 25:00, got:\n${boardReturned}`,
    );
    tty.assertHealthyScreen(boardReturned, 120, 36, 'BoardView after view switch');

    // Pause (P) and Reset (R) cleanly before teardown
    tty.send('P');
    await tty.waitFor(
      (s) =>
        useTuiStore.getState().pomodoro.running === false &&
        (s.includes('⏸') || s.includes('||')),
      { timeoutMs: 4_000, label: 'Pomodoro paused cleanly' },
    );

    tty.send('R');
    const boardReset = await tty.waitFor(
      (s) =>
        useTuiStore.getState().pomodoro.remainingSec === 25 * 60 &&
        s.includes('25:00'),
      { timeoutMs: 4_000, label: 'Pomodoro reset to 25:00 cleanly' },
    );
    tty.assertHealthyScreen(boardReset, 120, 36, 'BoardView after Pomodoro reset');
  });
});
