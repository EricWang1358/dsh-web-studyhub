// PR #1297 P0 regression suite: node --test tests/pr1297-p0.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import xtermPkg from '@xterm/headless';
import { render } from 'ink';
import React from 'react';
import { tsImport } from 'tsx/esm/api';

const { Terminal } = xtermPkg;
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const distDir = resolve(pkgRoot, 'dist');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const { StudyHubTuiApp } = await import(pathToFileURL(join(distDir, 'App.mjs')).href);
const { loadBoardSafe } = await tsImport('../src/views/board/board-store.ts', import.meta.url);

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
assert.equal(typeof loadBoardSafe, 'function', 'board-store must export loadBoardSafe');

const PREV_DSH_HOME = process.env.DSH_HOME;
const tempDirs = [];
async function makeTempDir(label) {
  const d = await mkdtemp(join(tmpdir(), `studyhub-tui-pr1297-${label}-`));
  tempDirs.push(d);
  return d;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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
    assert.ok(!screen.includes('\x1b'), `${contextLabel}: Unparsed escape sequence leaked!\n${screen}`);
    assert.ok(lines.length <= expectedRows, `${contextLabel}: Row count ${lines.length} > ${expectedRows}`);
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

function createStubComplete() {
  return async () => ({
    text: JSON.stringify({
      cards: [
        {
          kind: 'quiz',
          topic: 'P0 Regression',
          prompt: 'Stub question 1?',
          options: [
            { id: 'a', text: 'Option A', correct: true },
            { id: 'b', text: 'Option B', correct: false },
          ],
          answer: 'Option A',
          explanation: 'Option A is correct.',
        },
        {
          kind: 'quiz',
          topic: 'P0 Regression',
          prompt: 'Stub question 2?',
          options: [
            { id: 'a', text: 'Option A', correct: true },
            { id: 'b', text: 'Option B', correct: false },
          ],
          answer: 'Option A',
          explanation: 'Option A is correct.',
        },
      ],
    }),
    usage: { inputTokens: 120, outputTokens: 80 },
  });
}

describe('PR #1297 P0 regression suite', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let tty;
  let inkInstance;

  before(async () => {
    boxDir = await makeTempDir('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;

    host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: createStubComplete(),
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
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount error during teardown
      }
      await host?.dispose();
      tty?.dispose();
    } finally {
      if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = PREV_DSH_HOME;
      await Promise.all(
        tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
      );
    }
  });

  test('P0 #3 (unit): loadBoardSafe rejects corrupt & non-object tui-board.json without touching disk', async () => {
    const dir = await makeTempDir('board-unit');
    const boardPath = join(dir, 'tui-board.json');

    const missing = await loadBoardSafe(dir);
    assert.equal(missing.ok, true);
    assert.equal(missing.existed, false);

    await writeFile(boardPath, '{broken', 'utf8');
    const corruptRes = await loadBoardSafe(dir);
    assert.equal(corruptRes.ok, false);
    assert.equal(corruptRes.path, boardPath);
    assert.ok(corruptRes.error.length > 0, 'corrupt loadBoardSafe must provide error');
    assert.equal(await readFile(boardPath, 'utf8'), '{broken', 'corrupt file on disk must remain untouched');

    await writeFile(boardPath, '[1, 2, 3]', 'utf8');
    const arrayRes = await loadBoardSafe(dir);
    assert.equal(arrayRes.ok, false);
    assert.equal(await readFile(boardPath, 'utf8'), '[1, 2, 3]', 'non-object JSON must remain untouched');
  });

  test('P0 #4: ReviewView q opens confirmation dialog; cancel preserves round, confirm ends round', async () => {
    tty.send('\r');
    const activeReview = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'review' &&
        !s.includes('正在准备复习队列') &&
        !s.includes('正在加载页面') &&
        !s.includes('本轮练习总结') &&
        !s.includes('Round Summary') &&
        (s.includes('q  结束') || s.includes('q  End') || s.includes('1/')),
      { timeoutMs: 10_000, label: 'ReviewView started from LibraryView' },
    );
    tty.assertHealthyScreen(activeReview, 120, 36, 'ReviewView active question');

    tty.send('q');
    const confirmEnd = await tty.waitFor(
      (s) => s.includes('结束本轮练习') || s.includes('End This Round'),
      { timeoutMs: 6_000, label: 'ReviewView end round ConfirmDialog' },
    );
    assert.ok(
      !confirmEnd.includes('本轮练习总结') && !confirmEnd.includes('Round Summary'),
      'Round must NOT close before confirming q',
    );

    tty.send('n');
    const preservedScreen = await tty.waitFor(
      (s) =>
        !s.includes('结束本轮练习') &&
        !s.includes('End This Round') &&
        useTuiStore.getState().page === 'review',
      { timeoutMs: 6_000, label: 'ReviewView dialog closed on n' },
    );
    assert.ok(
      !preservedScreen.includes('本轮练习总结') && !preservedScreen.includes('Round Summary'),
      'Cancelling q confirmation must stay on active question, not Round Summary',
    );
    tty.assertHealthyScreen(preservedScreen, 120, 36, 'ReviewView preserved after cancel');

    tty.send('q');
    await tty.waitFor(
      (s) => s.includes('结束本轮练习') || s.includes('End This Round'),
      { timeoutMs: 6_000, label: 'ReviewView end round ConfirmDialog (2nd time)' },
    );
    tty.send('y');
    const summaryScreen = await tty.waitFor(
      (s) => s.includes('本轮练习总结') || s.includes('Round Summary') || s.includes('再来一轮'),
      { timeoutMs: 8_000, label: 'RoundSummary rendered after y confirm' },
    );
    tty.assertHealthyScreen(summaryScreen, 120, 36, 'ReviewView RoundSummary');

    tty.send('b');
    await tty.waitFor(
      (s) => useTuiStore.getState().page === 'library' && (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 6_000, label: 'Return to LibraryView from RoundSummary' },
    );
  });

  test('P0 #1: Written Mock Exam calls review.start exactly once and submits cleanly', async () => {
    const originalCall = host.call.bind(host);
    let reviewStartCount = 0;
    host.call = async (action, args) => {
      if (action === 'review.start') reviewStartCount += 1;
      return originalCall(action, args);
    };

    try {
      tty.send('5');
      const setupScreen = await tty.waitFor(
        (s) =>
          (s.includes('组卷设置') || s.includes('Exam Setup')) &&
          (s.includes('1:选择题卷') || s.includes('1:Written MCQ')) &&
          !s.includes('正在加载页面'),
        { timeoutMs: 8_000, label: 'ExamSetup rendered' },
      );
      tty.assertHealthyScreen(setupScreen, 120, 36, 'ExamSetup');

      tty.send('\r');
      const runningScreen = await tty.waitFor(
        (s) =>
          (s.includes('选择题卷') || s.includes('Written MCQ')) &&
          (s.includes('已答 0/') || s.includes('Ans 0/')) &&
          (s.includes('剩余') || s.includes('Left')),
        { timeoutMs: 10_000, label: 'Written exam running' },
      );
      await sleep(150);
      await tty.flush();
      assert.equal(reviewStartCount, 1, `Expected review.start to be called once, got ${reviewStartCount}`);
      tty.assertHealthyScreen(runningScreen, 120, 36, 'Written exam running');

      tty.send('1');
      const pickedScreen = await tty.waitFor(
        (s) => s.includes('已答 1/') || s.includes('Ans 1/'),
        { timeoutMs: 6_000, label: 'Written exam option 1 selected' },
      );
      assert.ok(!pickedScreen.includes('Review has ended'), 'Must not show "Review has ended"');

      tty.send('\x13');
      await tty.waitFor(
        (s) => s.includes('确认交卷') || s.includes('Submit Exam'),
        { timeoutMs: 6_000, label: 'Exam submit ConfirmDialog' },
      );

      tty.send('y');
      const reportScreen = await tty.waitFor(
        (s) =>
          (s.includes('考试成绩单') || s.includes('Exam Report')) &&
          !s.includes('确认交卷') &&
          !s.includes('Submit Exam'),
        { timeoutMs: 10_000, label: 'ExamReportView rendered' },
      );
      assert.ok(
        !reportScreen.includes('Exam has ended without submission'),
        'Must not show "Exam has ended without submission"',
      );
      tty.assertHealthyScreen(reportScreen, 120, 36, 'ExamReportView');

      tty.send('b');
      await tty.waitFor(
        (s) => s.includes('组卷设置') || s.includes('Exam Setup'),
        { timeoutMs: 6_000, label: 'Return from ExamReportView to ExamSetup' },
      );
      tty.send('\x7f');
      await tty.waitFor(
        (s) => useTuiStore.getState().page === 'library' && (s.includes('题组列表') || s.includes('Decks')),
        { timeoutMs: 6_000, label: 'Return to LibraryView after Exam test' },
      );
    } finally {
      host.call = originalCall;
    }
  });

  test('P0 #2: Ctrl+K is blocked on top of ConfirmDialog and cancel preserves deck', async () => {
    const beforeSnap = await host.call('snapshot', {});
    assert.equal(beforeSnap.ok, true);
    const beforeDeckCount = beforeSnap.value?.decks?.length ?? 0;
    assert.ok(beforeDeckCount > 0, 'Expected at least 1 deck in LibraryView');

    tty.send('d');
    const confirmScreen = await tty.waitFor(
      (s) => s.includes('永久删除题组') || s.includes('Delete Deck Permanently'),
      { timeoutMs: 6_000, label: 'LibraryView delete ConfirmDialog opened' },
    );
    tty.assertHealthyScreen(confirmScreen, 120, 36, 'Delete ConfirmDialog');

    tty.send('\x0b');
    await sleep(160);
    await tty.flush();

    assert.equal(
      useTuiStore.getState().commandPaletteOpen,
      false,
      'Ctrl+K must NOT open CommandPalette on top of ConfirmDialog',
    );
    const afterCtrlK = tty.readScreen();
    assert.ok(
      afterCtrlK.includes('永久删除题组') || afterCtrlK.includes('Delete Deck Permanently'),
      'ConfirmDialog must remain visible after Ctrl+K',
    );

    tty.send('n');
    const afterCancel = await tty.waitFor(
      (s) =>
        !s.includes('永久删除题组') &&
        !s.includes('Delete Deck Permanently') &&
        (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 6_000, label: 'ConfirmDialog closed on n' },
    );
    tty.assertHealthyScreen(afterCancel, 120, 36, 'LibraryView after cancel delete');

    const afterSnap = await host.call('snapshot', {});
    assert.equal(afterSnap.ok, true);
    assert.equal(afterSnap.value?.decks?.length ?? 0, beforeDeckCount, 'Deck must still exist after cancelling delete');
  });

  test('P0 #3 (E2E): BoardView shows read-only lock banner and blocks mutations on corrupt tui-board.json', async () => {
    const boardPath = join(libraryRoot, 'tui-board.json');
    await writeFile(boardPath, '{broken', 'utf8');

    tty.send('b');
    const lockedScreen = await tty.waitFor(
      (s) =>
        (s.includes('看板只读锁定') || s.includes('Read-only lock')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'BoardView read-only error banner' },
    );
    tty.assertHealthyScreen(lockedScreen, 120, 36, 'BoardView read-only locked');

    tty.send('a');
    await tty.waitFor(
      (s) =>
        s.includes('看板文件读取失败，已锁定只读防止覆盖原文件') ||
        s.includes('Board file unreadable; read-only lock active'),
      { timeoutMs: 6_000, label: 'BoardView read-only toast on a' },
    );
    assert.equal(
      await readFile(boardPath, 'utf8'),
      '{broken',
      'Pressing a must NOT overwrite corrupt tui-board.json on disk',
    );

    await unlink(boardPath);
    tty.send('r');
    const recoveredScreen = await tty.waitFor(
      (s) => !s.includes('看板只读锁定') && !s.includes('Read-only lock'),
      { timeoutMs: 8_000, label: 'BoardView recovered after r reload' },
    );
    tty.assertHealthyScreen(recoveredScreen, 120, 36, 'BoardView recovered');

    tty.send('1');
    await tty.waitFor(
      (s) => useTuiStore.getState().page === 'library' && (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 6_000, label: 'Return to LibraryView from BoardView' },
    );
  });

  test('P0 #6: LibraryView rolls back deck.archive when deck.remove fails', async () => {
    const snapBefore = await host.call('snapshot', {});
    assert.equal(snapBefore.ok, true);
    const targetDeck = (snapBefore.value?.decks ?? []).find((d) => !d.archived);
    assert.ok(targetDeck, 'Expected an unarchived deck in LibraryView');

    const originalCall = host.call.bind(host);
    const archiveCalls = [];
    host.call = async (action, args) => {
      if (action === 'deck.archive') {
        archiveCalls.push({ id: args?.id, archived: args?.archived });
      }
      if (action === 'deck.remove') {
        return { ok: false, error: { message: 'simulated remove failure' } };
      }
      return originalCall(action, args);
    };

    try {
      tty.send('d');
      await tty.waitFor(
        (s) => s.includes('永久删除题组') || s.includes('Delete Deck Permanently'),
        { timeoutMs: 6_000, label: 'LibraryView delete ConfirmDialog for rollback test' },
      );

      tty.send('y');
      await tty.waitFor(
        () =>
          useTuiStore
            .getState()
            .toasts.some(
              (toast) =>
                toast.text.includes('已自动恢复未归档状态') ||
                toast.text.includes('restored deck from archive'),
            ),
        { timeoutMs: 8_000, label: 'LibraryView archive-delete rollback toast' },
      );

      assert.deepEqual(
        archiveCalls,
        [
          { id: targetDeck.id, archived: true },
          { id: targetDeck.id, archived: false },
        ],
        'Expected deck.archive(true) followed by rollback deck.archive(false)',
      );

      const snapAfter = await host.call('snapshot', {});
      assert.equal(snapAfter.ok, true);
      const afterDeck = (snapAfter.value?.decks ?? []).find((d) => d.id === targetDeck.id);
      assert.ok(afterDeck, 'Target deck must still exist');
      assert.ok(!afterDeck.archived, 'Target deck must be restored to unarchived state');
    } finally {
      host.call = originalCall;
    }
  });

  test('P0 #7: DeckManageModal guards unpublished edit drafts; DraftEditor x confirms and u undoes removal', async () => {
    const snapBefore = await host.call('snapshot', {});
    assert.equal(snapBefore.ok, true);
    const targetDeck = (snapBefore.value?.decks ?? []).find((d) => !d.archived && (d.cardCount ?? 0) >= 2)
      ?? (snapBefore.value?.decks ?? []).find((d) => !d.archived);
    assert.ok(targetDeck, 'Expected an unarchived deck with cards');

    const editRes = await host.call('deck.edit', { id: targetDeck.id });
    assert.equal(editRes.ok, true, `deck.edit failed: ${editRes.error?.message}`);
    const editDraftId = editRes.value?.id;
    assert.ok(editDraftId, 'deck.edit must return draft id');

    const refreshed = await host.call('snapshot', {});
    assert.equal(refreshed.ok, true);
    useTuiStore.getState().setSnapshot(refreshed.value);
    await tty.waitFor(
      () => (useTuiStore.getState().snapshot?.drafts ?? []).some((d) => d.id === editDraftId),
      { timeoutMs: 8_000, label: 'Edit draft synced to store snapshot' },
    );

    const originalCall = host.call.bind(host);
    let quickPublishCalls = 0;
    host.call = async (action, args) => {
      if (action === 'draft.publish.quick') quickPublishCalls += 1;
      return originalCall(action, args);
    };

    try {
      tty.send('m');
      await tty.waitFor(
        (s) =>
          (s.includes('题组管理') || s.includes('Manage Deck')) &&
          !s.includes('正在读取题组卡片') &&
          !s.includes('Loading deck cards'),
        { timeoutMs: 8_000, label: 'DeckManageModal opened' },
      );

      tty.send('n');
      await tty.waitFor(
        (s) => s.includes('输入新题组标题') || s.includes('New deck title'),
        { timeoutMs: 6_000, label: 'DeckManageModal rename input opened' },
      );

      tty.send(' X');
      await tty.flush();
      tty.send('\r');

      await tty.waitFor(
        () =>
          useTuiStore
            .getState()
            .toasts.some(
              (toast) =>
                toast.text.includes('该题组已有未发布的编辑草稿') ||
                toast.text.includes('unpublished edit draft'),
            ),
        { timeoutMs: 6_000, label: 'DeckManageModal edit-draft guard warning toast' },
      );

      assert.equal(quickPublishCalls, 0, 'draft.publish.quick must NOT be called when edit draft exists');
      const snapGuard = await host.call('snapshot', {});
      assert.equal(snapGuard.ok, true);
      assert.ok(
        (snapGuard.value?.drafts ?? []).some((d) => d.id === editDraftId),
        'Edit draft must remain unpublished',
      );
      const deckAfterGuard = (snapGuard.value?.decks ?? []).find((d) => d.id === targetDeck.id);
      assert.equal(deckAfterGuard?.title, targetDeck.title, 'Deck title must remain unchanged');

      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('题组管理') && !s.includes('Manage Deck'),
        { timeoutMs: 6_000, label: 'DeckManageModal closed' },
      );
    } finally {
      host.call = originalCall;
    }

    // DraftEditor: open GenerateView (3) -> Drafts tab (Tab) on that edit draft
    const draftBefore = await host.call('draft.get', { id: editDraftId });
    assert.equal(draftBefore.ok, true);
    const initialCount = draftBefore.value?.cards?.length ?? 0;
    assert.ok(initialCount >= 2, `Expected edit draft to have >= 2 cards, got ${initialCount}`);

    tty.send('3');
    await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'generate' &&
        (s.includes('新建出题任务') || s.includes('New Generation')) &&
        !s.includes('正在加载页面'),
      { timeoutMs: 8_000, label: 'GenerateView rendered' },
    );

    tty.send('\t');
    await tty.waitFor(
      (s) => (s.includes('题目列表') || s.includes('Draft Cards')) && !s.includes('加载草稿'),
      { timeoutMs: 8_000, label: 'DraftEditor tab opened' },
    );

    const draftsOrder = useTuiStore.getState().snapshot?.drafts ?? [];
    const editDraftIdx = draftsOrder.findIndex((d) => d.id === editDraftId);
    assert.ok(editDraftIdx >= 0, 'editDraftId must be in snapshot.drafts');
    if (editDraftIdx > 0) {
      tty.send('d');
      await tty.waitFor(
        (s) => s.includes('选择草稿') || s.includes('Select Draft'),
        { timeoutMs: 6_000, label: 'Draft switcher modal opened' },
      );
      for (let step = 0; step < editDraftIdx; step += 1) {
        tty.send('j');
        await tty.flush();
      }
      tty.send('\r');
    }

    const draftScreen = await tty.waitFor(
      (s) =>
        (s.includes('题目列表') || s.includes('Draft Cards')) &&
        !s.includes('加载草稿') &&
        !s.includes('选择草稿') &&
        (s.includes(`${initialCount} 题`) || s.includes(`${initialCount} cards`)),
      { timeoutMs: 8_000, label: 'DraftEditor loaded edit draft' },
    );
    tty.assertHealthyScreen(draftScreen, 120, 36, 'DraftEditor loaded');

    tty.send('x');
    const removeConfirmScreen = await tty.waitFor(
      (s) => s.includes('移除草稿题目') || s.includes('Remove Draft Card'),
      { timeoutMs: 6_000, label: 'DraftEditor x ConfirmDialog' },
    );
    tty.assertHealthyScreen(removeConfirmScreen, 120, 36, 'DraftEditor remove ConfirmDialog');

    tty.send('y');
    const afterRemoveScreen = await tty.waitFor(
      (s) =>
        !s.includes('移除草稿题目') &&
        !s.includes('Remove Draft Card') &&
        (s.includes(`${initialCount - 1} 题`) || s.includes(`${initialCount - 1} cards`)) &&
        (s.includes('u  撤销删题') || s.includes('u  Undo')),
      { timeoutMs: 8_000, label: 'DraftEditor card removed after y' },
    );
    tty.assertHealthyScreen(afterRemoveScreen, 120, 36, 'DraftEditor after remove');

    const draftMid = await host.call('draft.get', { id: editDraftId });
    assert.equal(draftMid.value?.cards?.length, initialCount - 1, 'Card count must drop by 1');

    tty.send('u');
    const afterUndoScreen = await tty.waitFor(
      (s) => s.includes(`${initialCount} 题`) || s.includes(`${initialCount} cards`),
      { timeoutMs: 8_000, label: 'DraftEditor card restored after u' },
    );
    tty.assertHealthyScreen(afterUndoScreen, 120, 36, 'DraftEditor after u undo');

    const draftRestored = await host.call('draft.get', { id: editDraftId });
    assert.equal(draftRestored.value?.cards?.length, initialCount, 'Card count must be restored after u');

    tty.send('1');
    await tty.waitFor(
      (s) => useTuiStore.getState().page === 'library' && (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 6_000, label: 'Return to LibraryView from DraftEditor' },
    );
  });

  test('P0 #5: TasksView warns instead of claiming removal when job.delete skips a running job', async () => {
    const snapRes = await host.call('snapshot', {});
    assert.equal(snapRes.ok, true);
    const activeSource = (snapRes.value?.sources ?? []).find((s) => !s.archived) ?? snapRes.value?.sources?.[0];
    assert.ok(activeSource, 'Expected an active sample source');
    const activeCourse = activeSource.course || activeSource.courses?.[0] || '示例 · Memento 与 Bridge';

    const genRes = await host.call('generate', {
      course: activeCourse,
      sourceIds: [activeSource.id],
      count: 2,
      kind: 'quiz',
      title: 'P0 Running Job',
    });
    assert.equal(genRes.ok, true, `generate failed: ${genRes.error?.message}`);

    const refreshedJobSnap = await host.call('snapshot', {});
    assert.equal(refreshedJobSnap.ok, true);
    useTuiStore.getState().setSnapshot(refreshedJobSnap.value);
    await tty.flush();
    tty.send('t');
    const tasksScreen = await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'tasks' &&
        (s.includes('监控后台任务') || s.includes('Monitor jobs')) &&
        s.includes('P0 Running Job') &&
        !s.includes('正在加载页面'),
      { timeoutMs: 10_000, label: 'TasksView showing P0 Running Job' },
    );
    tty.assertHealthyScreen(tasksScreen, 120, 36, 'TasksView populated');

    const originalCall = host.call.bind(host);
    let deleteIntercepted = false;
    host.call = async (action, args) => {
      if (action === 'job.dismiss') {
        return { ok: false, error: { message: 'running job cannot be dismissed' } };
      }
      if (action === 'job.delete') {
        deleteIntercepted = true;
        const jobIds = Array.isArray(args?.jobIds) ? args.jobIds : [];
        return {
          ok: true,
          value: {
            deleted: [],
            skipped: jobIds.map((id) => ({ id, reason: 'running' })),
            missing: [],
          },
        };
      }
      return originalCall(action, args);
    };

    try {
      tty.send('d');
      await tty.waitFor(
        (s) => s.includes('删除任务记录') || s.includes('Dismiss Job'),
        { timeoutMs: 6_000, label: 'TasksView delete ConfirmDialog' },
      );

      tty.send('y');
      await tty.waitFor(
        () =>
          useTuiStore
            .getState()
            .toasts.some(
              (toast) =>
                toast.text.includes('运行中的任务无法直接删除') ||
                toast.text.includes('Running job cannot be removed'),
            ),
        { timeoutMs: 6_000, label: 'TasksView running-job skipped warning toast' },
      );

      assert.equal(deleteIntercepted, true, 'Expected job.delete to be invoked');
      const toasts = useTuiStore.getState().toasts;
      assert.equal(
        toasts.some((toast) => toast.text.includes('任务记录已移除') || toast.text.includes('Job removed')),
        false,
        'Must NOT claim job removed when skipped',
      );
      const warningToast = toasts.find(
        (toast) =>
          toast.text.includes('运行中的任务无法直接删除') ||
          toast.text.includes('Running job cannot be removed'),
      );
      assert.equal(warningToast?.tone, 'warning', 'Skipped running job toast must have warning tone');
    } finally {
      host.call = originalCall;
    }

    tty.send('\x7f');
    await tty.waitFor(
      (s) => useTuiStore.getState().page === 'library' && (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 6_000, label: 'Return to LibraryView from TasksView' },
    );
  });
});
