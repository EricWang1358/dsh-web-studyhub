import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-p2b-toast-'));
const outfile = path.join(outDir, 'bundle.mjs');
await build({
  stdin: {
    contents: [
      `export { default as React } from 'react';`,
      `export { Box, Text, render } from 'ink';`,
      `export { useTuiStore, MAX_TOAST_HISTORY } from './src/state/store.ts';`,
      `export { ToastStack, wrapToastLines, estimateToastStackHeight, toastAutoDismissMs } from './src/components/Badge.tsx';`,
      `export { InboxModal } from './src/shell/InboxModal.tsx';`,
      `export { AppShell } from './src/shell/AppShell.tsx';`,
      `export { ShellActionsContext } from './src/shell/actions.ts';`,
      `export { KeyScopeProvider, useKeyDispatcherBridge } from './src/components/key-dispatcher.ts';`,
    ].join('\n'),
    resolveDir: pkgRoot,
    loader: 'ts',
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(outDir, 'node_modules'), 'junction');
const Bundle = await import(pathToFileURL(outfile).href);
const { React, Box, Text, render } = Bundle;
process.on('exit', () => fs.rmSync(outDir, { recursive: true, force: true }));

function renderToString(element, cols = 60, rows = 20) {
  let out = '';
  const stdout = Object.assign(new EventEmitter(), {
    columns: cols,
    rows,
    isTTY: true,
    write(chunk) {
      out += String(chunk);
      return true;
    },
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    ref() {},
    unref() {},
    read() { return null; },
  });
  const inst = render(element, { stdout, stdin, debug: true, exitOnCtrlC: false });
  inst.unmount();
  return out;
}

test('P2-b: store.notify records persistent toastHistory (capped at MAX_TOAST_HISTORY) that survives dismissToast', () => {
  const store = Bundle.useTuiStore.getState();
  store.clearToastHistory();
  for (const t of [...store.toasts]) store.dismissToast(t.id);

  assert.ok(Bundle.MAX_TOAST_HISTORY >= 30, 'toastHistory must keep at least 30 recent messages');

  store.notify('First multi-line error message that must stay recallable even after auto-dismiss', 'error');
  store.notify('Second info toast', 'info');

  const afterNotify = Bundle.useTuiStore.getState();
  assert.equal(afterNotify.toasts.length, 2);
  assert.equal(afterNotify.toastHistory.length, 2);

  // Dismiss all active toasts -> toastHistory MUST retain both messages
  for (const t of [...afterNotify.toasts]) afterNotify.dismissToast(t.id);
  const afterDismiss = Bundle.useTuiStore.getState();
  assert.equal(afterDismiss.toasts.length, 0);
  assert.equal(afterDismiss.toastHistory.length, 2);
  assert.match(afterDismiss.toastHistory[0].text, /First multi-line error/);

  // Cap check: pushing MAX_TOAST_HISTORY + 10 keeps the most recent MAX_TOAST_HISTORY entries
  for (let i = 0; i < Bundle.MAX_TOAST_HISTORY + 10; i += 1) {
    afterDismiss.notify(`msg-${i}`, 'info');
  }
  const capped = Bundle.useTuiStore.getState();
  assert.equal(capped.toastHistory.length, Bundle.MAX_TOAST_HISTORY);
  assert.equal(capped.toastHistory.at(-1).text, `msg-${Bundle.MAX_TOAST_HISTORY + 9}`);
});

test('P2-b: ToastStack wraps long messages across multiple lines without single-line truncation and scales TTL', () => {
  const longText = '保存讲解失败：服务端返回 503，请检查模型配置后重试，且不要丢弃刚才生成的全部内容。';
  const lines = Bundle.wrapToastLines(longText, 36, false);
  assert.ok(lines.length >= 2, `Expected multi-line wrap, got ${lines.length}: ${JSON.stringify(lines)}`);
  assert.ok(lines.join('').includes('不要丢弃刚才生成的全部内容'), 'Wrapped lines must preserve the tail of the message');

  const errorToast = { id: 't1', text: longText, tone: 'error', createdAt: Date.now() };
  const infoToast = { id: 't2', text: 'OK', tone: 'info', createdAt: Date.now() };
  const errTtl = Bundle.toastAutoDismissMs(errorToast, 5000, lines.length);
  const infoTtl = Bundle.toastAutoDismissMs(infoToast, 5000, 1);
  assert.ok(errTtl > infoTtl && errTtl >= 10000, `Error multi-line toast TTL (${errTtl}) must exceed short info TTL (${infoTtl})`);

  const estRows = Bundle.estimateToastStackHeight([errorToast], 40, false);
  assert.ok(estRows >= 2, `Estimated stack height (${estRows}) must account for wrapped rows`);

  const rendered = renderToString(
    React.createElement(Bundle.ToastStack, {
      toasts: [errorToast],
      onDismiss: () => {},
      width: 40,
      autoDismissMs: 0,
    }),
    60,
    12,
  );
  assert.ok(rendered.includes('保存讲解失败'), `ToastStack should render beginning: ${rendered}`);
  assert.ok(rendered.includes('不要丢弃'), `ToastStack should render wrapped tail without single-line clipping: ${rendered}`);
});

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function createInteractiveTty(cols = 100, rows = 26) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(stdout, { isTTY: true, columns: cols, rows });
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let output = '';
  stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  return {
    stdout,
    stdin,
    async waitFor(predicate, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const plain = stripAnsi(output);
        if (predicate(plain)) return plain;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      throw new Error(`Timed out waiting for Ink output. Tail:\n${stripAnsi(output).slice(-800)}`);
    },
  };
}

test('P2-b: AppShell raises toastTop for wrapped multi-line toasts above footer and InboxModal recalls/clears toastHistory', async () => {
  const prevState = Bundle.useTuiStore.getState();
  const prevPrefs = { ...prevState.preferences };
  const host = {
    async call(action) {
      if (action === 'inbox') return { ok: true, value: { items: [], unread: 0 } };
      return { ok: true, value: {} };
    },
  };
  const renderPage = () => React.createElement(Box, null, React.createElement(Text, null, 'ShellBody'));

  try {
    // 1. AppShell vertical positioning: a multi-line wrapped toast starts higher than a single-line toast
    //    so its tail is never clipped and the footer hint bar remains visible on the bottom row.
    const setShellState = (toasts) => {
      Bundle.useTuiStore.setState({
        page: 'library',
        loading: false,
        showLaunchpad: false,
        snapshot: { decks: [{ id: 'd1', title: 'Demo' }] },
        footerHints: [{ key: 'Enter', label: 'Start' }],
        practiceStack: [],
        commandPaletteOpen: false,
        helpOpen: false,
        coursePickerOpen: false,
        inboxOpen: false,
        notificationHistoryOpen: false,
        quitConfirmOpen: false,
        toasts,
        preferences: {
          ...prevPrefs,
          language: 'zh',
          asciiMode: true,
          compactMode: true,
          showKeyHints: true,
        },
      });
    };

    const singleToast = { id: 'single-1', text: 'SINGLE_TOAST_OK', tone: 'info', createdAt: Date.now() };
    setShellState([singleToast]);
    const singleFrame = stripAnsi(
      renderToString(React.createElement(Bundle.AppShell, { host, renderPage, autoLaunchpad: false }), 80, 24),
    );
    const singleLines = singleFrame.split('\n');
    const singleRow = singleLines.findIndex((line) => line.includes('SINGLE_TOAST_OK'));
    assert.ok(singleRow >= 0, `AppShell must render single-line toast:\n${singleFrame}`);

    const multiText =
      'MULTI_HEAD_503 保存讲解失败：服务端暂时不可用，请检查模型配置后重试，并且完整保留已生成内容 MULTI_TAIL_END';
    const multiToast = { id: 'multi-1', text: multiText, tone: 'error', createdAt: Date.now() };
    setShellState([multiToast]);
    const multiFrame = stripAnsi(
      renderToString(React.createElement(Bundle.AppShell, { host, renderPage, autoLaunchpad: false }), 80, 24),
    );
    const multiLines = multiFrame.split('\n');
    const multiHeadRow = multiLines.findIndex((line) => line.includes('MULTI_HEAD_503'));
    const multiTailRow = multiLines.findIndex((line) => line.includes('MULTI_TAIL_END'));
    const footerRow = multiLines.findIndex((line) => line.includes('Start'));
    assert.ok(multiHeadRow >= 0, `AppShell must render multi-line toast head:\n${multiFrame}`);
    assert.ok(multiTailRow > multiHeadRow, `AppShell must render wrapped multi-line toast tail below head (${multiHeadRow} -> ${multiTailRow})`);
    assert.ok(multiHeadRow < singleRow, `Multi-line toast top row (${multiHeadRow}) must shift above single-line toast row (${singleRow})`);
    assert.ok(footerRow > multiTailRow, `Footer hints row (${footerRow}) must stay below toast tail row (${multiTailRow})`);

    // 2. InboxModal recalls dismissed toast messages under the 近期提示 tab (h) and clears them (C).
    const store = Bundle.useTuiStore.getState();
    store.clearToastHistory();
    for (const t of [...store.toasts]) store.dismissToast(t.id);
    store.notify('RECALLED_TOAST_99: 同步超时，可稍后在收件箱回看完整提示', 'error');
    for (const t of [...Bundle.useTuiStore.getState().toasts]) Bundle.useTuiStore.getState().dismissToast(t.id);
    assert.equal(Bundle.useTuiStore.getState().toasts.length, 0);
    assert.equal(Bundle.useTuiStore.getState().toastHistory.length, 1);

    const shellActions = {
      refresh: async () => {},
      switchCourse: () => {},
      openPalette: () => {},
      openHelp: () => {},
      openCoursePicker: () => {},
      openInbox: () => {},
      openAssistant: () => {},
      quit: () => {},
    };
    function InboxHarness() {
      Bundle.useKeyDispatcherBridge();
      return React.createElement(
        Bundle.ShellActionsContext.Provider,
        { value: shellActions },
        React.createElement(
          Box,
          { width: 100, height: 26 },
          React.createElement(
            Bundle.KeyScopeProvider,
            { id: 'test:inbox', depth: 10 },
            React.createElement(Bundle.InboxModal, { host, isActive: true, onClose: () => {} }),
          ),
        ),
      );
    }

    const tty = createInteractiveTty(100, 26);
    const inst = render(React.createElement(InboxHarness), {
      stdout: tty.stdout,
      stdin: tty.stdin,
      exitOnCtrlC: false,
      interactive: true,
    });
    try {
      const initial = await tty.waitFor((plain) => plain.includes('近期提示') && plain.includes('(1)'));
      assert.ok(initial.includes('近期提示'), 'InboxModal must display 近期提示 tab backed by store.toastHistory');

      tty.stdin.write('h');
      const recalled = await tty.waitFor((plain) => plain.includes('RECALLED_TOAST_99'));
      assert.ok(recalled.includes('RECALLED_TOAST_99'), 'Pressing h in InboxModal must recall dismissed toastHistory entry');

      tty.stdin.write('C');
      await tty.waitFor(() => Bundle.useTuiStore.getState().toastHistory.length === 0);
      assert.equal(Bundle.useTuiStore.getState().toastHistory.length, 0, 'Pressing C on 近期提示 tab must clear toastHistory');
    } finally {
      inst.unmount();
      tty.stdin.end();
      tty.stdout.end();
    }
  } finally {
    const store = Bundle.useTuiStore.getState();
    store.clearToastHistory();
    for (const t of [...store.toasts]) store.dismissToast(t.id);
    Bundle.useTuiStore.setState({
      page: prevState.page,
      loading: prevState.loading,
      showLaunchpad: prevState.showLaunchpad,
      snapshot: prevState.snapshot,
      footerHints: prevState.footerHints,
      practiceStack: prevState.practiceStack,
      preferences: prevPrefs,
    });
  }
});
