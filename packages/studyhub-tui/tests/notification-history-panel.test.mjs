// #1354 P2-b — standalone notification history panel.
//
// Covers the four acceptance points from the issue plus the toast pause guarantee:
//   1. three notices are listed newest-first,
//   2. the ring buffer drops the oldest entries beyond 50,
//   3. multi-line notices keep every line in the detail pane (and the list shows first line + count),
//   4. Esc closes only this panel and never leaks to the page underneath,
//   5. opening the panel pauses toast auto-dismiss without touching history.
//
// Run: node --test tests/notification-history-panel.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { Box, Text, render } from 'ink';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { NotificationHistoryModal } = await import('../src/shell/NotificationHistoryModal.tsx');
const { useTuiStore, MAX_TOAST_HISTORY } = await import('../src/state/store.ts');
const { KeyScopeProvider, KEY_LAYER_VIEW, useScopedInput } = await import('../src/components/key-dispatcher.ts');
const { ToastStack } = await import('../src/components/Badge.tsx');
const { AppShell } = await import('../src/shell/AppShell.tsx');

function createMockStreams(columns = 110, rows = 32) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.rows = rows;
  const chunks = [];
  stdout.on('data', (d) => chunks.push(d.toString('utf8')));
  return { stdin, stdout, output: () => chunks.join(''), clear: () => { chunks.length = 0; } };
}

const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

function resetHistory() {
  useTuiStore.setState({ toasts: [], toastHistory: [], notificationHistoryOpen: false, inputCaptured: false });
}

function renderPanel(streams, onClose = () => {}) {
  return render(
    React.createElement(
      Box,
      { width: 120, height: 36 },
      React.createElement(NotificationHistoryModal, { isActive: true, onClose }),
    ),
    { stdin: streams.stdin, stdout: streams.stdout, interactive: true, exitOnCtrlC: false, debug: true },
  );
}

