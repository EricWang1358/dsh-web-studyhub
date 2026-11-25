// #1354 P3-a: the four AI dialogue entrypoints (explain / retell / guided / follow-up) share one
// transport (`useAiConversation` + `host/ai-dialogue.ts`) without behaviour regressions.
//
// These are rendering-level tests against the *real* TUI host and the real StudyService
// (`createTuiHost` -> StudyRuntime / `teach.retell`), not a hand-shaped fake backend:
// - explain: true multi-turn `messages` length + role order survive the refactor
// - transport: abort is reported only by the request that still owns the controller
// - follow-up bar: changing the question clears the previous transcript (#1464)
// - guided retell: learner prose is evaluated by `teach.retell` and never counted as a command (#1469)
// - retell modal: verdict comes from the real `teach.retell` action and writes the card record
//
// node --test tests/issue-1354-p3a-ai-dialogue-merge.test.mjs
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
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

const [{ StudyService }, { createTuiHost }, { useAiConversation }, AiHelp, NextStep, Panel, Retell, storeMod] =
  await Promise.all([
    import('../../../lib/service.js'),
    import('../src/host/tui-host.ts'),
    import('../src/components/useAiConversation.ts'),
    import('../src/views/review/AiHelpDrawer.tsx'),
    import('../src/views/review/NextStepFollowupBar.tsx'),
    import('../src/shell/AssistantPanel.tsx'),
    import('../src/views/review/RetellModal.tsx'),
    import('../src/state/store.ts'),
  ]);

const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;
const { AiHelpDrawer } = AiHelp;
const { NextStepFollowupBar } = NextStep;
const { AssistantPanel, _resetAssistantSessionMemory } = Panel;
const { RetellModal } = Retell;

const CARD = {
  id: 'c-1354',
  deckId: 'd-1354',
  kind: 'short_answer',
  prompt: '为什么 TCP 握手需要三次而不是两次？',
  answer: '两次握手无法让服务端确认客户端的接收能力，旧连接请求也可能被误认为新连接。',
  explanation: '三次握手让双方都确认对方的发送与接收能力，并同步初始序列号。',
};

function makeRun(overrides = {}) {
  return {
    id: 'run-1354',
    deckId: 'd-1354',
    index: 0,
    total: 1,
    answered: 1,
    revealed: true,
    card: { ...CARD },
    feedback: { correct: false, grade: 1, assessment: '只说了同步序列号' },
    solution: { answer: CARD.answer, explanation: CARD.explanation },
    ...overrides,
  };
}

function resetStore(extra = {}) {
  useTuiStore.setState({
    page: 'review',
    navContext: {},
    history: [],
    inputCaptured: false,
    commandPaletteOpen: false,
    helpOpen: false,
    snapshot: { courses: [], decks: [], sources: [], jobs: [] },
    binding: { root: '/tmp' },
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
    activeRunId: null,
    toasts: [],
    footerHints: [],
    assistantOpen: true,
    assistantFocused: true,
    assistantTab: 'chat',
    assistantStage: 'idle',
    assistantCardContext: null,
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
    ...extra,
  });
}

