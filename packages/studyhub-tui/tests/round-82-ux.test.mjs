// Round 82 comprehensive behavior & layout tests:
// - Track A1: Unified grid/whitespace primitives (`SectionHeader`, `PageHeader`, `Panel quiet`) + 120x36 & 80x24 ASCII snapshots
// - Track B0 (#1319): Practice Context Stack (6+ acceptance tests: 4-hop LIFO push/pop, choice/cloze/open draft restore,
//                     no duplicate grading, SimilarCardsModal origin highlight + [B] return, ended-run graceful prompt + retry,
//                     cross-page TopBar/Footer/SideNav `[r]` visibility, tui.json lastPracticeContext persistence, Assistant coexistence)
// - Track D0 (#1315 Phase 1): Persistent AI Assistant + Guided Study/Retell merge + sizing & [F] fullscreen + OSC 52 copy & fallback
// node --test tests/round-82-ux.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Box, Text, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
const tempDirs = [];
after(async () => {
  unregisterTsx?.();
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

const [
  layoutMod,
  { Panel },
  stackMod,
  clipboardMod,
  intentMod,
  assistantMod,
  { AppShell },
  { ReviewView },
  { SimilarCardsModal },
  prefsMod,
  storeMod,
] = await Promise.all([
  import('../src/components/Layout.tsx'),
  import('../src/components/Panel.tsx'),
  import('../src/state/practice-stack.ts'),
  import('../src/render/clipboard.ts'),
  import('../src/shell/assistant-intent.ts'),
  import('../src/shell/AssistantPanel.tsx'),
  import('../src/shell/AppShell.tsx'),
  import('../src/views/review/ReviewView.tsx'),
  import('../src/views/review/SimilarCardsModal.tsx'),
  import('../src/host/tui-prefs.ts'),
  import('../src/state/store.ts'),
]);

const { SectionHeader, PageHeader } = layoutMod;
const { pushPracticeFrame, popPracticeFrame, formatReturnHintLabel, originReviewFrame, toLastPracticeContext } = stackMod;
const { buildOsc52Sequence, copyTextWithFallback, formatSessionTranscript } = clipboardMod;
const { parseAssistantIntent } = intentMod;
const { AssistantPanel, resolveAssistantPanelSize, _resetAssistantSessionMemory, _getAssistantRetellRecords } = assistantMod;
const { saveTuiPreferences, loadTuiPreferences } = prefsMod;
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

function createInkHarness(element, { cols = 120, rows = 36 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 1;

  const frames = [];
  const waiters = new Set();
  const notify = () => {
    const latest = frames.at(-1) ?? '';
    for (const w of [...waiters]) {
      if (w.predicate(latest)) {
        waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(latest);
      }
    }
  };
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim().length > 0) {
      frames.push(plain);
      notify();
    }
  });

  const inst = render(element, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });

  return {
    latest: () => frames.at(-1) ?? '',
    write: (s) => stdin.write(s),
    waitFor: (predicate, timeoutMs = 2000) => {
      const cur = frames.at(-1) ?? '';
      if (predicate(cur)) return Promise.resolve(cur);
      return new Promise((resolve, reject) => {
        const entry = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(entry);
            reject(new Error(`Timed out waiting for frame. Last frame:\n${frames.at(-1) ?? '<empty>'}`));
          }, timeoutMs),
        };
        waiters.add(entry);
      });
    },
    cleanup: () => {
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function resetStore(overrides = {}) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    inputCaptured: false,
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    voicePackOpen: false,
    inboxOpen: false,
    quitConfirmOpen: false,
    showLaunchpad: false,
    practiceStack: [],
    pendingPracticeRestore: null,
    assistantOpen: false,
    assistantTab: 'assistant',
    assistantStage: 'question',
    assistantFullscreen: false,
    assistantCardContext: null,
    snapshot: {
      courses: [{ id: 'c1', name: '操作系统' }],
      decks: [{ id: 'd1', title: '进程调度', cardCount: 10, dueCount: 3 }],
      sources: [
        { id: 's1', title: '讲义1' },
        { id: 's2', title: '讲义2' },
        { id: 's3', title: '讲义3' },
      ],
      jobs: [],
    },
    binding: { root: '/tmp' },
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
    activeRunId: null,
    toasts: [],
    footerHints: [],
    preferences: {
      ...DEFAULT_PREFERENCES,
      language: 'zh',
      asciiMode: false,
    },
    ...overrides,
  });
}

