// #1444: TUI Assistant intent coverage matrix + honest status labels + real action execution.
// Run: CI=1 node --test tests/issue-1444-intent-coverage.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const [intentMod, workflowMod, assistantMod, storeMod] = await Promise.all([
  import('../src/shell/assistant-intent.ts'),
  import('../src/shell/assistant-workflow.ts'),
  import('../src/shell/AssistantPanel.tsx'),
  import('../src/state/store.ts'),
]);

const { parseAssistantIntent } = intentMod;
const { planAssistantWorkflow, markWorkflowStepResult, formatWorkflowOutcomeSummary } = workflowMod;
const { AssistantPanel, _resetAssistantSessionMemory } = assistantMod;
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

const FULL_CARD = {
  runId: 'run-1',
  deckId: 'deck-os',
  cardId: 'card-tlb',
  cardIndex: 2,
  total: 10,
  prompt: '为什么 TLB 命中率通常很高？',
  topic: '虚拟内存',
  userAnswer: '因为容量大',
  answer: '程序访问具有时间与空间局部性。',
  explanation: '页表项在短期内会被反复访问。',
  citations: [{ sourceId: 's2', pageNumber: 17, sourceTitle: '第2章 虚拟内存', quote: 'TLB 利用局部性原理' }],
  isWrong: true,
  revealed: true,
};

const FULL_SNAPSHOT = {
  focus: { course: '操作系统' },
  courses: [{ id: 'c1', name: '操作系统' }],
  decks: [{ id: 'deck-os', title: '内存管理', cardCount: 10, dueCount: 3 }],
  sources: [
    { id: 's1', title: '第1章 导论' },
    { id: 's2', title: '第2章 虚拟内存' },
    { id: 's3', title: '第3章 文件系统' },
  ],
  jobs: [],
};

const BASE_CTX = {
  snapshot: FULL_SNAPSHOT,
  currentCardId: FULL_CARD.cardId,
  currentDeckId: FULL_CARD.deckId,
  card: FULL_CARD,
  lang: 'zh',
};

