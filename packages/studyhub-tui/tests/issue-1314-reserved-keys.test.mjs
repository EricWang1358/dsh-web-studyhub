// Regression tests for #1314: Reserved global shortcuts & honest SideNav key hints.
// node --test tests/issue-1314-reserved-keys.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Box, Text, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  { AppShell },
  { SideNav },
  { SourcesView },
  { DocumentReader },
  { ReaderNotesDrawer },
  { ReaderOutlineDrawer },
  focusMod,
  storeMod,
] = await Promise.all([
  import('../src/shell/AppShell.tsx'),
  import('../src/shell/SideNav.tsx'),
  import('../src/views/sources/SourcesView.tsx'),
  import('../src/views/sources/DocumentReader.tsx'),
  import('../src/views/sources/ReaderNotesDrawer.tsx'),
  import('../src/views/sources/ReaderOutlineDrawer.tsx'),
  import('../src/components/focus.ts'),
  import('../src/state/store.ts'),
]);

const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;
const { claimKeys, RESERVED_GLOBAL_KEYS } = focusMod;

function createInkHarness(element, { cols = 120, rows = 30 } = {}) {
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

function resetStore(overrides = {}) {
  useTuiStore.setState({
    page: 'sources',
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
    snapshot: {
      courses: [{ id: 'c1', name: 'OS' }],
      decks: [],
      sources: [
        {
          id: 'src-1',
          title: 'Lecture 1 Memory.pdf',
          filename: 'Lecture 1 Memory.pdf',
          format: 'pdf',
          course: 'OS',
          pageCount: 3,
        },
      ],
      jobs: [],
    },
    binding: { root: '/tmp' },
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
    activeRunId: 'run-active-42',
    toasts: [],
    footerHints: [],
    preferences: {
      ...DEFAULT_PREFERENCES,
      language: 'zh',
      asciiMode: false,
    },
    ...overrides,
  });
}

describe('#1314 reserved global shortcuts & honest SideNav hints', () => {
  test('1. RESERVED_GLOBAL_KEYS exports r, q, ?', () => {
    assert.ok(Array.isArray(RESERVED_GLOBAL_KEYS), 'focus.ts must export RESERVED_GLOBAL_KEYS');
    assert.ok(RESERVED_GLOBAL_KEYS.includes('r'));
    assert.ok(RESERVED_GLOBAL_KEYS.includes('q'));
    assert.ok(RESERVED_GLOBAL_KEYS.includes('?'));
  });

  test('2. SideNav hides shortcut hints for keys claimed by the active page', async () => {
    resetStore({ page: 'library', activeRunId: 'run-active-42' });
    // Claim 'a' (Audio) and 't' (Tasks), leave 'n' (Notes) unclaimed.
    const release = claimKeys(['a', 't']);
    const h = createInkHarness(React.createElement(SideNav, { width: 24, height: 28 }), { cols: 30, rows: 30 });
    try {
      const frame = await h.waitFor((s) => s.includes('音频转写') && s.includes('学习笔记'));
      const lines = frame.split('\n');
      const audioLine = lines.find((l) => l.includes('音频转写')) ?? '';
      const tasksLine = lines.find((l) => l.includes('后台任务')) ?? '';
      const notesLine = lines.find((l) => l.includes('学习笔记')) ?? '';
      const resumeLine = lines.find((l) => l.includes('继续练习')) ?? '';
      assert.ok(!/\ba\b/.test(audioLine), `Claimed key 'a' should not be shown on SideNav audio row: "${audioLine}"`);
      assert.ok(!/\bt\b/.test(tasksLine), `Claimed key 't' should not be shown on SideNav tasks row: "${tasksLine}"`);
      assert.ok(/\bn\b/.test(notesLine), `Unclaimed key 'n' should remain shown on SideNav notes row: "${notesLine}"`);
      assert.ok(/\br\b/.test(resumeLine), `Reserved key 'r' must remain shown on SideNav resume row: "${resumeLine}"`);
    } finally {
      h.cleanup();
      release();
    }
  });

  test('3. Pressing r in SourcesView returns to active review run instead of opening Rename', async () => {
    resetStore({ page: 'sources', activeRunId: 'run-active-42' });
    const mockHost = {
      call: async () => ({ ok: true, value: {} }),
      getSnapshot: async () => useTuiStore.getState().snapshot,
    };

    const h = createInkHarness(
      React.createElement(AppShell, {
        host: mockHost,
        autoLaunchpad: false,
        renderPage: (page, view) => {
          if (page === 'sources') return React.createElement(SourcesView, view);
          return React.createElement(Text, null, `ACTIVE_PAGE:${page}:${useTuiStore.getState().navContext.runId ?? ''}`);
        },
      }),
      { cols: 120, rows: 32 },
    );

    try {
      await h.waitFor((s) => s.includes('Lecture 1 Memory.pdf'));
      h.write('r');
      const frame = await h.waitFor((s) => s.includes('ACTIVE_PAGE:review:run-active-42'));
      assert.ok(frame.includes('ACTIVE_PAGE:review:run-active-42'));
      assert.ok(!frame.includes('重命名资料'), 'Pressing r in SourcesView must not open Rename dialog');
    } finally {
      h.cleanup();
    }
  });

  test('4. Pressing r in DocumentReader, ReaderNotesDrawer, and ReaderOutlineDrawer returns to active review run', async () => {
    const mockHost = {
      call: async (action) => {
        if (action === 'source.page.read') {
          return {
            ok: true,
            value: {
              sourceId: 'src-1',
              title: 'Lecture 1 Memory.pdf',
              pageNumber: 1,
              firstPage: 1,
              lastPage: 3,
              totalPages: 3,
              text: 'Virtual memory paging basics.',
            },
          };
        }
        if (action === 'source.outline.get') {
          return { ok: true, value: { chapters: [{ id: 'ch1', title: 'Ch 1', startPage: 1, endPage: 3 }] } };
        }
        if (action === 'source.annotations.list') {
          return { ok: true, value: { annotations: [] } };
        }
        if (action === 'source.marks.list') {
          return { ok: true, value: { marks: [] } };
        }
        return { ok: true, value: {} };
      },
      getSnapshot: async () => useTuiStore.getState().snapshot,
    };

    // 4a) DocumentReader directly
    resetStore({ page: 'sources', activeRunId: 'run-active-42' });
    const hReader = createInkHarness(
      React.createElement(AppShell, {
        host: mockHost,
        autoLaunchpad: false,
        renderPage: (page, view) => {
          if (page === 'sources') {
            return React.createElement(DocumentReader, {
              ...view,
              sourceId: 'src-1',
              initialPage: 1,
              initialTitle: 'Lecture 1 Memory.pdf',
              onClose: () => {},
            });
          }
          return React.createElement(Text, null, `ACTIVE_PAGE:${page}:${useTuiStore.getState().navContext.runId ?? ''}`);
        },
      }),
      { cols: 120, rows: 32 },
    );
    try {
      await hReader.waitFor((s) => s.includes('第 1 /'));
      hReader.write('r');
      await hReader.waitFor((s) => s.includes('ACTIVE_PAGE:review:run-active-42'));
    } finally {
      hReader.cleanup();
    }

    // 4b) ReaderNotesDrawer
    resetStore({ page: 'sources', activeRunId: 'run-active-42' });
    let closedNotes = false;
    const hNotes = createInkHarness(
      React.createElement(
        Box,
        { width: 100, height: 28 },
        React.createElement(ReaderNotesDrawer, {
          host: mockHost,
          sourceId: 'src-1',
          title: 'Lecture 1 Memory.pdf',
          width: 100,
          height: 28,
          isActive: true,
          onJumpPage: () => {},
          onClose: () => {
            closedNotes = true;
          },
        }),
      ),
      { cols: 100, rows: 28 },
    );
    try {
      await hNotes.waitFor((s) => s.includes('书签') || s.includes('批注'));
      hNotes.write('r');
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(useTuiStore.getState().page, 'review');
      assert.equal(useTuiStore.getState().navContext.runId, 'run-active-42');
      assert.equal(closedNotes, true);
    } finally {
      hNotes.cleanup();
    }

    // 4c) ReaderOutlineDrawer
    resetStore({ page: 'sources', activeRunId: 'run-active-42' });
    let closedOutline = false;
    const hOutline = createInkHarness(
      React.createElement(
        Box,
        { width: 100, height: 28 },
        React.createElement(ReaderOutlineDrawer, {
          host: mockHost,
          sourceId: 'src-1',
          title: 'Lecture 1 Memory.pdf',
          currentPage: 1,
          readChapterIds: new Set(),
          width: 100,
          height: 28,
          isActive: true,
          onJumpPage: () => {},
          onClose: () => {
            closedOutline = true;
          },
        }),
      ),
      { cols: 100, rows: 28 },
    );
    try {
      await hOutline.waitFor((s) => s.includes('目录') || s.includes('Outline'));
      hOutline.write('r');
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(useTuiStore.getState().page, 'review');
      assert.equal(useTuiStore.getState().navContext.runId, 'run-active-42');
      assert.equal(closedOutline, true);
    } finally {
      hOutline.cleanup();
    }
  });
});
