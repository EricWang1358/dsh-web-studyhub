// #1354 P1 Key Routing Consistency & Boundary Guardrails:
// 1. Strict single Ink `useInput` boundary (only `src/input/hooks.ts`; `components/mouse.tsx` routes
//    through the unified dispatcher, consuming non-wheel SGR click frames while passing wheel frames).
// 2. TooSmallViewportNotice (< 60x18) mounts an opaque scope masking hidden views/modals while
//    preserving `q` / `Ctrl+C` quit (including unsaved-work quit guards).
// 3. ConfirmDialog pushes an opaque KeyScope so unhandled keys never bleed into underlying views or
//    parent modals at the same depth.
// 4. Explicit shell depth hierarchy (SHELL_OVERLAY < TOO_SMALL < QUIT_CONFIRM) ensures Quit
//    ConfirmDialog stays interactive above HelpOverlay, CommandPalette, and depth-2 nested modals.
// 5. AppShell:system (`Ctrl+K`/`Ctrl+Space`/`Ctrl+G`/`Ctrl+O`) respects pure P1 `<KeyScope opaque>`
//    without requiring legacy `useInputCapture`.
//
// node --test packages/studyhub-tui/tests/p1-key-routing-boundaries.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { Box, Text, render } from 'ink';
import React, { useState } from 'react';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const [
  { AppShell },
  { ConfirmDialog },
  { KeyScope, useKeyDispatcherBridge, useKeyScope },
  { parseSgrWheelDelta },
  { useTuiStore, DEFAULT_PREFERENCES },
] = await Promise.all([
  import('../src/shell/AppShell.tsx'),
  import('../src/components/ConfirmDialog.tsx'),
  import('../src/input/hooks.ts'),
  import('../src/components/VirtualList.tsx'),
  import('../src/state/store.ts'),
]);

