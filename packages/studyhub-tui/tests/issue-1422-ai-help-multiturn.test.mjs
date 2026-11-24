// Regression tests for #1422: AiHelpDrawer follow-ups must use a follow-up system prompt,
// pass true multi-turn `messages` through streamComplete -> OpenAI adapter, and include
// source passage citations + learner attempt/feedback records.
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';
import { createVirtualTty, disposeTerminalPool } from './helpers/virtual-tty.mjs';

const unregisterTsx = register();
after(() => {
  try {
    disposeTerminalPool();
  } finally {
    unregisterTsx?.();
  }
});

const [helpersMod, drawerMod, storeMod, openaiMod] = await Promise.all([
  import('../src/views/review/review-helpers.ts'),
  import('../src/views/review/AiHelpDrawer.tsx'),
  import('../src/state/store.ts'),
  import('../../studyhub-desktop/adapters/http/openai-adapter.mjs'),
]);

const {
  buildCardHelpContext,
  buildCardHelpMessages,
  buildCardHelpSystemPrompt,
  buildCardHelpUserPrompt,
} = helpersMod;
const { AiHelpDrawer } = drawerMod;
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;
const { createOpenAiCompleteAdapter } = openaiMod;

function resetStore() {
  useTuiStore.setState({
    page: 'review',
    navContext: {},
    history: [],
    inputCaptured: false,
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    voicePackOpen: false,
    inboxOpen: false,
    quitConfirmOpen: false,
    showLaunchpad: false,
    snapshot: { courses: [], decks: [], sources: [], jobs: [] },
    binding: { root: '/tmp' },
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
    activeRunId: null,
    toasts: [],
    footerHints: [],
    preferences: {
      ...DEFAULT_PREFERENCES,
      language: 'zh',
      asciiMode: false,
    },
  });
}

