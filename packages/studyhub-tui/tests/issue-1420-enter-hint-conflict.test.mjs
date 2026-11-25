// Regression test for #1420: when AiHelpDrawer is open on an unrevealed card in
// ReviewView, the card must not simultaneously claim "[Enter] 翻开答案" while the
// drawer footer claims "i / Enter 追问".
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ AppShell }, { ReviewView }, { useTuiStore, DEFAULT_PREFERENCES }] = await Promise.all([
  import('../src/shell/AppShell.tsx'),
  import('../src/views/review/ReviewView.tsx'),
  import('../src/state/store.ts'),
]);

function createInkHarness(element, { cols = 150, rows = 34 } = {}) {
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

test('#1420: opening AiHelpDrawer on an unrevealed flashcard removes conflicting [Enter] flip hint from the card', async (t) => {
  const mockRun = {
    id: 'run-1420',
    title: '计算机网络',
    index: 0,
    total: 2,
    answered: 0,
    revealed: false,
    card: {
      id: 'c-1420',
      deckId: 'd-1420',
      kind: 'flashcard',
      prompt: '什么是滑动窗口协议？',
      answer: '发送方无需等待单个 ACK 即可连续发送多个分组。',
      explanation: '提高信道利用率。',
    },
  };
  const snapshot = {
    decks: [{ id: 'd-1420', title: '计算机网络', archived: false, cards: [mockRun.card] }],
    sources: [],
    attempts: [],
  };
  const host = {
    mode: 'embedded',
    snapshot: async () => snapshot,
    call: async (name) => {
      if (name === 'review.get' || name === 'review.start') return { ok: true, value: mockRun };
      return { ok: true, value: {} };
    },
    getLibraryRoot: () => '/tmp',
    close: async () => {},
  };

  useTuiStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false, showKeyHints: true },
    snapshot,
    loading: false,
    showLaunchpad: false,
    page: 'review',
    history: [{ page: 'library', navContext: {} }],
    navContext: { runId: 'run-1420' },
    activeRunId: 'run-1420',
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    quitConfirmOpen: false,
    inputCaptured: false,
    footerHints: [],
    assistantOpen: false,
    assistantFocused: false,
    assistantFullscreen: false,
    toasts: [],
  });

  const harness = createInkHarness(
    React.createElement(AppShell, {
      host,
      autoLaunchpad: false,
      renderPage: (_page, view) => React.createElement(ReviewView, { ...view }),
    }),
  );
  t.after(() => harness.cleanup());

  // 1) Before opening drawer, flashcard shows normal flip hint
  await harness.waitFor(
    (f) => f.includes('什么是滑动窗口协议') && f.includes('按 [Space] 或 [Enter] 翻开答案'),
    4000,
    'flashcard flip hint visible initially',
  );
  await new Promise((r) => setTimeout(r, 40));

  // 2) Press 'h' to open AiHelpDrawer -> bottom bar claims "i / Enter 追问", card must NOT claim "[Enter] 翻开答案"
  harness.write('h');
  const drawerFrame = await harness.waitFor(
    (f) => f.includes('AI 帮我理解') && f.includes('追问'),
    4000,
    'AiHelpDrawer opened',
  );
  assert.ok(
    !drawerFrame.includes('按 [Space] 或 [Enter] 翻开答案'),
    `card must not show conflicting [Enter] flip hint while AiHelpDrawer owns keyboard:\n${drawerFrame}`,
  );
  assert.ok(
    drawerFrame.includes('按 [Esc] 返回题卡后翻开答案'),
    `card should show muted return-to-card hint while drawer is open:\n${drawerFrame}`,
  );

  // 3) Close drawer with Esc -> flashcard flip hint returns
  await new Promise((r) => setTimeout(r, 40));
  harness.write('\x1b');
  await harness.waitFor(
    (f) => f.includes('按 [Space] 或 [Enter] 翻开答案'),
    4000,
    'flashcard flip hint restored after closing drawer',
  );
});