function createTtyStreams(columns = 100, rows = 30) {
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

const flush = (ms = 45) => new Promise((r) => setTimeout(r, ms));
const press = async (stdin, seq) => {
  stdin.write(seq);
  await flush(30);
};

const BASE_SNAPSHOT = {
  revision: 1,
  courses: [{ id: 'c1', name: 'OS' }],
  decks: [],
  focus: { course: 'OS' },
  stats: { totalCards: 0, dueToday: 0, reviewedToday: 0 },
  sources: [],
  tasks: [],
  wrongBook: [],
  notes: [],
  modelReady: false,
};

const STUB_HOST = {
  mode: 'embedded',
  call: async () => ({ ok: true, value: {} }),
  snapshot: async () => BASE_SNAPSHOT,
  getConfig: () => ({ effective: { ready: false } }),
  subscribe: () => () => {},
  close: async () => {},
};

function resetShellStore(extra = {}) {
  useTuiStore.setState({
    page: 'library',
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
    notificationHistoryOpen: false,
    voicePackOpen: false,
    quitConfirmOpen: false,
    assistantOpen: false,
    assistantFocused: false,
    assistantFullscreen: false,
    practiceStack: [],
    toasts: [],
    footerHints: [],
    preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
    snapshot: BASE_SNAPSHOT,
    ...extra,
  });
}

describe('#1354 P1 Key Routing Consistency & Boundaries', () => {
  test('1. Strict single Ink useInput boundary: mouse.tsx is banned from raw ink useInput and consumes SGR click frames while passing wheel frames', async (t) => {
    // (a) ESLint no-restricted-imports must reject raw `useInput` even inside components/mouse.tsx
    const eslint = new ESLint({ cwd: REPO_ROOT });
    const [lintRes] = await eslint.lintText("import { useInput } from 'ink';\nexport const u = useInput;\n", {
      filePath: path.join(REPO_ROOT, 'packages/studyhub-tui/src/components/mouse.tsx'),
    });
    assert.ok(
      lintRes.messages.some((m) => m.ruleId === 'no-restricted-imports' && m.severity === 2),
      `components/mouse.tsx must NOT be exempt from ink useInput ban, got: ${JSON.stringify(lintRes.messages)}`,
    );

    // (b) Runtime: SGR click frames are consumed inside the single dispatcher; wheel frames still reach views
    const prevState = useTuiStore.getState();
    resetShellStore();
    t.after(() => useTuiStore.setState(prevState));

    const viewKeys = [];
    const wheelDeltas = [];
    function MouseBoundaryProbe() {
      useKeyScope({
        id: 'mouse-boundary-probe',
        onKey: (inp) => {
          const wd = parseSgrWheelDelta(inp);
          if (wd !== 0) {
            wheelDeltas.push(wd);
            return true;
          }
          viewKeys.push(inp);
          return true;
        },
      });
      return React.createElement(Text, null, 'MouseProbe');
    }

    const streams = createTtyStreams(100, 30);
    const inst = render(
      React.createElement(AppShell, {
        host: STUB_HOST,
        autoLaunchpad: false,
        renderPage: () => React.createElement(MouseBoundaryProbe),
      }),
      { stdin: streams.stdin, stdout: streams.stdout, interactive: true, exitOnCtrlC: false },
    );
    t.after(() => inst.unmount());

    await flush(70);
    // ESC-stripped SGR click frame arrives through Ink stdin -> must NOT leak into viewKeys
    streams.stdin.write('[<0;12;5M');
    await flush(45);
    assert.deepEqual(viewKeys, [], 'SGR mouse click frame must be consumed before reaching view handlers');

    // ESC-stripped SGR wheel-up frame -> must still reach view wheel handler
    streams.stdin.write('[<64;12;5M');
    await flush(45);
    assert.deepEqual(wheelDeltas, [-3], 'SGR wheel frame must still flow through to view wheel handlers');

    // Normal keyboard input still reaches view cleanly
    streams.stdin.write('x');
    await flush(45);
    assert.deepEqual(viewKeys, ['x']);
  });

  test('2. TooSmallViewportNotice (< 60x18) isolates hidden view from blind keystrokes while keeping q -> quit guard functional', async (t) => {
    const prevState = useTuiStore.getState();
    resetShellStore({
      quitGuard: () => {
        useTuiStore.getState().setQuitConfirmOpen(true);
        return true;
      },
    });
    t.after(() => useTuiStore.setState(prevState));

    let quitCalled = 0;
    const hiddenViewHits = [];
    function HiddenViewProbe() {
      useKeyScope({
        id: 'hidden-view-under-too-small',
        keys: ['a', '1', 'q', ' '],
        onKey: (inp) => {
          hiddenViewHits.push(inp);
          return true;
        },
      });
      return React.createElement(Text, null, 'HiddenReviewCard');
    }

    const streams = createTtyStreams(50, 14);
    const inst = render(
      React.createElement(AppShell, {
        host: STUB_HOST,
        autoLaunchpad: false,
        actions: { quit: () => { quitCalled += 1; } },
        renderPage: () => React.createElement(HiddenViewProbe),
      }),
      { stdin: streams.stdin, stdout: streams.stdout, interactive: true, exitOnCtrlC: false },
    );
    t.after(() => inst.unmount());

    await flush(70);

    // Blind keys must NOT leak into hidden view or navigate pages
    for (const ch of ['a', '1', ' ', 'b']) {
      await press(streams.stdin, ch);
    }
    assert.deepEqual(hiddenViewHits, [], 'TooSmallViewportNotice must block blind keystrokes from reaching hidden view');
    assert.equal(useTuiStore.getState().page, 'library', 'TooSmallViewportNotice must block global page navigation');

    // System overlay openers must NOT open hidden overlays behind TooSmallViewportNotice
    await press(streams.stdin, '\u000b'); // Ctrl+K
    await press(streams.stdin, '\u000f'); // Ctrl+O
    assert.equal(useTuiStore.getState().commandPaletteOpen, false, 'Ctrl+K must not open CommandPalette behind TooSmallViewportNotice');
    assert.equal(useTuiStore.getState().notificationHistoryOpen, false, 'Ctrl+O must not open Notifications behind TooSmallViewportNotice');

    // Pressing q must trigger quit guard -> Quit ConfirmDialog (even though hidden view claimed q)
    streams.stdin.write('q');
    await flush(50);
    assert.equal(useTuiStore.getState().quitConfirmOpen, true, 'q on TooSmallViewportNotice must open Quit ConfirmDialog when quit guard is active');
    assert.equal(quitCalled, 0, 'quit guard must still protect against accidental exit');

    // Pressing n cancels Quit ConfirmDialog; q -> y confirms quit
    streams.stdin.write('n');
    await flush(50);
    assert.equal(useTuiStore.getState().quitConfirmOpen, false, 'n must dismiss Quit ConfirmDialog above TooSmallViewportNotice');

    streams.stdin.write('q');
    await flush(50);
    assert.equal(useTuiStore.getState().quitConfirmOpen, true);
    streams.stdin.write('y');
    await flush(50);
    assert.equal(quitCalled, 1, 'y on Quit ConfirmDialog above TooSmallViewportNotice must execute quit');
    assert.deepEqual(hiddenViewHits, [], 'hidden view must remain untouched throughout quit dialog interaction');
  });

  test('3. ConfirmDialog pushes an opaque KeyScope blocking ALL unhandled keys from bleeding into same-depth parent modal', async (t) => {
    const parentHits = [];
    let cancelled = 0;

    function NestedConfirmHarness() {
      useKeyDispatcherBridge(true);
      return React.createElement(
        KeyScope,
        { id: 'parent-modal', opaque: true },
        React.createElement(ParentModalBody),
      );
    }

    function ParentModalBody() {
      // Deliberately keeps active=true without manual `!confirmOpen` to verify ConfirmDialog's own opaque barrier
      useKeyScope({
        id: 'parent-modal-body',
        onKey: (inp) => {
          parentHits.push(inp);
          return true;
        },
      });
      return React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, null, 'ParentModal'),
        React.createElement(ConfirmDialog, {
          title: 'Delete?',
          message: 'Confirm destructive action',
          overlay: false,
          onConfirm: () => {},
          onCancel: () => { cancelled += 1; },
        }),
      );
    }

    const streams = createTtyStreams(100, 30);
    const inst = render(React.createElement(NestedConfirmHarness), {
      stdin: streams.stdin,
      stdout: streams.stdout,
      interactive: true,
      exitOnCtrlC: false,
    });
    t.after(() => inst.unmount());

    await flush(70);
    // Unhandled keys on ConfirmDialog must NEVER bleed through to ParentModalBody
    for (const ch of ['d', '1', ' ', 'j', 'x']) {
      await press(streams.stdin, ch);
    }
    assert.deepEqual(parentHits, [], 'unhandled keys on ConfirmDialog must never leak into parent modal');

    streams.stdin.write('n');
    await flush(45);
    assert.equal(cancelled, 1, 'n must cancel ConfirmDialog cleanly');
  });

  test('4. Shell depth hierarchy: Quit ConfirmDialog (Ctrl+C) stays interactive above HelpOverlay and depth-2 nested page ConfirmDialog', async (t) => {
    const prevState = useTuiStore.getState();
    resetShellStore({
      helpOpen: true,
      quitGuard: () => {
        useTuiStore.getState().setQuitConfirmOpen(true);
        return true;
      },
    });
    t.after(() => useTuiStore.setState(prevState));

    let quitCalled = 0;
    let pageConfirmCancelled = 0;
    let pageConfirmConfirmed = 0;

    function DeepModalPage() {
      return React.createElement(
        KeyScope,
        { id: 'page-modal-depth-1', opaque: true },
        React.createElement(ConfirmDialog, {
          title: 'Inner Page Confirm',
          message: 'Nested at depth 2',
          overlay: false,
          onConfirm: () => { pageConfirmConfirmed += 1; },
          onCancel: () => { pageConfirmCancelled += 1; },
        }),
      );
    }

    const streams = createTtyStreams(100, 30);
    const inst = render(
      React.createElement(AppShell, {
        host: STUB_HOST,
        autoLaunchpad: false,
        actions: { quit: () => { quitCalled += 1; } },
        renderPage: () => React.createElement(DeepModalPage),
      }),
      { stdin: streams.stdin, stdout: streams.stdout, interactive: true, exitOnCtrlC: false },
    );
    t.after(() => inst.unmount());

    await flush(80);
    // Trigger Ctrl+C while BOTH HelpOverlay (helpOpen=true) AND depth-2 nested ConfirmDialog are mounted
    streams.stdin.write('\u0003');
    await flush(60);
    assert.equal(useTuiStore.getState().quitConfirmOpen, true, 'Ctrl+C must open Quit ConfirmDialog');

    // Pressing n must cancel Quit ConfirmDialog (NOT be frozen by helpOpen or hijacked by depth-2 ConfirmDialog)
    streams.stdin.write('n');
    await flush(50);
    assert.equal(useTuiStore.getState().quitConfirmOpen, false, 'n must cancel Quit ConfirmDialog even while helpOpen is true');
    assert.equal(pageConfirmCancelled, 0, 'depth-2 inner ConfirmDialog must NOT receive n meant for Quit ConfirmDialog');

    // Trigger Ctrl+C again and confirm with y
    streams.stdin.write('\u0003');
    await flush(50);
    assert.equal(useTuiStore.getState().quitConfirmOpen, true);
    streams.stdin.write('y');
    await flush(50);
    assert.equal(quitCalled, 1, 'y must confirm Quit ConfirmDialog above HelpOverlay and depth-2 page modal');
    assert.equal(pageConfirmConfirmed, 0, 'depth-2 inner ConfirmDialog must NOT receive y meant for Quit ConfirmDialog');
  });

  test('5. AppShell:system (Ctrl+K/Ctrl+Space/Ctrl+G/Ctrl+O) respects pure P1 <KeyScope opaque> without legacy useInputCapture', async (t) => {
    const prevState = useTuiStore.getState();
    resetShellStore();
    t.after(() => useTuiStore.setState(prevState));

    let setEditorOpen = null;
    function PureP1ScopePage() {
      const [open, setOpen] = useState(true);
      setEditorOpen = setOpen;
      return React.createElement(
        Box,
        null,
        open
          ? React.createElement(
              KeyScope,
              { id: 'pure-p1-opaque-editor', opaque: true },
              React.createElement(Text, null, 'PureP1Editor'),
            )
          : React.createElement(Text, null, 'IdlePage'),
      );
    }

    const streams = createTtyStreams(100, 30);
    const inst = render(
      React.createElement(AppShell, {
        host: STUB_HOST,
        autoLaunchpad: false,
        renderPage: () => React.createElement(PureP1ScopePage),
      }),
      { stdin: streams.stdin, stdout: streams.stdout, interactive: true, exitOnCtrlC: false },
    );
    t.after(() => inst.unmount());

    await flush(70);
    assert.equal(useTuiStore.getState().inputCaptured, false, 'precondition: legacy inputCaptured is false');

    // While pure P1 opaque KeyScope is mounted, system overlay openers must NOT open competing shell overlays
    await press(streams.stdin, '\u000b'); // Ctrl+K
    await press(streams.stdin, '\u0000'); // Ctrl+Space
    await press(streams.stdin, '\u0007'); // Ctrl+G
    await press(streams.stdin, '\u000f'); // Ctrl+O
    assert.equal(useTuiStore.getState().commandPaletteOpen, false, 'Ctrl+K must respect pure P1 opaque KeyScope');
    assert.equal(useTuiStore.getState().assistantOpen, false, 'Ctrl+Space/Ctrl+G must respect pure P1 opaque KeyScope');
    assert.equal(useTuiStore.getState().notificationHistoryOpen, false, 'Ctrl+O must respect pure P1 opaque KeyScope');

    // Once pure P1 opaque KeyScope unmounts, Ctrl+K opens CommandPalette normally
    setEditorOpen(false);
    await flush(50);
    streams.stdin.write('\u000b');
    await flush(50);
    assert.equal(useTuiStore.getState().commandPaletteOpen, true, 'Ctrl+K works again once opaque KeyScope pops');
  });
});
