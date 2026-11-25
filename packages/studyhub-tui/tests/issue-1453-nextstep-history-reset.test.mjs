// Behavior tests for the salvaged part of #1453: the "What next?" follow-up bar must not
// resurrect a previous question's conversation.
//
// Real-world path (SimilarCardsModal): the bar is rendered once with the *origin* `cardId`,
// while the user browses similar cards. A -> B -> back to A changes only `resultContext`
// (and `run.card`), never `cardId`/`toolLabel`, so resetting on identity props alone leaves
// A's transcript on screen while B's result is displayed.
//
// node --test tests/issue-1453-nextstep-history-reset.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ NextStepFollowupBar }, storeMod] = await Promise.all([
  import('../src/views/review/NextStepFollowupBar.tsx'),
  import('../src/state/store.ts'),
]);
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

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

  const frames = [];
  const waiters = new Set();
  const notify = () => {
    const latest = frames.at(-1) ?? '';
    for (const w of [...waiters]) {
      if (w.predicate(latest)) {
        waiters.delete(w);
        clearTimeout(w.timer);
        w.resolve(latest);
      }
    }
  };
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim().length > 0) {
      frames.push(plain);
      notify();
    }
  });

  const inst = render(element, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    debug: true,
  });

  return {
    latest: () => frames.at(-1) ?? '',
    rerender: (next) => inst.rerender(next),
    write: (s) => stdin.write(s),
    waitFor: (predicate, timeoutMs = 2000) => {
      const cur = frames.at(-1) ?? '';
      if (predicate(cur)) return Promise.resolve(cur);
      return new Promise((resolve, reject) => {
        const entry = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(entry);
            reject(new Error(`Timed out waiting for frame. Last frame:\n${frames.at(-1) ?? '<empty>'}`));
          }, timeoutMs),
        };
        waiters.add(entry);
      });
    },
    cleanup: () => {
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

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
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
  });
}

const runA = {
  id: 'run-1453',
  deckId: 'deck-1453',
  title: 'Distributed Systems',
  index: 0,
  total: 3,
  revealed: true,
  card: {
    id: 'card-A',
    deckId: 'deck-1453',
    kind: 'short_answer',
    topic: 'Consensus',
    prompt: '解释 Raft 中的线性一致性读如何保证？',
  },
  solution: { answer: 'ReadIndex 或 Lease Read。' },
};

const CONTEXT_A = 'RESULT_A_READINDEX_QUORUM';
const CONTEXT_B = 'RESULT_B_LEASE_EPOCH';
const REPLY_A = 'REPLY_FOR_CARD_A_ONLY';
const REPLY_B = 'REPLY_FOR_CARD_B_ONLY';

const EMPTY_HINT = '已自动带上本题';

function bar(props) {
  return React.createElement(
    Box,
    { width: 96, height: 28, flexDirection: 'column' },
    React.createElement(NextStepFollowupBar, {
      host: undefined,
      width: 96,
      expandedHeight: 11,
      isActive: true,
      ...props,
    }),
  );
}

function makeHost() {
  const prompts = [];
  return {
    prompts,
    streamComplete: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompt.includes(CONTEXT_A)) return REPLY_A;
      if (prompt.includes(CONTEXT_B)) return REPLY_B;
      return 'REPLY_GENERIC';
    },
  };
}

async function ask(h, text) {
  h.write('a');
  await h.waitFor((s) => s.includes('通俗讲解'));
  await new Promise((r) => setTimeout(r, 30));
  h.write(text);
  await h.waitFor((s) => s.includes(text));
  h.write('\r');
}

