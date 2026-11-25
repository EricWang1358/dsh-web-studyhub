// Regression test for #1352:
// 1. CardToolsModal & SimilarCardsModal must not expose internal backend action names
//    (card.update, card.slay, card.terms, card.link, coach.feedback, coach.rewrite.retry, review.similar).
// 2. While a modal is open inside AppShell, the bottom KeyHintBar must show the modal's own keys
//    (never global default hints like "1-9 页面", "c 课程", "q 退出").
// node --test tests/issue-1352-card-tools-and-footer.test.mjs
import assert from 'node:assert/strict';
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

const [{ AppShell }, { ReviewView }, { CardToolsModal }, { SimilarCardsModal }, { useTuiStore, DEFAULT_PREFERENCES }] =
  await Promise.all([
    import('../src/shell/AppShell.tsx'),
    import('../src/views/review/ReviewView.tsx'),
    import('../src/views/review/CardToolsModal.tsx'),
    import('../src/views/review/SimilarCardsModal.tsx'),
    import('../src/state/store.ts'),
  ]);

function createHarness(element, { cols = 120, rows = 36 } = {}) {
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

  const inst = render(element, { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true });

  return {
    write: (s) => stdin.write(s),
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
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

const FORBIDDEN_INTERNAL_NAMES = [
  'card.update',
  'card.slay',
  'card.terms',
  'card.link',
  'coach.feedback',
  'coach.rewrite.retry',
  'review.similar',
];

test('#1352 Part 1: CardToolsModal menu, retry confirm dialog, and SimilarCardsModal hide all internal action names', async (t) => {
  useTuiStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
    toasts: [],
  });

  const card = {
    id: 'c-1',
    kind: 'flashcard',
    topic: '算法',
    prompt: '快速排序的平均时间复杂度是多少？',
    answer: 'O(n log n)',
    explanation: '每次划分期望平衡。',
  };
  const run = {
    id: 'run-1',
    deckId: 'd-1',
    mode: 'flashcard',
    index: 0,
    total: 1,
    card,
    revealed: true,
    feedback: { correct: true, grade: 4 },
  };
  const host = {
    mode: 'embedded',
    snapshot: async () => null,
    call: async (name) => {
      if (name === 'card.get') return { ok: true, value: { deckId: 'd-1', card, revisions: [], prerequisites: [] } };
      if (name === 'card.place') return { ok: true, value: null };
      if (name === 'review.similar') return { ok: true, value: { item: null } };
      return { ok: true, value: {} };
    },
    stream: async () => {
      throw new Error('unused');
    },
    close: async () => {},
  };

  // 1) CardToolsModal menu
  const hTools = createHarness(
    React.createElement(
      Box,
      { width: 120, height: 36 },
      React.createElement(CardToolsModal, {
        host,
        run,
        deckId: 'd-1',
        cardId: 'c-1',
        width: 116,
        height: 34,
        isActive: true,
        onClose: () => {},
      }),
    ),
  );
  t.after(() => hTools.cleanup());

  const menuFrame = await hTools.waitFor((s) => s.includes('编辑题目') && s.includes('重试失败的 AI 改题'), 4000, 'menu rendered');
  for (const forbidden of FORBIDDEN_INTERNAL_NAMES) {
    assert.ok(!menuFrame.includes(forbidden), `CardToolsModal menu must NOT expose "${forbidden}"`);
  }

  // Open retry confirm dialog ('R') -> must not show coach.rewrite.retry
  await new Promise((r) => setTimeout(r, 40));
  hTools.write('R');
  const confirmFrame = await hTools.waitFor((s) => s.includes('重试 AI 改题任务'), 3000, 'retry confirm opened');
  assert.ok(!confirmFrame.includes('coach.rewrite.retry'), 'Retry confirm dialog must NOT expose coach.rewrite.retry');

  // 2) SimilarCardsModal empty state -> must not show review.similar
  const hSim = createHarness(
    React.createElement(
      Box,
      { width: 120, height: 36 },
      React.createElement(SimilarCardsModal, {
        host,
        run,
        cardId: 'c-1',
        width: 116,
        height: 34,
        isActive: true,
        onClose: () => {},
        onStartSimilarRun: () => {},
      }),
    ),
  );
  t.after(() => hSim.cleanup());

  const simFrame = await hSim.waitFor((s) => s.includes('同类题'), 4000, 'similar modal empty rendered');
  assert.ok(!simFrame.includes('review.similar'), 'SimilarCardsModal must NOT expose review.similar');
});

