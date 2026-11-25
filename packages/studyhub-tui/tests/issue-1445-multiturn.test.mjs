// Regression & Contract tests for #1445: True Multi-Turn Assistant Conversation,
// Overflow Compression + User Notice, Fixed Card Grounding (Answer/Explanation/Citations),
// and Shared Guided Retell Session.
// Run: CI=1 node --test tests/issue-1445-multiturn.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import React from 'react';
import { render } from 'ink';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

function createMockStreams(columns = 100, rows = 32) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.rows = rows;
  return { stdin, stdout };
}

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe('#1445: True Multi-Turn Assistant Session & Grounding', () => {
  test('1. buildConversationRequest keeps full multi-turn messages (>6 turns, >200 chars) without 200-char slicing', async () => {
    const mod = await import('../src/shell/assistant-conversation.ts');
    assert.equal(typeof mod.buildConversationRequest, 'function');

    const longReply = '第一段详细解析：Belady 异常只出现在 FIFO 等不满足栈性质的页面置换算法中，因为增大物理帧数并不会保证旧页集合是新页集合的子集。'.repeat(4);
    assert.ok(longReply.length > 240, 'fixture reply must exceed legacy 200-char truncation');

    const turns = [];
    for (let i = 1; i <= 4; i += 1) {
      turns.push({ id: `u${i}`, at: i * 10, role: 'user', scope: 'card-1', text: `第 ${i} 轮追问` });
      turns.push({ id: `a${i}`, at: i * 10 + 1, role: 'assistant', scope: 'card-1', text: i === 4 ? longReply : `第 ${i} 轮回答内容` });
    }

    const built = mod.buildConversationRequest({
      turns,
      currentUserText: '你的上一个回复原文是什么？',
      card: {
        cardId: 'card-1',
        prompt: '哪种页面置换算法可能出现 Belady 异常？',
        userAnswer: 'LRU',
        answer: 'FIFO',
        explanation: 'FIFO 不具备栈性质，增加页框数反而可能增加缺页次数。',
        citations: [{ sourceId: 'src-os', sourceTitle: '操作系统第4章', pageNumber: 12, quote: 'FIFO suffers from Belady anomaly' }],
        revealed: true,
      },
      tab: 'assistant',
      stage: 'question',
      isPlainExplain: false,
      lang: 'zh',
    });

    assert.equal(built.compressed, false);
    assert.equal(built.messages.length, 9, 'must preserve all 8 prior turns + current user turn (not capped at 6)');
    assert.equal(built.messages[7].role, 'assistant');
    assert.equal(built.messages[7].content, longReply, 'assistant reply >200 chars must NOT be truncated');
    assert.equal(built.messages[8].role, 'user');
    assert.equal(built.messages[8].content, '你的上一个回复原文是什么？');

    // Grounding context in system message
    assert.match(built.system, /Belady 异常/, 'system prompt must include question prompt');
    assert.match(built.system, /标准答案：FIFO/, 'system prompt must include standard answer');
    assert.match(built.system, /官方解析：FIFO 不具备栈性质/, 'system prompt must include explanation');
    assert.match(built.system, /操作系统第4章.*p\.12/, 'system prompt must include citation source & page');
    assert.ok(!built.system.includes('不复述用户原话'), 'general chat system prompt must not forbid quoting prior replies verbatim');
  });

  test('2. buildConversationRequest hides answer/explanation during unrevealed exam and compresses overflow with explicit user notice', async () => {
    const mod = await import('../src/shell/assistant-conversation.ts');

    // Exam guard: unrevealed exam card must NOT leak standard answer or explanation
    const examBuilt = mod.buildConversationRequest({
      turns: [],
      currentUserText: '给我一点思路提示',
      card: {
        cardId: 'exam-1',
        prompt: '计算缺页率',
        answer: '42%',
        explanation: '用缺页次数除以总访问次数。',
        isExam: true,
        revealed: false,
      },
      tab: 'assistant',
      stage: 'question',
      isPlainExplain: false,
      lang: 'zh',
    });
    assert.ok(!examBuilt.system.includes('42%'), 'unrevealed exam card must not leak answer');
    assert.ok(!examBuilt.system.includes('用缺页次数除以总访问次数'), 'unrevealed exam card must not leak explanation');

    // Compression when exceeding maxChars
    const bigTurns = [];
    for (let i = 1; i <= 10; i += 1) {
      bigTurns.push({ id: `u${i}`, at: i * 10, role: 'user', scope: 'c1', text: `问题 ${i}: ${'A'.repeat(180)}` });
      bigTurns.push({ id: `a${i}`, at: i * 10 + 1, role: 'assistant', scope: 'c1', text: `回答 ${i}: ${'B'.repeat(220)}` });
    }
    const compressed = mod.buildConversationRequest({
      turns: bigTurns,
      currentUserText: '最新追问',
      card: { cardId: 'c1', prompt: '题干' },
      tab: 'assistant',
      stage: 'question',
      isPlainExplain: false,
      lang: 'zh',
      maxChars: 1200,
    });

    assert.equal(compressed.compressed, true, 'must flag compressed=true when exceeding maxChars');
    assert.ok(compressed.compressedCount > 0, 'must report how many earlier turns were compressed');
    assert.match(compressed.noticeText || '', /压缩/, 'noticeText must explicitly inform user about compression');
    assert.equal(compressed.messages[compressed.messages.length - 1].content, '最新追问');
    assert.ok(compressed.messages.length < bigTurns.length + 1, 'compressed messages array must shrink');
  });

  test('3. OpenAI adapter sends native multi-turn messages array when execution.messages is provided', async () => {
    const { createOpenAiCompleteAdapter } = await import('../../studyhub-desktop/adapters/http/openai-adapter.mjs');
    let capturedBody = null;
    const mockFetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'Verbatim reply OK' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const complete = createOpenAiCompleteAdapter(
      { baseUrl: 'https://api.example.com/v1', model: 'gpt-test', apiKey: 'sk-test' },
      { fetch: mockFetch, report: null },
    );

    const out = await complete('SYS_CTX', 'fallback prompt', {
      stream: false,
      messages: [
        { role: 'user', content: 'Turn 1 question' },
        { role: 'assistant', content: 'Turn 1 exact verbatim answer' },
        { role: 'user', content: 'What was your exact previous reply?' },
      ],
    });
    assert.equal(out, 'Verbatim reply OK');
    assert.deepEqual(capturedBody.messages, [
      { role: 'system', content: 'SYS_CTX' },
      { role: 'user', content: 'Turn 1 question' },
      { role: 'assistant', content: 'Turn 1 exact verbatim answer' },
      { role: 'user', content: 'What was your exact previous reply?' },
    ]);
  });

  test('4. checkRetell forwards conversationHistory from shared session to the model payload', async () => {
    const { checkRetell } = await import('../../../lib/teaching.js');
    let sentPayload = null;
    const stubComplete = async (_sys, userPrompt) => {
      sentPayload = JSON.parse(userPrompt);
      return JSON.stringify({ passed: true, right: ['讲清了核心原理'], missed: [], wrong: [], cite: null });
    };

    const verdict = await checkRetell(stubComplete, {
      material: { question: 'Q1', answer: 'A1', explanation: 'E1', citations: [] },
      citations: 0,
      text: '用自己的话复述要点',
      language: 'zh',
      conversationHistory: [
        { role: 'user', content: '什么是缺页中断？' },
        { role: 'assistant', content: '缺页中断是访问不在内存中的页面时触发的异常。' },
      ],
    });

    assert.equal(verdict.passed, true);
    assert.ok(Array.isArray(sentPayload?.priorDiscussion), 'checkRetell must include priorDiscussion when conversationHistory is given');
    assert.equal(sentPayload.priorDiscussion.length, 2);
    assert.equal(sentPayload.priorDiscussion[1].content, '缺页中断是访问不在内存中的页面时触发的异常。');
  });

  test('5. Live AssistantPanel sends multi-turn messages & shares session with guided retell', async () => {
    const { AssistantPanel, _resetAssistantSessionMemory } = await import('../src/shell/AssistantPanel.tsx');
    const { useTuiStore } = await import('../src/state/store.ts');

    _resetAssistantSessionMemory();
    const streamCalls = [];
    const retellCalls = [];
    const longFirstReply = '这是第一轮完整回复：缺页中断发生时，操作系统会把所需页面从外存调入内存并更新页表，然后重新执行被中断的指令。'.repeat(3);

    const host = {
      call: async (action, args) => {
        if (action === 'teach.retell') {
          retellCalls.push(args);
          return {
            ok: true,
            value: { passed: true, right: ['讲清了调入页面与更新页表'], missed: [], wrong: [] },
          };
        }
        return { ok: true, value: {} };
      },
      streamComplete: async (params) => {
        streamCalls.push(params);
        const reply = streamCalls.length === 1 ? longFirstReply : '上一条原文已完整保留。';
        params.onChunk?.(reply);
        return reply;
      },
      subscribeEvents: () => () => {},
      getLibraryRoot: () => '/tmp/demo',
      getConfig: () => null,
      dispose: async () => {},
    };

    const cardContext = {
      deckId: 'd1',
      cardId: 'c-multi-1',
      prompt: '缺页中断的处理流程是什么？',
      userAnswer: '查页表然后加载页面',
      answer: '陷入内核 -> 分配页框 -> 读入外存页 -> 更新页表 -> 重启指令',
      explanation: '缺页异常属于可恢复故障，处理完后会重新执行触发缺页的指令。',
      citations: [{ sourceId: 's1', sourceTitle: 'OS 讲义', pageNumber: 18, quote: 'Page fault handling' }],
      revealed: true,
    };

    useTuiStore.setState({
      page: 'review',
      assistantOpen: true,
      assistantFocused: true,
      assistantTab: 'assistant',
      assistantStage: 'question',
      assistantFullscreen: false,
      assistantCardContext: cardContext,
      snapshot: { revision: 1, decks: [{ id: 'd1', title: 'OS' }], sources: [], modelReady: true },
      preferences: { ...useTuiStore.getState().preferences, language: 'zh' },
    });

    const { stdin, stdout } = createMockStreams(100, 32);
    const inst = render(
      React.createElement(AssistantPanel, {
        host,
        isActive: true,
        onClose: () => {},
        cardContext,
      }),
      { stdin, stdout, interactive: true, exitOnCtrlC: false },
    );

    try {
      await wait(60);
      // Turn 1: ask a question
      stdin.write('i');
      await wait(60);
      stdin.write('解释一下缺页中断');
      await wait(60);
      stdin.write('\r');
      await wait(140);
      assert.equal(streamCalls.length, 1);
      assert.match(streamCalls[0].system, /陷入内核 -> 分配页框/, 'system must include standard answer');
      assert.match(streamCalls[0].system, /OS 讲义.*p\.18/, 'system must include citation');

      // Turn 2: ask for verbatim previous reply -> must pass full multi-turn messages!
      stdin.write('i');
      await wait(60);
      stdin.write('你的上一个回复原文是什么');
      await wait(60);
      stdin.write('\r');
      await wait(140);
      assert.equal(streamCalls.length, 2);
      assert.ok(Array.isArray(streamCalls[1].messages), 'second turn must pass native messages array');
      assert.ok(
        streamCalls[1].messages.some((m) => m.role === 'assistant' && m.content === longFirstReply),
        'multi-turn messages must include full verbatim previous assistant reply (>200 chars)',
      );

      // Switch to Guided Retell stage and submit retell -> shares conversationHistory with teach.retell!
      useTuiStore.getState().setAssistantTab('guided');
      useTuiStore.getState().setAssistantStage('retell');
      await wait(60);
      stdin.write('i');
      await wait(60);
      stdin.write('操作系统发现缺页后会调入页面并更新页表');
      await wait(60);
      stdin.write('\r');
      await wait(140);
      assert.equal(retellCalls.length, 1);
      assert.ok(Array.isArray(retellCalls[0].conversationHistory), 'teach.retell must receive shared conversationHistory');
      assert.ok(
        retellCalls[0].conversationHistory.some((m) => m.role === 'assistant' && m.content === longFirstReply),
        'teach.retell conversationHistory must include prior assistant turns in this session',
      );
    } finally {
      inst.unmount();
      _resetAssistantSessionMemory();
    }
  });
});