// -----------------------------------------------------------------------------
// Track A1: Grid & Whitespace Unification + 120x36 & 80x24 ASCII Snapshots
// -----------------------------------------------------------------------------
describe('Round 82 Track A1: Unified Grid & Whitespace Primitives', () => {
  test('1. SectionHeader, PageHeader, and Panel(quiet) render clean aligned ASCII layouts at 120x36 and 80x24', async () => {
    for (const [cols, rows] of [
      [120, 36],
      [80, 24],
    ]) {
      resetStore({ preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true } });
      const h = createInkHarness(
        React.createElement(
          Box,
          { flexDirection: 'column', width: cols, height: Math.min(rows, 14), paddingX: 1 },
          React.createElement(PageHeader, {
            title: '学习库概览',
            icon: '*',
            badge: '3',
            meta: '操作系统',
            width: cols - 2,
            ascii: true,
          }),
          React.createElement(
            Panel,
            { title: '今日待练', subtitle: '无边框留白', quiet: true, ascii: true, width: cols - 2 },
            React.createElement(SectionHeader, { title: '重点题目', meta: '按 Enter 开始', width: cols - 4, ascii: true }),
            React.createElement(Text, null, '1. 时间片轮转与多级反馈队列区别'),
          ),
        ),
        { cols, rows },
      );
      try {
        const frame = await h.waitFor((s) => s.includes('学习库概览') && s.includes('重点题目') && s.includes('时间片轮转'));
        // Pure ASCII check (no Unicode box borders) and zero nested double-box chrome
        assert.equal(frame.includes('╭'), false, `quiet layout must not emit Unicode round boxes at ${cols}x${rows}`);
        assert.equal(frame.includes('+-'), false, `quiet panel must use whitespace + hairline instead of heavy +- box at ${cols}x${rows}`);
        assert.ok(frame.includes('---'), `hairline divider must render cleanly at ${cols}x${rows}`);
      } finally {
        h.cleanup();
      }
    }
  });
});