describe('#1444 Intent Coverage Matrix (意图覆盖表)', () => {
  const COVERAGE_MATRIX = [
    // 1. 出前置题并关联
    {
      name: '出前置题并关联 (assist.start derive prerequisite)',
      input: '出前置题下次补强',
      expectKind: 'write_confirm',
      expectAction: 'assist.start',
      verify: (intent) => {
        assert.equal(intent.requiresConfirm, true);
        assert.equal(intent.params.mode, 'derive');
        assert.equal(intent.params.derive?.relation, 'prerequisite');
        assert.equal(intent.params.cardId, 'card-tlb');
        assert.equal(intent.params.deckId, 'deck-os');
      },
    },
    // 2. 同类题
    {
      name: '同类题 (review.similar)',
      input: '再给我一道同类题',
      expectKind: 'run_action',
      expectAction: 'review.similar',
      verify: (intent) => {
        assert.equal(intent.requiresConfirm, false);
        assert.equal(intent.params.runId, 'run-1');
        assert.equal(intent.params.cardId, 'card-tlb');
      },
    },
    // 3. 帮我理解
    {
      name: '帮我理解这道题 (generate_plain_explain)',
      input: '帮我理解这道题',
      expectKind: 'generate_plain_explain',
      expectAction: 'card.followup.add',
    },
    // 4. 存到笔记
    {
      name: '存到笔记 (note.qa.add)',
      input: '把这个解答加到我的笔记',
      expectKind: 'write_confirm',
      expectAction: 'note.qa.add',
      verify: (intent) => {
        assert.equal(intent.requiresConfirm, true);
        assert.equal(intent.params.cardId, 'card-tlb');
      },
    },
    // 5. 修题
    {
      name: '修题 (assist.start improve)',
      input: '这题答案有问题，帮我修一下',
      expectKind: 'write_confirm',
      expectAction: 'assist.start',
      verify: (intent) => {
        assert.equal(intent.params.mode, 'improve');
        assert.equal(intent.params.cardId, 'card-tlb');
      },
    },
    // 7. 标记题目有问题
    {
      name: '标记题目有问题 (card.flag)',
      input: '标记这道题题干有问题',
      expectKind: 'write_confirm',
      expectAction: 'card.flag',
      verify: (intent) => {
        assert.equal(intent.params.cardId, 'card-tlb');
        assert.equal(intent.params.deckId, 'deck-os');
      },
    },
    // 8. 改判评分 (#1447: only the grade the learner named, no invented 4)
    {
      name: '改判评分 (review.grade.adjust)',
      input: '这题我答对了，改判为5分',
      expectKind: 'write_confirm',
      expectAction: 'review.grade.adjust',
      verify: (intent) => {
        assert.equal(intent.params.runId, 'run-1');
        assert.equal(intent.params.cardId, 'card-tlb');
        assert.equal(intent.params.grade, 5);
        assert.match(intent.previewMessage, /掌握/);
      },
    },
    // 9. 确认订正
    {
      name: '确认订正 (review.correction.ack)',
      input: '我订正好了',
      expectKind: 'write_confirm',
      expectAction: 'review.correction.ack',
      verify: (intent) => {
        assert.equal(intent.params.runId, 'run-1');
        assert.equal(intent.params.cardId, 'card-tlb');
      },
    },
    // 10. 练错题变式
    {
      name: '练错题变式 (coach.practice)',
      input: '练一下错题的变式',
      expectKind: 'write_confirm',
      expectAction: 'coach.practice',
    },
    // 11. 批量重练错题
    {
      name: '批量重练错题 (review.start)',
      input: '把错题拿来练一遍',
      expectKind: 'write_confirm',
      expectAction: 'review.start',
      verify: (intent) => {
        assert.equal(intent.params.mode, 'path');
        assert.equal(intent.params.only, 'wrong');
        assert.equal(intent.params.course, '操作系统');
      },
    },
    // 12. 提取术语
    {
      name: '提取术语 (card.terms)',
      input: '把这题里的术语提取出来',
      expectKind: 'write_confirm',
      expectAction: 'card.terms',
      verify: (intent) => {
        assert.equal(intent.params.cardId, 'card-tlb');
        assert.equal(intent.requiresConfirm, true, '#1447: it spends model quota');
      },
    },
    // 14. 按讲义出题
    {
      name: '按讲义出题 -> 跳转创建题组页',
      input: '根据这份讲义出 10 道题',
      expectKind: 'navigate',
      expectAction: 'navigate(generate)',
      verify: (intent) => {
        assert.equal(intent.page, 'generate');
      },
    },
    // 15a. 斩题
    {
      name: '斩题 (card.slay)',
      input: '这题已经掌握了，别再出了',
      expectKind: 'write_confirm',
      expectAction: 'card.slay',
      verify: (intent) => {
        assert.equal(intent.params.cardId, 'card-tlb');
        assert.equal(intent.params.deckId, 'deck-os');
      },
    },
    // 15b. 暂停本题
    {
      name: '暂停本题 (card.suspend)',
      input: '暂停这道题',
      expectKind: 'write_confirm',
      expectAction: 'card.suspend',
      verify: (intent) => {
        assert.equal(intent.params.suspended, true);
      },
    },
    // 15c. 收藏重点
    {
      name: '收藏重点 (card.focus)',
      input: '把这题标为考纲重点',
      expectKind: 'write_confirm',
      expectAction: 'card.focus',
      verify: (intent) => {
        assert.equal(intent.params.cardId, 'card-tlb');
      },
    },
    // 16a. 跳过本题 (#1447: review.skip at execution time, never review.move{direction:1})
    {
      name: '跳过本题 (review.skip)',
      input: '跳过这题',
      expectKind: 'run_action',
      expectAction: 'review.skip',
      verify: (intent) => {
        assert.equal(intent.params.runId, 'run-1');
        assert.equal(intent.params.cardId, 'card-tlb', 'skip needs the question it leaves');
        assert.equal(intent.params.direction, undefined);
      },
    },
    // 16b. 撤销上一题评分
    {
      name: '撤销上一题评分 (review.undo)',
      input: '撤销上一题评分',
      expectKind: 'write_confirm',
      expectAction: 'review.undo',
      verify: (intent) => {
        assert.equal(intent.params.runId, 'run-1');
      },
    },
    // 17. 翻译本题
    {
      name: '翻译本题 (card.translate)',
      input: '把这题翻译成英文',
      expectKind: 'write_confirm',
      expectAction: 'card.translate',
      verify: (intent) => {
        assert.equal(intent.params.cardId, 'card-tlb');
        assert.equal(intent.requiresConfirm, true, '#1447: it spends model quota');
      },
    },
    // 18. 调整本轮题序
    {
      name: '调整本轮题序 (review.queue.edit)',
      input: '把这题挪到最后',
      // #1458: reordering a round is reversible, so it runs directly without a ConfirmDialog.
      expectKind: 'run_action',
      expectAction: 'review.queue.edit',
      verify: (intent) => {
        assert.equal(intent.requiresConfirm, false);
        assert.equal(intent.params.runId, 'run-1');
        assert.equal(intent.params.position, 'end');
        assert.equal(intent.params.allowCurrent, true);
      },
    },
    // Core existing + fixed intents
    {
      name: '加入错题本并标错因 (attempt.errorReason.set)',
      input: '标记为漏看条件',
      expectKind: 'write_confirm',
      expectAction: 'attempt.errorReason.set',
    },
    {
      name: '导出整门课错题 (export.wrongbook)',
      input: '导出本课错题 Markdown',
      expectKind: 'write_confirm',
      expectAction: 'export.wrongbook',
      verify: (intent) => {
        assert.notEqual(intent.params.singleCard, true);
      },
    },
    {
      name: '导出当前单道错题 (export.wrongbook singleCard)',
      input: '导出这道错题',
      expectKind: 'write_confirm',
      expectAction: 'export.wrongbook',
      verify: (intent) => {
        assert.equal(intent.params.singleCard, true);
        assert.equal(intent.params.cardId, 'card-tlb');
      },
    },
    {
      name: '开带学（自然句式不必整句死匹配）',
      input: '用带学模式帮我梳理一下这题',
      expectKind: 'enter_guided',
      expectAction: 'assistant.guided',
    },
    {
      name: '查统计',
      input: '今天有多少题到期',
      expectKind: 'readonly_stats',
      expectAction: 'snapshot',
    },
    {
      name: '改设置（护眼主题）',
      input: '切换到护眼模式',
      expectKind: 'set_preference',
      expectAction: 'preferences.set',
    },
    // Fixed navigation bugs from #1444
    {
      name: '打开笔记 -> 笔记页 (not chat)',
      input: '打开笔记',
      expectKind: 'navigate',
      expectAction: 'navigate(notes)',
      verify: (intent) => {
        assert.equal(intent.page, 'notes');
      },
    },
    {
      name: '打开这题的原文 -> 当前题 citation 对应资料与页码 (NOT sources[0])',
      input: '打开这题的原文',
      expectKind: 'navigate',
      expectAction: 'navigate(sources)',
      verify: (intent) => {
        assert.equal(intent.page, 'sources');
        assert.equal(intent.sourceId, 's2', 'must use current card citation sourceId, not sources[0]');
        assert.equal(intent.pageNumber, 17, 'must use current card citation page number');
      },
    },
    {
      name: '回到这道错题继续做 -> review (NOT wrongbook)',
      input: '回到这道错题继续做',
      expectKind: 'navigate',
      expectAction: 'navigate(review)',
      verify: (intent) => {
        assert.equal(intent.page, 'review');
      },
    },
    {
      name: '打开错题本 -> wrongbook',
      input: '打开错题本',
      expectKind: 'navigate',
      expectAction: 'navigate(wrongbook)',
      verify: (intent) => {
        assert.equal(intent.page, 'wrongbook');
      },
    },
  ];

  for (const row of COVERAGE_MATRIX) {
    test(`matrix: ${row.name}`, () => {
      const intent = parseAssistantIntent(row.input, BASE_CTX);
      assert.equal(intent.kind, row.expectKind, `input="${row.input}" got kind=${intent.kind} (${intent.actionName})`);
      assert.equal(intent.actionName, row.expectAction, `input="${row.input}" actionName mismatch`);
      row.verify?.(intent);
    });
  }
});

