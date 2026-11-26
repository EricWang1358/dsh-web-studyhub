// Regression & Guardrail suite for #1428 follow-ups (①②③) under #1354 P4:
//   ① Focused AssistantPanel single-letter key isolation via KeyDispatcher (#1354 D1)
//   ② Unified 2-step Esc semantics (1st Esc hands keyboard back keeping dock, 2nd Esc folds dock) across ALL pages
//   ③ ImeCursorAnchor immediate terminal cursor recomputation on ancestor/sibling layout shift (no keystroke wait)
// Run: node --test tests/issue-1428-followups.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import React, { useRef, useState } from 'react';
import { Box, Text, render } from 'ink';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const { AppShell } = await import('../src/shell/AppShell.tsx');
const { useTuiStore } = await import('../src/state/store.ts');
const { getHub } = await import('../src/input/dispatcher.ts');
const { useScopedInput, KEY_LAYER_VIEW, KEY_LAYER_WIDGET } = await import('../src/components/key-dispatcher.ts');
const imeMod = await import('../src/components/ime-cursor.tsx');
const { ImeCursorAnchor, absoluteOrigin } = imeMod;

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
  return { stdin, stdout };
}

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function createDummyHost() {
  return {
    getSnapshot: async () => ({
      courses: [{ id: 'c1', name: 'Demo Course' }],
      decks: [{ id: 'd1', name: 'Demo Deck', course: 'Demo Course', cardCount: 5, dueCount: 2 }],
      focus: { course: 'Demo Course' },
      stats: { totalCards: 5, dueToday: 2, reviewedToday: 0 },
      sources: [],
      tasks: [],
      wrongBook: [],
      notes: [],
      modelReady: false,
    }),
    runAction: async () => ({ ok: true }),
    subscribe: () => () => {},
  };
}

function resetStore(page = 'library') {
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
    snapshot: {
      courses: [{ id: 'c1', name: 'Demo Course' }],
      decks: [{ id: 'd1', name: 'Demo Deck', course: 'Demo Course', cardCount: 5, dueCount: 2 }],
      focus: { course: 'Demo Course' },
      stats: { totalCards: 5, dueToday: 2, reviewedToday: 0 },
      sources: [],
      tasks: [],
      wrongBook: [],
      notes: [],
      modelReady: false,
    },
  });
}

