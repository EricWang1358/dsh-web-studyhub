// Regression test for #1406 (salvaged from #1407): guided-retell prose is a learner answer,
// not an assistant command. It must never be counted in the adaptive chip stats
// (`assistantCommandStats`), otherwise repeated short answers get promoted into command chips
// and evict genuine commands from the per-page top-20. Normal command submits still count.
// node --test tests/issue-1406-retell-usage.test.mjs
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
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

const [{ StudyService }, { AssistantPanel, _resetAssistantSessionMemory }, { useTuiStore, DEFAULT_PREFERENCES }] =
  await Promise.all([
    import('../../../lib/service.js'),
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

async function makeFixtureService(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studyhub-1406-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));
  const service = new StudyService(root, {
    complete: async () =>
      JSON.stringify({ passed: true, right: ['说出了要点'], missed: [], wrong: [], cite: null }),
  });
  await service.store.update((s) => {
    s.decks.push({
      id: 'd-1406',
      title: '计算机网络',
      cards: [
        {
          id: 'c-1406',
          kind: 'flashcard',
          topic: 'HTTP 缓存',
          prompt: 'HTTP 强缓存和协商缓存有什么区别？',
          answer: '强缓存直接复用本地副本不发请求；协商缓存需向服务器验证 ETag/Last-Modified。',
          explanation: 'Cache-Control/Expires 控制强缓存，ETag/If-None-Match 控制协商缓存。',
        },
      ],
    });
  });
  return { root, service };
}

test('#1406: guided-retell prose is not counted as a command in chip stats', async (t) => {
  _resetAssistantSessionMemory();
  const { root, service } = await makeFixtureService(t);
  const snapshot = await service.call('snapshot', {});
  const host = {
    mode: 'embedded',
    dshHome: root,
    snapshot: async () => snapshot,
    call: async (name, args) => {
      try {
        return { ok: true, value: await service.call(name, args) };
      } catch (err) {
        return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
      }
    },
    stream: async () => {
      throw new Error('stream unused');
    },
    close: async () => {},
  };

  useTuiStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
    snapshot,
    page: 'review',
    assistantOpen: true,
    assistantFocused: true,
    assistantTab: 'guided',
    assistantStage: 'retell',
    assistantCardContext: {
      deckId: 'd-1406',
      cardId: 'c-1406',
      prompt: 'HTTP 强缓存和协商缓存有什么区别？',
      revealed: true,
    },
    toasts: [],
  });

  const h = createInkHarness(
    React.createElement(
      Box,
      { width: 100, height: 30 },
      React.createElement(AssistantPanel, { host, width: 96, height: 28, isActive: true, onClose: () => {} }),
    ),
  );
  t.after(() => h.cleanup());

  await h.waitFor((s) => s.includes('复述'), 3000, 'guided retell stage visible');
  await new Promise((r) => setTimeout(r, 40));

  const retellText = '强缓存直接用本地缓存，协商缓存发请求核对 ETag';
  h.write('i');
  await new Promise((r) => setTimeout(r, 40));
  h.write(retellText);
  await new Promise((r) => setTimeout(r, 30));
  h.write('\r');

  await h.waitFor((s) => s.includes('复述通过'), 4000, 'retell verdict shown');
  const stats = useTuiStore.getState().preferences.assistantCommandStats ?? {};
  const reviewStats = stats.review ?? {};
  assert.deepEqual(reviewStats[retellText], undefined, 'retell prose must not be recorded as a command');
  assert.deepEqual(reviewStats, {}, 'a retell submit must not add any command stat');
});

test('#1406: non-retell submits still count as commands', async (t) => {
  _resetAssistantSessionMemory();
  const { root, service } = await makeFixtureService(t);
  const snapshot = await service.call('snapshot', {});
  const host = {
    mode: 'embedded',
    dshHome: root,
    snapshot: async () => snapshot,
    call: async (name, args) => {
      try {
        return { ok: true, value: await service.call(name, args) };
      } catch (err) {
        return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
      }
    },
    stream: async () => {
      throw new Error('stream unused');
    },
    close: async () => {},
  };

  useTuiStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
    snapshot,
    page: 'review',
    assistantOpen: true,
    assistantFocused: true,
    assistantTab: 'chat',
    assistantStage: 'idle',
    assistantCardContext: null,
    toasts: [],
  });

  const h = createInkHarness(
    React.createElement(
      Box,
      { width: 100, height: 30 },
      React.createElement(AssistantPanel, { host, width: 96, height: 28, isActive: true, onClose: () => {} }),
    ),
  );
  t.after(() => h.cleanup());

  await new Promise((r) => setTimeout(r, 80));
  h.write('i');
  await new Promise((r) => setTimeout(r, 40));
  h.write('查看统计');
  await new Promise((r) => setTimeout(r, 30));
  h.write('\r');
  await new Promise((r) => setTimeout(r, 300));

  const stats = useTuiStore.getState().preferences.assistantCommandStats ?? {};
  assert.ok(stats.review?.['查看统计']?.count >= 1, 'typed commands must still be counted');
});
