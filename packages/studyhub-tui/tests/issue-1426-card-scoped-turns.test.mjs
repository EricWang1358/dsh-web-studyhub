// Regression test for #1426: AssistantPanel turns must be scoped by cardId
// (or null when off-card), hiding other cards' turns behind a collapsible
// "之前的对话 N 条已收起（按 [H] 展开）" toggle and excluding other cards from
// the model's `recentContext`.
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ AssistantPanel, _resetAssistantSessionMemory }, { useTuiStore, DEFAULT_PREFERENCES }] = await Promise.all([
  import('../src/shell/AssistantPanel.tsx'),
  import('../src/state/store.ts'),
]);

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

  let latest = '';
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim()) latest = plain;
  });

  const instance = render(element, { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true });

  return {
    write: (data) => stdin.write(data),
    frame: () => latest,
    async waitFor(pred, timeoutMs = 4000, label = 'condition') {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (pred(latest)) return latest;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`waitFor(${label}) timed out. Last frame:\n${latest}`);
    },
    cleanup() {
      instance.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

test('#1426: switching cards isolates panel transcript & model recentContext while collapsing prior turns behind [H]', async (t) => {
  _resetAssistantSessionMemory();
  const capturedPrompts = [];
  const snapshot = { decks: [], sources: [], attempts: [] };
  let replyCount = 0;
  const host = {
    mode: 'embedded',
    snapshot: async () => snapshot,
    call: async () => ({ ok: true, value: {} }),
    streamComplete: async ({ prompt }) => {
      capturedPrompts.push(prompt);
      replyCount += 1;
      return replyCount === 1 ? 'CARD_A_UNIQUE_ANSWER' : 'CARD_B_UNIQUE_ANSWER';
    },
    close: async () => {},
  };

  useTuiStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
    snapshot,
    page: 'review',
    assistantOpen: true,
    assistantFocused: true,
    assistantTab: 'assistant',
    assistantStage: 'question',
    assistantCardContext: {
      deckId: 'd1',
      cardId: 'card-A',
      cardIndex: 0,
      total: 2,
      prompt: 'Card A: 什么是死锁？',
    },
    toasts: [],
  });

  const harness = createInkHarness(
    React.createElement(
      Box,
      { width: 100, height: 30 },
      React.createElement(AssistantPanel, {
        host,
        width: 96,
        height: 28,
        docked: true,
        isActive: true,
        onClose: () => {},
      }),
    ),
  );
  t.after(() => harness.cleanup());

  await harness.waitFor((f) => f.includes('按 [1-4] 直达推荐动作'), 4000, 'initial card A intro');
  await new Promise((r) => setTimeout(r, 40));

  // 1) Ask on Card A
  harness.write('i');
  await new Promise((r) => setTimeout(r, 40));
  harness.write('解释死锁四个条件');
  await new Promise((r) => setTimeout(r, 30));
  harness.write('\r');
  await harness.waitFor((f) => f.includes('CARD_A_UNIQUE_ANSWER'), 4000, 'Card A answer rendered');

  // 2) Switch to Card B: Card A's answer must be collapsed, Card B intro visible
  useTuiStore.setState({
    assistantCardContext: {
      deckId: 'd1',
      cardId: 'card-B',
      cardIndex: 1,
      total: 2,
      prompt: 'Card B: 什么是虚拟内存？',
    },
  });

  const cardBFrame = await harness.waitFor(
    (f) => f.includes('之前的对话') && f.includes('已收起') && f.includes('按 [1-4] 直达推荐动作'),
    4000,
    'Card B opens clean with collapsed prior indicator',
  );
  assert.ok(!cardBFrame.includes('CARD_A_UNIQUE_ANSWER'), 'Card A reply must stay hidden when collapsed on Card B');

  // 3) Press [H] to expand prior turns, then [H] again to collapse
  await new Promise((r) => setTimeout(r, 40));
  harness.write('H');
  await harness.waitFor((f) => f.includes('CARD_A_UNIQUE_ANSWER'), 4000, '[H] expands prior card turns');
  await new Promise((r) => setTimeout(r, 40));
  harness.write('H');
  await harness.waitFor((f) => !f.includes('CARD_A_UNIQUE_ANSWER') && f.includes('已收起'), 4000, '[H] collapses prior turns again');

  // 4) Ask on Card B -> model prompt must NOT include Card A's conversation in recentContext
  harness.write('i');
  await new Promise((r) => setTimeout(r, 40));
  harness.write('讲一下页表的作用');
  await new Promise((r) => setTimeout(r, 30));
  harness.write('\r');
  await harness.waitFor((f) => f.includes('CARD_B_UNIQUE_ANSWER'), 4000, 'Card B answer rendered');
  assert.equal(capturedPrompts.length, 2);
  assert.ok(
    !capturedPrompts[1].includes('CARD_A_UNIQUE_ANSWER'),
    `Card B recentContext must not leak Card A's reply, got:\n${capturedPrompts[1]}`,
  );

  // 5) Leave Review to Library (off-card): both card A and card B turns are collapsed
  useTuiStore.setState({
    page: 'library',
    assistantCardContext: null,
  });
  const libFrame = await harness.waitFor(
    (f) => f.includes('当前：学习库') && f.includes('之前的对话') && f.includes('已收起'),
    4000,
    'Library off-card view hides card-specific turns behind collapsed bar',
  );
  assert.ok(!libFrame.includes('CARD_B_UNIQUE_ANSWER'), 'off-card view must not show Card B transcript');
});
