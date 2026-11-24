// Behavior tests for #1313: Unified "What next?" agent-style follow-up bar across AI result modals.
// node --test tests/issue-1313-next-step-followup.test.mjs
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

const [
  nextStepMod,
  { CardToolsModal },
  { TeachModal },
  { RetellModal },
  storeMod,
] = await Promise.all([
  import('../src/views/review/NextStepFollowupBar.tsx'),
  import('../src/views/review/CardToolsModal.tsx'),
  import('../src/views/review/TeachModal.tsx'),
  import('../src/views/review/RetellModal.tsx'),
  import('../src/state/store.ts'),
]);

const {
  NEXT_STEP_PRESETS,
  NEXT_STEP_ACTIVATION_KEY,
  nextStepIdlePrompt,
  buildNextStepUserPrompt,
} = nextStepMod;
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
    write: (s) => stdin.write(s),
    waitFor: (predicate, timeoutMs = 1500) => {
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
    preferences: {
      ...DEFAULT_PREFERENCES,
      language: 'zh',
      asciiMode: false,
    },
  });
}

const baseRun = {
  id: 'run-1313',
  deckId: 'deck-1313',
  title: 'Distributed Systems',
  index: 0,
  total: 3,
  answered: 1,
  revealed: true,
  card: {
    id: 'card-1313',
    deckId: 'deck-1313',
    kind: 'short_answer',
    topic: 'Consensus',
    prompt: '解释 Raft 中的线性一致性读（Linearizable Read）如何保证？',
  },
  solution: { answer: 'ReadIndex 或 Lease Read。' },
};

