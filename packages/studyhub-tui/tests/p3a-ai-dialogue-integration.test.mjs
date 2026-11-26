// #1354 P3-a: behavioral & runtime integration tests for the unified AI dialogue send layer
// (`useAiConversation` + `host/ai-dialogue.ts`) across all merged TUI surfaces:
// - `AiHelpDrawer` (Explain)
// - `NextStepFollowupBar` (Follow-up)
// - `AssistantPanel` (Guided Study / Chat / Retell)
// - `DocumentReader` (Page Ask AI)
//
// Exercises real `createTuiHost` + real `StudyService` + interactive Ink rendering (`interactive: true`).
// Zero source-grep assertions; event-driven waits and deterministic deferred promises.
//
// node --test tests/p3a-ai-dialogue-integration.test.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';
import { createVirtualTty, disposeTerminalPool } from './helpers/virtual-tty.mjs';

const unregisterTsx = register();
after(() => {
  try {
    disposeTerminalPool();
  } finally {
    unregisterTsx?.();
  }
});

const [
  { StudyService },
  { createTuiHost },
  { useAiConversation },
  aiDialogue,
  AiHelp,
  NextStep,
  Panel,
  Reader,
  storeMod,
] = await Promise.all([
  import('../../../lib/service.js'),
  import('../src/host/tui-host.ts'),
  import('../src/components/useAiConversation.ts'),
  import('../src/host/ai-dialogue.ts'),
  import('../src/views/review/AiHelpDrawer.tsx'),
  import('../src/views/review/NextStepFollowupBar.tsx'),
  import('../src/shell/AssistantPanel.tsx'),
  import('../src/views/sources/DocumentReader.tsx'),
  import('../src/state/store.ts'),
]);

const { describeAiDialogueError, persistCardQaToFollowupAndNote } = aiDialogue;
const { AiHelpDrawer } = AiHelp;
const { NextStepFollowupBar } = NextStep;
const { AssistantPanel, _resetAssistantSessionMemory } = Panel;
const { DocumentReader } = Reader;
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

const SECRET_ANSWER = 'SECRET_REF_ANSWER_TCP_3WAY_991';
const SECRET_EXPLANATION = 'SECRET_EXPLANATION_SYN_ACK_991';

const CARD_A = {
  id: 'c-p3a-1',
  deckId: 'd-p3a',
  kind: 'short_answer',
  topic: '传输层协议',
  prompt: '为什么 TCP 建立连接需要三次握手？',
  answer: SECRET_ANSWER,
  explanation: SECRET_EXPLANATION,
};

const CARD_B = {
  id: 'c-p3a-2',
  deckId: 'd-p3a',
  kind: 'short_answer',
  topic: '传输层协议',
  prompt: '为什么 UDP 适合实时音视频传输？',
  answer: 'UDP 无连接且无重传延迟，开销小，适合容忍少量丢包的实时流。',
  explanation: '实时音视频优先保证低时延而非严格按序重传。',
};

function makeRun(card = CARD_A, overrides = {}) {
  const revealed = overrides.revealed ?? true;
  return {
    id: `run-${card.id}`,
    deckId: card.deckId,
    index: 0,
    total: 2,
    answered: revealed ? 1 : 0,
    revealed,
    card: { ...card },
    feedback: revealed ? { correct: false, grade: 2, assessment: '缺少接收能力确认说明' } : undefined,
    solution: revealed ? { answer: card.answer, explanation: card.explanation } : undefined,
    ...overrides,
  };
}

