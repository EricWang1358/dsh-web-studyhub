// Regression test for #1410: every submission in AssistantPanel (input box or
// recommendation chip) must append a visible user turn ("我:") before the reply,
// while recentContext sent to streamComplete never duplicates the current command.
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

test('#1410: AssistantPanel displays user turns for input & chips without duplicating current prompt in recentContext', async (t) => {
  _resetAssistantSessionMemory();
  const capturedPrompts = [];
  const snapshot = {
    decks: [{ id: 'd1', title: '计算机网络', archived: false, cards: [] }],
    sources: [],
    attempts: [],
  };
  const host = {
    mode: 'embedded',
    snapshot: async () => snapshot,
    call: async () => ({ ok: true, value: {} }),
    streamComplete: async ({ prompt }) => {
      capturedPrompts.push(prompt);
      return 'TCP 三次握手用于同步双方初始序列号。';
    },
    close: async () => {},
  };

  useTuiStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
    snapshot,
    page: 'library',
    assistantOpen: true,
    assistantFocused: true,
    assistantTab: 'assistant',
    assistantStage: 'question',
    assistantCardContext: null,
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

  await harness.waitFor((f) => f.includes('[1]查看统计'), 4000, 'chips visible');
  await new Promise((r) => setTimeout(r, 40));

  // 1) Recommendation chip ([1] 查看统计) must echo "我:" + "查看统计" BEFORE the assistant stats reply
  harness.write('1');
  const afterChip = await harness.waitFor(
    (f) => f.includes('我:') && f.includes('活跃题组'),
    4000,
    'user turn visible for chip submission',
  );
  assert.ok(afterChip.indexOf('我:') < afterChip.indexOf('活跃题组'), 'user turn appears before assistant reply');

  // 2) Input-box submission must echo "我:" + learner question AND not duplicate it in recentContext
  harness.write('i');
  await new Promise((r) => setTimeout(r, 40));
  const question = '为什么 TCP 需要三次握手？';
  harness.write(question);
  await new Promise((r) => setTimeout(r, 30));
  harness.write('\r');

  const afterInput = await harness.waitFor(
    (f) => f.includes(question) && f.includes('同步双方初始序列号'),
    4000,
    'user turn and reply visible for input submission',
  );
  assert.ok(
    afterInput.lastIndexOf(question) < afterInput.indexOf('同步双方初始序列号'),
    'user question appears before assistant reply',
  );

  assert.equal(capturedPrompts.length, 1);
  const prompt = capturedPrompts[0];
  const occurrences = prompt.split(question).length - 1;
  assert.equal(occurrences, 1, `current instruction must appear exactly once in model prompt, got:\n${prompt}`);
  assert.match(prompt, /近期上下文：[\s\S]*user: 查看统计/, 'prior turn stays in recentContext');
});
