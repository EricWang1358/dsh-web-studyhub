// Regression test for #1412:
// 1. Focused docked AssistantPanel shows its own footer hints (not generic "Esc 关闭").
// 2. Pressing Esc while docked panel is focused returns focus to the left page without closing the panel,
//    restoring left-page shortcuts immediately.
// 3. Pressing Esc (goBack) on the page closes the passive docked panel first without leaving the page.
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

const [{ AppShell }, { ReviewView }, { _resetAssistantSessionMemory }, { useTuiStore, DEFAULT_PREFERENCES }] =
  await Promise.all([
    import('../src/shell/AppShell.tsx'),
    import('../src/views/review/ReviewView.tsx'),
    import('../src/shell/AssistantPanel.tsx'),
    import('../src/state/store.ts'),
  ]);

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

test('#1412: Esc unfocuses docked AssistantPanel keeping it open, restores page shortcuts, and next Esc closes panel without leaving page', async (t) => {
  _resetAssistantSessionMemory();
  const answeredCalls = [];
  const mockRun = {
    id: 'run-1412',
    title: '操作系统',
    index: 0,
    total: 2,
    answered: 0,
    revealed: false,
    card: {
      id: 'c-1412',
      deckId: 'd-1412',
      kind: 'single',
      prompt: 'Belady 异常发生在哪种页面置换算法？',
      options: [
        { id: 'A', text: 'FIFO' },
        { id: 'B', text: 'LRU' },
      ],
    },
  };
  const snapshot = {
    decks: [{ id: 'd-1412', title: '操作系统', archived: false, cards: [mockRun.card] }],
    sources: [],
    attempts: [],
  };
  const host = {
    mode: 'embedded',
    snapshot: async () => snapshot,
    call: async (name, payload) => {
      if (name === 'review.get' || name === 'review.start') return { ok: true, value: mockRun };
      if (name === 'review.answer') {
        answeredCalls.push(payload);
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
    close: async () => {},
  };

  useTuiStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false, showKeyHints: true },
    snapshot,
    loading: false,
    showLaunchpad: false,
    page: 'review',
    history: [{ page: 'library', navContext: {} }],
    navContext: { runId: 'run-1412' },
    activeRunId: 'run-1412',
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    quitConfirmOpen: false,
    inputCaptured: false,
    footerHints: [],
    assistantOpen: true,
    assistantFocused: true,
    assistantFullscreen: false,
    assistantTab: 'assistant',
    assistantStage: 'question',
    assistantCardContext: {
      runId: 'run-1412',
      deckId: 'd-1412',
      cardId: 'c-1412',
      prompt: mockRun.card.prompt,
      revealed: false,
    },
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

  // 1) Focused panel shows panel's own footer hints instead of generic "Esc 关闭"
  const focusedFrame = await harness.waitFor(
    (f) => f.includes('Belady 异常') && f.includes('AI 助手') && f.includes('还回页面'),
    4000,
    'panel footer hints shown while focused',
  );
  assert.ok(focusedFrame.includes('快捷指令') || focusedFrame.includes('输入'), 'footer displays panel shortcuts');
  await new Promise((r) => setTimeout(r, 40));

  // 2) First Esc returns keyboard focus to ReviewView WITHOUT closing the docked panel
  harness.write('\x1b');
  await harness.waitFor(
    () => useTuiStore.getState().assistantFocused === false,
    4000,
    'Esc unfocuses assistant panel',
  );
  assert.equal(useTuiStore.getState().assistantOpen, true, 'docked panel stays visible after first Esc');
  assert.equal(useTuiStore.getState().page, 'review', 'still on review page');
  await new Promise((r) => setTimeout(r, 50));

  // 3) Left-page shortcut (1 -> answer option A) works immediately while panel stays open
  harness.write('1');
  await harness.waitFor(() => answeredCalls.length === 1, 4000, 'left page shortcut answered question');
  assert.equal(useTuiStore.getState().assistantOpen, true, 'panel still visible while answering');

  // 4) Next Esc (goBack) on ReviewView closes passive docked panel WITHOUT leaving ReviewView
  harness.write('\x1b');
  await harness.waitFor(() => useTuiStore.getState().assistantOpen === false, 4000, 'second Esc closes docked panel');
  assert.equal(useTuiStore.getState().page, 'review', 'closing passive panel must NOT leave review page');

  // 5) Following Esc leaves ReviewView back to library as normal
  await new Promise((r) => setTimeout(r, 40));
  harness.write('\x1b');
  await harness.waitFor(() => useTuiStore.getState().page === 'library', 4000, 'third Esc navigates back to library');
});
