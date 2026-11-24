// Regression suite for #1429 (review of the #1429 → #1438 → #1446 stack):
//   1. Real pages: filter active + docked-but-unfocused assistant + Esc clears the filter and
//      KEEPS the dock; the next Esc folds it.
//   2. DocumentReader: Esc declares consumption; in Q&A / translation sub-modes Esc only returns
//      to the reading layer (and does not fold the dock).
//   3. Multi-line TextInput: Ctrl+S must not be swallowed when the input has no onSubmit —
//      it has to fall through to the owning view (DraftEditor's edit-card save).
// Run: node --test tests/issue-1429-esc-consumption.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { Box, Text, render } from 'ink';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '../src');

const { AppShell } = await import('../src/shell/AppShell.tsx');
const { useTuiStore } = await import('../src/state/store.ts');
const { KEY_LAYER_GLOBAL, KEY_LAYER_VIEW, useKeyDispatcherBridge, useScopedInput } = await import(
  '../src/components/key-dispatcher.ts'
);
const { TextInput } = await import('../src/components/TextInput.tsx');
const { DocumentReader } = await import('../src/views/sources/DocumentReader.tsx');
const { SkeletonView } = await import('../src/views/skeleton/SkeletonView.tsx');

function createMockStreams(columns = 120, rows = 36) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = columns;
  stdout.rows = rows;
  const chunks = [];
  stdout.on('data', (d) => chunks.push(d.toString('utf8')));
  return { stdin, stdout, output: () => chunks.join(''), clearOutput: () => { chunks.length = 0; } };
}

const wait = (ms = 70) => new Promise((r) => setTimeout(r, ms));

function makeSnapshot() {
  return {
    revision: 1,
    courses: [{ id: 'c1', name: 'OS' }],
    decks: [{ id: 'd1', title: 'Virtual Memory', course: 'OS', cardCount: 4, dueCount: 2 }],
    focus: { course: 'OS' },
    stats: { totalCards: 4, dueToday: 2, reviewedToday: 0 },
    sources: [{ id: 's1', title: 'Paging Lecture', format: 'pdf', course: 'OS', pageCount: 12 }],
    tasks: [],
    wrongBook: [],
    notes: [],
    modelReady: false,
  };
}

function createDummyHost() {
  return {
    getSnapshot: async () => makeSnapshot(),
    runAction: async () => ({ ok: true, value: {} }),
    call: async () => ({ ok: true, value: {} }),
    subscribe: () => () => {},
  };
}

function resetStore(page) {
  useTuiStore.setState({
    page,
    navContext: {},
    history: [],
    loading: false,
    refreshing: false,
    showLaunchpad: false,
    inputCaptured: false,
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    quitConfirmOpen: false,
    assistantOpen: false,
    assistantFocused: false,
    assistantFullscreen: false,
    assistantTab: 'assistant',
    practiceStack: [],
    toasts: [],
    snapshot: makeSnapshot(),
  });
}

