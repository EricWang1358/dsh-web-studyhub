// Consolidated PR #1297 P0/P1/P2/P3 regression suite: node --test tests/pr1297-regressions.test.mjs
import assert from 'node:assert/strict';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { tsImport } from 'tsx/esm/api';
import {
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');

const storeFile = (await readdir(distDir)).find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore } = await import(pathToFileURL(join(distDir, storeFile)).href);
assert.ok(useTuiStore, 'dist/ must export useTuiStore');

const appCode = await readFile(join(distDir, 'App.mjs'), 'utf8');
const cjkImport = appCode.match(/import\s*\{[^}]*\bdisplayWidth\b[^}]*\}\s*from\s*["'](\.\/[^"']+\.mjs)["']/);
assert.ok(cjkImport, 'dist/App.mjs must import displayWidth');
const { displayWidth } = await import(pathToFileURL(resolve(distDir, cjkImport[1])).href);
assert.ok(displayWidth, 'dist/ must export displayWidth');

const [boardStoreMod, examUtilsMod, shellDataMod, sourceHelpersMod] = await Promise.all([
  tsImport('../src/views/board/board-store.ts', import.meta.url),
  tsImport('../src/views/exam/utils.ts', import.meta.url),
  tsImport('../src/shell/data.ts', import.meta.url),
  tsImport('../src/views/sources/source-helpers.ts', import.meta.url),
]);
const { loadBoardSafe } = boardStoreMod;
const { buildScopeChoices } = examUtilsMod;
const { dueToday, wrongCount } = shellDataMod;
const { groupSourcesFromSnapshot } = sourceHelpersMod;
assert.equal(typeof loadBoardSafe, 'function', 'board-store must export loadBoardSafe');

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-tui-pr1297-');