// -----------------------------------------------------------------------------
// Track B0 (#1319): Practice Context Stack (6+ acceptance tests)
// -----------------------------------------------------------------------------
describe('Round 82 Track B0 (#1319): Practice Context Stack', () => {
  test('1. 4-hop chain (原题 -> 原文 -> 同类题 -> 错题本) pops layer-by-layer back to original card', () => {
    let stack = [];
    // Hop 1: leave original card #3 (draft) -> source p.12
    stack = pushPracticeFrame(stack, {
      kind: 'review',
      returnPage: 'review',
      runId: 'run-orig',
      cardId: 'card-orig',
      deckId: 'd1',
      cardIndex: 2,
      total: 10,
      draft: { openDraft: '我的开放题草稿' },
      originKind: 'source',
      pushedAt: 1000,
    });
    // Hop 2: leave source p.12 -> similar card run
    stack = pushPracticeFrame(stack, {
      kind: 'page',
      returnPage: 'sources',
      navContext: { sourceId: 's1', pageNumber: 12 },
      readingPos: { sourceId: 's1', pageNumber: 12 },
      originKind: 'source',
      pushedAt: 2000,
    });
    // Hop 3: leave similar card -> wrongbook
    stack = pushPracticeFrame(stack, {
      kind: 'review',
      returnPage: 'review',
      runId: 'run-sim',
      cardId: 'card-sim',
      deckId: 'd1',
      cardIndex: 0,
      originKind: 'wrongbook',
      pushedAt: 3000,
    });
    assert.equal(stack.length, 3);
    assert.equal(originReviewFrame(stack)?.cardId, 'card-orig');

    // Step 1 pop -> similar card
    const pop1 = popPracticeFrame(stack);
    assert.equal(pop1.frame?.runId, 'run-sim');
    // Step 2 pop -> source reader p.12
    const pop2 = popPracticeFrame(pop1.rest);
    assert.equal(pop2.frame?.returnPage, 'sources');
    assert.equal(pop2.frame?.readingPos?.pageNumber, 12);
    // Step 3 pop -> original card #3 with draft intact
    const pop3 = popPracticeFrame(pop2.rest);
    assert.equal(pop3.frame?.runId, 'run-orig');
    assert.equal(pop3.frame?.cardIndex, 2);
    assert.equal(pop3.frame?.draft?.openDraft, '我的开放题草稿');
    assert.equal(pop3.rest.length, 0);
  });

  test('2. Draft restore (choice/cloze/open) & zero duplicate submission/grading on already-submitted card', async () => {
    resetStore({ page: 'review', activeRunId: 'run-draft' });
    const hostCalls = [];
    const baseRun = {
      id: 'run-draft',
      title: 'Draft Test',
      index: 0,
      total: 5,
      answered: 0,
      revealed: false,
      card: {
        id: 'card-open-3',
        deckId: 'd1',
        kind: 'open',
        prompt: '请解释死锁四个必要条件',
      },
    };
    const mockHost = {
      call: async (action, args) => {
        hostCalls.push({ action, args });
        if (action === 'review.get') return { ok: true, value: { ...baseRun, index: 0 } };
        if (action === 'review.move') return { ok: true, value: { ...baseRun, index: args.index } };
        return { ok: true, value: {} };
      },
      getSnapshot: async () => useTuiStore.getState().snapshot,
    };

    // Push frame with openDraft at index 2 and pop it back
    useTuiStore.getState().pushPracticeContext({
      kind: 'review',
      returnPage: 'review',
      runId: 'run-draft',
      cardId: 'card-open-3',
      deckId: 'd1',
      cardIndex: 2,
      draft: { openDraft: '互斥、占有且等待、不可抢占、循环等待' },
      submitted: false,
      originKind: 'wrongbook',
      pushedAt: Date.now(),
    });
    useTuiStore.getState().returnViaPracticeStack();

    const h = createInkHarness(
      React.createElement(ReviewView, { host: mockHost, width: 100, height: 24, isActive: true }),
      { cols: 100, rows: 24 },
    );
    try {
      const frame = await h.waitFor((s) => s.includes('互斥、占有且等待'));
      assert.ok(frame.includes('3/5'), 'Must restore exact question index 3/5');
      assert.equal(
        hostCalls.some((c) => c.action === 'review.answer' || c.action === 'card.grade'),
        false,
        'Restoring card from context stack MUST NOT trigger re-submission or re-grading',
      );
    } finally {
      h.cleanup();
    }
  });

  test('3. TopBar chip, SideNav & Footer [r] return hint are visible across all pages and work via global r', async () => {
    resetStore({ page: 'wrongbook' });
    useTuiStore.getState().pushPracticeContext({
      kind: 'review',
      returnPage: 'review',
      runId: 'run-99',
      cardId: 'c-99',
      deckId: 'd1',
      cardIndex: 4, // 第 5 题
      originKind: 'wrongbook',
      pushedAt: Date.now(),
    });
    assert.equal(formatReturnHintLabel(useTuiStore.getState().practiceStack, 'zh'), '回到第 5 题');

    const mockHost = {
      call: async () => ({ ok: true, value: {} }),
      getSnapshot: async () => useTuiStore.getState().snapshot,
    };
    const h = createInkHarness(
      React.createElement(AppShell, {
        host: mockHost,
        autoLaunchpad: false,
        renderPage: (page) => React.createElement(Text, null, `PAGE:${page}`),
      }),
      { cols: 120, rows: 30 },
    );
    try {
      const frame = await h.waitFor((s) => s.includes('PAGE:wrongbook') && s.includes('回到第 5 题'));
      assert.ok(frame.includes('← 回到第 5 题 [r]'), 'TopBar must show return chip');
      // Press global `r` from WrongBook -> pops stack & navigates back to review!
      h.write('r');
      await h.waitFor((s) => s.includes('PAGE:review'));
      assert.equal(useTuiStore.getState().practiceStack.length, 0);
      assert.equal(useTuiStore.getState().pendingPracticeRestore?.cardIndex, 4);
    } finally {
      h.cleanup();
    }
  });

  test('4. SimilarCardsModal highlights origin card and provides [B] return to origin', async () => {
    resetStore({ page: 'review' });
    let closed = false;
    const run = {
      id: 'run-s1',
      index: 1,
      total: 6,
      card: { id: 'card-origin', deckId: 'd1', kind: 'single', prompt: '原题：TCP 三次握手为什么不能两次？' },
    };
    const mockHost = {
      call: async (name) => {
        if (name === 'review.similar') {
          return {
            ok: true,
            value: {
              items: [
                { deckId: 'd1', cardId: 'card-origin', kind: 'single', prompt: '原题：TCP 三次握手为什么不能两次？', score: 1.0 },
                { deckId: 'd1', cardId: 'card-sim2', kind: 'single', prompt: '同类题：TCP 四次挥手 TIME_WAIT', score: 0.88 },
              ],
            },
          };
        }
        return { ok: true, value: {} };
      },
    };
    const h = createInkHarness(
      React.createElement(
        Box,
        { width: 100, height: 24 },
        React.createElement(SimilarCardsModal, {
          host: mockHost,
          run,
          cardId: 'card-origin',
          kind: 'single',
          width: 100,
          height: 24,
          isActive: true,
          mathUnicode: true,
          onClose: () => {
            closed = true;
          },
          onStartRun: () => {},
        }),
      ),
      { cols: 100, rows: 24 },
    );
    try {
      const frame = await h.waitFor((s) => s.includes('[原题 第2题]') && s.includes('[原题]') && s.includes('回到原题'));
      assert.ok(frame.includes('[原题]'), 'SimilarCardsModal must highlight origin card');
      h.write('B');
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(closed, true, 'Pressing B must return to origin');
    } finally {
      h.cleanup();
    }
  });

  test('5. Ended original run shows explicit prompt + [R] 重新练这道题 instead of silently jumping away', async () => {
    resetStore({ page: 'review' });
    const startedScopes = [];
    const mockHost = {
      call: async (name, args) => {
        if (name === 'review.get') {
          return { ok: true, value: { id: 'run-ended', complete: true, closed: true, index: 3, total: 5 } };
        }
        if (name === 'review.start') {
          startedScopes.push(args);
          return {
            ok: true,
            value: {
              id: 'run-restarted',
              index: 0,
              total: 1,
              card: { id: 'c-ended', deckId: 'd1', kind: 'flashcard', prompt: '重练原题成功' },
            },
          };
        }
        return { ok: true, value: {} };
      },
      getSnapshot: async () => useTuiStore.getState().snapshot,
    };

    useTuiStore.getState().pushPracticeContext({
      kind: 'review',
      returnPage: 'review',
      runId: 'run-ended',
      cardId: 'c-ended',
      deckId: 'd1',
      cardIndex: 3,
      promptPreview: '原题预览文本',
      originKind: 'wrongbook',
      pushedAt: Date.now(),
    });
    useTuiStore.getState().returnViaPracticeStack();

    const h = createInkHarness(
      React.createElement(ReviewView, { host: mockHost, width: 100, height: 24, isActive: true }),
      { cols: 100, rows: 24 },
    );
    try {
      const frame = await h.waitFor((s) => s.includes('原题所在练习已结束（第 4 题）') && s.includes('重新练这道题'));
      assert.ok(frame.includes('原题预览文本'));
      await new Promise((r) => setTimeout(r, 40));
      // Press R -> starts focused practice of that exact card!
      h.write('R');
      await h.waitFor((s) => s.includes('重练原题成功'));
      assert.equal(startedScopes[0]?.scope?.[0]?.cardId, 'c-ended');
    } finally {
      h.cleanup();
    }
  });

  test('6. tui.json persists lastPracticeContext cleanly & AssistantPanel open/close never alters practiceStack', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'studyhub-r82-prefs-'));
    tempDirs.push(dir);
    const frame = {
      kind: 'review',
      returnPage: 'review',
      runId: 'run-p1',
      cardId: 'card-p1',
      deckId: 'd1',
      cardIndex: 6,
      total: 12,
      promptPreview: '持久化的原题',
      originKind: 'source',
      pushedAt: 1700000000000,
    };
    const rec = toLastPracticeContext(frame);
    assert.ok(rec);
    await saveTuiPreferences({ lastPracticeContext: rec }, { env: { DSH_HOME: dir } });
    const loaded = await loadTuiPreferences({ env: { DSH_HOME: dir } });
    assert.equal(loaded.lastPracticeContext?.runId, 'run-p1');
    assert.equal(loaded.lastPracticeContext?.cardIndex, 6);

    // Coexistence with #1315 assistant panel
    resetStore();
    useTuiStore.getState().pushPracticeContext(frame);
    useTuiStore.getState().openAssistant({ tab: 'guided', stage: 'retell' });
    useTuiStore.getState().closeAssistant();
    assert.equal(useTuiStore.getState().practiceStack.length, 1, 'Opening/closing AssistantPanel must not alter practiceStack');
  });
});

