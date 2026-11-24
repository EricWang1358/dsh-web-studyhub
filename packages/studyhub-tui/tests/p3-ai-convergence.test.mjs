// P3 (#1354 D7): Permanent AI Dialogue, Prompt Registry, useAiConversation & <AiConversation> Convergence Guardrails.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { render } from 'ink';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const srcDir = path.join(pkgRoot, 'src');

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
    unmount: () => inst.unmount(),
  };
}

describe('P3 (#1354 D7): Unified AI Dialogue, Prompts, useAiConversation & <AiConversation>', () => {
  test('1. Static guardrail: all 6 AI dialogue surfaces share host/ai-dialogue.ts with zero scattered system prompts', () => {
    const promptConsumers = [
      'views/review/review-helpers.ts',
      'views/review/AiHelpDrawer.tsx',
      'views/review/NextStepFollowupBar.tsx',
      'views/review/TeachModal.tsx',
      'views/review/RetellModal.tsx',
      'shell/AssistantPanel.tsx',
      'views/sources/DocumentReader.tsx',
      'views/sources/CompanionsModal.tsx',
    ];
    for (const rel of promptConsumers) {
      const code = fs.readFileSync(path.join(srcDir, rel), 'utf8');
      assert.match(code, /host\/ai-dialogue\.js/, `${rel} must import shared AI helpers from host/ai-dialogue.js`);
    }

    const readerCode = fs.readFileSync(path.join(srcDir, 'views/sources/DocumentReader.tsx'), 'utf8');
    assert.doesNotMatch(
      readerCode,
      /你是 StudyHub 终端助教|You are the StudyHub terminal tutor/,
      'DocumentReader.tsx must use buildUnifiedAiSystemPrompt("reader_page", lang) instead of inline system prompt',
    );
    assert.match(readerCode, /buildReaderPageUserPrompt/, 'DocumentReader.tsx must use buildReaderPageUserPrompt()');

    const compCode = fs.readFileSync(path.join(srcDir, 'views/sources/CompanionsModal.tsx'), 'utf8');
    assert.doesNotMatch(
      compCode,
      /你是 StudyHub 交互伴学导师|StudyHub Interactive Companion tutor/,
      'CompanionsModal.tsx must use buildUnifiedAiSystemPrompt("companion", lang) instead of inline system prompt',
    );
    assert.match(compCode, /buildCompanionUserPrompt/, 'CompanionsModal.tsx must use buildCompanionUserPrompt()');

    const assistantCode = fs.readFileSync(path.join(srcDir, 'shell/AssistantPanel.tsx'), 'utf8');
    assert.match(
      assistantCode,
      /buildAssistantTurnUserPrompt/,
      'AssistantPanel.tsx must use buildAssistantTurnUserPrompt() instead of hand-assembling prompt arrays',
    );
  });

  test('2. Static guardrail: AiHelpDrawer & NextStepFollowupBar delegate streaming to useAiConversation (<AiConversation> stays marked-free)', () => {
    const hookPath = path.join(srcDir, 'components/useAiConversation.ts');
    const compPath = path.join(srcDir, 'components/AiConversation.tsx');
    assert.ok(fs.existsSync(hookPath), 'src/components/useAiConversation.ts must exist');
    assert.ok(fs.existsSync(compPath), 'src/components/AiConversation.tsx must exist');

    const hookCode = fs.readFileSync(hookPath, 'utf8');
    const compCode = fs.readFileSync(compPath, 'utf8');
    assert.doesNotMatch(hookCode, /\bfrom\s+['"](?:marked|.*MarkdownView\.js)['"]/, 'useAiConversation.ts must stay marked-free');
    assert.doesNotMatch(compCode, /\bfrom\s+['"](?:marked|.*MarkdownView\.js)['"]/, 'AiConversation.tsx must stay marked-free');

    const drawerCode = fs.readFileSync(path.join(srcDir, 'views/review/AiHelpDrawer.tsx'), 'utf8');
    assert.match(drawerCode, /useAiConversation/, 'AiHelpDrawer.tsx must consume useAiConversation');
    assert.doesNotMatch(drawerCode, /host\.streamComplete\s*\(/, 'AiHelpDrawer.tsx must not duplicate host.streamComplete loop');

    const followupCode = fs.readFileSync(path.join(srcDir, 'views/review/NextStepFollowupBar.tsx'), 'utf8');
    assert.match(followupCode, /useAiConversation/, 'NextStepFollowupBar.tsx must consume useAiConversation');
    assert.match(followupCode, /AiConversation/, 'NextStepFollowupBar.tsx must render transcript via <AiConversation>');
    assert.doesNotMatch(followupCode, /host\.streamComplete\s*\(/, 'NextStepFollowupBar.tsx must not duplicate host.streamComplete loop');
  });

  test('3. Unified prompt builders & content-digest scope keys cover all 7 modes cleanly', async () => {
    const ai = await import('../src/host/ai-dialogue.ts');

    const modes = ['explain', 'plain_explain', 'followup', 'guided', 'assistant', 'reader_page', 'companion'];
    for (const mode of modes) {
      for (const lang of ['zh', 'en']) {
        const sys = ai.buildUnifiedAiSystemPrompt(mode, lang, { stageLabel: '复述' });
        assert.ok(sys.trim().length >= 20, `System prompt for ${mode}/${lang} must be non-empty`);
      }
    }

    const readerPrompt = ai.buildReaderPageUserPrompt({
      title: 'OS Slides',
      page: 4,
      lastPage: 20,
      pageText: 'Virtual memory maps virtual pages to physical frames.',
      question: 'What is a page table?',
      lang: 'en',
    });
    assert.ok(readerPrompt.includes('OS Slides') && readerPrompt.includes('Page 4/20') && readerPrompt.includes('What is a page table?'));

    const companionPrompt = ai.buildCompanionUserPrompt({
      title: 'Binary Trees',
      summaryContext: 'Slide 1: Tree traversal',
      question: 'Why inorder for BST?',
      lang: 'zh',
    });
    assert.ok(companionPrompt.includes('Binary Trees') && companionPrompt.includes('Why inorder for BST?'));

    const assistantPrompt = ai.buildAssistantTurnUserPrompt({
      cardPrompt: 'Explain deadlock',
      userAnswer: 'Circular wait',
      history: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello' }],
      question: 'Give an example',
      lang: 'zh',
    });
    assert.ok(assistantPrompt.includes('Explain deadlock') && assistantPrompt.includes('Give an example'));

    // Scope key combines id + content digest (#1354 D7)
    const k1 = ai.buildConversationScopeKey('card-1', 'Original prompt');
    const k2 = ai.buildConversationScopeKey('card-1', 'Original prompt');
    const k3 = ai.buildConversationScopeKey('card-1', 'Edited prompt');
    assert.equal(k1, k2, 'Identical entity + content must yield identical scope key');
    assert.notEqual(k1, k3, 'Edited content must yield a distinct scope key to avoid stale history');
    assert.equal(ai.buildConversationScopeKey('card-1'), 'card-1', 'Empty content falls back to raw id');
  });

  test('4. useAiConversation lifecycle: idle -> streaming -> done, error with partial preservation, and abort()', async () => {
    const { useAiConversation } = await import('../src/components/useAiConversation.ts');
    const { Box } = await import('ink');

    let api = null;
    let streamBehavior = 'success';
    let abortObserved = false;
    const mockHost = {
      mode: 'embedded',
      streamComplete: async ({ onChunk, onReasoning, signal }) => {
        if (streamBehavior === 'success') {
          onReasoning?.(12);
          onChunk?.('Part 1 ');
          onChunk?.('Part 2');
          return 'Part 1 Part 2';
        }
        if (streamBehavior === 'error_partial') {
          onChunk?.('Partial insight');
          throw new Error('upstream 503');
        }
        if (streamBehavior === 'abort') {
          return await new Promise((_resolve, reject) => {
            onChunk?.('Working...');
            signal?.addEventListener('abort', () => {
              abortObserved = true;
              reject(new Error('aborted'));
            });
          });
        }
        return '';
      },
    };

    function Harness({ scopeKey }) {
      const conv = useAiConversation({ host: mockHost, scopeKey, lang: 'en', maxTurns: 6 });
      api = conv;
      return React.createElement(Box);
    }

    const h = renderDebug(React.createElement(Harness, { scopeKey: 'c1' }), 60, 10);
    try {
      assert.equal(api.status, 'idle');
      assert.deepEqual(api.turns, []);

      // 1) Success path
      await api.send({
        question: 'Explain TCP',
        system: 'sys',
        buildPrompt: (q) => q,
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(api.status, 'done');
      assert.equal(api.turns.length, 2);
      assert.equal(api.turns[0].text, 'Explain TCP');
      assert.equal(api.turns[1].text, 'Part 1 Part 2');
      assert.equal(api.errorText, null);

      // 2) Error path preserves partial text
      streamBehavior = 'error_partial';
      await api.send({
        question: 'More details',
        system: 'sys',
        buildPrompt: (q) => q,
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(api.status, 'error');
      assert.match(api.errorText || '', /upstream 503/);
      assert.equal(api.turns.at(-1)?.text, 'Partial insight');

      // 3) Abort path
      streamBehavior = 'abort';
      const pending = api.send({
        question: 'Long question',
        system: 'sys',
        buildPrompt: (q) => q,
      });
      await new Promise((r) => setTimeout(r, 15));
      api.abort();
      await pending;
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(abortObserved, true, 'abort() must trigger AbortSignal on in-flight streamComplete');
      assert.equal(api.status, 'aborted');
      assert.equal(api.streaming, false);
    } finally {
      h.unmount();
    }
  });

  test('5. <AiConversation> renders turns, streaming buffer, and wrapped error banner cleanly in pure ASCII', async () => {
    const { AiConversation } = await import('../src/components/AiConversation.tsx');
    const { useTuiStore, DEFAULT_PREFERENCES } = await import('../src/state/store.ts');
    useTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true } });

    const h = renderDebug(
      React.createElement(AiConversation, {
        turns: [
          { role: 'user', text: '什么是死锁？' },
          { role: 'assistant', text: '死锁是多个进程互相等待资源。' },
        ],
        streaming: true,
        streamingText: '补充四个必要条件...',
        errorText: '模型返回 503 超时，请稍后重试并且不要丢弃内容_ERROR_TAIL',
        width: 50,
        height: 12,
        isActive: false,
      }),
      60,
      14,
    );
    try {
      const out = h.getOutput();
      assert.ok(out.includes('什么是死锁'), `Must render user turn: ${out}`);
      assert.ok(out.includes('互相等待资源'), `Must render assistant turn: ${out}`);
      assert.ok(out.includes('补充四个必要条件'), `Must render live streaming text: ${out}`);
      assert.ok(out.includes('ERROR_TAIL'), `Error text must wrap without truncation: ${out}`);
    } finally {
      h.unmount();
    }
  });
});