describe('#1444 Unrecognized action boundary & truthful workflow status', () => {
  test('unrecognized action-like commands return unsupported with honest boundary + guidance (never chat)', () => {
    const cases = [
      { input: '把这题的答案改成 B', mustMention: '[D]' },
      { input: '把这段加入待出题', mustMention: '[H]' },
      { input: '帮我自动把所有题按难度重排并同步到 Notion', mustMention: '不能直接' },
    ];
    for (const c of cases) {
      const intent = parseAssistantIntent(c.input, BASE_CTX);
      assert.equal(intent.kind, 'boundary', `expected boundary for "${c.input}", got ${intent.kind}`);
      assert.match(intent.reason, /不能直接/, `reason must clearly state assistant cannot execute directly: ${intent.reason}`);
      assert.ok(
        intent.reason.includes(c.mustMention) || intent.alternativeLabel.includes(c.mustMention),
        `expected "${c.mustMention}" in reason/alternativeLabel for "${c.input}"`,
      );
    }
  });

  test('pure conceptual questions still route to chat', () => {
    for (const q of ['什么是 Belady 异常？', '为什么 TLB 命中率高？', '解释一下页表和多级页表的区别']) {
      const intent = parseAssistantIntent(q, BASE_CTX);
      assert.equal(intent.kind, 'chat', `conceptual question "${q}" must stay chat`);
    }
  });

  test('multi-step workflow with skipped steps never claims all steps completed', () => {
    assert.equal(typeof formatWorkflowOutcomeSummary, 'function', 'formatWorkflowOutcomeSummary must be exported');
    const plan0 = planAssistantWorkflow('先查看统计，再解释一下为什么 TLB 命中率高', BASE_CTX);
    assert.ok(plan0, 'compound instruction with an executable step must build a workflow');
    let plan = markWorkflowStepResult(plan0, 'done', '到期 3 / 错题 1');
    plan = markWorkflowStepResult(plan, 'skipped', '请单步继续');
    const summary = formatWorkflowOutcomeSummary(plan, 'zh');
    assert.ok(!summary.includes('多步任务已完成'), `must not say 多步任务已完成 when a step was skipped: ${summary}`);
    assert.match(summary, /已执行\s*1\s*步/);
    assert.match(summary, /跳过\s*1\s*步/);
  });
});

