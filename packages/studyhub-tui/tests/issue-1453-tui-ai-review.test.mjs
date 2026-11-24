// #1453 review fixes: useAiConversation overlapping send, restored prompt copy,
// and next-step follow-up history clearing on card/tool change.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { Box, render } from 'ink';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const srcDir = path.join(pkgRoot, 'src');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function renderDebug(element, cols = 80, rows = 24) {
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
    read() {
      return null;
    },
  });
  const inst = render(element, { stdout, stdin, debug: true, exitOnCtrlC: false });
  return {
    getOutput: () => out,
    rerender: (next) => inst.rerender(next),
    unmount: () => inst.unmount(),
  };
}

function createFrameHarness(element, { cols = 100, rows = 30 } = {}) {
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

  const frames = [];
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim().length > 0) frames.push(plain);
  });

  const inst = render(element, { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true });
  return {
    latest: () => frames.at(-1) ?? '',
    write: (s) => stdin.write(s),
    rerender: (next) => inst.rerender(next),
    unmount: () => inst.unmount(),
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await tick(15);
  }
  return false;
}

describe('#1453 TUI AI review fixes', () => {
  test('1. send() while a previous stream is still in flight keeps the NEW stream live (never reports "aborted")', async () => {
    const { useAiConversation } = await import('../src/components/useAiConversation.ts');

    const calls = [];
    const mockHost = {
      mode: 'embedded',
      streamComplete: ({ onChunk, signal }) =>
        new Promise((resolve, reject) => {
          const call = { onChunk, signal, resolve, reject };
          calls.push(call);
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    };

    let api = null;
    function Harness({ scopeKey }) {
      api = useAiConversation({ host: mockHost, scopeKey, lang: 'en', maxTurns: 6 });
      return React.createElement(Box);
    }

    const h = renderDebug(React.createElement(Harness, { scopeKey: 'card-1' }), 60, 10);
    try {
      const first = api.send({ question: 'First question', system: 'sys', buildPrompt: (q) => q });
      assert.equal(await waitFor(() => api.status === 'streaming'), true, `expected streaming, got ${api.status}`);
      assert.equal(calls.length, 1);

      // User asks again before the first answer finishes.
      const second = api.send({ question: 'Second question', system: 'sys', buildPrompt: (q) => q });
      await tick(10);
      assert.equal(calls.length, 2, 'a second stream call must start');
      assert.equal(calls[0].signal.aborted, true, 'the superseded call must be aborted');

      // The superseded promise settles: it must not touch the new call's state.
      await first;
      await tick(60);
      assert.equal(api.status, 'streaming', 'stale settle must not mark the new answer as aborted');
      assert.equal(api.streaming, true, 'spinner stays on for the visible stream');

      calls[1].onChunk?.('Second answer');
      assert.equal(
        await waitFor(() => /Second answer/.test(api.streamingText)),
        true,
        `live text of the new call must keep rendering (got "${api.streamingText}")`,
      );

      calls[1].resolve('Second answer');
      await second;
      assert.equal(await waitFor(() => api.status === 'done'), true, `expected done, got ${api.status}`);
      assert.equal(api.turns.at(-1)?.text, 'Second answer');
    } finally {
      h.unmount();
    }
  });

  test('2. AssistantPanel keeps the pre-PR single-segment prompt copy (200 chars, Chinese labels) and no longer ships buildAssistantTurnUserPrompt', async () => {
    const ai = await import('../src/host/ai-dialogue.ts');
    assert.equal(
      'buildAssistantTurnUserPrompt' in ai,
      false,
      'buildAssistantTurnUserPrompt must be removed so #1447 can own AssistantPanel multi-turn messages',
    );

    const panel = fs.readFileSync(path.join(srcDir, 'shell/AssistantPanel.tsx'), 'utf8');
    assert.doesNotMatch(panel, /buildAssistantTurnUserPrompt/, 'AssistantPanel must not import the removed single-segment builder');
    assert.match(panel, /x\.text\.slice\(0, 200\)/, 'assistant-panel history must truncate at 200 chars');
    assert.doesNotMatch(panel, /slice\(0, 300\)/, 'assistant-panel history must not truncate at 300 chars');
    assert.match(panel, /当前题目：\$\{/, 'labels must stay Chinese with a full-width colon even in the English UI');
    assert.match(panel, /近期上下文：\\n/, 'recent-context label must stay Chinese with a full-width colon');
    assert.match(panel, /指令：\$\{/, 'instruction label must stay Chinese with a full-width colon');
  });

  test('3. Reader-page and companion system prompts keep their original wording', async () => {
    const ai = await import('../src/host/ai-dialogue.ts');

    assert.equal(
      ai.buildUnifiedAiSystemPrompt('reader_page', 'zh'),
      '你是 StudyHub 终端助教。请严格基于提供的当前页面内容回答用户问题；如需补充通用背景，请明确标注。使用简洁 Markdown 输出。',
    );
    assert.equal(
      ai.buildUnifiedAiSystemPrompt('reader_page', 'en'),
      'You are the StudyHub terminal tutor. Answer based strictly on the provided page text; clearly mark any general background knowledge. Output concise Markdown.',
    );
    assert.equal(
      ai.buildUnifiedAiSystemPrompt('companion', 'zh'),
      '你是 StudyHub 交互伴学导师。请基于伴学课内容与结构简洁回答学习者的困惑，使用 Markdown 与 LaTeX 数学公式。',
    );
    assert.equal(
      ai.buildUnifiedAiSystemPrompt('companion', 'en'),
      'You are the StudyHub Interactive Companion tutor. Answer the learner question concisely in Markdown using the companion context.',
    );

    assert.equal(
      ai.buildReaderPageUserPrompt({
        title: 'OS Slides',
        page: 4,
        lastPage: 20,
        pageText: 'Virtual memory maps virtual pages to physical frames.',
        question: 'What is a page table?',
      }),
      'Document: OS Slides (Page 4/20)\n\n--- PAGE TEXT ---\nVirtual memory maps virtual pages to physical frames.\n--- END ---\n\nQuestion: What is a page table?',
    );
    assert.equal(
      ai.buildCompanionUserPrompt({
        title: 'Binary Trees',
        summaryContext: 'Slide 1: Tree traversal',
        question: 'Why inorder for BST?',
      }),
      'Companion: Binary Trees\n\nSlide 1: Tree traversal\n\nLearner Question: Why inorder for BST?',
    );
  });

  test('4. Next-step follow-up history is cleared on card change and never restored when returning', async () => {
    const { NextStepFollowupBar } = await import('../src/views/review/NextStepFollowupBar.tsx');
    const { useTuiStore, DEFAULT_PREFERENCES } = await import('../src/state/store.ts');
    useTuiStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
      snapshot: null,
      notify: () => {},
    });

    const host = {
      call: async () => ({ ok: true, value: {} }),
      streamComplete: async () => {
        await tick(5);
        return 'ANSWER_FOR_FIRST_CARD';
      },
    };
    const run = { id: 'run-1453', deckId: 'deck-1453', index: 0, card: { prompt: 'Q', topic: 'T' } };

    const element = (cardId) =>
      React.createElement(NextStepFollowupBar, {
        host,
        run,
        cardId,
        kind: 'mcq',
        userAnswer: '',
        toolLabel: 'similar',
        resultContext: 'CTX',
        width: 90,
        isActive: true,
      });

    const h = createFrameHarness(element('card-A'));
    try {
      h.write('a');
      await tick(30);
      h.write('hi');
      await tick(20);
      h.write('\r');
      const shown = await waitFor(() => h.latest().includes('ANSWER_FOR_FIRST_CARD'));
      assert.equal(shown, true, `first answer must render: ${h.latest()}`);

      h.rerender(element('card-B'));
      await tick(30);
      h.rerender(element('card-A'));
      await tick(30);
      h.write('a');
      await tick(40);

      assert.equal(
        h.latest().includes('ANSWER_FOR_FIRST_CARD'),
        false,
        `returning to the same card must not replay the previous conversation: ${h.latest()}`,
      );
    } finally {
      h.unmount();
    }
  });
});