function resetStore(extra = {}) {
  useTuiStore.setState({
    page: 'review',
    navContext: {},
    history: [],
    inputCaptured: false,
    commandPaletteOpen: false,
    helpOpen: false,
    snapshot: {
      courses: [{ id: 'course-net', name: '计算机网络' }],
      decks: [{ id: 'd-p3a', title: '计算机网络', course: '计算机网络', cards: [{ ...CARD_A }, { ...CARD_B }] }],
      sources: [],
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
    assistantOpen: true,
    assistantFocused: true,
    assistantTab: 'assistant',
    assistantStage: 'question',
    assistantCardContext: null,
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
    ...extra,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Create a real StudyService library and a real TuiHost with configurable streaming completion. */
async function createRealHost(t, { onComplete, seedSource = false } = {}) {
  _resetAssistantSessionMemory?.();
  const base = await mkdtemp(path.join(os.tmpdir(), 'studyhub-p3a-int-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));
  const libraryRoot = path.join(base, 'library');
  await mkdir(libraryRoot, { recursive: true });

  const seed = new StudyService(libraryRoot, { complete: async () => '{}' });
  await seed.store.update((s) => {
    s.decks.push({
      id: 'd-p3a',
      title: '计算机网络',
      course: '计算机网络',
      cards: [{ ...CARD_A }, { ...CARD_B }],
    });
    if (seedSource) {
      s.sources.push({
        id: 'src-p3a-1',
        title: 'TCP 拥塞控制讲义',
        kind: 'markdown',
        course: '计算机网络',
        text: '# TCP 拥塞控制\n\n慢启动阶段每经过一个 RTT 拥塞窗口 cwnd 翻倍，达到 ssthresh 后进入拥塞避免阶段线性增长。',
        createdAt: new Date().toISOString(),
      });
    }
  });
  await seed.dispose?.();

  const calls = [];
  const host = await createTuiHost({
    libraryRoot,
    env: { DSH_HOME: path.join(base, 'dsh-home') },
    home: base,
    documentsDir: base,
    skipAutoProbe: true,
    language: 'zh',
    injectedComplete: async (system, prompt, execution) => {
      const entry = {
        system: String(system ?? ''),
        prompt: String(prompt ?? ''),
        messages: execution?.messages,
        signal: execution?.signal,
        task: execution?.task,
      };
      calls.push(entry);
      if (onComplete) {
        return onComplete(entry, execution, calls);
      }
      execution?.onChunk?.('默认流式回复');
      return '默认流式回复';
    },
  });
  t.after(() => host.dispose());
  return { base, libraryRoot, host, calls };
}

function mountInteractive(element, { cols = 104, rows = 32 } = {}) {
  const tty = createVirtualTty(cols, rows);
  const instance = render(element, {
    stdin: tty.stdin,
    stdout: tty.stdout,
    stderr: tty.stderr,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    tty,
    instance,
    rerender: (next) => instance.rerender(next),
    cleanup() {
      instance.unmount();
      tty.dispose();
    },
  };
}

describe('P3-a unified AI dialogue integration', () => {
  test('1) useAiConversation: chunked streaming -> done, reasoning callback, unavailable host, and error normalization', async (t) => {
    let conv = null;
    function Probe({ host, lang = 'zh' }) {
      conv = useAiConversation(host, lang);
      return React.createElement(Box, null);
    }

    const { host } = await createRealHost(t, {
      onComplete: async (_entry, execution) => {
        execution?.onReasoning?.(18);
        execution?.onChunk?.('第一段·');
        await Promise.resolve();
        execution?.onReasoning?.(42);
        execution?.onChunk?.('第二段·');
        await Promise.resolve();
        execution?.onChunk?.('第三段');
        return '第一段·第二段·第三段';
      },
    });

    const m = mountInteractive(React.createElement(Probe, { host, lang: 'zh' }), { cols: 60, rows: 10 });
    t.after(() => m.cleanup());
    await m.tty.flush(20);
    assert.ok(conv, 'useAiConversation hook should initialize');

    const chunks = [];
    const reasoningCounts = [];
    const doneOutcome = await conv.send({
      system: 'sys-test',
      prompt: 'prompt-test',
      onChunk: (d) => chunks.push(d),
      onReasoning: (n) => reasoningCounts.push(n),
    });
    assert.deepEqual(doneOutcome, { status: 'done', text: '第一段·第二段·第三段' });
    assert.deepEqual(chunks, ['第一段·', '第二段·', '第三段']);
    assert.deepEqual(reasoningCounts, [18, 42]);

    // Host without streamComplete must resolve cleanly as unavailable (both zh & en)
    const noStreamHost = { ...host, streamComplete: undefined };
    m.rerender(React.createElement(Probe, { host: noStreamHost, lang: 'en' }));
    await m.tty.flush(20);
    const unavailableEn = await conv.send({ system: 's', prompt: 'p' });
    assert.equal(unavailableEn.status, 'unavailable');
    assert.match(unavailableEn.error, /unavailable/i);

    m.rerender(React.createElement(Probe, { host: noStreamHost, lang: 'zh' }));
    await m.tty.flush(20);
    const unavailableZh = await conv.send({ system: 's', prompt: 'p' });
    assert.equal(unavailableZh.status, 'unavailable');
    assert.match(unavailableZh.error, /流式 AI/);

    // Error normalization never leaks raw "Unknown error"
    assert.doesNotMatch(describeAiDialogueError(new Error('Unknown error'), 'en'), /^Unknown error$/);
    assert.match(describeAiDialogueError(null, 'zh'), /AI 请求失败/);
    assert.equal(describeAiDialogueError(new Error('HTTP 503 overloaded'), 'en'), 'HTTP 503 overloaded');
  });

  test('2) AiHelpDrawer: streaming chunks -> history persistence and pre-reveal answer guard before vs after reveal', async (t) => {
    resetStore();
    const releaseFirst = deferred();
    const firstStarted = deferred();
    let callIdx = 0;

    const { host, calls } = await createRealHost(t, {
      onComplete: async (_entry, execution) => {
        callIdx += 1;
        if (callIdx === 1) {
          execution?.onChunk?.('思路提示：先思考双向通信');
          firstStarted.resolve();
          await releaseFirst.promise;
          execution?.onChunk?.('如何确认各自收发能力。');
          return '思路提示：先思考双向通信如何确认各自收发能力。';
        }
        execution?.onChunk?.('揭晓后精讲：结合参考答案确认双方能力。');
        return '揭晓后精讲：结合参考答案确认双方能力。';
      },
    });

    const historyByCard = new Map();
    function StatefulDrawer({ run }) {
      const [history, setHistory] = React.useState([]);
      return React.createElement(AiHelpDrawer, {
        host,
        run,
        cardId: CARD_A.id,
        kind: 'short_answer',
        userAnswer: '我只记得同步序列号',
        width: 96,
        height: 28,
        isActive: true,
        mathUnicode: true,
        history,
        onHistoryChange: (cid, turns) => {
          historyByCard.set(cid, turns);
          setHistory(turns);
        },
        onClose: () => {},
      });
    }
    const makeDrawer = (run) => React.createElement(StatefulDrawer, { run });

    // Phase 1: pre-reveal — reference answer and official explanation must NEVER leak into prompt/messages
    const preRevealRun = makeRun(CARD_A, { revealed: false, feedback: undefined, solution: undefined });
    const m = mountInteractive(makeDrawer(preRevealRun), { cols: 100, rows: 30 });
    t.after(() => m.cleanup());

    await m.tty.firstFramePromise;
    await firstStarted.promise;
    await m.tty.waitFor((s) => s.includes('先思考双向通信'), { timeoutMs: 8_000, label: 'streaming chunk visible' });

    // Release remaining stream chunks -> done state & history persisted
    releaseFirst.resolve();
    await m.tty.waitFor((s) => s.includes('如何确认各自收发能力') && s.includes('已就绪'), {
      timeoutMs: 8_000,
      label: 'initial stream done',
    });

    assert.equal(calls.length, 1);
    const firstPayload = `${calls[0].system}\n${calls[0].prompt}\n${JSON.stringify(calls[0].messages ?? [])}`;
    assert.ok(!firstPayload.includes(SECRET_ANSWER), 'pre-reveal explain must never leak reference answer');
    assert.ok(!firstPayload.includes(SECRET_EXPLANATION), 'pre-reveal explain must never leak explanation');
    assert.match(calls[0].prompt, /不要直接剧透/, 'pre-reveal auto prompt should request a non-spoiler hint');

    const persistedAfterTurn1 = historyByCard.get(CARD_A.id);
    assert.ok(Array.isArray(persistedAfterTurn1) && persistedAfterTurn1.length === 2);
    assert.equal(persistedAfterTurn1[0].role, 'user');
    assert.equal(persistedAfterTurn1[1].role, 'assistant');
    assert.equal(persistedAfterTurn1[1].text, '思路提示：先思考双向通信如何确认各自收发能力。');

    // Phase 2: post-reveal — reference answer is now exposed and prior history is preserved
    const revealedRun = makeRun(CARD_A, { revealed: true });
    m.rerender(makeDrawer(revealedRun));
    await m.tty.flush(20);

    m.tty.send('i');
    await m.tty.waitFor((s) => s.includes('输入你的追问'), { timeoutMs: 5_000, label: 'input focused' });
    m.tty.send('现在结合答案对比一下');
    await m.tty.waitFor((s) => s.includes('现在结合答案对比一下'), { timeoutMs: 5_000, label: 'followup typed' });
    m.tty.send('\r');

    await m.tty.waitFor((s) => s.includes('揭晓后精讲'), { timeoutMs: 8_000, label: 'post-reveal reply' });
    assert.equal(calls.length, 2);
    const secondPayload = `${calls[1].prompt}\n${JSON.stringify(calls[1].messages ?? [])}`;
    assert.ok(secondPayload.includes(SECRET_ANSWER), 'post-reveal explain must include reference answer');
    assert.ok(secondPayload.includes(SECRET_EXPLANATION), 'post-reveal explain must include explanation');
    assert.equal(historyByCard.get(CARD_A.id)?.length, 4, 'turn history should persist all 4 turns');
  });

  test('3) NextStepFollowupBar: pre-reveal guard, streaming delivery, and scope switch reset on resultContext change', async (t) => {
    resetStore();
    let seq = 0;
    const { host, calls } = await createRealHost(t, {
      onComplete: async (_entry, execution) => {
        seq += 1;
        if (seq === 1) {
          execution?.onChunk?.('前置例子第一句，');
          await Promise.resolve();
          execution?.onChunk?.('前置例子第二句。');
          return '前置例子第一句，前置例子第二句。';
        }
        execution?.onChunk?.('切换范围后的全新回答。');
        return '切换范围后的全新回答。';
      },
    });

    const renderBar = (run, resultContext) =>
      React.createElement(
        Box,
        { width: 100, height: 24 },
        React.createElement(NextStepFollowupBar, {
          host,
          run,
          cardId: run.card.id,
          kind: 'short_answer',
          userAnswer: '我写的尝试答案',
          toolLabel: '带学提示',
          resultContext,
          width: 96,
          expandedHeight: 14,
          isActive: true,
        }),
      );

    // Pre-reveal on CARD_A
    const unrevealedRun = makeRun(CARD_A, { revealed: false, feedback: undefined, solution: undefined });
    const m = mountInteractive(renderBar(unrevealedRun, '工具结果A-未揭晓'), { cols: 102, rows: 26 });
    t.after(() => m.cleanup());

    await m.tty.waitFor((s) => s.includes('接下来想做什么'), { timeoutMs: 5_000, label: 'bar idle' });
    m.tty.send('a');
    await m.tty.waitFor((s) => s.includes('Enter 发送'), { timeoutMs: 5_000, label: 'bar focused' });
    m.tty.send('举个生活例子');
    await m.tty.waitFor((s) => s.includes('举个生活例子'), { timeoutMs: 5_000, label: 'typed instruction' });
    m.tty.send('\r');

    await m.tty.waitFor((s) => s.includes('前置例子第二句'), { timeoutMs: 8_000, label: 'chunked followup done' });
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].prompt.includes(SECRET_ANSWER), 'pre-reveal followup must never leak reference answer');
    assert.ok(calls[0].prompt.includes('工具结果A-未揭晓'), 'followup prompt must include tool resultContext');

    // Scope switch with SAME cardId but changed resultContext + revealed run (like SimilarCardsModal)
    const revealedSameCard = makeRun(CARD_A, { revealed: true });
    m.rerender(renderBar(revealedSameCard, '工具结果B-已揭晓'));
    await m.tty.waitFor((s) => s.includes('按 [a] 自由输入') && !s.includes('前置例子第二句'), {
      timeoutMs: 5_000,
      label: 'scope switch resets followup bar',
    });

    m.tty.send('a');
    await m.tty.waitFor((s) => s.includes('Enter 发送'), { timeoutMs: 5_000, label: 'refocused after reset' });
    m.tty.send('对照答案讲讲');
    await m.tty.waitFor((s) => s.includes('对照答案讲讲'), { timeoutMs: 5_000, label: 'typed post-reveal' });
    m.tty.send('\r');
    await m.tty.waitFor((s) => s.includes('切换范围后的全新回答'), { timeoutMs: 8_000, label: 'second reply' });

    assert.equal(calls.length, 2);
    assert.ok(calls[1].prompt.includes(SECRET_ANSWER), 'post-reveal followup must expose reference answer');
    assert.ok(!calls[1].prompt.includes('前置例子第一句'), 'prior scope turns must not leak into new scope');
  });

  test('4) AssistantPanel: streaming chunks, turn history persistence, and scope isolation when switching cards', async (t) => {
    resetStore({
      page: 'review',
      assistantTab: 'assistant',
      assistantStage: 'question',
      assistantCardContext: {
        deckId: 'd-p3a',
        cardId: CARD_A.id,
        prompt: CARD_A.prompt,
        revealed: true,
      },
    });

    const releaseStream = deferred();
    const chunkVisible = deferred();
    let seq = 0;
    const { host, calls } = await createRealHost(t, {
      onComplete: async (_entry, execution) => {
        seq += 1;
        if (seq === 1) {
          execution?.onChunk?.('卡片A流式第一段·');
          chunkVisible.resolve();
          await releaseStream.promise;
          execution?.onChunk?.('卡片A流式第二段');
          return '卡片A流式第一段·卡片A流式第二段';
        }
        if (seq === 2) {
          execution?.onChunk?.('卡片A二轮追问回复');
          return '卡片A二轮追问回复';
        }
        execution?.onChunk?.('卡片B全新作用域回复');
        return '卡片B全新作用域回复';
      },
    });

    const makePanel = (cardCtx) =>
      React.createElement(
        Box,
        { width: 100, height: 30 },
        React.createElement(AssistantPanel, {
          host,
          width: 96,
          height: 28,
          isActive: true,
          cardContext: cardCtx,
          onClose: () => {},
        }),
      );

    const ctxA = { deckId: 'd-p3a', cardId: CARD_A.id, prompt: CARD_A.prompt, revealed: true };
    const ctxB = { deckId: 'd-p3a', cardId: CARD_B.id, prompt: CARD_B.prompt, revealed: true };

    const m = mountInteractive(makePanel(ctxA), { cols: 102, rows: 32 });
    t.after(() => m.cleanup());

    await m.tty.waitFor((s) => s.includes('指令输入'), { timeoutMs: 5_000, label: 'assistant mounted' });
    m.tty.send('i');
    await m.tty.waitFor((s) => s.includes('Enter发送'), { timeoutMs: 5_000, label: 'input focused' });
    m.tty.send('请用一句话讲清三次握手');
    await m.tty.waitFor((s) => s.includes('请用一句话讲清三次握手'), { timeoutMs: 5_000, label: 'typed question' });
    m.tty.send('\r');

    await chunkVisible.promise;
    await m.tty.waitFor((s) => s.includes('卡片A流式第一段'), { timeoutMs: 6_000, label: 'live streaming chunk' });
    releaseStream.resolve();
    await m.tty.waitFor((s) => s.includes('卡片A流式第二段'), { timeoutMs: 8_000, label: 'stream finished' });

    // Follow-up in same scope keeps multi-turn messages
    m.tty.send('i');
    await m.tty.waitFor((s) => s.includes('Enter发送'), { timeoutMs: 5_000, label: 'refocus input' });
    m.tty.send('再补一个常见坑');
    await m.tty.waitFor((s) => s.includes('再补一个常见坑'), { timeoutMs: 5_000, label: 'typed turn 2' });
    m.tty.send('\r');
    await m.tty.waitFor((s) => s.includes('卡片A二轮追问回复'), { timeoutMs: 8_000, label: 'turn 2 finished' });

    assert.equal(calls.length, 2);
    const turn2Payload = JSON.stringify(calls[1].messages ?? []);
    assert.ok(turn2Payload.includes('卡片A流式第一段·卡片A流式第二段'), 'same-scope follow-up must keep prior reply');

    // Switch card scope to CARD_B: card A turns fold away and do NOT leak into card B request
    m.rerender(makePanel(ctxB));
    await m.tty.waitFor((s) => s.includes('已收起') && !s.includes('卡片A二轮追问回复'), {
      timeoutMs: 5_000,
      label: 'scope switch folds card A turns',
    });

    m.tty.send('i');
    await m.tty.waitFor((s) => s.includes('Enter发送'), { timeoutMs: 5_000, label: 'focus card B input' });
    m.tty.send('UDP 为何低延迟');
    await m.tty.waitFor((s) => s.includes('UDP 为何低延迟'), { timeoutMs: 5_000, label: 'typed card B question' });
    m.tty.send('\r');
    await m.tty.waitFor((s) => s.includes('卡片B全新作用域回复'), { timeoutMs: 8_000, label: 'card B reply' });

    assert.equal(calls.length, 3);
    const cardBPayload = `${calls[2].prompt}\n${JSON.stringify(calls[2].messages ?? [])}`;
    assert.ok(!cardBPayload.includes('卡片A流式第一段'), 'card B request must not inherit card A transcript');
  });

  test('5) DocumentReader: Ask-AI streaming chunks, mid-stream Esc abort, and unmount cleanup', async (t) => {
    resetStore({ page: 'reader' });
    let callCount = 0;
    const secondStarted = deferred();
    const secondAborted = deferred();
    const thirdStarted = deferred();
    const thirdAborted = deferred();

    const { host } = await createRealHost(t, {
      seedSource: true,
      onComplete: async (_entry, execution) => {
        callCount += 1;
        if (callCount === 1) {
          execution?.onChunk?.('页内总结：慢启动指数增长，');
          await Promise.resolve();
          execution?.onChunk?.('拥塞避免线性增长。');
          return '页内总结：慢启动指数增长，拥塞避免线性增长。';
        }
        const started = callCount === 2 ? secondStarted : thirdStarted;
        const aborted = callCount === 2 ? secondAborted : thirdAborted;
        execution?.onChunk?.('正在分析当前页...');
        started.resolve();
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            aborted.resolve(true);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          };
          if (execution?.signal?.aborted) {
            onAbort();
            return;
          }
          execution?.signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
    });

    const m = mountInteractive(
      React.createElement(DocumentReader, {
        host,
        sourceId: 'src-p3a-1',
        initialTitle: 'TCP 拥塞控制讲义',
        width: 104,
        height: 30,
        isActive: true,
        onClose: () => {},
      }),
      { cols: 106, rows: 32 },
    );
    t.after(() => m.cleanup());

    await m.tty.waitFor((s) => s.includes('慢启动阶段'), { timeoutMs: 8_000, label: 'reader page loaded' });

    // 1) Normal streaming ask on page
    m.tty.send('a');
    await m.tty.waitFor((s) => s.includes('AI') || s.includes('提问'), { timeoutMs: 5_000, label: 'ask-input open' });
    m.tty.send('总结这两个阶段的区别');
    await m.tty.waitFor((s) => s.includes('总结这两个阶段的区别'), { timeoutMs: 5_000, label: 'typed page question' });
    m.tty.send('\r');
    const askFrame = await m.tty.waitFor(
      (s) => s.includes('慢启动指数增长') && s.includes('拥塞避免线性') && s.includes('[s] 存笔记'),
      { timeoutMs: 8_000, label: 'reader ask streamed' },
    );
    assert.ok(askFrame.includes('长。'), 'wrapped trailing chunk should also be rendered in ask-view');

    // Exit ask-view cleanly
    m.tty.send('\x1b');
    await m.tty.waitFor((s) => !s.includes('[s] 存笔记'), { timeoutMs: 5_000, label: 'returned to read mode' });

    // 2) Mid-stream Esc abort fires AbortController signal
    m.tty.send('a');
    await m.tty.flush(30);
    m.tty.send('需要中止的提问');
    await m.tty.waitFor((s) => s.includes('需要中止的提问'), { timeoutMs: 5_000, label: 'typed abort question' });
    m.tty.send('\r');
    await secondStarted.promise;
    m.tty.send('\x1b');
    assert.equal(await secondAborted.promise, true, 'Esc in DocumentReader ask-view must abort in-flight stream');

    // 3) Unmount mid-stream fires AbortController signal cleanly without unhandled error
    await m.tty.flush(30);
    m.tty.send('a');
    await m.tty.flush(30);
    m.tty.send('卸载时中止');
    await m.tty.waitFor((s) => s.includes('卸载时中止'), { timeoutMs: 5_000, label: 'typed unmount question' });
    m.tty.send('\r');
    await thirdStarted.promise;
    m.cleanup();
    assert.equal(await thirdAborted.promise, true, 'unmounting DocumentReader must abort in-flight stream');
  });

  test('6) Mid-stream abort & unmount cleanup across AiHelpDrawer, AssistantPanel, and NextStepFollowupBar', async (t) => {
    // 6a) AiHelpDrawer: Esc aborts in-flight stream, calls onClose, and does not commit half-finished turn
    resetStore();
    const drawerStarted = deferred();
    const drawerAborted = deferred();
    let drawerClosed = false;
    const drawerHistory = [];

    const { host: drawerHost } = await createRealHost(t, {
      onComplete: async (_entry, execution) => {
        execution?.onChunk?.('未完成抽屉片段');
        drawerStarted.resolve();
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            drawerAborted.resolve(true);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          };
          if (execution?.signal?.aborted) {
            onAbort();
            return;
          }
          execution?.signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
    });

    const mDrawer = mountInteractive(
      React.createElement(AiHelpDrawer, {
        host: drawerHost,
        run: makeRun(CARD_A, { revealed: true }),
        cardId: CARD_A.id,
        kind: 'short_answer',
        userAnswer: '测试',
        width: 96,
        height: 28,
        isActive: true,
        mathUnicode: true,
        onHistoryChange: (_cid, turns) => {
          drawerHistory.push(turns);
        },
        onClose: () => {
          drawerClosed = true;
        },
      }),
      { cols: 100, rows: 30 },
    );
    t.after(() => mDrawer.cleanup());

    await drawerStarted.promise;
    await mDrawer.tty.waitFor((s) => s.includes('未完成抽屉片段'), { timeoutMs: 5_000, label: 'drawer streaming' });
    mDrawer.tty.send('\x1b');
    assert.equal(await drawerAborted.promise, true, 'Esc must abort AiHelpDrawer stream');
    await mDrawer.tty.flush(40);
    assert.equal(drawerClosed, true, 'Esc must invoke onClose');
    const lastDrawerTurns = drawerHistory.at(-1) ?? [];
    assert.equal(
      lastDrawerTurns.some((x) => x.role === 'assistant'),
      false,
      'aborted AiHelpDrawer turn must not commit partial assistant reply',
    );
    mDrawer.cleanup();

    // 6b) AssistantPanel: Esc while streaming aborts, notifies, exits busy, and accepts next request cleanly
    resetStore({
      page: 'review',
      assistantTab: 'assistant',
      assistantCardContext: { deckId: 'd-p3a', cardId: CARD_A.id, prompt: CARD_A.prompt, revealed: true },
    });
    const panelStarted = deferred();
    const panelAborted = deferred();
    let panelCall = 0;
    const { host: panelHost } = await createRealHost(t, {
      onComplete: async (_entry, execution) => {
        panelCall += 1;
        if (panelCall === 1) {
          execution?.onChunk?.('正在长时思考...');
          panelStarted.resolve();
          return new Promise((_resolve, reject) => {
            const onAbort = () => {
              panelAborted.resolve(true);
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            };
            if (execution?.signal?.aborted) {
              onAbort();
              return;
            }
            execution?.signal?.addEventListener('abort', onAbort, { once: true });
          });
        }
        execution?.onChunk?.('中止后恢复正常回复');
        return '中止后恢复正常回复';
      },
    });

    const mPanel = mountInteractive(
      React.createElement(
        Box,
        { width: 100, height: 30 },
        React.createElement(AssistantPanel, {
          host: panelHost,
          width: 96,
          height: 28,
          isActive: true,
          cardContext: { deckId: 'd-p3a', cardId: CARD_A.id, prompt: CARD_A.prompt, revealed: true },
          onClose: () => {},
        }),
      ),
      { cols: 102, rows: 32 },
    );
    t.after(() => mPanel.cleanup());

    await mPanel.tty.waitFor((s) => s.includes('指令输入'), { timeoutMs: 5_000, label: 'panel ready' });
    mPanel.tty.send('i');
    await mPanel.tty.waitFor((s) => s.includes('Enter发送'), { timeoutMs: 5_000, label: 'panel input focused' });
    mPanel.tty.send('卡住的流式问题');
    await mPanel.tty.waitFor((s) => s.includes('卡住的流式问题'), { timeoutMs: 5_000, label: 'typed hang prompt' });
    mPanel.tty.send('\r');
    await panelStarted.promise;

    mPanel.tty.send('\x1b');
    assert.equal(await panelAborted.promise, true, 'Esc while busy must abort AssistantPanel stream');
    await mPanel.tty.flush(40);
    assert.ok(
      useTuiStore.getState().toasts.some((toast) => toast.text.includes('已中止当前操作')),
      'aborting busy AssistantPanel should emit cancellation toast',
    );

    // Next turn succeeds right after abort
    mPanel.tty.send('i');
    await mPanel.tty.waitFor((s) => s.includes('Enter发送'), { timeoutMs: 5_000, label: 'panel input refocused' });
    mPanel.tty.send('重新问一遍');
    await mPanel.tty.waitFor((s) => s.includes('重新问一遍'), { timeoutMs: 5_000, label: 'typed recovery prompt' });
    mPanel.tty.send('\r');
    await mPanel.tty.waitFor((s) => s.includes('中止后恢复正常回复'), { timeoutMs: 8_000, label: 'recovery reply' });
    mPanel.cleanup();

    // 6c) NextStepFollowupBar: unmount mid-stream aborts signal and notifies onFocusChange(false)
    resetStore();
    const barStarted = deferred();
    const barAborted = deferred();
    const focusEvents = [];
    const { host: barHost } = await createRealHost(t, {
      onComplete: async (_entry, execution) => {
        execution?.onChunk?.('半途输出...');
        barStarted.resolve();
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            barAborted.resolve(true);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          };
          if (execution?.signal?.aborted) {
            onAbort();
            return;
          }
          execution?.signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
    });

    const mBar = mountInteractive(
      React.createElement(
        Box,
        { width: 100, height: 24 },
        React.createElement(NextStepFollowupBar, {
          host: barHost,
          run: makeRun(CARD_A, { revealed: true }),
          cardId: CARD_A.id,
          kind: 'short_answer',
          toolLabel: 'AI 讲解',
          resultContext: '已有讲解内容',
          width: 96,
          expandedHeight: 14,
          isActive: true,
          onFocusChange: (engaged) => focusEvents.push(engaged),
        }),
      ),
      { cols: 102, rows: 26 },
    );

    await mBar.tty.waitFor((s) => s.includes('接下来想做什么'), { timeoutMs: 5_000, label: 'bar ready' });
    mBar.tty.send('a');
    await mBar.tty.waitFor((s) => s.includes('Enter 发送'), { timeoutMs: 5_000, label: 'bar input focused' });
    mBar.tty.send('会被卸载打断的追问');
    await mBar.tty.waitFor((s) => s.includes('会被卸载打断的追问'), { timeoutMs: 5_000, label: 'bar typed' });
    mBar.tty.send('\r');
    await barStarted.promise;

    mBar.cleanup();
    assert.equal(await barAborted.promise, true, 'unmounting NextStepFollowupBar must abort active stream');
    assert.equal(focusEvents.at(-1), false, 'unmounting NextStepFollowupBar must release focus engagement');
  });

  test('7) Upstream error preserves partial streaming output without truncation across AiHelpDrawer & NextStepFollowupBar, and recovers cleanly in AssistantPanel', async (t) => {
    // 7a) AiHelpDrawer with partial output before upstream error -> keeps partial text + shows error
    resetStore();
    const partialChunk = '前半段完整分析：三次握手分别验证客户端发、服务端收发、客户端收';
    let drawerAttempt = 0;
    const { host: drawerHost } = await createRealHost(t, {
      onComplete: async (_entry, execution) => {
        drawerAttempt += 1;
        if (drawerAttempt === 1) {
          execution?.onChunk?.(partialChunk);
          await Promise.resolve();
          throw new Error('Upstream 502 Bad Gateway');
        }
        // Second call fails with ZERO chunks -> must roll back unanswered user turn
        throw new Error('Upstream 504 Gateway Timeout');
      },
    });

    const recordedTurns = [];
    function ErrorStatefulDrawer() {
      const [history, setHistory] = React.useState([]);
      return React.createElement(AiHelpDrawer, {
        host: drawerHost,
        run: makeRun(CARD_A, { revealed: true }),
        cardId: CARD_A.id,
        kind: 'short_answer',
        userAnswer: '测试',
        width: 100,
        height: 30,
        isActive: true,
        mathUnicode: true,
        history,
        onHistoryChange: (_cid, turns) => {
          recordedTurns.push([...turns]);
          setHistory(turns);
        },
        onClose: () => {},
      });
    }
    const mDrawer = mountInteractive(
      React.createElement(ErrorStatefulDrawer),
      { cols: 104, rows: 32 },
    );
    t.after(() => mDrawer.cleanup());

    await mDrawer.tty.waitFor((s) => s.includes('Upstream 502 Bad Gateway'), {
      timeoutMs: 8_000,
      label: 'drawer upstream error',
    });
    const finalTurnsAfterPartialErr = recordedTurns.at(-1) ?? [];
    assert.equal(finalTurnsAfterPartialErr.length, 2, 'partial output must be committed as assistant turn');
    assert.equal(
      finalTurnsAfterPartialErr[1].text,
      partialChunk,
      'partial streamed text must be preserved byte-for-byte without truncation',
    );
    assert.ok(mDrawer.tty.readScreen().includes('三次握手分别验证'), 'partial text must stay visible on screen');

    // Now trigger a zero-chunk failure: unanswered user turn must be rolled back (stays at 2 turns, not 3)
    mDrawer.tty.send('i');
    await mDrawer.tty.waitFor((s) => s.includes('输入你的追问'), { timeoutMs: 5_000, label: 'drawer input' });
    mDrawer.tty.send('空输出失败测试');
    await mDrawer.tty.waitFor((s) => s.includes('空输出失败测试'), { timeoutMs: 5_000, label: 'typed zero-chunk' });
    mDrawer.tty.send('\r');
    await mDrawer.tty.waitFor((s) => s.includes('Upstream 504 Gateway Timeout'), {
      timeoutMs: 8_000,
      label: 'drawer zero-chunk error',
    });
    assert.equal(
      recordedTurns.at(-1)?.length,
      2,
      'zero-chunk error must drop unanswered user turn so roles never double up',
    );
    mDrawer.cleanup();

    // 7b) NextStepFollowupBar preserves partial streaming output on upstream error
    resetStore();
    const partialFollowup = '部分后续要点：首先画出状态机转移图，其次标注序列号变化';
    const { host: barHost } = await createRealHost(t, {
      onComplete: async (_entry, execution) => {
        execution?.onChunk?.(partialFollowup);
        await Promise.resolve();
        throw new Error('Stream interrupted by peer');
      },
    });

    const mBar = mountInteractive(
      React.createElement(
        Box,
        { width: 100, height: 24 },
        React.createElement(NextStepFollowupBar, {
          host: barHost,
          run: makeRun(CARD_A, { revealed: true }),
          cardId: CARD_A.id,
          kind: 'short_answer',
          toolLabel: '精讲',
          resultContext: '原解析内容',
          width: 96,
          expandedHeight: 15,
          isActive: true,
        }),
      ),
      { cols: 104, rows: 28 },
    );
    t.after(() => mBar.cleanup());

    await mBar.tty.waitFor((s) => s.includes('接下来想做什么'), { timeoutMs: 5_000, label: 'bar idle' });
    mBar.tty.send('a');
    await mBar.tty.waitFor((s) => s.includes('Enter 发送'), { timeoutMs: 5_000, label: 'bar focused' });
    mBar.tty.send('展开讲状态机');
    await mBar.tty.waitFor((s) => s.includes('展开讲状态机'), { timeoutMs: 5_000, label: 'typed followup' });
    mBar.tty.send('\r');

    await mBar.tty.waitFor((s) => s.includes('Stream interrupted by peer'), {
      timeoutMs: 8_000,
      label: 'bar upstream error',
    });
    const barScreen = mBar.tty.readScreen();
    assert.ok(barScreen.includes('首先画出状态机转移图'), 'NextStepFollowupBar must keep partial output on error');
    assert.ok(barScreen.includes('标注序列号变化'), 'partial output must not be truncated');
    mBar.cleanup();

    // 7c) AssistantPanel surfaces upstream error with [P] fallback and stays interactive
    resetStore({
      page: 'review',
      assistantTab: 'assistant',
      assistantCardContext: { deckId: 'd-p3a', cardId: CARD_A.id, prompt: CARD_A.prompt, revealed: true },
    });
    let panelAttempt = 0;
    const { host: panelHost } = await createRealHost(t, {
      onComplete: async (_entry, execution) => {
        panelAttempt += 1;
        if (panelAttempt === 1) {
          execution?.onChunk?.('半截助手输出');
          await Promise.resolve();
          throw new Error('Provider rate limited 429');
        }
        execution?.onChunk?.('重试后成功输出');
        return '重试后成功输出';
      },
    });
    const mPanel = mountInteractive(
      React.createElement(
        Box,
        { width: 100, height: 30 },
        React.createElement(AssistantPanel, {
          host: panelHost,
          width: 96,
          height: 28,
          isActive: true,
          cardContext: { deckId: 'd-p3a', cardId: CARD_A.id, prompt: CARD_A.prompt, revealed: true },
          onClose: () => {},
        }),
      ),
      { cols: 102, rows: 32 },
    );
    t.after(() => mPanel.cleanup());

    await mPanel.tty.waitFor((s) => s.includes('指令输入'), { timeoutMs: 5_000, label: 'panel ready' });
    mPanel.tty.send('i');
    await mPanel.tty.waitFor((s) => s.includes('Enter发送'), { timeoutMs: 5_000, label: 'panel focus' });
    mPanel.tty.send('触发上游报错');
    await mPanel.tty.waitFor((s) => s.includes('触发上游报错'), { timeoutMs: 5_000, label: 'panel typed' });
    mPanel.tty.send('\r');
    await mPanel.tty.waitFor((s) => s.includes('Provider rate limited 429') && s.includes('[P]'), {
      timeoutMs: 8_000,
      label: 'panel error shown with fallback',
    });

    mPanel.tty.send('i');
    await mPanel.tty.waitFor((s) => s.includes('Enter发送'), { timeoutMs: 5_000, label: 'panel retry focus' });
    mPanel.tty.send('再试一次');
    await mPanel.tty.waitFor((s) => s.includes('再试一次'), { timeoutMs: 5_000, label: 'panel retry typed' });
    mPanel.tty.send('\r');
    await mPanel.tty.waitFor((s) => s.includes('重试后成功输出'), { timeoutMs: 8_000, label: 'panel recovered' });
  });

  test('8) Atomic composite note.qa.save contract: single-call replace:true + title persisted via real host across AiHelpDrawer & NextStepFollowupBar with zero half-writes on failure', async (t) => {
    resetStore();
    const { host: baseHost } = await createRealHost(t, {
      onComplete: async (_entry, execution) => {
        execution?.onChunk?.('可复用的完整解析内容');
        return '可复用的完整解析内容';
      },
    });

    const recordedCalls = [];
    let failAtomicSave = false;
    const instrumentedHost = {
      ...baseHost,
      async call(action, payload) {
        recordedCalls.push({ action, payload });
        if (action === 'note.qa.save' && failAtomicSave) {
          return { ok: false, error: { code: 'note-write-failed', message: '笔记文件被占用' } };
        }
        return baseHost.call(action, payload);
      },
    };

    // 8a) AiHelpDrawer [N] save -> single atomic note.qa.save(replace:true, title)
    const savedCallbacks = [];
    const mDrawer = mountInteractive(
      React.createElement(AiHelpDrawer, {
        host: instrumentedHost,
        run: makeRun(CARD_A, { revealed: true }),
        cardId: CARD_A.id,
        kind: 'short_answer',
        userAnswer: '测试答案',
        width: 96,
        height: 28,
        isActive: true,
        mathUnicode: true,
        onSavedFollowup: (cid, item) => savedCallbacks.push({ cid, item }),
        onClose: () => {},
      }),
      { cols: 100, rows: 30 },
    );
    t.after(() => mDrawer.cleanup());

    await mDrawer.tty.waitFor((s) => s.includes('可复用的完整解析内容') && s.includes('已就绪'), {
      timeoutMs: 8_000,
      label: 'drawer ready to save',
    });

    mDrawer.tty.send('N');
    await mDrawer.tty.waitFor(
      () => useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已保存到本题讲解')),
      { timeoutMs: 8_000, label: 'drawer save success toast' },
    );

    const saveCall = recordedCalls.find((c) => c.action === 'note.qa.save');
    assert.ok(saveCall, 'must call atomic backend composite action note.qa.save');
    assert.equal(recordedCalls.some((c) => c.action === 'card.followup.add'), false, 'must not split into card.followup.add');
    assert.equal(recordedCalls.some((c) => c.action === 'note.qa.add'), false, 'must not split into note.qa.add');
    assert.equal(saveCall.payload.replace, true, 'note.qa.save must pass replace: true');
    assert.equal(saveCall.payload.deckId, 'd-p3a');
    assert.equal(saveCall.payload.cardId, CARD_A.id);
    assert.equal(saveCall.payload.answer, '可复用的完整解析内容');
    assert.ok(
      typeof saveCall.payload.title === 'string' && saveCall.payload.title.includes('计算机网络'),
      `note.qa.save must include daily course note title, got: ${String(saveCall.payload.title)}`,
    );
    assert.equal(savedCallbacks.length, 1);

    // Verify real persistence on backend card AND notes in one atomic transaction
    const cardGet = await baseHost.call('card.get', { deckId: 'd-p3a', cardId: CARD_A.id });
    assert.equal(cardGet.ok, true);
    assert.ok(
      Array.isArray(cardGet.value?.card?.followups) &&
        cardGet.value.card.followups.some((f) => f.answer === '可复用的完整解析内容'),
      'real StudyService must persist the saved followup',
    );
    const notesList = await baseHost.call('note.list', {});
    assert.equal(notesList.ok, true);
    assert.ok(
      Array.isArray(notesList.value?.notes) && notesList.value.notes.length >= 1,
      'real StudyService must persist the study note atomically',
    );
    mDrawer.cleanup();

    // 8b) NextStepFollowupBar [N] save with note.qa.save failure -> truthful error toast, zero partial write
    useTuiStore.setState({ toasts: [] });
    recordedCalls.length = 0;
    failAtomicSave = true;

    const mBar = mountInteractive(
      React.createElement(
        Box,
        { width: 100, height: 24 },
        React.createElement(NextStepFollowupBar, {
          host: instrumentedHost,
          run: makeRun(CARD_A, { revealed: true }),
          cardId: CARD_A.id,
          kind: 'short_answer',
          toolLabel: '费曼复述评估',
          resultContext: '复述结果上下文',
          width: 96,
          expandedHeight: 14,
          isActive: true,
        }),
      ),
      { cols: 102, rows: 26 },
    );
    t.after(() => mBar.cleanup());

    await mBar.tty.waitFor((s) => s.includes('接下来想做什么'), { timeoutMs: 5_000, label: 'bar ready' });
    mBar.tty.send('a');
    await mBar.tty.waitFor((s) => s.includes('Enter 发送'), { timeoutMs: 5_000, label: 'bar focused' });
    mBar.tty.send('帮我整理要点');
    await mBar.tty.waitFor((s) => s.includes('帮我整理要点'), { timeoutMs: 5_000, label: 'bar typed' });
    mBar.tty.send('\r');
    await mBar.tty.waitFor((s) => s.includes('可复用的完整解析内容'), { timeoutMs: 8_000, label: 'bar reply done' });

    mBar.tty.send('N');
    await mBar.tty.waitFor(
      () => useTuiStore.getState().toasts.some((toast) => toast.text.includes('笔记文件被占用')),
      { timeoutMs: 8_000, label: 'atomic failure error toast' },
    );
    const barSave = recordedCalls.find((c) => c.action === 'note.qa.save');
    assert.equal(barSave?.payload.replace, true, 'NextStepFollowupBar must also use atomic note.qa.save with replace: true');
    assert.ok(typeof barSave?.payload.title === 'string' && barSave.payload.title.length > 0);
    mBar.cleanup();

    // 8c) Direct atomic failure: single call fails cleanly with zero follow-up or note split calls
    recordedCalls.length = 0;
    const directFail = await persistCardQaToFollowupAndNote({
      host: instrumentedHost,
      deckId: 'd-p3a',
      cardId: CARD_A.id,
      question: '测试问题',
      answer: '测试回答',
      noteTitle: '2026-11-26 · 计算机网络 · 学习笔记',
      lang: 'zh',
    });
    assert.equal(directFail.ok, false);
    assert.equal(directFail.noteSaved, false);
    assert.match(directFail.error ?? '', /笔记文件被占用/);
    assert.equal(recordedCalls.length, 1);
    assert.equal(recordedCalls[0].action, 'note.qa.save');
  });
});