function createInkHarness(element, { cols = 100, rows = 30 } = {}) {
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
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(chunk.toString('utf8'));
    if (plain.trim()) frames.push(plain);
  });

  const inst = render(element, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
    interactive: true,
  });

  const latest = () => frames.at(-1) ?? '';
  return {
    latest,
    write: (s) => stdin.write(s),
    async waitFor(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(latest())) return latest();
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timed out waiting for frame. Last frame:\n${latest() || '<empty>'}`);
    },
    cleanup() {
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function resetPanelStore(cardCtx = FULL_CARD) {
  _resetAssistantSessionMemory();
  useTuiStore.setState({
    page: 'review',
    navContext: {},
    history: [],
    inputCaptured: false,
    showLaunchpad: false,
    practiceStack: [],
    assistantOpen: true,
    assistantFocused: true,
    assistantTab: 'assistant',
    assistantStage: 'question',
    assistantFullscreen: false,
    assistantCardContext: cardCtx,
    snapshot: FULL_SNAPSHOT,
    binding: { root: '/tmp' },
    desktopConfig: null,
    activeRunId: 'run-1',
    toasts: [],
    footerHints: [],
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
  });
}

async function submitCommand(h, text) {
  h.write('i');
  await new Promise((r) => setTimeout(r, 40));
  h.write(text);
  await new Promise((r) => setTimeout(r, 50));
  h.write('\r');
}

describe('#1444 Live AssistantPanel honest feedback & real actions', () => {
  test('chat reply never shows "已完成：回答已生成"; unrecognized action shows honest boundary', async () => {
    resetPanelStore();
    const mockHost = {
      call: async () => ({ ok: true, value: {} }),
      getLibraryRoot: () => '/tmp',
      streamComplete: async () => 'Belady 异常指 FIFO 算法分配更多页框时缺页率反而上升。',
    };
    const h = createInkHarness(
      React.createElement(
        Box,
        { width: 100, height: 30 },
        React.createElement(AssistantPanel, {
          host: mockHost,
          isActive: true,
          width: 100,
          height: 30,
          docked: true,
          onClose: () => {},
        }),
      ),
    );
    try {
      await h.waitFor((s) => s.includes('AI 助手'));
      await submitCommand(h, '什么是 Belady 异常？');
      const chatFrame = await h.waitFor((s) => s.includes('缺页率反而上升'));
      assert.ok(!chatFrame.includes('已完成：回答已生成'), `Chat must NOT claim 已完成：回答已生成:\n${chatFrame}`);
      assert.ok(chatFrame.includes('AI 回答'), `Chat should label reply neutrally:\n${chatFrame}`);

      await new Promise((r) => setTimeout(r, 30));
      await submitCommand(h, '帮我自动把所有题按难度重排并同步到 Notion');
      const boundaryFrame = await h.waitFor((s) => s.includes('我目前不能直接'));
      assert.ok(!boundaryFrame.includes('已完成：回答已生成'), 'Unsupported action must never claim 已完成');
      assert.ok(boundaryFrame.includes('[P] 复制提示词'), 'Unsupported action must still offer actionable fallback');
    } finally {
      h.cleanup();
    }
  });

  test('executes real actions: assist.start (prerequisite), card.flag + [z] undo, review.similar, citation navigation, and honest export truncation', async () => {
    const libDir = await mkdtemp(join(tmpdir(), 'studyhub-1444-export-'));
    tempDirs.push(libDir);
    resetPanelStore();
    const calls = [];
    const mockHost = {
      call: async (name, args) => {
        calls.push({ name, args });
        if (name === 'assist.start') {
          return { ok: true, value: { id: 'task-prereq-1', status: 'running', label: '出前置题' } };
        }
        if (name === 'card.flag') {
          return { ok: true, value: { ok: true } };
        }
        if (name === 'review.similar') {
          return {
            ok: true,
            value: {
              item: { deckId: 'deck-os', cardId: 'card-sim-1', prompt: '二级页表如何减少页表占用内存？', topic: '虚拟内存' },
              items: [{ deckId: 'deck-os', cardId: 'card-sim-1', prompt: '二级页表如何减少页表占用内存？', topic: '虚拟内存' }],
            },
          };
        }
        if (name === 'wrongbook') {
          return {
            ok: true,
            value: {
              total: 150,
              items: Array.from({ length: 100 }, (_, i) => ({ prompt: `错题 ${i + 1}` })),
            },
          };
        }
        return { ok: true, value: {} };
      },
      getLibraryRoot: () => libDir,
    };

    const h = createInkHarness(
      React.createElement(
        Box,
        { width: 100, height: 30 },
        React.createElement(AssistantPanel, {
          host: mockHost,
          isActive: true,
          width: 100,
          height: 30,
          docked: true,
          onClose: () => {},
        }),
      ),
    );
    try {
      await h.waitFor((s) => s.includes('AI 助手'));

      // 1) 出前置题下次补强 -> confirm -> calls assist.start (mode: derive, relation: prerequisite)
      await submitCommand(h, '出前置题下次补强');
      await h.waitFor((s) => s.includes('确认生成前置题并关联'));
      await new Promise((r) => setTimeout(r, 30));
      h.write('y');
      await h.waitFor((s) => s.includes('已启动前置题生成后台任务'));
      const assistCall = calls.find((c) => c.name === 'assist.start');
      assert.ok(assistCall, 'must invoke assist.start');
      assert.equal(assistCall.args.mode, 'derive');
      assert.equal(assistCall.args.derive?.relation, 'prerequisite');

      // 2) 标记这道题有问题 -> confirm -> card.flag -> [z] undo clears flag
      await new Promise((r) => setTimeout(r, 40));
      await submitCommand(h, '标记这道题有问题');
      await h.waitFor((s) => s.includes('确认标记题目问题'));
      await new Promise((r) => setTimeout(r, 30));
      h.write('y');
      await h.waitFor((s) => s.includes('已为本题添加问题标记'));
      assert.ok(calls.some((c) => c.name === 'card.flag' && c.args.cardId === 'card-tlb' && c.args.reason));
      h.write('z');
      await h.waitFor((s) => s.includes('已撤销'));
      assert.ok(calls.some((c) => c.name === 'card.flag' && c.args.cardId === 'card-tlb' && c.args.reason === ''));

      // 3) 同类题 -> read-only review.similar displays matched card
      await new Promise((r) => setTimeout(r, 40));
      await submitCommand(h, '再给我一道同类题');
      await h.waitFor((s) => s.includes('二级页表如何减少页表占用内存'));

      // 4) 打开这题的原文 -> jumps to card citation s2 p.17 (not s1)
      await new Promise((r) => setTimeout(r, 40));
      await submitCommand(h, '打开这题的原文');
      await h.waitFor(() => useTuiStore.getState().page === 'sources');
      assert.equal(useTuiStore.getState().navContext.sourceId, 's2');
      assert.equal(useTuiStore.getState().navContext.pageNumber, 17);

      // 5) 导出本课错题 Markdown when total=150 > 100 warns truthfully (no silent truncation)
      await new Promise((r) => setTimeout(r, 40));
      await submitCommand(h, '导出本课错题 Markdown');
      await h.waitFor((s) => s.includes('确认导出错题本'));
      h.write('y');
      await h.waitFor((s) => s.includes('100') && s.includes('150'));
      const files = await readdir(join(libDir, 'backups'));
      const mdFile = files.find((f) => f.startsWith('studyhub-wrongbook'));
      assert.ok(mdFile, 'must write wrongbook export file');
      const content = await readFile(join(libDir, 'backups', mdFile), 'utf8');
      assert.ok(content.includes('错题 1'));
    } finally {
      h.cleanup();
    }
  });
});