describe('#1453 salvage · NextStepFollowupBar conversation scope', () => {
  test('1. switching the grounded result (same cardId/toolLabel) clears the conversation; returning to A stays empty', async () => {
    resetStore();
    const host = makeHost();
    const base = {
      host,
      run: runA,
      cardId: 'card-A',
      kind: 'short_answer',
      toolLabel: '同类易混题对比',
      resultContext: CONTEXT_A,
    };

    const h = createInkHarness(bar(base), { cols: 96, rows: 28 });
    try {
      await h.waitFor((s) => s.includes('接下来想做什么'));
      await ask(h, '第一题追问');
      const aFrame = await h.waitFor((s) => s.includes(REPLY_A));
      assert.ok(aFrame.includes(REPLY_A), 'baseline: A conversation renders');

      // A -> B: only the grounded result changes, exactly like SimilarCardsModal browsing.
      h.rerender(bar({ ...base, resultContext: CONTEXT_B }));
      await new Promise((r) => setTimeout(r, 60));
      h.write('a');
      await h.waitFor((s) => s.includes('通俗讲解'));
      await new Promise((r) => setTimeout(r, 40));
      const bFrame = h.latest();
      assert.equal(
        bFrame.includes(REPLY_A),
        false,
        `A's transcript leaked into B's result:\n${bFrame}`,
      );
      assert.ok(bFrame.includes(EMPTY_HINT), `expected empty conversation hint:\n${bFrame}`);

      // B -> back to A: the old conversation must not come back on its own.
      h.rerender(bar({ ...base, resultContext: CONTEXT_A }));
      await new Promise((r) => setTimeout(r, 60));
      h.write('a');
      await h.waitFor((s) => s.includes('通俗讲解'));
      await new Promise((r) => setTimeout(r, 40));
      const backFrame = h.latest();
      assert.equal(
        backFrame.includes(REPLY_A),
        false,
        `A -> B -> A resurrected the old conversation:\n${backFrame}`,
      );
      assert.ok(backFrame.includes(EMPTY_HINT), `expected empty conversation hint after returning:\n${backFrame}`);
    } finally {
      h.cleanup();
    }
  });

  test('2. cardId and runId changes still reset (regression guard)', async () => {
    resetStore();
    const host = makeHost();
    const base = {
      host,
      run: runA,
      cardId: 'card-A',
      kind: 'short_answer',
      toolLabel: '同类易混题对比',
      resultContext: CONTEXT_A,
    };

    const h = createInkHarness(bar(base), { cols: 96, rows: 28 });
    try {
      await h.waitFor((s) => s.includes('接下来想做什么'));
      await ask(h, '第一题追问');
      await h.waitFor((s) => s.includes(REPLY_A));

      h.rerender(bar({ ...base, cardId: 'card-Z', resultContext: CONTEXT_B }));
      await new Promise((r) => setTimeout(r, 60));
      h.write('a');
      await h.waitFor((s) => s.includes('通俗讲解'));
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(h.latest().includes(REPLY_A), false, 'cardId change must clear transcript');

      // New run, same card id: a fresh run must not inherit the previous run's chat.
      await ask(h, '第二题追问');
      await h.waitFor((s) => s.includes(REPLY_B));
      h.rerender(bar({ ...base, cardId: 'card-Z', resultContext: CONTEXT_B, run: { ...runA, id: 'run-1453-b' } }));
      await new Promise((r) => setTimeout(r, 60));
      h.write('a');
      await h.waitFor((s) => s.includes('通俗讲解'));
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(h.latest().includes(REPLY_B), false, 'runId change must clear transcript');
    } finally {
      h.cleanup();
    }
  });

  test('3. identical rebuilt context string does not wipe an active conversation', async () => {
    resetStore();
    const host = makeHost();
    const base = {
      host,
      run: runA,
      cardId: 'card-A',
      kind: 'short_answer',
      toolLabel: '同类易混题对比',
      resultContext: CONTEXT_A,
    };

    const h = createInkHarness(bar(base), { cols: 96, rows: 28 });
    try {
      await h.waitFor((s) => s.includes('接下来想做什么'));
      await ask(h, '第一题追问');
      await h.waitFor((s) => s.includes(REPLY_A));

      // Parents like CardToolsModal rebuild the context string on every render; the same
      // value must be treated as "same result" and keep the transcript.
      h.rerender(bar({ ...base, resultContext: `RESULT_A_${'READINDEX_QUORUM'}` }));
      await new Promise((r) => setTimeout(r, 80));
      assert.ok(h.latest().includes(REPLY_A), 'identical context value must not reset the conversation');
    } finally {
      h.cleanup();
    }
  });
});
