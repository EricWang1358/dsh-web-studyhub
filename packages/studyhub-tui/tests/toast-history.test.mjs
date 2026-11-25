import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-p2b-toast-'));
const outfile = path.join(outDir, 'bundle.mjs');
await build({
  stdin: {
    contents: [
      `export { useTuiStore, MAX_TOAST_HISTORY } from './src/state/store.ts';`,
      `export { ToastStack, wrapToastLines, estimateToastStackHeight, toastAutoDismissMs } from './src/components/Badge.tsx';`,
      `export { InboxModal } from './src/shell/InboxModal.tsx';`,
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

test('P2-b: AppShell calculates toastTop using estimateToastStackHeight and InboxModal supports toastHistory recall', () => {
  const appShellSrc = fs.readFileSync(path.join(pkgRoot, 'src/shell/AppShell.tsx'), 'utf8');
  assert.match(appShellSrc, /estimateToastStackHeight/, 'AppShell must size toast overlay height from wrapped toast rows');

  const inboxSrc = fs.readFileSync(path.join(pkgRoot, 'src/shell/InboxModal.tsx'), 'utf8');
  assert.match(inboxSrc, /toastHistory/, 'InboxModal must expose store.toastHistory for message recall');
});
