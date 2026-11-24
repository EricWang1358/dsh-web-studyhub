// Regression test for #1348: Guided Study retell stage in AssistantPanel must call
// `teach.retell` (not nonexistent `card.retell`), evaluate against real StudyService,
// and never mislabel non-model errors as "模型暂不可用".
// node --test tests/issue-1348-retell-action.test.mjs
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

test('#1348: AssistantPanel guided retell calls real backend teach.retell and never leaks card.retell', async (t) => {
  _resetAssistantSessionMemory();
  const root = await mkdtemp(path.join(os.tmpdir(), 'studyhub-1348-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));

  let modelCalls = 0;
  let capturedPrompt = '';
  const service = new StudyService(root, {
    complete: async (_system, prompt) => {
      modelCalls += 1;
      capturedPrompt = prompt;
      return JSON.stringify({
        passed: true,
        right: ['准确说出了缓存命中的两个条件'],
        missed: [],
        wrong: [],
        cite: null,
      });
    },
  });

  await service.store.update((s) => {
    s.decks.push({
      id: 'd-1348',
      title: '计算机网络',
      cards: [
        {
          id: 'c-1348',
          kind: 'flashcard',
          topic: 'HTTP 缓存',
          prompt: 'HTTP 强缓存和协商缓存有什么区别？',
          answer: '强缓存直接复用本地副本不发请求；协商缓存需向服务器验证 ETag/Last-Modified。',
          explanation: 'Cache-Control/Expires 控制强缓存，ETag/If-None-Match 控制协商缓存。',
        },
      ],
    });
  });

  const snapshot = await service.call('snapshot', {});
  const calledActions = [];
  const host = {
    mode: 'embedded',
    snapshot: async () => snapshot,
    call: async (name, args) => {
      calledActions.push({ name, args });
      try {
        const value = await service.call(name, args);
        return { ok: true, value };
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
      deckId: 'd-1348',
      cardId: 'c-1348',
      prompt: 'HTTP 强缓存和协商缓存有什么区别？',
      answer: '强缓存直接复用本地副本不发请求；协商缓存需向服务器验证 ETag/Last-Modified。',
      revealed: true,
      topic: 'HTTP 缓存',
    },
    toasts: [],
  });

  const h = createInkHarness(
    React.createElement(
      Box,
      { width: 100, height: 30 },
      React.createElement(AssistantPanel, {
        host,
        width: 96,
        height: 28,
        isActive: true,
        onClose: () => {},
      }),
    ),
  );
  t.after(() => h.cleanup());

  await h.waitFor((s) => s.includes('复述'), 3000, 'guided retell stage visible');
  await new Promise((r) => setTimeout(r, 40));

  // Focus input ('i'), type retell explanation, submit
  h.write('i');
  await new Promise((r) => setTimeout(r, 40));
  h.write('强缓存直接用本地缓存，协商缓存发请求核对 ETag');
  await new Promise((r) => setTimeout(r, 30));
  h.write('\r');

  const frame = await h.waitFor((s) => s.includes('复述通过'), 4000, 'retell verdict shown');
  assert.equal(modelCalls, 1, 'real backend teach.retell must invoke model once');
  assert.equal(calledActions.length, 1);
  assert.equal(calledActions[0].name, 'teach.retell', 'must call backend action teach.retell, not card.retell');
  assert.equal(calledActions[0].args.deckId, 'd-1348');
  assert.equal(calledActions[0].args.cardId, 'c-1348');
  assert.equal(calledActions[0].args.text, '强缓存直接用本地缓存，协商缓存发请求核对 ETag');
  assert.ok(capturedPrompt.includes('强缓存直接用本地缓存'), 'backend received learnerExplanation text');
  assert.ok(!frame.includes('Unknown study action'), 'must not fail with Unknown study action');
  assert.ok(!frame.includes('card.retell'), 'must not leak internal card.retell string in UI');
  assert.equal(useTuiStore.getState().assistantStage, 'summary', 'advances to summary stage after evaluation');
});

test('#1348: non-model retell failure is not mislabeled as 模型暂不可用', async (t) => {
  _resetAssistantSessionMemory();
  const host = {
    mode: 'embedded',
    snapshot: async () => null,
    call: async () => ({ ok: false, error: { message: 'Card not found in deck' } }),
    stream: async () => {
      throw new Error('stream unused');
    },
    close: async () => {},
  };

  useTuiStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
    snapshot: null,
    page: 'review',
    assistantOpen: true,
    assistantFocused: true,
    assistantTab: 'guided',
    assistantStage: 'retell',
    assistantCardContext: {
      deckId: 'd-missing',
      cardId: 'c-missing',
      prompt: '示例题干',
      revealed: true,
    },
    toasts: [],
  });

  const h = createInkHarness(
    React.createElement(
      Box,
      { width: 100, height: 30 },
      React.createElement(AssistantPanel, {
        host,
        width: 96,
        height: 28,
        isActive: true,
        onClose: () => {},
      }),
    ),
  );
  t.after(() => h.cleanup());

  await h.waitFor((s) => s.includes('复述'), 3000, 'retell stage ready');
  await new Promise((r) => setTimeout(r, 40));
  h.write('i');
  await new Promise((r) => setTimeout(r, 40));
  h.write('我的复述内容');
  await new Promise((r) => setTimeout(r, 30));
  h.write('\r');

  const frame = await h.waitFor((s) => s.includes('Card not found in deck'), 4000, 'error rendered');
  assert.ok(!frame.includes('模型暂不可用'), 'non-model error must not be mislabeled as 模型暂不可用');
});