describe('#1428 follow-ups (①②③) — Guardrails & Regression', () => {
  test('① Runtime isolation: focused AssistantPanel pushes an opaque KeyScope and blocks ALL left-page single-letter & global keys via KeyDispatcher', async () => {
    resetStore('library');
    const leaked = [];

    function ProbePage() {
      // Deliberately register active handlers at both VIEW and WIDGET layers to prove
      // KeyDispatcher scope barrier + drawer layer structurally isolate the focused dock.
      useScopedInput(
        (input) => {
          if (input) leaked.push(`view:${input}`);
          return false;
        },
        { isActive: true, layer: KEY_LAYER_VIEW, id: 'ProbePage:view' },
      );
      useScopedInput(
        (input) => {
          if (input) leaked.push(`widget:${input}`);
          return false;
        },
        { isActive: true, layer: KEY_LAYER_WIDGET, id: 'ProbePage:widget' },
      );
      return React.createElement(Box, null, React.createElement(Text, null, 'ProbeLeftPage'));
    }

    const { stdin, stdout } = createMockStreams(120, 36);
    const host = createDummyHost();
    const inst = render(
      React.createElement(AppShell, {
        host,
        autoLaunchpad: false,
        renderPage: () => React.createElement(ProbePage),
      }),
      { stdin, stdout, interactive: true, exitOnCtrlC: false },
    );

    try {
      await wait(80);
      const hub = getHub(stdin);
      assert.equal(hub.opaqueStack.size, 0, 'closed assistant must not hold an opaque KeyScope');

      // Open & focus the docked assistant panel
      useTuiStore.getState().openAssistant({ focused: true });
      await wait(120);
      assert.ok(hub.opaqueStack.size >= 1, 'focused docked AssistantPanel must push an opaque KeyScope barrier');

      // Send single-letter keys that would normally trigger global nav ('b'->board, 'd'->dashboard, 's'->sources)
      // or left-page shortcuts ('x', 'm', 'g', 'q').
      for (const ch of ['b', 'd', 's', 'm', 'x', 'g']) {
        stdin.write(ch);
        await wait(25);
      }

      assert.deepEqual(leaked, [], `Focused AssistantPanel must not leak single-letter keys to left page, got: ${leaked.join(', ')}`);
      assert.equal(useTuiStore.getState().page, 'library', 'Focused AssistantPanel must not let global page shortcuts navigate away');

      // Fullscreen focused assistant must also hold an opaque scope and isolate single-letter/global keys
      useTuiStore.getState().setAssistantFullscreen(true);
      await wait(80);
      assert.ok(hub.opaqueStack.size >= 1, 'fullscreen AssistantPanel must keep an opaque KeyScope barrier');
      for (const ch of ['b', 'd', 'x']) {
        stdin.write(ch);
        await wait(25);
      }
      assert.deepEqual(leaked, [], `Fullscreen AssistantPanel must not leak keys to left page, got: ${leaked.join(', ')}`);
      assert.equal(useTuiStore.getState().page, 'library', 'Fullscreen AssistantPanel must not trigger global navigation');

      // When passive (unfocused dock), opaque scope pops and left page receives single-letter keys normally
      useTuiStore.getState().setAssistantFullscreen(false);
      useTuiStore.getState().setAssistantFocused(false);
      await wait(80);
      assert.equal(hub.opaqueStack.size, 0, 'passive (unfocused) dock must release the opaque KeyScope barrier');
      stdin.write('x');
      await wait(40);
      assert.ok(leaked.includes('view:x'), 'Passive (unfocused) dock must let left page receive single-letter keys');
    } finally {
      inst.unmount();
    }
  });

  test('② Runtime 2-step Esc: works uniformly on non-review pages (library & board), respects page-level Esc first, and handles fullscreen 3-step', async () => {
    for (const startPage of ['library', 'board', 'review']) {
      resetStore(startPage);
      let filterActive = startPage === 'library';
      let filterCleared = 0;

      function EscProbePage({ isActive }) {
        useScopedInput(
          (_input, key) => {
            if (key.escape && filterActive) {
              filterActive = false;
              filterCleared += 1;
              return true;
            }
            return false;
          },
          { isActive, layer: KEY_LAYER_VIEW, id: `EscProbe:${startPage}` },
        );
        return React.createElement(Box, null, React.createElement(Text, null, `Page:${startPage}`));
      }

      const { stdin, stdout } = createMockStreams(120, 36);
      const host = createDummyHost();
      const inst = render(
        React.createElement(AppShell, {
          host,
          autoLaunchpad: false,
          renderPage: (_p, view) => React.createElement(EscProbePage, { isActive: view.isActive }),
        }),
        { stdin, stdout, interactive: true, exitOnCtrlC: false },
      );

      try {
        await wait(80);
        // Step 0: Open docked & focused
        useTuiStore.getState().openAssistant({ focused: true });
        await wait(120);
        assert.equal(useTuiStore.getState().assistantOpen, true);
        assert.equal(useTuiStore.getState().assistantFocused, true);

        // Step 1: 1st Esc hands keyboard back to page, dock stays visible!
        stdin.write('\u001b');
        await wait(80);
        assert.equal(useTuiStore.getState().assistantOpen, true, `[${startPage}] 1st Esc must keep dock visible`);
        assert.equal(useTuiStore.getState().assistantFocused, false, `[${startPage}] 1st Esc must hand keyboard back to page`);

        if (startPage === 'library') {
          // If the page itself has a filter to clear on Esc, Esc clears the filter FIRST without folding the dock!
          stdin.write('\u001b');
          await wait(80);
          assert.equal(filterCleared, 1, '[library] page-level Esc filter clear must run before passive dock fold');
          assert.equal(useTuiStore.getState().assistantOpen, true, '[library] dock stays open when Esc was consumed by page filter');
        }

        // Step 2: Next Esc (when nothing on page consumes it) folds the passive dock!
        stdin.write('\u001b');
        await wait(80);
        assert.equal(useTuiStore.getState().assistantOpen, false, `[${startPage}] 2nd Esc must fold the passive dock`);
        assert.equal(useTuiStore.getState().page, startPage, `[${startPage}] folding passive dock must keep user on current page`);

        // Fullscreen 3-step check on board: Esc1 exits fullscreen -> Esc2 hands focus back -> Esc3 folds dock
        if (startPage === 'board') {
          useTuiStore.getState().openAssistant({ focused: true });
          useTuiStore.getState().setAssistantFullscreen(true);
          await wait(100);
          stdin.write('\u001b');
          await wait(80);
          assert.equal(useTuiStore.getState().assistantFullscreen, false, '[board] fullscreen Esc1 exits fullscreen');
          assert.equal(useTuiStore.getState().assistantOpen, true, '[board] fullscreen Esc1 keeps dock open');
          assert.equal(useTuiStore.getState().assistantFocused, true, '[board] fullscreen Esc1 keeps dock focused');
          stdin.write('\u001b');
          await wait(80);
          assert.equal(useTuiStore.getState().assistantOpen, true, '[board] Esc2 keeps dock open');
          assert.equal(useTuiStore.getState().assistantFocused, false, '[board] Esc2 hands focus back');
          stdin.write('\u001b');
          await wait(80);
          assert.equal(useTuiStore.getState().assistantOpen, false, '[board] Esc3 folds dock');
        }
      } finally {
        inst.unmount();
      }
    }
  });

  test('③ Unit + live layout shift: ImeCursorAnchor immediately recomputes cursor when an ancestor shifts without any keystroke', async () => {
    assert.equal(typeof imeMod.subscribeRootLayout, 'function', 'ime-cursor.tsx must export subscribeRootLayout');
    assert.equal(typeof imeMod.resolveImeCursorPosition, 'function', 'ime-cursor.tsx must export resolveImeCursorPosition');

    // Unit test: subscribeRootLayout attaches to ink-root and cleans up cleanly
    const yoga = (left, top) => ({ getComputedLeft: () => left, getComputedTop: () => top });
    const root = { nodeName: 'ink-root', yogaNode: yoga(0, 0), parentNode: undefined };
    const parent = { nodeName: 'ink-box', yogaNode: yoga(10, 4), parentNode: root };
    const field = { nodeName: 'ink-box', yogaNode: yoga(2, 0), parentNode: parent };

    let hits = 0;
    const unsub = imeMod.subscribeRootLayout(field, () => {
      hits += 1;
    });
    assert.ok(root.internal_layoutListeners instanceof Set && root.internal_layoutListeners.size === 1);
    for (const fn of root.internal_layoutListeners) fn();
    assert.equal(hits, 1);
    unsub();
    assert.equal(root.internal_layoutListeners.size, 0);

    assert.deepEqual(imeMod.resolveImeCursorPosition(field, 3, 1), { x: 15, y: 5 });
    assert.equal(imeMod.resolveImeCursorPosition(null, 3, 1), undefined);

    // Live Ink render test: sibling above parent grows from height=1 to height=5 while field's
    // OWN relative layout.top stays 0. Verify ImeCursorAnchor IMMEDIATELY emits the new cursor row
    // without waiting for any keystroke!
    let setBannerHeightRef = null;
    let fieldRefOut = null;
    const observedPositions = [];

    // Wrap input field in React.memo (just like real TextInput = memo(...)) so parent banner resize
    // does NOT re-render the field — proving root layout listener alone repositions the IME cursor!
    const MemoField = React.memo(function MemoField() {
      const fieldRef = useRef(null);
      fieldRefOut = fieldRef;
      return React.createElement(
        Box,
        { ref: fieldRef, height: 1 },
        React.createElement(Text, null, 'input'),
        React.createElement(ImeCursorAnchor, {
          anchorRef: fieldRef,
          dx: 4,
          dy: 0,
          onPositionChange: (pos) => {
            if (pos) observedPositions.push(pos);
          },
        }),
      );
    });

    function LayoutShiftHarness() {
      const [bannerH, setBannerH] = useState(1);
      setBannerHeightRef = setBannerH;

      return React.createElement(
        Box,
        { flexDirection: 'column', width: 40, height: 15 },
        React.createElement(
          Box,
          { height: bannerH },
          React.createElement(Text, null, 'banner'),
        ),
        // Parent wrapper whose top shifts when bannerH changes, while child fieldRef's own top stays 0!
        React.createElement(
          Box,
          { flexDirection: 'column' },
          React.createElement(MemoField),
        ),
      );
    }

    const { stdin, stdout } = createMockStreams(40, 15);
    const inst = render(React.createElement(LayoutShiftHarness), { stdin, stdout, interactive: true, exitOnCtrlC: false });
    try {
      await wait(80);
      const firstOrigin = absoluteOrigin(fieldRefOut?.current);
      assert.ok(firstOrigin, 'field must be measured after mount');
      assert.equal(firstOrigin.y, 1, 'initial field y should be 1 (below 1-row banner)');
      const lastBefore = observedPositions[observedPositions.length - 1];
      assert.deepEqual(lastBefore, { x: 4, y: 1 }, 'initial IME cursor should sit at (4, 1)');

      // Now grow the sibling banner above the parent wrapper (NO keystroke sent!).
      setBannerHeightRef(5);
      await wait(100);

      const shiftedOrigin = absoluteOrigin(fieldRefOut?.current);
      assert.equal(shiftedOrigin?.y, 5, 'field absolute y should shift to 5');
      // Field's OWN relative top inside its parent wrapper is still 0 — proving ancestor shift!
      assert.equal(fieldRefOut?.current?.yogaNode?.getComputedTop(), 0, 'field own relative top must still be 0');
      const lastAfter = observedPositions[observedPositions.length - 1];
      assert.deepEqual(
        lastAfter,
        { x: 4, y: 5 },
        `ImeCursorAnchor must immediately reposition cursor to (4, 5) on ancestor layout shift without a keystroke, got: ${JSON.stringify(observedPositions)}`,
      );
    } finally {
      inst.unmount();
    }
  });
});