test('#1352 Part 2: Opening CardToolsModal inside AppShell replaces bottom global hints with modal hints', async (t) => {
  const card = {
    id: 'c-1',
    kind: 'flashcard',
    topic: '算法',
    prompt: '归并排序的时间复杂度是多少？',
    answer: 'O(n log n)',
  };
  const run = {
    id: 'run-1352',
    deckId: 'd-1',
    mode: 'flashcard',
    index: 0,
    total: 1,
    done: false,
    card,
    revealed: false,
    feedback: null,
    position: { at: 1, total: 1 },
  };
  const snapshot = {
    root: '/tmp/test-1352',
    decks: [{ id: 'd-1', title: '算法基础', course: 'CS', cards: [card] }],
    courses: [{ id: 'cs', name: 'CS' }],
    today: { due: 1, new: 0, weak: 0, done: 0 },
    progress: { 'd-1': { total: 1, due: 1, mastered: 0, learning: 0, new: 0, weak: 0 } },
    inbox: [],
  };
  const host = {
    mode: 'embedded',
    snapshot: async () => snapshot,
    call: async (name) => {
      if (name === 'review.start' || name === 'review.get') return { ok: true, value: run };
      if (name === 'card.get') return { ok: true, value: { deckId: 'd-1', card, revisions: [], prerequisites: [] } };
      if (name === 'card.place') return { ok: true, value: null };
      return { ok: true, value: {} };
    },
    stream: async () => {
      throw new Error('unused');
    },
    close: async () => {},
  };

  useTuiStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false },
    snapshot,
    page: 'review',
    activeRunId: 'run-1352',
    navContext: { runId: 'run-1352' },
    coursePickerOpen: false,
    commandPaletteOpen: false,
    helpOpen: false,
    inboxOpen: false,
    quitConfirmOpen: false,
    assistantOpen: false,
    assistantFocused: false,
    showLaunchpad: false,
    inputCaptured: false,
    practiceStack: [],
    toasts: [],
  });

  const h = createHarness(
    React.createElement(AppShell, {
      host,
      renderPage: (page, viewProps) =>
        page === 'review' ? React.createElement(ReviewView, viewProps) : React.createElement(Box, null),
      onRefresh: async () => {},
      onQuit: () => {},
    }),
  );
  t.after(() => h.cleanup());

  await h.waitFor((s) => s.includes('归并排序的时间复杂度'), 4000, 'review card visible');
  await new Promise((r) => setTimeout(r, 50));

  // Press 'D' to open CardToolsModal and wait for Modal footer hints effect to settle
  h.write('D');
  const modalFrame = await h.waitFor(
    (s) => {
      if (!s.includes('编辑题目') || !s.includes('斩题')) return false;
      const bar = s.split('\n').filter((l) => l.trim().length > 0).at(-1) || '';
      return !bar.includes('1-9  页面') && bar.includes('Esc');
    },
    4000,
    'CardToolsModal opened with modal footer hints',
  );

  // Bottom bar (last non-empty line) must NOT show global default hints "1-9 页面" / "c 课程" / "q 退出"
  const lines = modalFrame.split('\n').filter((l) => l.trim().length > 0);
  const bottomBar = lines[lines.length - 1] || '';
  assert.ok(!bottomBar.includes('1-9 页面'), `Bottom bar must NOT show global "1-9 页面" while modal is open. Bottom bar: "${bottomBar}"`);
  assert.ok(!bottomBar.includes('c 课程'), `Bottom bar must NOT show global "c 课程" while modal is open. Bottom bar: "${bottomBar}"`);
  assert.ok(!bottomBar.includes('q 退出'), `Bottom bar must NOT show global "q 退出" while modal is open. Bottom bar: "${bottomBar}"`);
  assert.ok(bottomBar.includes('Esc'), `Bottom bar should show modal Esc hint. Bottom bar: "${bottomBar}"`);
});