function assertScreenHealthy(tty, screen, expectedCols, expectedRows, contextLabel) {
  tty.assertHealthyScreen(screen, expectedCols, expectedRows, contextLabel);
  const lines = screen.split('\n');
  assert.ok(lines.length <= expectedRows, `${contextLabel}: Row count ${lines.length} > ${expectedRows}`);
  assert.ok(!/\bNaN\b/.test(screen), `${contextLabel}: Raw NaN leaked\n${screen}`);
  assert.ok(!/\bundefined\b/.test(screen), `${contextLabel}: Raw undefined leaked\n${screen}`);
  assert.ok(!screen.includes('[object Object]'), `${contextLabel}: [object Object] leaked\n${screen}`);
  assert.ok(!screen.includes('\uFFFD'), `${contextLabel}: Replacement char U+FFFD found!\n${screen}`);
  assert.ok(!screen.includes('\u001b'), `${contextLabel}: Unparsed escape sequence leaked!\n${screen}`);
  for (let i = 0; i < lines.length; i += 1) {
    const w = displayWidth(lines[i]);
    assert.ok(
      w <= expectedCols,
      `${contextLabel}: Row ${i} exceeds cols (${w} > ${expectedCols}): ${JSON.stringify(lines[i])}`,
    );
  }
  const buf = tty.term.buffer.active;
  for (let y = 0; y < tty.term.rows; y += 1) {
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

function createStubComplete(onModelCall) {
  return async (_system, prompt) => {
    if (String(prompt || '').includes('OK?')) return 'OK';
    onModelCall();
    return {
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
    };
  };
}

describe('PR #1297 P0, P1 & P2 regression suite', () => {
  let boxDir;
  let dshHome;
  let libraryRoot;
  let host;
  let tty;
  let inkInstance;
  let modelCallCount = 0;

  before(async () => {
    boxDir = await temps.make('main');
    dshHome = join(boxDir, 'dsh-home');
    libraryRoot = join(boxDir, 'library');
    process.env.DSH_HOME = dshHome;

    host = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      injectedComplete: createStubComplete(() => {
        modelCallCount += 1;
      }),
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
      disposeTerminalPool();
    } finally {
      if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = PREV_DSH_HOME;
      await temps.cleanup();
    }
  });

  test('P0 #3 (unit): loadBoardSafe rejects corrupt & non-object tui-board.json without touching disk', async () => {
    const dir = await temps.make('board-unit');
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
        !s.includes('示例案例 · 墨笺笔记') &&
        !s.includes('正在准备复习队列') &&
        !s.includes('正在加载页面') &&
        !s.includes('本轮练习总结') &&
        !s.includes('Round Summary') &&
        (s.includes('q  结束') || s.includes('q  End') || s.includes('AI讲解') || s.includes('AI Tutor')),
      { timeoutMs: 10_000, label: 'ReviewView started from LibraryView' },
    );
    assertScreenHealthy(tty, activeReview, 120, 36, 'ReviewView active question');

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
        useTuiStore.getState().page === 'review' &&
        (s.includes('q  结束') || s.includes('q  End') || s.includes('AI讲解') || s.includes('AI Tutor')),
      { timeoutMs: 6_000, label: 'ReviewView dialog closed on n' },
    );
    assert.ok(
      !preservedScreen.includes('本轮练习总结') && !preservedScreen.includes('Round Summary'),
      'Cancelling q confirmation must stay on active question, not Round Summary',
    );
    assertScreenHealthy(tty, preservedScreen, 120, 36, 'ReviewView preserved after cancel');

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
    assert.match(summaryScreen, /本轮练习总结|Round Summary|再来一轮/);
    assertScreenHealthy(tty, summaryScreen, 120, 36, 'ReviewView RoundSummary');

    tty.send('b');
    await tty.waitFor(
      (s) => useTuiStore.getState().page === 'library' && (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 6_000, label: 'Return to LibraryView from RoundSummary' },
    );
  });

  test('P3 #24: FSRS review rating persists attempt, today, and progress to disk', async () => {
    const snapBefore = await host.call('snapshot', {});
    assert.equal(snapBefore.ok, true);
    const beforeAttempts = snapBefore.value?.attempts?.length ?? 0;
    const beforeReviewed = Number(snapBefore.value?.today?.reviewed ?? 0);

    tty.send('\r');
    await tty.waitFor(
      (s) =>
        useTuiStore.getState().page === 'review' &&
        !s.includes('正在准备复习队列') &&
        !s.includes('正在加载页面') &&
        (s.includes('按 [Space] 或 [Enter] 翻开答案') || s.includes('Press [Space] or [Enter] to flip card')),
      { timeoutMs: 10_000, label: 'ReviewView card 1 rendered' },
    );

    tty.send(' ');
    await tty.waitFor(
      (s) => s.includes('答案与解析') && (s.includes('重来') || s.includes('Again')),
      { timeoutMs: 8_000, label: 'ReviewView card 1 revealed' },
    );

    tty.send('5');
    await tty.waitFor(
      (s) => s.includes('2/9') || s.includes('本轮练习总结') || s.includes('Round Summary'),
      { timeoutMs: 8_000, label: 'ReviewView advanced after FSRS grade 5' },
    );

    const snapAfter = await host.call('snapshot', {});
    assert.equal(snapAfter.ok, true);
    assert.ok(
      (snapAfter.value?.attempts?.length ?? 0) > beforeAttempts,
      `Expected attempts count > ${beforeAttempts}, got ${snapAfter.value?.attempts?.length ?? 0}`,
    );
    const afterReviewed = Number(snapAfter.value?.today?.reviewed ?? snapAfter.value?.today?.done ?? 0);
    assert.ok(
      afterReviewed >= beforeReviewed + 1 || (snapAfter.value?.attempts?.length ?? 0) > beforeAttempts,
      `Expected today progress or attempts to increment (before=${beforeReviewed}, after=${afterReviewed})`,
    );
    assert.ok(
      Object.keys(snapAfter.value?.progress ?? {}).length > 0,
      'Expected snapshot.progress to be populated',
    );

    const workspaceRaw = JSON.parse(await readFile(join(libraryRoot, 'study-workspace.json'), 'utf8'));
    const inlineAttempts = Array.isArray(workspaceRaw.attempts) ? workspaceRaw.attempts.length : 0;
    const attemptShards = workspaceRaw.collections?.attempts ?? workspaceRaw.shards?.attempts ?? [];
    assert.ok(
      inlineAttempts > beforeAttempts || attemptShards.length > 0,
      'Expected persisted attempts in study-workspace.json or its shards',
    );

    // Verify a fresh host opening the same libraryRoot reads the persisted attempt from disk
    const freshHost = await createTuiHost({
      env: { DSH_HOME: dshHome },
      home: join(boxDir, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
    });
    try {
      const freshSnap = await freshHost.call('snapshot', {});
      assert.equal(freshSnap.ok, true);
      assert.ok(
        (freshSnap.value?.attempts?.length ?? 0) > beforeAttempts,
        'Fresh host must load persisted attempts from disk',
      );
    } finally {
      await freshHost.dispose();
    }

    // Exit review back to LibraryView
    tty.send('q');
    await tty.waitFor(
      (s) => s.includes('结束本轮练习') || s.includes('End This Round'),
      { timeoutMs: 6_000, label: 'ReviewView quit ConfirmDialog' },
    );
    tty.send('y');
    await tty.waitFor(
      (s) => s.includes('本轮练习总结') || s.includes('Round Summary'),
      { timeoutMs: 8_000, label: 'RoundSummary rendered' },
    );
    tty.send('b');
    await tty.waitFor(
      (s) => useTuiStore.getState().page === 'library' && (s.includes('题组列表') || s.includes('Decks')),
      { timeoutMs: 6_000, label: 'Return to LibraryView after FSRS persistence test' },
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
      assertScreenHealthy(tty, setupScreen, 120, 36, 'ExamSetup');

      tty.send('\r');
      const runningScreen = await tty.waitFor(
        (s) =>
          (s.includes('选择题卷') || s.includes('Written MCQ')) &&
          (s.includes('已答 0/') || s.includes('Ans 0/')) &&
          (s.includes('剩余') || s.includes('Left')),
        { timeoutMs: 10_000, label: 'Written exam running' },
      );
      await tty.flush();
      assert.equal(reviewStartCount, 1, `Expected review.start to be called once, got ${reviewStartCount}`);
      assertScreenHealthy(tty, runningScreen, 120, 36, 'Written exam running');

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
      assertScreenHealthy(tty, reportScreen, 120, 36, 'ExamReportView');

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
    assertScreenHealthy(tty, confirmScreen, 120, 36, 'Delete ConfirmDialog');

    tty.send('\x0b');
    await tty.flush(40);

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
    assertScreenHealthy(tty, afterCancel, 120, 36, 'LibraryView after cancel delete');

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
    assertScreenHealthy(tty, lockedScreen, 120, 36, 'BoardView read-only locked');

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
    assertScreenHealthy(tty, recoveredScreen, 120, 36, 'BoardView recovered');

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
    const targetDeck =
      (snapBefore.value?.decks ?? []).find((d) => !d.archived && (d.cardCount ?? 0) >= 2) ??
      (snapBefore.value?.decks ?? []).find((d) => !d.archived);
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
      assert.ok(deckAfterGuard?.id === targetDeck.id, 'Target deck id must remain intact');

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
    assertScreenHealthy(tty, draftScreen, 120, 36, 'DraftEditor loaded');

    tty.send('x');
    const removeConfirmScreen = await tty.waitFor(
      (s) => s.includes('移除草稿题目') || s.includes('Remove Draft Card'),
      { timeoutMs: 6_000, label: 'DraftEditor x ConfirmDialog' },
    );
    assertScreenHealthy(tty, removeConfirmScreen, 120, 36, 'DraftEditor remove ConfirmDialog');

    tty.send('y');
    const afterRemoveScreen = await tty.waitFor(
      (s) =>
        !s.includes('移除草稿题目') &&
        !s.includes('Remove Draft Card') &&
        (s.includes(`${initialCount - 1} 题`) || s.includes(`${initialCount - 1} cards`)) &&
        (s.includes('u  撤销删题') || s.includes('u  Undo')),
      { timeoutMs: 8_000, label: 'DraftEditor card removed after y' },
    );
    assertScreenHealthy(tty, afterRemoveScreen, 120, 36, 'DraftEditor after remove');

    const draftMid = await host.call('draft.get', { id: editDraftId });
    assert.equal(draftMid.value?.cards?.length, initialCount - 1, 'Card count must drop by 1');

    tty.send('u');
    const afterUndoScreen = await tty.waitFor(
      (s) => s.includes(`${initialCount} 题`) || s.includes(`${initialCount} cards`),
      { timeoutMs: 8_000, label: 'DraftEditor card restored after u' },
    );
    assertScreenHealthy(tty, afterUndoScreen, 120, 36, 'DraftEditor after u undo');

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
    assertScreenHealthy(tty, tasksScreen, 120, 36, 'TasksView populated');

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

  test('P1 #2: buildScopeChoices(oral) returns sample choices and wrongCount/dueToday read d.wrong/d.due', async () => {
    const snapRes = await host.call('snapshot', {});
    assert.equal(snapRes.ok, true);
    const snap = snapRes.value;

    const oralChoices = buildScopeChoices(snap, 'oral', 'zh');
    assert.ok(oralChoices.length > 0, 'Expected buildScopeChoices(snap, "oral", "zh") to return choices for sample course');
    const deckChoices = oralChoices.filter((c) => c.id.startsWith('deck:'));
    assert.ok(deckChoices.length > 0, 'Expected per-deck oral scope choices with count > 0');

    const syntheticSnap = {
      decks: [
        { id: 'd1', title: 'Deck 1', count: 10, due: 4, wrong: 3, archived: false },
        { id: 'd2', title: 'Deck 2', count: 5, due: 2, wrong: 1, archived: false },
        { id: 'd3', title: 'Archived', count: 8, due: 7, wrong: 9, archived: true },
      ],
    };
    assert.equal(wrongCount(syntheticSnap), 4, 'wrongCount must sum d.wrong for unarchived decks');
    assert.equal(dueToday(syntheticSnap), 6, 'dueToday fallback must sum d.due for unarchived decks');
    assert.equal(dueToday({ ...syntheticSnap, today: { due: 9 } }), 9, 'dueToday prefers snapshot.today.due');
  });

  test('P1 #16: groupSourcesFromSnapshot excludes historical, examPointList, and courseOutline sources', () => {
    const groups = groupSourcesFromSnapshot({
      sources: [
        { id: 'src-normal', title: 'Lecture 1.md', course: 'CS101', text: 'Core material content' },
        { id: 'src-hist', title: 'Lecture 1 (old)', course: 'CS101', historical: true, text: 'Old version' },
        {
          id: 'src-epl',
          title: 'Exam Point List',
          course: 'CS101',
          provenance: 'exam-blueprint',
          blueprint: { points: [{ title: 'P1' }] },
        },
        {
          id: 'src-outline',
          title: 'Course Outline',
          course: 'CS101',
          provenance: 'course-outline',
          courseOutline: { version: 1, nodes: [] },
        },
      ],
    });
    assert.equal(groups.length, 1, 'Only non-historical, non-library-list sources should remain');
    assert.deepEqual(groups[0].sourceIds, ['src-normal']);
  });

  test('P1 #18: DeckOpsModal & deck.import accept single-backslash LaTeX JSON', async () => {
    const latexDir = await temps.make('latex');
    const latexPath = join(latexDir, 'latex-single-backslash.json');
    const rawJsonWithSingleBackslash =
      '{"title":"LaTeX Single Backslash","course":"Math 101","cards":[{"kind":"quiz","topic":"Calculus","prompt":"Compute \\(\\alpha + \\frac{1}{2}\\)","options":[{"id":"a","text":"\\(\\alpha\\)","correct":true},{"id":"b","text":"0","correct":false}],"explanation":"Formula \\(\\alpha\\)"}]}';
    await writeFile(latexPath, rawJsonWithSingleBackslash, 'utf8');

    // Verify raw text is invalid standard JSON without TeX escape repair
    assert.throws(() => JSON.parse(rawJsonWithSingleBackslash), SyntaxError);

    // 1) Ensure we are on LibraryView and drive DeckOpsModal UI import in @xterm/headless
    if (useTuiStore.getState().page !== 'library') {
      tty.send('1');
      await tty.waitFor(
        (s) => useTuiStore.getState().page === 'library' && (s.includes('题组列表') || s.includes('Decks')),
        { timeoutMs: 6_000, label: 'LibraryView active before DeckOpsModal' },
      );
    }
    tty.send('o');
    await tty.waitFor(
      (s) => s.includes('本地题组 JSON 路径') || s.includes('Local JSON Path'),
      { timeoutMs: 6_000, label: 'DeckOpsModal Import tab opened' },
    );

    tty.send(latexPath);
    await tty.waitFor(
      (s) => s.includes('1 题') || s.includes('1 cards') || s.includes('1题'),
      { timeoutMs: 6_000, label: 'DeckOpsModal previewed single-backslash LaTeX JSON' },
    );

    tty.send('\r');
    await tty.waitFor(
      (s) => !s.includes('本地题组 JSON 路径') && !s.includes('Local JSON Path'),
      { timeoutMs: 8_000, label: 'DeckOpsModal closed after LaTeX import' },
    );

    const snapAfterUi = await host.call('snapshot', {});
    assert.equal(snapAfterUi.ok, true);
    const importedDeck = (snapAfterUi.value?.decks ?? []).find((d) => d.title === 'LaTeX Single Backslash');
    assert.ok(importedDeck, 'Deck imported via DeckOpsModal must appear in snapshot');
    assert.equal(importedDeck.title, 'LaTeX Single Backslash');

    // 2) Also verify direct host.call('deck.import') accepts single-backslash LaTeX JSON
    const latexPath2 = join(latexDir, 'latex-direct.json');
    const rawJson2 =
      '{"title":"LaTeX Direct Import","course":"Math 101","cards":[{"kind":"quiz","topic":"Algebra","prompt":"Solve \\(\\beta = 1\\)","options":[{"id":"a","text":"1","correct":true},{"id":"b","text":"2","correct":false}],"explanation":"Direct \\(\\beta\\)"}]}';
    await writeFile(latexPath2, rawJson2, 'utf8');
    const directRes = await host.call('deck.import', { path: latexPath2 });
    assert.equal(directRes.ok, true, `deck.import failed: ${directRes.error?.message}`);
    assert.ok(
      Number(directRes.value?.added ?? directRes.value?.imported ?? directRes.value?.cards?.length ?? 1) >= 1,
      'Expected direct LaTeX JSON import to succeed',
    );
  });

  test('P2 confirm guards: ExamPrepView (0 -> g) and SkeletonView (8 -> g) open ConfirmDialog without calling model', async () => {
    const snapRes = await host.call('snapshot', {});
    assert.equal(snapRes.ok, true);
    const activeCourse =
      snapRes.value?.focus?.course ||
      (snapRes.value?.courses?.[0]?.name ?? snapRes.value?.courses?.[0]?.id ?? '示例 · Memento 与 Bridge');

    // Seed a missing focus topic so ExamPrepView 'g' opens the gap-fill ConfirmDialog
    const saveRes = await host.call('course.save', {
      name: activeCourse,
      focusTopics: ['Unseen Focus Gap Topic'],
    });
    assert.equal(saveRes.ok, true, `course.save failed: ${saveRes.error?.message}`);

    const refreshed = await host.call('snapshot', {});
    assert.equal(refreshed.ok, true);
    useTuiStore.getState().setSnapshot(refreshed.value);

    const originalCall = host.call.bind(host);
    let generateCalls = 0;
    host.call = async (action, args) => {
      if (action === 'generate') generateCalls += 1;
      return originalCall(action, args);
    };
    const modelBefore = modelCallCount;

    try {
      // 1) ExamPrepView (0 -> g)
      tty.send('0');
      const prepScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'examprep' &&
          (s.includes('备考补习') || s.includes('Exam Prep')) &&
          s.includes('Unseen Focus Gap Topic') &&
          !s.includes('正在加载'),
        { timeoutMs: 10_000, label: 'ExamPrepView rendered with missing focus topic' },
      );
      assertScreenHealthy(tty, prepScreen, 120, 36, 'ExamPrepView initial');

      tty.send('g');
      const prepConfirm = await tty.waitFor(
        (s) =>
          (s.includes('确认重点补齐出题') || s.includes('Confirm Gap-Fill Generation')) &&
          s.includes('(y)') &&
          s.includes('(n)'),
        { timeoutMs: 6_000, label: 'ExamPrepView g ConfirmDialog' },
      );
      assertScreenHealthy(tty, prepConfirm, 120, 36, 'ExamPrepView g ConfirmDialog');
      assert.match(prepConfirm, /\(y\)/);
      assert.equal(generateCalls, 0, 'ExamPrepView g must NOT call generate before confirmation');
      assert.equal(modelCallCount, modelBefore, 'ExamPrepView g must NOT call model before confirmation');

      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('确认重点补齐出题') && !s.includes('Confirm Gap-Fill Generation'),
        { timeoutMs: 6_000, label: 'ExamPrepView ConfirmDialog dismissed with n' },
      );
      assert.equal(generateCalls, 0, 'ExamPrepView cancel must NOT call generate');

      // 2) SkeletonView (8 -> g)
      tty.send('8');
      const skelScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'skeleton' &&
          (s.includes('知识层级树') || s.includes('Knowledge Tree') || s.includes('课程主题预览')) &&
          !s.includes('正在加载'),
        { timeoutMs: 10_000, label: 'SkeletonView rendered' },
      );
      assertScreenHealthy(tty, skelScreen, 120, 36, 'SkeletonView initial');

      tty.send('g');
      const skelConfirm = await tty.waitFor(
        (s) =>
          (s.includes('确认生成知识骨架') || s.includes('Confirm Skeleton Generation')) &&
          s.includes('(y)') &&
          s.includes('(n)'),
        { timeoutMs: 6_000, label: 'SkeletonView g ConfirmDialog' },
      );
      assertScreenHealthy(tty, skelConfirm, 120, 36, 'SkeletonView g ConfirmDialog');
      assert.match(skelConfirm, /\(y\)/);
      assert.equal(modelCallCount, modelBefore, 'SkeletonView g must NOT invoke model before confirmation');

      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('确认生成知识骨架') && !s.includes('Confirm Skeleton Generation'),
        { timeoutMs: 6_000, label: 'SkeletonView ConfirmDialog dismissed with n' },
      );
      assert.equal(modelCallCount, modelBefore, 'SkeletonView cancel must NOT invoke model');

      tty.send('1');
      await tty.waitFor(
        (s) => useTuiStore.getState().page === 'library' && (s.includes('题组列表') || s.includes('Decks')),
        { timeoutMs: 6_000, label: 'Return to LibraryView' },
      );
    } finally {
      host.call = originalCall;
    }
  });
});
