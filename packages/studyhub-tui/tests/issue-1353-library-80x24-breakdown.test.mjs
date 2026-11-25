// Regression test for #1353:
// 1. At 80x24, LibraryView's Deck Detail must NOT leave an orphaned "题量分布" header with blank content,
//    and must display both the Mastery ProgressBar and Breakdown counts cleanly.
// 2. At 120x36, the Breakdown section must NOT insert 2 blank lines between wrapped rows.
// node --test tests/issue-1353-library-80x24-breakdown.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ AppShell }, { LibraryView }, { useTuiStore, DEFAULT_PREFERENCES }] = await Promise.all([
  import('../src/shell/AppShell.tsx'),
  import('../src/views/library/LibraryView.tsx'),
  import('../src/state/store.ts'),
]);

function renderLibraryInShell(cols, rows) {
  const snapshot = {
    root: '/tmp/test-1353',
    decks: [
      {
        id: 'd-1',
        title: '线性代数核心题组',
        course: '线性代数',
        topics: ['矩阵', '特征值', '正交化'],
        cards: [
          { id: 'c1', prompt: 'P1', answer: 'A1' },
          { id: 'c2', prompt: 'P2', answer: 'A2' },
          { id: 'c3', prompt: 'P3', answer: 'A3' },
          { id: 'c4', prompt: 'P4', answer: 'A4' },
          { id: 'c5', prompt: 'P5', answer: 'A5' },
          { id: 'c6', prompt: 'P6', answer: 'A6' },
        ],
      },
    ],
    courses: [{ id: 'la', name: '线性代数' }],
    today: { due: 2, new: 1, weak: 1, done: 2 },
    progress: {
      'd-1': { total: 6, due: 2, mastered: 2, familiar: 1, learning: 1, new: 1, weak: 1 },
    },
    inbox: [],
  };
  const host = {
    mode: 'embedded',
    snapshot: async () => snapshot,
    call: async () => ({ ok: true, value: {} }),
    stream: async () => {
      throw new Error('unused');
    },
    close: async () => {},
  };

  useTuiStore.setState({
    preferences: {
      ...DEFAULT_PREFERENCES,
      language: 'zh',
      asciiMode: false,
      dismissedBriefingDate: '',
    },
    snapshot,
    page: 'library',
    course: null,
    showLaunchpad: false,
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    quitConfirmOpen: false,
    assistantOpen: false,
    assistantFocused: false,
    inputCaptured: false,
    toasts: [],
  });

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

  const inst = render(
    React.createElement(AppShell, {
      host,
      renderPage: (page, viewProps) =>
        page === 'library' ? React.createElement(LibraryView, viewProps) : React.createElement('ink-text', null, page),
      onRefresh: async () => {},
      onQuit: () => {},
    }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true },
  );

  return {
    async waitFor(pred, timeoutMs = 4000, label = 'frame') {
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

test('#1353: at 80x24, Deck Detail shows Mastery bar and Breakdown content (never an orphaned 题量分布 header)', async (t) => {
  const h = renderLibraryInShell(80, 24);
  t.after(() => h.cleanup());

  const frame = await h.waitFor((s) => s.includes('线性代数核心题组') && s.includes('今日一键直达'), 4000, '80x24 library');
  const lines = frame.split('\n');
  const breakdownIdx = lines.findIndex((l) => l.includes('题量分布'));
  if (breakdownIdx >= 0) {
    const nextLine = lines[breakdownIdx + 1] ?? '';
    const hasContentAfterHeader =
      /总题数|总\s*6|已掌握|掌握|新题|薄弱/.test(nextLine) ||
      /总题数|总\s*6|已掌握|掌握|新题|薄弱/.test(lines[breakdownIdx + 2] ?? '');
    assert.ok(
      hasContentAfterHeader,
      `At 80x24, "题量分布" header must have visible breakdown content right below it, not blank!\nFrame:\n${frame}`,
    );
  }
  assert.ok(frame.includes('掌握度'), `At 80x24, Mastery progress bar should be visible.\nFrame:\n${frame}`);
});

test('#1353: at 120x36, Breakdown wrapped rows have no multi-line vertical gap between them', async (t) => {
  const h = renderLibraryInShell(120, 36);
  t.after(() => h.cleanup());

  const frame = await h.waitFor((s) => s.includes('题量分布') && s.includes('总题数'), 4000, '120x36 library');
  const lines = frame.split('\n');
  const breakdownIdx = lines.findIndex((l) => l.includes('题量分布'));
  const totalIdx = lines.findIndex((l, i) => i > breakdownIdx && l.includes('总题数'));
  const weakIdx = lines.findIndex((l, i) => i >= totalIdx && l.includes('薄弱/错题'));
  assert.ok(totalIdx > breakdownIdx && weakIdx >= totalIdx, `Expected 总题数 and 薄弱/错题 below 题量分布.\nFrame:\n${frame}`);
  assert.ok(
    weakIdx - totalIdx <= 1,
    `Wrapped Breakdown rows must be adjacent (delta <= 1), got delta=${weakIdx - totalIdx} (extra blank lines from rowGap!).\nFrame:\n${frame}`,
  );
});