describe('#1429 Esc consumption — real pages with a docked, unfocused assistant', () => {
  test('SkeletonView: Esc with an active filter clears it, keeps the dock; next Esc folds it', async () => {
    resetStore('skeleton');
    const { stdin, stdout, output } = createMockStreams(120, 36);
    const inst = render(
      React.createElement(AppShell, {
        host: createDummyHost(),
        autoLaunchpad: false,
        renderPage: (page, view) => (page === 'skeleton' ? React.createElement(SkeletonView, view) : null),
      }),
      { stdin, stdout, interactive: true, exitOnCtrlC: false },
    );

    try {
      await wait(120);

      // Dock the assistant WITHOUT focus first: its Esc must not steal the page's Esc.
      useTuiStore.getState().openAssistant({ focused: false });
      await wait(120);
      assert.equal(useTuiStore.getState().assistantOpen, true);
      assert.equal(useTuiStore.getState().assistantFocused, false);

      // Activate the page filter and commit a query.
      stdin.write('/');
      await wait(80);
      stdin.write('zz');
      await wait(40);
      stdin.write('\r');
      await wait(80);
      assert.match(output(), /已筛选|Filtered/, 'filter must be committed before testing Esc consumption');

      // First Esc: the page filter consumes it -> filter cleared, dock still open.
      stdin.write('\u001b');
      await wait(100);
      assert.equal(
        useTuiStore.getState().assistantOpen,
        true,
        'page filter Esc must be consumed and must NOT fold the docked assistant',
      );

      // Second Esc: the filter is gone, so nothing on the page claims it -> the dock folds.
      // (This also proves the first Esc reached the page filter instead of the dock.)
      stdin.write('\u001b');
      await wait(120);
      assert.equal(useTuiStore.getState().assistantOpen, false, 'next Esc folds the passive dock');
      assert.equal(useTuiStore.getState().page, 'skeleton', 'folding the dock keeps the user on the page');
      assert.ok(output().length > 0);
    } finally {
      inst.unmount();
    }
  });

  test('DocumentReader: Esc is consumed (dock stays) and closes the reader', async () => {
    resetStore('sources');
    const spy = { globalEsc: 0 };
    let closed = 0;

    function ReaderPage() {
      // Lower-priority shell-level handler: must NOT see the Esc the reader consumed.
      useScopedInput(
        (_input, key) => {
          if (key.escape) spy.globalEsc += 1;
          return false;
        },
        { isActive: true, layer: KEY_LAYER_GLOBAL, id: 'test:global-esc-spy' },
      );
      return React.createElement(DocumentReader, {
        host: createDummyHost(),
        sourceId: 's1',
        initialTitle: 'Paging Lecture',
        initialFormat: 'pdf',
        initialPage: 1,
        totalPagesHint: 12,
        width: 100,
        height: 24,
        isActive: true,
        onClose: () => {
          closed += 1;
        },
      });
    }

    const { stdin, stdout } = createMockStreams(120, 36);
    const inst = render(
      React.createElement(AppShell, {
        host: createDummyHost(),
        autoLaunchpad: false,
        renderPage: () => React.createElement(ReaderPage),
      }),
      { stdin, stdout, interactive: true, exitOnCtrlC: false },
    );
    try {
      await wait(150);
      useTuiStore.getState().openAssistant({ focused: false });
      await wait(100);
      stdin.write('\u001b');
      await wait(150);
      assert.equal(closed, 1, 'Esc in the reader must close it');
      assert.equal(spy.globalEsc, 0, 'reader Esc must be declared consumed, not leaked to the shell');
      assert.equal(useTuiStore.getState().assistantOpen, true, 'closing the reader with Esc must not fold the dock');
    } finally {
      inst.unmount();
    }
  });

  test('DocumentReader source: sub-modes return to the reading layer before closing, and Esc returns true', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'views/sources/DocumentReader.tsx'), 'utf8');
    const escStart = src.indexOf('if (key.escape || (subMode === \'read\' && key.backspace))');
    assert.ok(escStart > 0, 'reader must branch on key.escape');
    const block = src.slice(escStart, escStart + 1400);
    assert.match(block, /if \(subMode !== 'read'\)/, 'sub-modes must be handled separately from the read layer');
    assert.match(block, /setSubMode\('read'\)/, 'Esc in Q&A/translation must return to the reading layer');
    assert.match(block, /onClose\(\)/, 'Esc in the read layer closes the reader');
    assert.match(block, /return true;/, 'the Esc branch must declare consumption');
  });

  test('multi-line TextInput without onSubmit lets Ctrl+S fall through to the owning view', async () => {
    const hits = { parent: 0, submitted: 0 };

    for (const withSubmit of [false, true]) {
      hits.parent = 0;
      hits.submitted = 0;
      resetStore('library');

      function EditorPage() {
        useScopedInput(
          (input, key) => {
            if (key.ctrl && input === 's') {
              hits.parent += 1;
              return true;
            }
            return false;
          },
          { isActive: true, layer: KEY_LAYER_VIEW, id: 'test:edit-card-owner' },
        );
        return React.createElement(
          Box,
          { flexDirection: 'column' },
          React.createElement(Text, null, 'DraftEditor stand-in'),
          React.createElement(TextInput, {
            value: 'prompt',
            onChange: () => {},
            multiline: true,
            height: 3,
            width: 40,
            isActive: true,
            onSubmit: withSubmit
              ? () => {
                  hits.submitted += 1;
                }
              : undefined,
          }),
        );
      }

      const { stdin, stdout } = createMockStreams(100, 30);
      const inst = render(
        React.createElement(AppShell, {
          host: createDummyHost(),
          autoLaunchpad: false,
          renderPage: () => React.createElement(EditorPage),
        }),
        { stdin, stdout, interactive: true, exitOnCtrlC: false },
      );
      try {
        await wait(150);
        stdin.write('\u0013'); // Ctrl+S
        await wait(150);
        if (withSubmit) {
          assert.equal(hits.submitted, 1, 'Ctrl+S must reach the input’s own onSubmit');
          assert.equal(hits.parent, 0, 'a handled Ctrl+S must not bubble further');
        } else {
          assert.equal(hits.parent, 1, 'Ctrl+S must reach the owning view when the input has no onSubmit');
          assert.equal(hits.submitted, 0);
        }
      } finally {
        inst.unmount();
      }
    }
  });
});