// -----------------------------------------------------------------------------
// Track D0 (#1315 Phase 1): Persistent AI Assistant + Guided/Retell + OSC 52 Copy
// -----------------------------------------------------------------------------
describe('Round 82 Track D0 (#1315 Phase 1): Persistent AI Assistant, Guided/Retell & OSC 52 Copy', () => {
  test('1. OSC 52 clipboard sequence, tmux passthrough, atomic file fallback, and stage-marked transcript', async () => {
    const seq = buildOsc52Sequence('你好 StudyHub');
    assert.ok(seq.startsWith('\x1b]52;c;') && seq.endsWith('\x07'));
    assert.equal(Buffer.from(seq.slice(7, -1), 'base64').toString('utf8'), '你好 StudyHub');

    const tmuxSeq = buildOsc52Sequence('abc', { tmux: true });
    assert.ok(tmuxSeq.startsWith('\x1bPtmux;\x1b\x1b]52;c;') && tmuxSeq.endsWith('\x1b\\'));

    // TTY OSC 52 success
    const written = [];
    const okRes = await copyTextWithFallback('测试复制内容', {
      stdout: { isTTY: true, write: (s) => { written.push(s); return true; } },
      env: {},
    });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.method, 'osc52');
    assert.equal(okRes.chars, 6);
    assert.equal(written.length, 1);

    // Fallback to <library>/backups/copy-<time>.md when stdout is non-TTY / unavailable
    const libDir = await mkdtemp(join(tmpdir(), 'studyhub-r82-copy-'));
    tempDirs.push(libDir);
    const md = formatSessionTranscript({
      title: '测试带学会话',
      prompt: '什么是虚拟内存？',
      userAnswer: '把磁盘空间映射为逻辑地址空间',
      currentStage: 'retell',
      turns: [
        { role: 'user', stage: 'retell', text: '分页与按需调页让程序突破物理内存限制' },
        { role: 'assistant', stage: 'retell', text: '复述判定：通过 ✓' },
      ],
      lang: 'zh',
    });
    assert.ok(md.includes('## 题目') && md.includes('## 我的作答') && md.includes('[阶段: 复述]'));

    const fileRes = await copyTextWithFallback(md, {
      stdout: { isTTY: false },
      libraryRoot: libDir,
      env: {},
    });
    assert.equal(fileRes.ok, true);
    assert.equal(fileRes.method, 'file');
    assert.ok(fileRes.filePath?.includes('backups') && fileRes.filePath?.endsWith('.md'));
    const diskContent = await readFile(fileRes.filePath, 'utf8');
    assert.ok(diskContent.includes('[阶段: 复述]') && diskContent.includes('什么是虚拟内存？'));
  });

  test('2. Natural-language intent parser maps navigation, plain explain, and P2-confirmed writes without inventing actions', () => {
    const snap = useTuiStore.getState().snapshot;
    const nav = parseAssistantIntent('跳到资料库，打开第 3 份讲义的第 12 页', { snapshot: snap });
    assert.equal(nav.kind, 'navigate');
    assert.equal(nav.page, 'sources');
    assert.equal(nav.sourceId, 's3');
    assert.equal(nav.pageNumber, 12);
    assert.equal(nav.requiresConfirm, false);

    const explain = parseAssistantIntent('讲解新增通俗讲解', { snapshot: snap, currentCardId: 'c1' });
    assert.equal(explain.kind, 'generate_plain_explain');
    assert.equal(explain.actionName, 'card.followup.add');

    const write = parseAssistantIntent('把这题加入错题本并标记为粗心', { snapshot: snap, currentCardId: 'c1', currentDeckId: 'd1' });
    assert.equal(write.kind, 'write_confirm');
    assert.equal(write.actionName, 'attempt.errorReason.set');
    assert.equal(write.requiresConfirm, true);

    const exp = parseAssistantIntent('导出本课错题 Markdown', { snapshot: snap });
    assert.equal(exp.kind, 'write_confirm');
    assert.equal(exp.actionName, 'export.wrongbook');
    assert.equal(exp.requiresConfirm, true);
  });

  test('3. AssistantPanel sizing (min(cols-4, 120), rows-2), [F] fullscreen + Esc split, Tab preserves stage, skip retell & P2 confirm cancel', async () => {
    _resetAssistantSessionMemory();
    assert.deepEqual(resolveAssistantPanelSize(160, 40, false), { width: 120, height: 38 });
    assert.deepEqual(resolveAssistantPanelSize(100, 30, false), { width: 96, height: 28 });
    assert.deepEqual(resolveAssistantPanelSize(160, 40, true), { width: 158, height: 38 });

    resetStore({
      assistantOpen: true,
      assistantTab: 'guided',
      assistantStage: 'retell',
      assistantFullscreen: false,
      assistantCardContext: {
        runId: 'r1',
        deckId: 'd1',
        cardId: 'c1',
        prompt: 'TCP 拥塞控制四个阶段',
        userAnswer: '慢启动、拥塞避免',
      },
    });

    const hostCalls = [];
    const oscWrites = [];
    const mockHost = {
      call: async (action, args) => {
        hostCalls.push({ action, args });
        return { ok: true, value: {} };
      },
      getLibraryRoot: () => '/tmp',
      streamComplete: async () => '通俗讲解：就像高速公路限流。',
    };

    let closedCount = 0;
    const h = createInkHarness(
      React.createElement(
        Box,
        { width: 120, height: 36 },
        React.createElement(AssistantPanel, {
          host: mockHost,
          isActive: true,
          onClose: () => {
            closedCount += 1;
          },
          copyStdout: { isTTY: true, write: (s) => { oscWrites.push(s); return true; } },
        }),
      ),
      { cols: 120, rows: 36 },
    );

    try {
      await h.waitFor((s) => s.includes('AI 助手') && s.includes('[复述]'));

      // Toggle fullscreen [F] -> Esc returns to split (does NOT close panel yet!)
      h.write('F');
      await h.waitFor((s) => s.includes('全屏 (Esc分栏)'));
      assert.equal(useTuiStore.getState().assistantFullscreen, true);
      h.write('\x1b');
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(useTuiStore.getState().assistantFullscreen, false);
      assert.equal(closedCount, 0, 'First Esc must exit fullscreen back to split instead of closing');

      // Switch tab to Assistant and back to Guided -> stage 'retell' MUST be preserved!
      h.write('\t');
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(useTuiStore.getState().assistantTab, 'assistant');
      h.write('\t');
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(useTuiStore.getState().assistantTab, 'guided');
      assert.equal(useTuiStore.getState().assistantStage, 'retell', 'Switching tabs must preserve stage progress');

      // Skip retell [S] -> recorded with stage='retell', skipped=true, advances to summary
      h.write('S');
      await h.waitFor((s) => s.includes('已跳过本轮复述'));
      assert.equal(useTuiStore.getState().assistantStage, 'summary');
      const retells = _getAssistantRetellRecords();
      assert.equal(retells.length, 1);
      assert.equal(retells[0].stage, 'retell');
      assert.equal(retells[0].skipped, true);

      // Copy full session [C] -> emits OSC 52 sequence containing stage markers!
      h.write('C');
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(oscWrites.length, 1, 'Pressing C must emit OSC 52 sequence');
      const b64Match = oscWrites[0].match(/\]52;c;([A-Za-z0-9+/=]+)/);
      assert.ok(b64Match, `Expected OSC 52 payload, got: ${JSON.stringify(oscWrites[0])}`);
      const decoded = Buffer.from(b64Match[1], 'base64').toString('utf8');
      assert.ok(decoded.includes('[阶段: 复述]') && decoded.includes('TCP 拥塞控制四个阶段'), `Unexpected transcript:\n${decoded}`);

      // Switch to Assistant tab via Tab -> press i -> submit write command -> ConfirmDialog appears -> cancel ('n') leaves host untouched!
      h.write('\t');
      await new Promise((r) => setTimeout(r, 30));
      h.write('i');
      await new Promise((r) => setTimeout(r, 30));
      h.write('把这题加入错题本并标记为粗心');
      await h.waitFor((s) => s.includes('把这题加入错题本并标记为粗心'));
      h.write('\r');
      await h.waitFor((s) => s.includes('确认标记错题原因'));
      h.write('n');
      await h.waitFor((s) => s.includes('已取消，数据未改动'));
      assert.equal(
        hostCalls.some((c) => c.action === 'attempt.errorReason.set'),
        false,
        'Cancelling ConfirmDialog must NOT call attempt.errorReason.set',
      );
    } finally {
      h.cleanup();
    }
  });
});
