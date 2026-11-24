// Regression test for #1406: in Guided Study retell stage, triggering recommendation
// chips ([1]-[4]) or fallback action ([A]) must execute the command intent instead of
// sending the chip command text to `teach.retell` as a learner retell submission.
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

test('#1406: recommendation chips and [A] fallback in guided retell stage never call teach.retell', async (t) => {
  _resetAssistantSessionMemory();
  const root = await mkdtemp(path.join(os.tmpdir(), 'studyhub-1406-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));

  const service = new StudyService(root, {
    complete: async () =>
      JSON.stringify({
        passed: true,
        right: ['关键点正确'],
        missed: [],
        wrong: [],
        cite: null,
      }),
  });

  await service.store.update((s) => {
    s.decks.push({
      id: 'd-1406',
      title: '数据库系统',
      cards: [
        {
          id: 'c-1406',
          kind: 'flashcard',
          topic: 'MVCC',
          prompt: 'MVCC 如何实现非阻塞读？',
          answer: '通过维护多版本快照与 ReadView 判断可见性。',
          explanation: '读操作读取历史版本，不加行锁。',
        },
      ],
    });
  });

  const snapshot = await service.call('snapshot', {});
  const calledActions = [];
  let failNextRetell = false;
  const host = {
    mode: 'embedded',
    snapshot: async () => snapshot,
    call: async (name, args) => {
      calledActions.push({ name, args });
      if (name === 'teach.retell' && failNextRetell) {
        failNextRetell = false;
        return { ok: false, error: { message: 'Model unavailable' } };
      }
      try {
        const value = await service.call(name, args);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
      }
    },
    streamComplete: async () => '通俗地说，MVCC 就像给数据拍快照。',
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
      prompt: 'MVCC 如何实现非阻塞读？',
      answer: '通过维护多版本快照与 ReadView 判断可见性。',
      revealed: true,
      isWrong: true,
      topic: 'MVCC',
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

  await harness.waitFor((f) => f.includes('通俗讲解') && f.includes('查看统计'), 4000, 'guided retell chips visible');
  await new Promise((r) => setTimeout(r, 40));

  // 1) Press [4] (查看统计): must run readonly stats (0 model calls), NOT teach.retell, and stay in retell
  harness.write('4');
  await harness.waitFor((f) => f.includes('活跃题组') && f.includes('只读统计'), 4000, 'stats reply rendered');
  assert.equal(calledActions.filter((a) => a.name === 'teach.retell').length, 0, '[4] 查看统计 must not call teach.retell');
  assert.equal(useTuiStore.getState().assistantStage, 'retell', 'stage stays retell after stats chip');

  // 2) Press chip matching 通俗讲解: must stream plain explanation and open save confirm, NOT call teach.retell
  const explainKey = harness.frame().match(/\[([1-4])\]\s*通俗讲解/)?.[1];
  assert.ok(explainKey, '通俗讲解 chip key should be visible');
  harness.write(explainKey);
  await harness.waitFor((f) => f.includes('快照') || f.includes('保存通俗讲解'), 4000, 'plain explanation generated');
  assert.equal(calledActions.filter((a) => a.name === 'teach.retell').length, 0, '通俗讲解 chip must not call teach.retell');
  assert.equal(useTuiStore.getState().assistantStage, 'retell', 'stage stays retell after plain explanation chip');
  harness.write('\x1b');
  await new Promise((r) => setTimeout(r, 80));

  // 3) Press chip matching 加入错题本: must open write confirm preview, NOT call teach.retell
  const wrongKey = harness.frame().match(/\[([1-4])\]\s*加入错题本/)?.[1];
  assert.ok(wrongKey, '加入错题本 chip key should be visible');
  harness.write(wrongKey);
  await harness.waitFor((f) => f.includes('将执行') && f.includes('错题'), 4000, 'mark wrong confirm preview');
  assert.equal(calledActions.filter((a) => a.name === 'teach.retell').length, 0, '加入错题本 chip must not call teach.retell');
  assert.equal(useTuiStore.getState().assistantStage, 'retell', 'stage stays retell after mark wrong chip');
  harness.write('\x1b');
  await new Promise((r) => setTimeout(r, 60));

  // 4) Trigger a failed user retell so [A] fallback bar appears, then press [A]: must run altCommand (查看统计), NOT teach.retell
  failNextRetell = true;
  harness.write('i');
  await new Promise((r) => setTimeout(r, 40));
  harness.write('我的第一次尝试复述');
  await new Promise((r) => setTimeout(r, 30));
  harness.write('\r');
  await harness.waitFor((f) => f.includes('[A]') && f.includes('[P]'), 4000, 'fallback bar visible after model error');
  assert.equal(calledActions.filter((a) => a.name === 'teach.retell').length, 1, 'failed learner retell called teach.retell once');
  await new Promise((r) => setTimeout(r, 40));

  harness.write('A');
  await harness.waitFor((f) => !f.includes('[A]') && f.includes('只读统计'), 4000, '[A] fallback ran stats command');
  assert.equal(calledActions.filter((a) => a.name === 'teach.retell').length, 1, '[A] fallback must NOT call teach.retell again');
  assert.equal(useTuiStore.getState().assistantStage, 'retell', 'stage stays retell after [A] fallback');

  // 5) Learner-typed retell submission still calls teach.retell and advances stage to summary
  harness.write('i');
  await new Promise((r) => setTimeout(r, 40));
  harness.write('MVCC 通过多版本快照与 ReadView 实现非阻塞读');
  await new Promise((r) => setTimeout(r, 30));
  harness.write('\r');
  await harness.waitFor((f) => f.includes('复述通过'), 4000, 'learner retell evaluated');
  assert.equal(calledActions.filter((a) => a.name === 'teach.retell').length, 2, 'learner-typed input still calls teach.retell');
  assert.equal(useTuiStore.getState().assistantStage, 'summary', 'valid learner retell advances to summary');
});