describe('#1422: AiHelpDrawer multi-turn follow-up context & prompt specialization', () => {
  test('pure helpers: distinct follow-up system prompt, rich context (citation + attempt record), and true multi-turn messages', () => {
    assert.equal(typeof buildCardHelpContext, 'function', 'must export buildCardHelpContext');
    assert.equal(typeof buildCardHelpMessages, 'function', 'must export buildCardHelpMessages');

    const initialSysZh = buildCardHelpSystemPrompt('zh', false);
    const followupSysZh = buildCardHelpSystemPrompt('zh', true);
    assert.notEqual(initialSysZh, followupSysZh, 'zh follow-up system prompt must differ from initial explain prompt');
    assert.ok(
      followupSysZh.includes('追问') && followupSysZh.includes('不要'),
      `zh follow-up prompt must focus on answering the follow-up without restarting: ${followupSysZh}`,
    );

    const initialSysEn = buildCardHelpSystemPrompt('en', false);
    const followupSysEn = buildCardHelpSystemPrompt('en', true);
    assert.notEqual(initialSysEn, followupSysEn, 'en follow-up system prompt must differ from initial explain prompt');
    assert.ok(
      /follow-up/i.test(followupSysEn) && /without re-explaining/i.test(followupSysEn),
      `en follow-up prompt must focus on follow-up without restarting: ${followupSysEn}`,
    );

    const sampleRun = {
      id: 'run-1422',
      deckId: 'deck-os',
      index: 0,
      total: 3,
      answered: 1,
      revealed: true,
      card: {
        id: 'card-tlb',
        deckId: 'deck-os',
        kind: 'single',
        topic: 'Virtual Memory',
        prompt: 'What is the primary role of a TLB?',
        options: [
          { id: 'A', text: 'Cache recent virtual-to-physical page translations' },
          { id: 'B', text: 'Store swapped-out disk pages' },
        ],
        lapses: 2,
        reps: 5,
      },
      feedback: {
        correct: false,
        grade: 1,
        selected: ['B'],
        assessment: 'Confused TLB with swap space',
      },
      solution: {
        answer: 'A',
        explanation: 'TLB is a hardware associative cache for page table entries.',
        citations: [
          {
            sourceId: 'src-os',
            page: 14,
            title: 'OSTEP Ch.19',
            quote: 'The TLB is part of the chip memory-management unit and caches popular translations.',
          },
        ],
      },
    };

    const ctx = buildCardHelpContext({
      run: sampleRun,
      kind: 'single',
      userAnswer: 'Store swapped-out disk pages',
      sourceExcerpt: 'On a TLB miss, the hardware or OS consults the page table in memory.',
      lang: 'zh',
    });
    assert.ok(ctx.includes('OSTEP Ch.19'), 'context must include citation title');
    assert.ok(ctx.includes('popular translations'), 'context must include citation quote');
    assert.ok(ctx.includes('consults the page table in memory'), 'context must include fetched source excerpt');
    assert.ok(ctx.includes('答错'), 'context must reflect learner got the card wrong');
    assert.ok(ctx.includes('Confused TLB with swap space'), 'context must include feedback assessment');
    assert.ok(ctx.includes('历史错题/遗忘 2 次') || ctx.includes('lapses'), 'context must include card lapse history');

    const msgs = buildCardHelpMessages({
      run: sampleRun,
      kind: 'single',
      userAnswer: 'Store swapped-out disk pages',
      sourceExcerpt: 'On a TLB miss, the hardware or OS consults the page table in memory.',
      history: [
        { role: 'user', text: '请帮我深入讲解这道题' },
        { role: 'assistant', text: 'TLB 是硬件快表，专门缓存页表项（PTE）。' },
      ],
      question: '刚才提到的页表项（PTE）里一般存什么？',
      lang: 'zh',
    });

    assert.equal(msgs.length, 3, 'follow-up must emit 3 real messages: [user(context+Q1), assistant(A1), user(Q2)]');
    assert.equal(msgs[0].role, 'user');
    assert.ok(msgs[0].content.includes('What is the primary role of a TLB?'));
    assert.ok(msgs[0].content.includes('请帮我深入讲解这道题'));
    assert.equal(msgs[1].role, 'assistant');
    assert.equal(msgs[1].content, 'TLB 是硬件快表，专门缓存页表项（PTE）。');
    assert.equal(msgs[2].role, 'user');
    assert.equal(msgs[2].content, '刚才提到的页表项（PTE）里一般存什么？');

    // Fallback single-string prompt also carries the enriched citation & attempt context
    const fallbackPrompt = buildCardHelpUserPrompt({
      run: sampleRun,
      kind: 'single',
      userAnswer: 'Store swapped-out disk pages',
      sourceExcerpt: 'On a TLB miss, the hardware or OS consults the page table in memory.',
      history: [{ role: 'assistant', text: 'TLB 是硬件快表。' }],
      question: '刚才那个词是什么意思？',
      lang: 'zh',
    });
    assert.ok(fallbackPrompt.includes('popular translations'));
    assert.ok(fallbackPrompt.includes('答错'));
  });

  test('openai-adapter forwards multi-turn execution.messages as OpenAI chat messages array', async () => {
    let capturedBody = null;
    const mockFetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'PTE stores physical frame number and permission bits.' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const complete = createOpenAiCompleteAdapter(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'gpt-test' },
      { fetch: mockFetch, report: null },
    );

    const out = await complete('FOLLOWUP_SYSTEM', 'FALLBACK_PROMPT', {
      stream: false,
      messages: [
        { role: 'user', content: 'Card context + Q1' },
        { role: 'assistant', content: 'A1 explaining PTE' },
        { role: 'user', content: 'What is inside that PTE?' },
      ],
    });

    assert.equal(out, 'PTE stores physical frame number and permission bits.');
    assert.deepEqual(capturedBody.messages, [
      { role: 'system', content: 'FOLLOWUP_SYSTEM' },
      { role: 'user', content: 'Card context + Q1' },
      { role: 'assistant', content: 'A1 explaining PTE' },
      { role: 'user', content: 'What is inside that PTE?' },
    ]);
  });

  test('AiHelpDrawer fetches cited source passage and sends multi-turn messages + follow-up system prompt on follow-up', async () => {
    resetStore();
    const streamCalls = [];
    const sourceCalls = [];

    const mockRun = {
      id: 'run-drawer-1422',
      deckId: 'deck-os',
      index: 0,
      total: 2,
      answered: 1,
      revealed: true,
      card: {
        id: 'card-1422',
        deckId: 'deck-os',
        kind: 'single',
        prompt: 'Why does Raft require a majority quorum?',
        options: [
          { id: 'A', text: 'Any two majorities intersect so committed entries persist' },
          { id: 'B', text: 'To reduce network bandwidth' },
        ],
      },
      feedback: {
        correct: false,
        grade: 1,
        selected: ['B'],
      },
      solution: {
        answer: 'A',
        explanation: 'Quorum intersection guarantees a newly elected leader has all committed entries.',
        citations: [{ sourceId: 'src-raft', page: 7, title: 'Raft Paper' }],
      },
    };

    const mockHost = {
      call: async (action, args) => {
        if (action === 'source.pages') {
          sourceCalls.push(args);
          return {
            ok: true,
            value: {
              pages: [
                {
                  page: 7,
                  text: 'Raft guarantees that any two quorums share at least one server with the latest committed log entry.',
                },
              ],
            },
          };
        }
        return { ok: true, value: {} };
      },
      streamComplete: async (params) => {
        streamCalls.push(params);
        if (streamCalls.length === 1) {
          return '法定人数（quorum）交集保证了新选出的 Leader 一定包含已提交日志。';
        }
        return '交集指的是任意两个过半集合至少重叠一台节点。';
      },
      subscribeEvents: () => () => {},
      getLibraryRoot: () => '/tmp',
      getConfig: () => null,
      dispose: async () => {},
    };

    const tty = createVirtualTty(100, 32);
    const inst = render(
      React.createElement(AiHelpDrawer, {
        host: mockHost,
        run: mockRun,
        cardId: 'card-1422',
        kind: 'single',
        userAnswer: 'To reduce network bandwidth',
        width: 96,
        height: 30,
        isActive: true,
        mathUnicode: true,
        onClose: () => {},
      }),
      {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await tty.firstFramePromise;
      await tty.waitFor((s) => s.includes('法定人数（quorum）交集保证了'), {
        timeoutMs: 6_000,
        label: 'Initial AI explanation rendered',
      });

      assert.equal(streamCalls.length, 1);
      assert.equal(sourceCalls.length, 1, 'should fetch cited source page once when citation lacks inline quote');
      assert.equal(sourceCalls[0].id, 'src-raft');
      assert.equal(sourceCalls[0].from, 7);
      assert.ok(
        Array.isArray(streamCalls[0].messages) && streamCalls[0].messages.length === 1,
        'initial turn must pass 1-turn messages array',
      );
      assert.ok(
        streamCalls[0].messages[0].content.includes('share at least one server'),
        'initial request must include fetched cited source passage',
      );
      assert.ok(
        streamCalls[0].messages[0].content.includes('答错'),
        'initial request must include learner wrong-answer feedback',
      );

      // Focus follow-up input with 'i', wait for focused prompt, type follow-up question, press Enter
      tty.send('i');
      await tty.waitFor((s) => s.includes('输入你的追问'), {
        timeoutMs: 4_000,
        label: 'Follow-up input focused after pressing i',
      });
      tty.send('刚才说的交集是什么意思？');
      await tty.waitFor((s) => s.includes('刚才说的交集是什么意思？'), {
        timeoutMs: 4_000,
        label: 'Follow-up typed into input',
      });
      tty.send('\r');

      await tty.waitFor((s) => s.includes('任意两个过半集合至少重叠一台节点'), {
        timeoutMs: 6_000,
        label: 'Follow-up answer rendered',
      });

      assert.equal(streamCalls.length, 2);
      assert.notEqual(
        streamCalls[1].system,
        streamCalls[0].system,
        'follow-up turn must switch system prompt away from full-card re-explanation',
      );
      assert.ok(streamCalls[1].system.includes('追问'), 'follow-up system prompt must target answering the follow-up');
      assert.equal(streamCalls[1].messages.length, 3, 'follow-up must pass true 3-turn messages array');
      assert.equal(streamCalls[1].messages[1].role, 'assistant');
      assert.ok(streamCalls[1].messages[1].content.includes('法定人数'));
      assert.equal(streamCalls[1].messages[2].role, 'user');
      assert.equal(streamCalls[1].messages[2].content, '刚才说的交集是什么意思？');
    } finally {
      inst.unmount();
      tty.dispose();
    }
  });
});