describe('#1313 unified AI result follow-up bar', () => {
  test('1. buildNextStepUserPrompt automatically packs card, user answer, tool output, and custom instruction', () => {
    const prompt = buildNextStepUserPrompt({
      run: baseRun,
      kind: 'short_answer',
      userAnswer: '通过 Leader 心跳确认',
      toolLabel: '生词提取',
      resultContext: '1. ReadIndex: 记录提交索引\n2. Quorum: 多数派确认',
      history: [],
      instruction: '给每个词写一段通俗讲解',
      lang: 'zh',
    });
    assert.ok(prompt.includes('Linearizable Read'));
    assert.ok(prompt.includes('通过 Leader 心跳确认'));
    assert.ok(prompt.includes('ReadIndex'));
    assert.ok(prompt.includes('Quorum'));
    assert.ok(prompt.includes('给每个词写一段通俗讲解'));
    assert.equal(NEXT_STEP_ACTIVATION_KEY, 'a');
    assert.equal(NEXT_STEP_PRESETS.length, 4);
  });

  test('2. CardToolsModal vocab extraction result includes unified follow-up bar, sends extracted terms in context, and saves via N', async () => {
    resetStore();
    const promptsSent = [];
    const savedFollowups = [];
    const savedNotes = [];

    const mockHost = {
      call: async (name, payload) => {
        if (name === 'card.terms') {
          return {
            ok: true,
            value: {
              terms: [
                { term: 'ReadIndex', definition: 'Leader 记录当前 commitIndex' },
                { term: 'Quorum', definition: '集群多数派节点集合' },
              ],
            },
          };
        }
        if (name === 'card.followup.add') {
          savedFollowups.push(payload);
          return { ok: true, value: { item: { id: 'fu-1313' } } };
        }
        if (name === 'note.qa.add') {
          savedNotes.push(payload);
          return { ok: true, value: { status: 'ok' } };
        }
        return { ok: true, value: {} };
      },
      streamComplete: async ({ prompt }) => {
        promptsSent.push(prompt);
        return 'PLAIN_EXPLAIN_FOR_READINDEX_AND_QUORUM';
      },
    };

    const h = createInkHarness(
      React.createElement(
        Box,
        { width: 96, height: 28 },
        React.createElement(CardToolsModal, {
          host: mockHost,
          run: baseRun,
          cardId: 'card-1313',
          kind: 'short_answer',
          width: 96,
          height: 28,
          isActive: true,
          onClose: () => {},
        }),
      ),
      { cols: 96, rows: 28 },
    );

    try {
      // Wait for menu and open vocab extraction
      const menuFrame = await h.waitFor((s) => s.includes('术语') || s.includes('生词'));
      const match = /\[([1-90])\]\s*[^\n]*(?:术语|生词)/.exec(menuFrame);
      assert.ok(match, `Could not find terms menu item in:\n${menuFrame}`);
      h.write(match[1]);

      const termsFrame = await h.waitFor((s) => s.includes('ReadIndex') && s.includes('接下来想做什么'));
      assert.ok(termsFrame.includes('接下来想做什么'), 'Vocab result must render unified follow-up bar');
      await new Promise((r) => setTimeout(r, 30));

      // Press 'a' to focus follow-up input, type custom instruction, press Enter
      h.write('a');
      await h.waitFor((s) => s.includes('通俗讲解') && s.includes('出前置题'));
      await new Promise((r) => setTimeout(r, 30));
      h.write('给每个词写一段通俗讲解');
      await h.waitFor((s) => s.includes('给每个词写一段通俗讲解'));
      h.write('\r');

      const replyFrame = await h.waitFor((s) => s.includes('PLAIN_EXPLAIN_FOR_READINDEX_AND_QUORUM'));
      assert.ok(replyFrame.includes('PLAIN_EXPLAIN_FOR_READINDEX_AND_QUORUM'));
      assert.equal(promptsSent.length, 1);
      assert.ok(promptsSent[0].includes('ReadIndex'), 'Prompt must automatically include extracted ReadIndex');
      assert.ok(promptsSent[0].includes('Quorum'), 'Prompt must automatically include extracted Quorum');
      assert.ok(promptsSent[0].includes('给每个词写一段通俗讲解'));

      // Press 'N' to save follow-up & study note via existing backend actions
      await new Promise((r) => setTimeout(r, 30));
      h.write('N');
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(savedFollowups.length, 1, 'N must save via card.followup.add');
      assert.equal(savedNotes.length, 1, 'N must save via note.qa.add');
    } finally {
      h.cleanup();
    }
  });

  test('3. TeachModal (complete) and RetellModal (verdict) show identical follow-up prompt & accept custom instructions', async () => {
    resetStore();
    const teachPrompts = [];
    const teachHost = {
      call: async (name) => {
        if (name === 'teach.get' || name === 'teach.start') {
          return {
            ok: true,
            value: {
              id: 'ts-1',
              mode: 'understanding',
              index: 2,
              total: 2,
              complete: true,
              takeaway: 'TEACH_LESSON_SUMMARY',
            },
          };
        }
        return { ok: true, value: {} };
      },
      streamComplete: async ({ prompt }) => {
        teachPrompts.push(prompt);
        return 'TEACH_NEXT_STEP_REPLY';
      },
    };

    const hTeach = createInkHarness(
      React.createElement(
        Box,
        { width: 96, height: 28 },
        React.createElement(TeachModal, {
          host: teachHost,
          run: baseRun,
          cardId: 'card-1313',
          kind: 'short_answer',
          width: 96,
          height: 28,
          isActive: true,
          mathUnicode: true,
          onClose: () => {},
        }),
      ),
      { cols: 96, rows: 28 },
    );

    try {
      const f = await hTeach.waitFor((s) => s.includes('带学完成') && s.includes('接下来想做什么'));
      assert.ok(f.includes(nextStepIdlePrompt('zh').slice(0, 14)));
      await new Promise((r) => setTimeout(r, 30));
      hTeach.write('a');
      await hTeach.waitFor((s) => s.includes('[1]通俗讲解'));
      await new Promise((r) => setTimeout(r, 30));
      hTeach.write('换个生活例子再讲一遍');
      await hTeach.waitFor((s) => s.includes('换个生活例子再讲一遍'));
      hTeach.write('\r');
      await hTeach.waitFor((s) => s.includes('TEACH_NEXT_STEP_REPLY'));
      assert.ok(teachPrompts[0].includes('带学完成'));
    } finally {
      hTeach.cleanup();
    }

    // RetellModal verdict phase
    const retellPrompts = [];
    const retellHost = {
      call: async (name) => {
        if (name === 'teach.retell') {
          return {
            ok: true,
            value: {
              passed: true,
              gap: 'none',
              right: ['RETELL_RIGHT_POINT_XYZ'],
              missed: [],
              wrong: [],
              note: 'Good job',
            },
          };
        }
        return { ok: true, value: {} };
      },
      streamComplete: async ({ prompt }) => {
        retellPrompts.push(prompt);
        return 'RETELL_FOLLOWUP_REPLY';
      },
    };

    const hRetell = createInkHarness(
      React.createElement(
        Box,
        { width: 96, height: 28 },
        React.createElement(RetellModal, {
          host: retellHost,
          run: baseRun,
          cardId: 'card-1313',
          kind: 'short_answer',
          width: 96,
          height: 28,
          isActive: true,
          mathUnicode: true,
          onClose: () => {},
          onNavigateToSource: () => {},
        }),
      ),
      { cols: 96, rows: 28 },
    );

    try {
      await hRetell.waitFor((s) => s.includes('费曼复述'));
      hRetell.write('Leader 通过心跳确认自己仍是主节点');
      await hRetell.waitFor((s) => s.includes('Leader 通过心跳确认自己仍是主节点'));
      hRetell.write('\x13'); // Ctrl+S to submit multiline retell
      await hRetell.waitFor((s) => s.includes('RETELL_RIGHT_POINT_XYZ') && s.includes('接下来想做什么'));
      await new Promise((r) => setTimeout(r, 30));
      hRetell.write('a');
      await hRetell.waitFor((s) => s.includes('[1]通俗讲解'));
      await new Promise((r) => setTimeout(r, 30));
      hRetell.write('给我出两道进阶追问');
      await hRetell.waitFor((s) => s.includes('给我出两道进阶追问'));
      hRetell.write('\r');
      await hRetell.waitFor((s) => s.includes('RETELL_FOLLOWUP_REPLY'));
      assert.ok(retellPrompts[0].includes('RETELL_RIGHT_POINT_XYZ'));
    } finally {
      hRetell.cleanup();
    }
  });

  test('4. (#1344) Inside AppShell, pressing 1-4 or a when NextStepFollowupBar is expanded (non-typing) does NOT trigger global page jumps', async () => {
    const { AppShell } = await import('../src/shell/AppShell.tsx');
    resetStore();
    useTuiStore.setState({ page: 'review', activeRunId: baseRun.id });

    const teachHost = {
      call: async (name) => {
        if (name === 'teach.get' || name === 'teach.start') {
          return {
            ok: true,
            value: {
              id: 'ts-1344',
              mode: 'understanding',
              index: 2,
              total: 2,
              complete: true,
              takeaway: 'TEACH_SUMMARY_1344',
            },
          };
        }
        return { ok: true, value: {} };
      },
      streamComplete: async () => 'REPLY_1344',
    };

    const h = createInkHarness(
      React.createElement(AppShell, {
        host: teachHost,
        autoLaunchpad: false,
        renderPage: (_page, view) =>
          React.createElement(TeachModal, {
            host: teachHost,
            run: baseRun,
            cardId: 'card-1313',
            kind: 'short_answer',
            width: view.width,
            height: view.height,
            isActive: view.isActive,
            mathUnicode: true,
            onClose: () => {},
          }),
      }),
      { cols: 120, rows: 32 },
    );

    try {
      await h.waitFor((s) => s.includes('带学完成') && s.includes('接下来想做什么'));
      await new Promise((r) => setTimeout(r, 30));
      // Expand & submit an instruction so bar stays expanded with inputFocused=false
      h.write('a');
      await h.waitFor((s) => s.includes('[1]通俗讲解'));
      await new Promise((r) => setTimeout(r, 30));
      h.write('说说核心要点');
      await h.waitFor((s) => s.includes('说说核心要点'));
      await new Promise((r) => setTimeout(r, 30));
      h.write('\r');
      await h.waitFor((s) => s.includes('REPLY_1344'));
      await new Promise((r) => setTimeout(r, 40));

      assert.equal(useTuiStore.getState().inputCaptured, true, 'Expanded follow-up bar must keep inputCaptured=true');

      // Press '1' (preset 1) -> must fill preset, NOT jump globally to library!
      h.write('1');
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(useTuiStore.getState().page, 'review', 'Pressing 1 in expanded follow-up bar must NOT jump to library');

      // Blur input (Esc) while bar remains expanded, then press 'a' -> must focus input, NOT jump globally to audio!
      h.write('\x1b');
      await new Promise((r) => setTimeout(r, 40));
      h.write('a');
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(useTuiStore.getState().page, 'review', 'Pressing a in expanded follow-up bar must NOT jump to audio');
    } finally {
      h.cleanup();
    }
  });
});