describe('#1354 P2-b notification history panel', () => {
  test('1) three notices appear newest-first', async () => {
    resetHistory();
    const store = useTuiStore.getState();
    store.notify('第一条：课程已切换', 'info', 'library');
    store.notify('第二条：生成完成', 'success', 'generate');
    store.notify('第三条：保存失败', 'error', 'sources');

    assert.equal(useTuiStore.getState().toastHistory.length, 3);
    const streams = createMockStreams(120, 36);
    const inst = renderPanel(streams, () => {});
    try {
      await wait(240);
      const out = streams.output();
      assert.match(out, /通知历史|Notification History/, 'panel title must render');
      const i1 = out.indexOf('第一条');
      const i2 = out.indexOf('第二条');
      const i3 = out.indexOf('第三条');
      assert.ok(i1 >= 0 && i2 >= 0 && i3 >= 0, `all three notices must be visible: ${out}`);
      assert.ok(i3 < i2 && i2 < i1, 'list must be newest-first (third < second < first)');
      assert.match(out, /error/, 'level badge must be shown');
    } finally {
      inst.unmount();
    }
  });

  test('2) history keeps only the latest MAX_TOAST_HISTORY (50) notices', async () => {
    resetHistory();
    const store = useTuiStore.getState();
    for (let i = 0; i < MAX_TOAST_HISTORY + 7; i += 1) {
      store.notify(`msg-${i}`, 'info', 'test');
    }
    const history = useTuiStore.getState().toastHistory;
    assert.equal(history.length, 50);
    assert.equal(history[0].text, 'msg-7', 'oldest entries must be dropped');
    assert.equal(history.at(-1).text, 'msg-56', 'newest entry must be kept');
    assert.equal(history[0].source, 'test', 'optional source must be preserved');

    const streams = createMockStreams(120, 36);
    const inst = renderPanel(streams, () => {});
    try {
      await wait(240);
      const out = streams.output();
      assert.match(out, /msg-56/, 'newest retained notice must render');
      assert.match(out, /最近 50 条|50 recent/, 'panel must report the retained count');
    } finally {
      inst.unmount();
    }
  });

  test('3) multi-line notices keep every line and the list shows first line + line count', async () => {
    resetHistory();
    useTuiStore.getState().notify('第一行：导出失败\n第二行：服务端返回 503\n第三行：请稍后重试', 'error', 'export');

    const streams = createMockStreams(120, 36);
    const inst = renderPanel(streams, () => {});
    try {
      await wait(240);
      const out = streams.output();
      assert.match(out, /第一行：导出失败/, 'first line must be in the list');
      assert.match(out, /\+2/, 'list row must advertise the extra two lines');
      assert.match(out, /第二行：服务端返回 503/, 'detail pane must not truncate line 2');
      assert.match(out, /第三行：请稍后重试/, 'detail pane must not truncate line 3');
    } finally {
      inst.unmount();
    }
  });

  test('4) Esc closes only the panel and never leaks to the lower scope', async () => {
    resetHistory();
    useTuiStore.getState().notify('待回看提示', 'info');
    const hits = { lower: 0, closed: 0 };

    function LowerScope() {
      useScopedInput(
        () => {
          hits.lower += 1;
          return true;
        },
        { isActive: true, layer: KEY_LAYER_VIEW, id: 'test:lower' },
      );
      return React.createElement(Text, null, 'lower');
    }

    const streams = createMockStreams(120, 36);
    const inst = render(
      React.createElement(
        KeyScopeProvider,
        null,
        React.createElement(LowerScope),
        React.createElement(
          KeyScopeProvider,
          { opaque: true },
          React.createElement(NotificationHistoryModal, {
            isActive: true,
            onClose: () => {
              hits.closed += 1;
            },
          }),
        ),
      ),
      { stdin: streams.stdin, stdout: streams.stdout, interactive: true, exitOnCtrlC: false, debug: true },
    );
    try {
      await wait(240);
      streams.stdin.write('\u001b');
      await wait(240);
      assert.equal(hits.closed, 1, 'Esc must close the history panel exactly once');
      assert.equal(hits.lower, 0, 'Esc must not reach the lower page scope');
    } finally {
      inst.unmount();
    }
  });

  test('5) opening history pauses toast auto-dismiss without clearing history', async () => {
    resetHistory();
    useTuiStore.setState({
      toasts: [{ id: 'toast-pause', text: '暂停期间不应消失', tone: 'info', createdAt: Date.now() }],
      toastHistory: [{ id: 'toast-pause', text: '暂停期间不应消失', tone: 'info', createdAt: Date.now() }],
    });
    let dismissed = 0;
    const streams = createMockStreams(100, 30);
    const stack = (paused) =>
      React.createElement(ToastStack, {
        toasts: useTuiStore.getState().toasts,
        onDismiss: () => {
          dismissed += 1;
        },
        width: 40,
        autoDismissMs: 80,
        paused,
      });
    const inst = render(stack(true), {
      stdin: streams.stdin,
      stdout: streams.stdout,
      interactive: true,
      exitOnCtrlC: false,
      debug: true,
    });
    try {
      await wait(320);
      assert.equal(dismissed, 0, 'paused toast must not auto-dismiss');
      assert.equal(useTuiStore.getState().toastHistory.length, 1, 'history must stay intact while paused');
      inst.rerender(stack(false));
      await wait(520);
      assert.equal(dismissed, 1, 'toast must resume dismissing after the panel closes');
    } finally {
      inst.unmount();
    }
  });

  test('6) AppShell: Ctrl+O opens the panel, Esc closes it and keeps the page', async () => {
    useTuiStore.setState({
      page: 'library',
      navContext: {},
      history: [],
      loading: false,
      refreshing: false,
      showLaunchpad: false,
      inputCaptured: false,
      commandPaletteOpen: false,
      helpOpen: false,
      coursePickerOpen: false,
      inboxOpen: false,
      notificationHistoryOpen: false,
      voicePackOpen: false,
      quitConfirmOpen: false,
      assistantOpen: false,
      assistantFocused: false,
      assistantFullscreen: false,
      practiceStack: [],
      toasts: [],
      toastHistory: [],
      snapshot: {
        revision: 1,
        courses: [],
        decks: [],
        focus: {},
        stats: { totalCards: 0, dueToday: 0, reviewedToday: 0 },
        sources: [],
        tasks: [],
        wrongBook: [],
        notes: [],
        modelReady: false,
      },
    });
    useTuiStore.getState().notify('Ctrl+O 打开的提示', 'warning', 'shell');
    const host = {
      getSnapshot: async () => useTuiStore.getState().snapshot,
      runAction: async () => ({ ok: true, value: {} }),
      call: async () => ({ ok: true, value: {} }),
      subscribe: () => () => {},
    };
    const streams = createMockStreams(120, 36);
    const inst = render(
      React.createElement(AppShell, {
        host,
        autoLaunchpad: false,
        renderPage: () => React.createElement(Text, null, 'page-content'),
      }),
      { stdin: streams.stdin, stdout: streams.stdout, interactive: true, exitOnCtrlC: false },
    );
    try {
      await wait(240);
      streams.stdin.write("\u000f"); // Ctrl+O
      await wait(800);
      assert.equal(useTuiStore.getState().notificationHistoryOpen, true, 'Ctrl+O must open history');
      assert.match(streams.output(), /通知历史|Notification History/, 'panel must be visible');

      streams.stdin.write("\u001b");
      await wait(450);
      assert.equal(useTuiStore.getState().notificationHistoryOpen, false, 'Esc must close history');
      assert.equal(useTuiStore.getState().page, 'library', 'Esc must not navigate the page underneath');
    } finally {
      inst.unmount();
    }
  });
});
