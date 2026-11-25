// #1315 Phase 1 Full-Workflow Integration Acceptance Suite (docs/ASSISTANT-UX.md):
// Covers all 5 required user scenarios + non-stealing docked focus + real [z] undo + 3x chip promotion + >2s latency notice:
//   1. 卡住带学 (stuck on unanswered card -> chips recommend Guided Study -> stage progression)
//   2. 答错讲解 (wrong card -> chips prioritize Plain Explain & Mark Wrong -> streaming + card.followup.add save)
//   3. 跳转定位 (natural language "跳到资料库第 3 份讲义第 12 页" -> navigates accurately without parroting + [z] undo)
//   4. 批量导出 ("导出本课错题 Markdown" -> ConfirmDialog "将执行：..." -> confirm writes atomic file + 1-line result)
//   5. 做不了兜底 (unsupported request -> nearest alternative [A] + [P] copy prompt via OSC 52 / fallback file)
//   6. 焦点不丢失 (Ctrl+Space docks assistant on right without stealing focus: user still answers option 1 on ReviewView!)
//   7. 撤销可用 (attempt.errorReason.set confirmed -> [z] calls inverse action to restore previous reason)
//   8. 越用越顺手 (same command repeated 3x auto-promotes to permanent page chip & recent pins to top) + >2s progress notice
// node --test tests/assistant-ux-1315.test.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
const tempDirs = [];
after(async () => {
  unregisterTsx?.();
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

const [
  chipsMod,
  assistantMod,
  { AppShell },
  { ReviewView },
  storeMod,
] = await Promise.all([
  import('../src/shell/assistant-chips.ts'),
  import('../src/shell/AssistantPanel.tsx'),
  import('../src/shell/AppShell.tsx'),
  import('../src/views/review/ReviewView.tsx'),
  import('../src/state/store.ts'),
]);

const { buildContextChips, recordCommandStat, PROMOTION_THRESHOLD } = chipsMod;
const { AssistantPanel, _resetAssistantSessionMemory } = assistantMod;
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

function createInkHarness(element, { cols = 120, rows = 32 } = {}) {
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
    waitFor: (predicate, timeoutMs = 2500) => {
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
  _resetAssistantSessionMemory();
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
    assistantFocused: false,
    assistantTab: 'assistant',
    assistantStage: 'question',
    assistantFullscreen: false,
    assistantCardContext: null,
    snapshot: {
      focus: { course: '操作系统' },
      courses: [{ id: 'c1', name: '操作系统' }],
      decks: [{ id: 'd1', title: '内存管理', cardCount: 12, dueCount: 4 }],
      sources: [
        { id: 's1', title: '第1章 导论' },
        { id: 's2', title: '第2章 进程' },
        { id: 's3', title: '第3章 虚拟内存' },
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
      assistantCommandStats: undefined,
    },
    ...overrides,
  });
}

describe('#1315 Phase 1 Full-Workflow Assistant UX Acceptance Gate', () => {
  test('0. Deliverable docs/ASSISTANT-UX.md exists and covers principles, layout, chips, and fallback', async () => {
    const docPath = join(pkgRoot, 'docs/ASSISTANT-UX.md');
    assert.equal(existsSync(docPath), true, 'docs/ASSISTANT-UX.md must exist');
    const doc = await readFile(docPath, 'utf8');
    for (const token of ['Ctrl+Space', '停靠', 'Chips', '3 次', '复制提示词', '撤销', '2 秒']) {
      assert.ok(doc.includes(token), `docs/ASSISTANT-UX.md missing "${token}"`);
    }
  });

  test('1. Scenario: 卡住带学 + 焦点不丢失 (Ctrl+Space right-docks without stealing ReviewView answering focus, chip [1] enters Guided Study)', async () => {
    resetStore({ page: 'review', activeRunId: 'run-ux1' });
    const actions = [];
    const mockRun = {
      id: 'run-ux1',
      title: '内存管理',
      index: 0,
      total: 4,
      answered: 0,
      revealed: false,
      card: {
        id: 'c-ux1',
        deckId: 'd1',
        kind: 'single',
        prompt: '虚拟内存页面置换中 Belady 异常发生在哪种算法？',
        options: [
          { id: 'A', text: 'FIFO' },
          { id: 'B', text: 'LRU' },
        ],
      },
    };
    const mockHost = {
      call: async (name, payload) => {
        actions.push({ name, payload });
        if (name === 'review.get' || name === 'review.start') return { ok: true, value: mockRun };
        if (name === 'review.answer') {
          return {
            ok: true,
            value: {
              ...mockRun,
              answered: 1,
              revealed: true,
              feedback: { correct: true, selected: payload.selected },
              solution: { answer: 'A', options: [{ id: 'A', correct: true }] },
            },
          };
        }
        return { ok: true, value: {} };
      },
      getLibraryRoot: () => '/tmp',
      streamComplete: async () => '提示：想想先进先出队列会不会因为页框变多反而置换更多？',
    };

    const h = createInkHarness(
      React.createElement(AppShell, {
        host: mockHost,
        autoLaunchpad: false,
        renderPage: (_page, view) => React.createElement(ReviewView, { ...view }),
      }),
      { cols: 120, rows: 32 },
    );

    try {
      await h.waitFor((s) => s.includes('Belady 异常') && s.includes('FIFO'));
      // Press Ctrl+Space (\x00) -> opens right-docked assistant WITHOUT stealing focus or covering question!
      h.write('\x00');
      const dockedFrame = await h.waitFor(
        (s) => s.includes('AI 助手') && s.includes('停靠不抢焦点') && s.includes('Belady 异常') && s.includes('[1]苏格拉底带学'),
      );
      assert.equal(useTuiStore.getState().assistantOpen, true);
      assert.equal(useTuiStore.getState().assistantFocused, false, 'Initial Ctrl+Space dock must NOT steal focus');
      assert.ok(dockedFrame.includes('FIFO'), 'Docked assistant must NOT cover the question/options');

      // While assistant is open on the right, user presses '1' directly to answer option A on ReviewView!
      h.write('1');
      await h.waitFor((s) => s.includes('回答正确'));
      assert.ok(
        actions.some((a) => a.name === 'review.answer' && a.payload?.selected?.[0] === 'A'),
        'User must still be able to answer on ReviewView while assistant is docked',
      );

      // Second Ctrl+Space focuses the docked assistant -> press [1] chip to enter Guided Study!
      h.write('\x00');
      await h.waitFor(() => useTuiStore.getState().assistantFocused === true);
      await new Promise((r) => setTimeout(r, 40));
      h.write('1');
      await h.waitFor((s) => s.includes('[提问]') && useTuiStore.getState().assistantTab === 'guided');
    } finally {
      h.cleanup();
    }
  });

  test('2. Scenario: 答错讲解 (#1338: streams plain explanation first, asks P2 confirm before card.followup.add, human-readable output)', async () => {
    resetStore({
      page: 'review',
      assistantOpen: true,
      assistantFocused: true,
      assistantCardContext: {
        runId: 'r2',
        deckId: 'd1',
        cardId: 'c-wrong',
        cardIndex: 2,
        total: 8,
        prompt: '为什么 TLB 命中率高？',
        userAnswer: '因为容量大',
        isWrong: true,
        revealed: true,
      },
    });
    const savedCalls = [];
    const mockHost = {
      call: async (name, args) => {
        if (name === 'card.followup.add') savedCalls.push(args);
        return { ok: true, value: { ok: true } };
      },
      getLibraryRoot: () => '/tmp',
      streamComplete: async ({ onChunk }) => {
        onChunk?.('TLB 像桌面便利贴，利用局部性原理缓存最近页表项。');
        return 'TLB 像桌面便利贴，利用局部性原理缓存最近页表项。';
      },
    };

    const h = createInkHarness(
      React.createElement(
        Box,
        { width: 90, height: 28 },
        React.createElement(AssistantPanel, {
          host: mockHost,
          isActive: true,
          width: 90,
          height: 28,
          docked: true,
          onClose: () => {},
        }),
      ),
      { cols: 90, rows: 28 },
    );

    try {
      const frame = await h.waitFor((s) => s.includes('[1]通俗讲解') && s.includes('[2]标记错因') && s.includes('第 3/8 题(答错)'));
      assert.ok(frame.includes('第 3/8 题(答错)'), 'Context ribbon must show card index & wrong status');
      // Press [1] chip directly -> generates explanation and opens confirmation dialog WITHOUT writing yet
      h.write('1');
      const confirmFrame = await h.waitFor((s) => s.includes('保存通俗讲解到本题') && s.includes('将执行：'));
      assert.equal(savedCalls.length, 0, 'Must NOT write card.followup.add before user confirms');
      assert.ok(!confirmFrame.includes('card.followup.add'), 'Confirmation should use human-readable wording');

      // Cancelling keeps explanation without writing to disk
      await new Promise((r) => setTimeout(r, 30));
      h.write('n');
      await h.waitFor((s) => s.includes('已取消') && s.includes('桌面便利贴'));
      assert.equal(savedCalls.length, 0, 'Cancelling confirmation must not write to card');

      // Trigger again and confirm with y -> writes once with human-readable confirmation (no actionName or cardId)
      await new Promise((r) => setTimeout(r, 30));
      h.write('1');
      await h.waitFor((s) => s.includes('保存通俗讲解到本题'));
      await new Promise((r) => setTimeout(r, 30));
      h.write('y');
      const savedFrame = await h.waitFor((s) => s.includes('已保存到本题讲解'));
      assert.equal(savedCalls.length, 1);
      assert.equal(savedCalls[0].cardId, 'c-wrong');
      assert.ok(!savedFrame.includes('card.followup.add'), 'Must not leak internal action name in UI');
      assert.ok(!savedFrame.includes('c-wrong'), 'Must not leak raw card ID in UI');
    } finally {
      h.cleanup();
    }
  });

  test('3. Scenario: 跳转定位 + 撤销可用 (navigate to source #3 page 12 without parroting -> [z] returns to previous page)', async () => {
    resetStore({ page: 'library', assistantOpen: true, assistantFocused: true });
    const mockHost = {
      call: async () => ({ ok: true, value: {} }),
      getLibraryRoot: () => '/tmp',
    };

    const h = createInkHarness(
      React.createElement(
        Box,
        { width: 90, height: 28 },
        React.createElement(AssistantPanel, {
          host: mockHost,
          isActive: true,
          width: 90,
          height: 28,
          docked: true,
          onClose: () => {},
        }),
      ),
      { cols: 90, rows: 28 },
    );

    try {
      await h.waitFor((s) => s.includes('当前：学习库'));
      h.write('i');
      await new Promise((r) => setTimeout(r, 30));
      h.write('跳到资料库，打开第 3 份讲义的第 12 页');
      await h.waitFor((s) => s.includes('第 12 页'));
      h.write('\r');
      await h.waitFor((s) => s.includes('已定位至 sources 第 12 页') && s.includes('[z]'));
      assert.equal(useTuiStore.getState().page, 'sources');
      assert.equal(useTuiStore.getState().navContext.sourceId, 's3');
      assert.equal(useTuiStore.getState().navContext.pageNumber, 12);

      // Press [z] -> Undo returns to library!
      h.write('z');
      await h.waitFor((s) => s.includes('已撤销：返回 library'));
      assert.equal(useTuiStore.getState().page, 'library');
    } finally {
      h.cleanup();
    }
  });

  test('4. Scenario: 批量导出 + 写操作撤销 (ConfirmDialog shows "将执行：..." -> confirm writes file; mark wrong -> [z] undoes)', async () => {
    const libDir = await mkdtemp(join(tmpdir(), 'studyhub-ux1315-export-'));
    tempDirs.push(libDir);
    resetStore({
      page: 'wrongbook',
      assistantOpen: true,
      assistantFocused: true,
      assistantCardContext: { runId: 'r4', deckId: 'd1', cardId: 'c-4', prompt: '死锁预防策略' },
    });
    const reasonCalls = [];
    const mockHost = {
      call: async (name, args) => {
        if (name === 'wrongbook') {
          return { ok: true, value: { items: [{ prompt: '死锁预防策略', errorReason: 'concept' }] } };
        }
        if (name === 'attempt.errorReason.set') {
          reasonCalls.push(args);
          return { ok: true, value: { ok: true, updated: true } };
        }
        return { ok: true, value: {} };
      },
      getLibraryRoot: () => libDir,
    };

    const h = createInkHarness(
      React.createElement(
        Box,
        { width: 96, height: 28 },
        React.createElement(AssistantPanel, {
          host: mockHost,
          isActive: true,
          width: 96,
          height: 28,
          docked: true,
          onClose: () => {},
        }),
      ),
      { cols: 96, rows: 28 },
    );

    try {
      // On WrongBook page, chip [1] is "导出本课错题" -> press '1' -> ConfirmDialog "将执行：export.wrongbook..."
      await h.waitFor((s) => s.includes('[1]导出本课错题'));
      h.write('1');
      await h.waitFor((s) => s.includes('将执行：export.wrongbook'));
      h.write('y');
      await h.waitFor((s) => s.includes('已导出 1 道错题至'));
      // The wrong-book rows carry `errorReason` (an id); the export names it as the wrong-book does.
      const exportDir = join(libDir, 'backups');
      const [exported] = (await readdir(exportDir)).filter((name) => name.startsWith('studyhub-wrongbook'));
      assert.match(await readFile(join(exportDir, exported), 'utf8'), /死锁预防策略（错因：概念混淆）/);

      // Now execute write action attempt.errorReason.set -> confirm -> press [z] Undo!
      h.write('i');
      await new Promise((r) => setTimeout(r, 30));
      h.write('把这题加入错题本并标记为粗心');
      await h.waitFor((s) => s.includes('把这题加入错题本并标记为粗心'));
      h.write('\r');
      await h.waitFor((s) => s.includes('将执行：attempt.errorReason.set'));
      h.write('y');
      await h.waitFor((s) => s.includes('已完成：错因已标为「粗心手滑」'));
      assert.equal(reasonCalls.length, 1);
      assert.deepEqual(reasonCalls[0], { deckId: 'd1', cardId: 'c-4', errorReason: 'slip' });

      // Undo via [z]
      h.write('z');
      await h.waitFor((s) => s.includes('已撤销：错题原因已清空'));
      assert.equal(reasonCalls.length, 2);
      assert.deepEqual(reasonCalls[1], { deckId: 'd1', cardId: 'c-4', errorReason: null });
    } finally {
      h.cleanup();
    }
  });

  test('5. Scenario: 做不了兜底 + 延迟可感知 (>2s notice) + 重复 3 次晋升常驻 chip', async () => {
    // 5a) 3x repetition promotes command to permanent page chip & pins recent to top
    let stats = {};
    for (let i = 0; i < PROMOTION_THRESHOLD; i += 1) {
      stats = recordCommandStat(stats, 'review', '对比容易混淆的概念', 1000 + i * 100);
    }
    const promotedChips = buildContextChips({
      page: 'review',
      card: { cardId: 'c1', isWrong: false },
      practiceStack: [],
      statsByPage: stats,
      lang: 'zh',
    });
    assert.equal(promotedChips[0].promoted, true, '3x repeated command must promote to top chip');
    assert.equal(promotedChips[0].command, '对比容易混淆的概念');

    // 5b) Unsupported request -> nearest alternative + [P] copy prompt (OSC 52) + >2s latency notice
    resetStore({
      page: 'review',
      assistantOpen: true,
      assistantFocused: true,
      assistantCardContext: { cardId: 'c5', prompt: '分页与分段的区别' },
    });
    const oscWrites = [];
    const mockHost = {
      call: async () => ({ ok: true, value: {} }),
      getLibraryRoot: () => '/tmp',
      streamComplete: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return '分段按逻辑划分，分页按固定大小划分。';
      },
    };

    const h = createInkHarness(
      React.createElement(
        Box,
        { width: 96, height: 28 },
        React.createElement(AssistantPanel, {
          host: mockHost,
          isActive: true,
          width: 96,
          height: 28,
          docked: true,
          slowNoticeMs: 40, // accelerated >2s progress notice for deterministic test
          copyStdout: { isTTY: true, write: (s) => { oscWrites.push(s); return true; } },
          onClose: () => {},
        }),
      ),
      { cols: 96, rows: 28 },
    );

    try {
      await h.waitFor((s) => s.includes('AI 助手'));
      // Unsupported command -> never dead-ends, offers [A] nearest alternative & [P] Copy Prompt!
      h.write('i');
      await new Promise((r) => setTimeout(r, 30));
      h.write('帮我发邮件给同学');
      await h.waitFor((s) => s.includes('帮我发邮件给同学'));
      h.write('\r');
      const fbFrame = await h.waitFor((s) => s.includes('不支持外部通信') && s.includes('[P] 复制提示词'));
      assert.ok(fbFrame.includes('改为：导出本课错题'), 'Must present nearest supported alternative');

      // Press [P] -> copies ready-to-paste prompt with current card context via OSC 52!
      h.write('P');
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(oscWrites.length, 1);
      const b64 = oscWrites[0].match(/\]52;c;([A-Za-z0-9+/=]+)/)?.[1] ?? '';
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      assert.ok(decoded.includes('分页与分段的区别'), 'Copied fallback prompt must include live card context');

      // Slow streaming request -> shows "正在执行：..." and then slow progress notice (>slowNoticeMs) -> completes!
      h.write('2'); // chip [2] 通俗讲解
      await h.waitFor((s) => s.includes('正在执行：生成通俗讲解') && s.includes('耗时较长'));
      await h.waitFor((s) => s.includes('分段按逻辑划分'));
    } finally {
      h.cleanup();
    }
  });

  test('6. (#1339) Semicolon/然后 ordinary questions go to model; multi-step workflow resumes remaining steps after confirm', async () => {
    resetStore({
      page: 'review',
      assistantOpen: true,
      assistantFocused: true,
      assistantCardContext: { runId: 'r6', deckId: 'd1', cardId: 'card-internal-999', prompt: '设计模式对比' },
    });
    const promptsSent = [];
    const reasonCalls = [];
    const mockHost = {
      call: async (name, args) => {
        if (name === 'attempt.errorReason.set') {
          reasonCalls.push(args);
          return { ok: true, value: { ok: true, updated: true } };
        }
        return { ok: true, value: {} };
      },
      getLibraryRoot: () => '/tmp',
      streamComplete: async ({ prompt }) => {
        promptsSent.push(prompt);
        return 'Memento 负责保存与恢复状态，Bridge 分离抽象与实现。';
      },
    };

    const h = createInkHarness(
      React.createElement(
        Box,
        { width: 96, height: 28 },
        React.createElement(AssistantPanel, {
          host: mockHost,
          isActive: true,
          width: 96,
          height: 28,
          docked: true,
          onClose: () => {},
        }),
      ),
      { cols: 96, rows: 28 },
    );

    try {
      await h.waitFor((s) => s.includes('AI 助手'));
      h.write('i');
      await new Promise((r) => setTimeout(r, 30));
      h.write('讲讲 Memento；再讲讲 Bridge');
      await h.waitFor((s) => s.includes('讲讲 Memento；再讲讲 Bridge'));
      h.write('\r');
      const replyFrame = await h.waitFor((s) => s.includes('Memento 负责保存与恢复状态'));
      assert.equal(promptsSent.length, 1, 'Ordinary semicolon question must invoke model once');
      assert.ok(promptsSent[0].includes('讲讲 Memento；再讲讲 Bridge'), 'Entire question must be sent to model');
      assert.ok(!replyFrame.includes('card-internal-999'), 'Must not leak internal cardId');
      assert.ok(!replyFrame.includes('多步任务已完成'), 'Must not treat plain question as multi-step workflow');

      // Real multi-step workflow: write step first -> confirm -> remaining step (navigate to dashboard) continues!
      await new Promise((r) => setTimeout(r, 30));
      h.write('i');
      await new Promise((r) => setTimeout(r, 30));
      h.write('先把这题加入错题本并标记为粗心，再跳到统计');
      await h.waitFor((s) => s.includes('先把这题加入错题本并标记为粗心，再跳到统计'));
      h.write('\r');
      await h.waitFor((s) => s.includes('确认标记错题原因'));
      await new Promise((r) => setTimeout(r, 30));
      h.write('y');
      await h.waitFor(() => useTuiStore.getState().page === 'dashboard');
      assert.equal(reasonCalls.length, 1, 'Confirmed write step must execute');
      assert.equal(useTuiStore.getState().page, 'dashboard', 'Step after confirmed write must automatically continue');
    } finally {
      h.cleanup();
    }
  });
});