/** Seed a real library, then open the real host over it. */
async function makeRealHost(t, { onComplete } = {}) {
  _resetAssistantSessionMemory?.();
  const base = await mkdtemp(path.join(os.tmpdir(), 'studyhub-1354-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));
  const libraryRoot = path.join(base, 'library');
  await mkdir(libraryRoot, { recursive: true });

  const seed = new StudyService(libraryRoot, { complete: async () => '{}' });
  await seed.store.update((s) => {
    s.decks.push({ id: 'd-1354', title: '计算机网络', cards: [{ ...CARD }] });
  });
  await seed.dispose?.();

  const calls = [];
  const host = await createTuiHost({
    libraryRoot,
    env: { DSH_HOME: path.join(base, 'dsh-home') },
    home: base,
    documentsDir: base,
    skipAutoProbe: true,
    language: 'zh',
    injectedComplete: async (system, prompt, execution) => {
      calls.push({ system, prompt, messages: execution?.messages, task: execution?.task });
      if (String(system).includes('learnerExplanation')) {
        return JSON.stringify({
          passed: true,
          right: ['说出了三次握手确认双方收发能力'],
          missed: [],
          wrong: [],
          cite: null,
        });
      }
      return onComplete ? onComplete(system, prompt, execution, calls) : '测试讲解正文';
    },
  });
  t.after(() => host.dispose());
  return { base, libraryRoot, host, calls };
}

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
    rerender: (next) => instance.rerender(next),
    frame: () => latest,
    async waitFor(pred, timeoutMs = 5000, label = 'condition') {
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

test('P3-a transport: abort is reported by the owning request, a newer send supersedes the old one', async (t) => {
  let conversation = null;
  function Probe({ host }) {
    conversation = useAiConversation(host, 'zh');
    return null;
  }

  const { host } = await makeRealHost(t, {
    onComplete: (_system, prompt, execution) => {
      if (prompt === 'HANG') {
        if (execution?.signal?.aborted) {
          return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }
        return new Promise((_resolve, reject) => {
          execution?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      }
      return 'second reply';
    },
  });

  const inst = render(React.createElement(Probe, { host }));
  t.after(() => inst.unmount());
  await new Promise((r) => setTimeout(r, 50));

  const first = conversation.send({ system: 'S1', prompt: 'HANG' });
  conversation.abort();
  const firstOutcome = await first;
  assert.equal(firstOutcome.status, 'aborted', 'the owning request reports aborted');

  const second = conversation.send({ system: 'S2', prompt: 'OK' });
  const secondOutcome = await second;
  assert.deepEqual(secondOutcome, { status: 'done', text: 'second reply' });

  // A stale request must never publish after a newer one took over.
  const stale = conversation.send({ system: 'S3', prompt: 'HANG' });
  const fresh = conversation.send({ system: 'S4', prompt: 'OK' });
  const [staleOutcome, freshOutcome] = await Promise.all([stale, fresh]);
  assert.equal(staleOutcome.status, 'superseded', 'older request must not write aborted/done over the new one');
  assert.equal(freshOutcome.status, 'done');
});

test('P3-a explain: AiHelpDrawer still sends true multi-turn messages with stable roles', async (t) => {
  resetStore();
  let turn = 0;
  const { host, calls } = await makeRealHost(t, {
    onComplete: () => {
      turn += 1;
      return turn === 1 ? '第一次讲解：三次握手确认双方收发能力。' : '第二次追问：两次握手的旧报文会被误认。';
    },
  });

  const tty = createVirtualTty(100, 32);
  const inst = render(
    React.createElement(AiHelpDrawer, {
      host,
      run: makeRun(),
      cardId: CARD.id,
      kind: 'short_answer',
      userAnswer: '只记住了同步序列号',
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
    await tty.waitFor((s) => s.includes('第一次讲解'), { timeoutMs: 8_000, label: 'initial explanation' });
    assert.equal(calls.length, 1, 'initial explain is one stream call');
    assert.equal(calls[0].messages.length, 1, 'initial turn sends a 1-message array');
    assert.equal(calls[0].messages[0].role, 'user');

    tty.send('i');
    await tty.waitFor((s) => s.includes('输入你的追问'), { timeoutMs: 4_000, label: 'follow-up input' });
    tty.send('那为什么不能用两次握手？');
    await tty.waitFor((s) => s.includes('那为什么不能用两次握手？'), { timeoutMs: 4_000, label: 'typed follow-up' });
    tty.send('\r');
    await tty.waitFor((s) => s.includes('第二次追问'), { timeoutMs: 8_000, label: 'follow-up reply' });

    assert.equal(calls.length, 2);
    const msgs = calls[1].messages;
    assert.equal(msgs.length, 3, 'follow-up keeps [context+Q1, A1, Q2]');
    assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.ok(msgs[0].content.includes('为什么 TCP 握手需要三次'), 'first user message carries the card context');
    assert.equal(msgs[1].content, '第一次讲解：三次握手确认双方收发能力。');
    assert.equal(msgs[2].content, '那为什么不能用两次握手？');
  } finally {
    inst.unmount();
    tty.dispose();
  }
});

test('P3-a follow-up: changing the question clears the previous transcript (#1464)', async (t) => {
  resetStore();
  const { host, calls } = await makeRealHost(t, {
    onComplete: (_system, prompt) => (String(prompt).includes('OLD') ? 'OLD_ANSWER' : 'NEW_ANSWER'),
  });

  const runA = makeRun({ id: 'run-A', card: { ...CARD, id: 'c-A' } });
  const runB = makeRun({ id: 'run-B', card: { ...CARD, id: 'c-B', prompt: '为什么 UDP 不需要握手？' } });

  const bar = (run, resultContext) =>
    React.createElement(NextStepFollowupBar, {
      host,
      run,
      cardId: run.card.id,
      kind: 'short_answer',
      userAnswer: '',
      toolLabel: 'Teach',
      resultContext,
      width: 100,
      height: 30,
      isActive: true,
    });

  const h = createInkHarness(React.createElement(Box, { width: 100, height: 30 }, bar(runA, 'A 的结果')));
  t.after(() => h.cleanup());

  await h.waitFor((s) => s.includes('接下来想做什么'), 4_000, 'bar idle');
  h.write('a');
  await h.waitFor((s) => s.includes('Enter 发送'), 4_000, 'bar focused');
  h.write('OLD instruction');
  await new Promise((r) => setTimeout(r, 40));
  h.write('\r');
  await h.waitFor((s) => s.includes('OLD_ANSWER'), 8_000, 'old answer rendered');
  assert.ok(calls.length >= 1);

  // Next question: same bar instance, new run/context -> transcript must be gone.
  h.rerender(React.createElement(Box, { width: 100, height: 30 }, bar(runB, 'B 的结果')));
  await h.waitFor((s) => s.includes('接下来想做什么') && !s.includes('OLD instruction'), 4_000, 'bar reset');
  assert.ok(!h.frame().includes('OLD_ANSWER'), 'previous question transcript must not survive');

  h.write('a');
  await h.waitFor((s) => s.includes('Enter 发送'), 4_000, 'bar focused again');
  h.write('NEW instruction');
  await new Promise((r) => setTimeout(r, 40));
  h.write('\r');
  await h.waitFor((s) => s.includes('NEW_ANSWER'), 8_000, 'new answer rendered');
  const last = calls.at(-1);
  assert.ok(!String(last.prompt).includes('OLD instruction'), 'new request must not carry the old transcript');
  assert.ok(!String(last.prompt).includes('OLD_ANSWER'), 'new request must not carry the old answer');
});

test('P3-a guided retell: real teach.retell evaluates prose and records no command usage (#1469)', async (t) => {
  resetStore({
    page: 'review',
    assistantTab: 'guided',
    assistantStage: 'retell',
    assistantCardContext: {
      deckId: 'd-1354',
      cardId: CARD.id,
      prompt: CARD.prompt,
      revealed: true,
    },
  });
  const { host } = await makeRealHost(t);

  const h = createInkHarness(
    React.createElement(
      Box,
      { width: 100, height: 30 },
      React.createElement(AssistantPanel, { host, width: 96, height: 28, isActive: true, onClose: () => {} }),
    ),
  );
  t.after(() => h.cleanup());

  await h.waitFor((s) => s.includes('复述'), 5_000, 'guided retell stage');
  await new Promise((r) => setTimeout(r, 60));

  const retellText = '三次握手让双方确认收发能力并同步序列号';
  h.write('i');
  await new Promise((r) => setTimeout(r, 60));
  h.write(retellText);
  await new Promise((r) => setTimeout(r, 40));
  h.write('\r');

  await h.waitFor((s) => s.includes('复述通过'), 8_000, 'retell verdict from real service');
  const stats = useTuiStore.getState().preferences.assistantCommandStats ?? {};
  assert.equal(stats.review?.[retellText], undefined, 'retell prose must not become a command stat');
  assert.deepEqual(stats.review ?? {}, {}, 'a retell submit adds no stats at all');

  const cardRes = await host.call('card.get', { deckId: 'd-1354', cardId: CARD.id });
  assert.equal(cardRes.ok, true);
  assert.equal(cardRes.value?.card?.retell?.tries, 1, 'real service persisted the retell aggregate');
});

test('P3-a retell modal: verdict is the real teach.retell result, never a command stat', async (t) => {
  resetStore();
  const { host } = await makeRealHost(t);

  const h = createInkHarness(
    React.createElement(
      Box,
      { width: 100, height: 32 },
      React.createElement(RetellModal, {
        host,
        run: makeRun(),
        cardId: CARD.id,
        kind: 'short_answer',
        width: 96,
        height: 30,
        isActive: true,
        mathUnicode: true,
        onClose: () => {},
        onNavigateToSource: () => {},
      }),
    ),
    { cols: 100, rows: 32 },
  );

  try {
    await h.waitFor((s) => s.includes('复述') || s.includes('费曼'), 6_000, 'retell modal');
    const text = '三次握手确认双方收发能力并同步初始序列号';
    h.write(text);
    await h.waitFor((s) => s.includes(text), 4_000, 'typed retell');
    h.write('\r');
    await h.waitFor((s) => s.includes('已抓准核心机制'), 8_000, 'real verdict rendered');

    const cardRes = await host.call('card.get', { deckId: 'd-1354', cardId: CARD.id });
    assert.equal(cardRes.ok, true);
    assert.equal(cardRes.value?.card?.retell?.tries, 1);
    const stats = useTuiStore.getState().preferences.assistantCommandStats ?? {};
    assert.deepEqual(stats, {}, 'retell modal never records command usage');
  } finally {
    h.cleanup();
  }
});
