// #1354 P1 Centralized Key Router & Alt-Chord Containment Guardrail Suite:
// Verifies that global shortcut routing and Alt+s / Alt+x / unhandled Alt+* containment
// live in one pure router (`src/input/global-router.ts`), that `AppShell` delegates to it
// without breaking TextInput's Alt+Enter / Alt+Backspace / Alt+Arrow editing chords, and
// that migrated shell/settings/view components use `useKeyScope` with modifier guards.
//
// node --test packages/studyhub-tui/tests/p1-centralized-key-router.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Box, Text, render } from 'ink';
import React, { useState } from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  { AppShell },
  { Launchpad },
  { ShellActionsContext },
  { Modal },
  { TextInput },
  { useScopedInput },
  { AppearanceTab },
  { WorkspaceTab },
  { DEFAULT_PREFERENCES, useTuiStore },
  { PAGE_REGISTRY },
] = await Promise.all([
  import('../src/shell/AppShell.tsx'),
  import('../src/shell/Launchpad.tsx'),
  import('../src/shell/actions.ts'),
  import('../src/components/Modal.tsx'),
  import('../src/components/TextInput.tsx'),
  import('../src/components/key-dispatcher.ts'),
  import('../src/views/settings/AppearanceTab.tsx'),
  import('../src/views/settings/WorkspaceTab.tsx'),
  import('../src/state/store.ts'),
  import('../src/types/contracts.ts'),
]);

function makeKey(overrides = {}) {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  };
}

function mountInk(element, { cols = 100, rows = 30 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  stdin.resume();

  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;

  let latest = '';
  let allOutput = '';
  stdout.on('data', (chunk) => {
    const s = stripAnsi(chunk.toString('utf8'));
    allOutput += s;
    if (s.trim()) latest = s;
  });

  const instance = render(element, {
    stdin,
    stdout,
    stderr: stdout,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    stdin,
    frame: () => latest || allOutput,
    send: (raw) => stdin.write(raw),
    async waitFor(predicate, timeoutMs = 4000, label = 'condition') {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const cur = latest || allOutput;
        if (predicate(cur)) return cur;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timed out waiting for ${label}; last frame:\n${latest || allOutput}`);
    },
    async settle(ms = 60) {
      await new Promise((r) => setTimeout(r, ms));
    },
    cleanup() {
      try {
        instance.unmount();
      } catch {
        // already unmounted
      }
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function makeOfflineHost() {
  return {
    mode: 'embedded',
    getLibraryRoot: () => '',
    call: async () => ({ ok: true, value: {} }),
    getConfig: () => ({ effective: { ready: false } }),
    close: async () => {},
  };
}

describe('#1354 P1 Centralized Global & Alt-Chord Key Router', () => {
  test('1. global-router pure tables & resolvers cover all global/system/alt routes deterministically', async () => {
    const router = await import('../src/input/global-router.ts');

    // (a) Single-key global routes and PAGE_REGISTRY shortcuts never collide
    const pageShortcuts = PAGE_REGISTRY.map((p) => p.shortcut);
    const singleKeys = Object.keys(router.GLOBAL_SINGLE_KEY_ROUTES);
    assert.equal(new Set(pageShortcuts).size, pageShortcuts.length);
    assert.equal(new Set(singleKeys).size, singleKeys.length);
    for (const k of singleKeys) {
      assert.ok(!pageShortcuts.includes(k), `GLOBAL_SINGLE_KEY_ROUTES key "${k}" must not collide with PAGE_REGISTRY`);
    }

    // (b) Alt-chord guard: intercepts Alt+s, Alt+x, Alt+q, Alt+1, Alt+?, Alt+/, Alt+c;
    //     passes TextInput editing chords (Alt+Enter, Alt+Left/Right, Alt+Backspace/Delete) & plain/Ctrl keys.
    for (const ch of ['s', 'x', 'S', 'X', 'q', 'd', 'r', 'c', '/', '?', '1', '2']) {
      const res = router.resolveAltChordRoute(ch, makeKey({ meta: true }));
      assert.equal(res.kind, 'consume-unhandled-alt', `Alt+${ch} must be consumed by centralized alt guard`);
    }
    assert.equal(router.resolveAltChordRoute('', makeKey({ meta: true, return: true })).kind, 'pass');
    assert.equal(router.resolveAltChordRoute('', makeKey({ meta: true, leftArrow: true })).kind, 'pass');
    assert.equal(router.resolveAltChordRoute('', makeKey({ meta: true, rightArrow: true })).kind, 'pass');
    assert.equal(router.resolveAltChordRoute('', makeKey({ meta: true, backspace: true })).kind, 'pass');
    assert.equal(router.resolveAltChordRoute('', makeKey({ meta: true, delete: true })).kind, 'pass');
    assert.equal(router.resolveAltChordRoute('s', makeKey()).kind, 'pass');
    assert.equal(router.resolveAltChordRoute('x', makeKey()).kind, 'pass');
    assert.equal(router.resolveAltChordRoute('k', makeKey({ ctrl: true })).kind, 'pass');

    // (c) isPlainKey helper
    assert.equal(router.isPlainKey('s', makeKey()), true);
    assert.equal(router.isPlainKey('s', makeKey({ meta: true })), false);
    assert.equal(router.isPlainKey('s', makeKey({ ctrl: true })), false);
    assert.equal(router.isPlainKey('', makeKey()), false);

    // (d) resolveGlobalKeyRoute: single keys, page jumps, cycle, backspace, passive-dock Esc, claim & reserved rules
    const baseCtx = {
      overlayOpen: false,
      inputCaptured: false,
      showLaunchpad: false,
      page: 'library',
      passiveAssistantOpen: false,
      isKeyClaimed: () => false,
    };
    assert.deepEqual(router.resolveGlobalKeyRoute('/', makeKey(), baseCtx), { action: 'palette-open' });
    assert.deepEqual(router.resolveGlobalKeyRoute('?', makeKey(), baseCtx), { action: 'help-open' });
    assert.deepEqual(router.resolveGlobalKeyRoute('c', makeKey(), baseCtx), { action: 'course-picker-open' });
    assert.deepEqual(router.resolveGlobalKeyRoute('I', makeKey(), baseCtx), { action: 'inbox-open' });
    assert.deepEqual(router.resolveGlobalKeyRoute('q', makeKey(), baseCtx), { action: 'quit-request' });
    assert.deepEqual(router.resolveGlobalKeyRoute('\\', makeKey(), baseCtx), { action: 'toggle-sidebar' });
    assert.deepEqual(router.resolveGlobalKeyRoute(']', makeKey(), baseCtx), { action: 'page-next' });
    assert.deepEqual(router.resolveGlobalKeyRoute('[', makeKey(), baseCtx), { action: 'page-prev' });
    assert.deepEqual(router.resolveGlobalKeyRoute('', makeKey({ backspace: true }), baseCtx), { action: 'go-back' });
    assert.deepEqual(router.resolveGlobalKeyRoute('r', makeKey(), baseCtx), { action: 'navigate-review' });
    assert.deepEqual(router.resolveGlobalKeyRoute('2', makeKey(), baseCtx), { action: 'navigate-page', page: 'sources' });
    assert.deepEqual(
      router.resolveGlobalKeyRoute('', makeKey({ escape: true }), { ...baseCtx, passiveAssistantOpen: true }),
      { action: 'fold-passive-assistant' },
    );

    // Modifier keys & overlays never resolve to global shortcuts
    assert.equal(router.resolveGlobalKeyRoute('q', makeKey({ meta: true }), baseCtx), null);
    assert.equal(router.resolveGlobalKeyRoute('2', makeKey({ meta: true }), baseCtx), null);
    assert.equal(router.resolveGlobalKeyRoute('/', makeKey({ ctrl: true }), baseCtx), null);
    assert.equal(router.resolveGlobalKeyRoute('?', makeKey(), { ...baseCtx, overlayOpen: true }), null);
    assert.equal(router.resolveGlobalKeyRoute('?', makeKey(), { ...baseCtx, inputCaptured: true }), null);

    // Non-reserved keys yield to claimed keys; reserved keys ('r', 'q', '?') NEVER yield
    const allClaimedCtx = { ...baseCtx, isKeyClaimed: () => true };
    assert.equal(router.resolveGlobalKeyRoute('c', makeKey(), allClaimedCtx), null);
    assert.equal(router.resolveGlobalKeyRoute('/', makeKey(), allClaimedCtx), null);
    assert.equal(router.resolveGlobalKeyRoute('', makeKey({ backspace: true }), allClaimedCtx), null);
    assert.deepEqual(router.resolveGlobalKeyRoute('?', makeKey(), allClaimedCtx), { action: 'help-open' });
    assert.deepEqual(router.resolveGlobalKeyRoute('q', makeKey(), allClaimedCtx), { action: 'quit-request' });
    assert.deepEqual(router.resolveGlobalKeyRoute('r', makeKey(), allClaimedCtx), { action: 'navigate-review' });

    // Launchpad reserves s/i/m
    for (const k of ['s', 'i', 'm']) {
      assert.equal(router.resolveGlobalKeyRoute(k, makeKey(), { ...baseCtx, showLaunchpad: true }), null);
    }

    // (e) resolveSystemKeyRoute
    const sysCtx = {
      blockedByScope: false,
      tooSmall: false,
      quitConfirmOpen: false,
      commandPaletteOpen: false,
      assistantOpen: false,
      assistantFocused: false,
      assistantFullscreen: false,
    };
    assert.deepEqual(router.resolveSystemKeyRoute('c', makeKey({ ctrl: true }), sysCtx), {
      action: 'quit-request',
      consume: true,
    });
    assert.deepEqual(
      router.resolveSystemKeyRoute('c', makeKey({ ctrl: true }), { ...sysCtx, quitConfirmOpen: true }),
      { action: 'quit-force', consume: true },
    );
    assert.deepEqual(router.resolveSystemKeyRoute('k', makeKey({ ctrl: true }), sysCtx), {
      action: 'palette-open',
      consume: true,
    });
    assert.deepEqual(router.resolveSystemKeyRoute('\u0000', makeKey(), sysCtx), {
      action: 'assistant-open-passive',
      consume: true,
    });
    assert.deepEqual(
      router.resolveSystemKeyRoute('\u0000', makeKey(), { ...sysCtx, assistantOpen: true }),
      { action: 'assistant-focus', consume: true },
    );
    assert.deepEqual(
      router.resolveSystemKeyRoute('\u0000', makeKey(), { ...sysCtx, assistantOpen: true, assistantFocused: true }),
      { action: 'assistant-close', consume: true },
    );
    assert.deepEqual(router.resolveSystemKeyRoute('r', makeKey({ ctrl: true }), sysCtx), {
      action: 'refresh',
      consume: false,
    });
    // Meta+Ctrl chords are rejected
    assert.equal(router.resolveSystemKeyRoute('k', makeKey({ ctrl: true, meta: true }), sysCtx), null);
  });

  test('2. Real AppShell: Alt+s and Alt+x never leak into view or modal handlers, while plain s/x & TextInput Alt-editing still work', async (t) => {
    const prevState = useTuiStore.getState();
    useTuiStore.setState({
      page: 'library',
      history: [],
      showLaunchpad: false,
      commandPaletteOpen: false,
      helpOpen: false,
      coursePickerOpen: false,
      inboxOpen: false,
      notificationHistoryOpen: false,
      quitConfirmOpen: false,
      assistantOpen: false,
      assistantFocused: false,
      assistantFullscreen: false,
      inputCaptured: false,
      loading: false,
      snapshot: { revision: 1, decks: [{ id: 'd1', title: 'Demo', cardCount: 1 }], courses: [], sources: [], notes: [], drafts: [], jobs: [] },
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
      toasts: [],
    });
    t.after(() => useTuiStore.setState(prevState));

    let sCount = 0;
    let xCount = 0;
    let modalXCount = 0;
    let latestText = '';

    function ProbeModalBody({ isActive }) {
      useScopedInput(
        (input) => {
          if (input === 'x') {
            modalXCount += 1;
            return true;
          }
          return false;
        },
        { isActive, id: 'probe:modal' },
      );
      return React.createElement(Text, null, 'MODAL_BODY');
    }

    function ProbePage({ isActive }) {
      const [mode, setMode] = useState('view'); // 'view' | 'modal' | 'input'
      const [val, setVal] = useState('');

      // Deliberately unguarded single-key checks (simulating legacy handlers without !key.meta)
      useScopedInput(
        (input) => {
          if (input === 's') {
            sCount += 1;
            return true;
          }
          if (input === 'x') {
            xCount += 1;
            return true;
          }
          if (input === 'M') {
            setMode('modal');
            return true;
          }
          if (input === 'E') {
            setMode('input');
            return true;
          }
          return false;
        },
        { isActive: isActive && mode === 'view', id: 'probe:view' },
      );

      return React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(Text, null, `PROBE mode=${mode} s=${sCount} x=${xCount} mx=${modalXCount} val=${JSON.stringify(val)}`),
        mode === 'modal'
          ? React.createElement(
              Modal,
              { title: 'ProbeModal', overlay: false, width: 50, height: 10, isActive, onClose: () => setMode('view') },
              React.createElement(ProbeModalBody, { isActive }),
            )
          : null,
        mode === 'input'
          ? React.createElement(TextInput, {
              value: val,
              onChange: (next) => {
                latestText = next;
                setVal(next);
              },
              multiline: true,
              submitOnEnter: true,
              isActive,
            })
          : null,
      );
    }

    const host = makeOfflineHost();
    const h = mountInk(
      React.createElement(AppShell, {
        host,
        autoLaunchpad: false,
        renderPage: (_page, view) => React.createElement(ProbePage, { isActive: view.isActive }),
      }),
      { cols: 100, rows: 28 },
    );
    t.after(() => h.cleanup());

    await h.waitFor((s) => s.includes('PROBE mode=view'), 4000, 'ProbePage mount');

    // Alt+s (\x1bs) and Alt+x (\x1bx) MUST NOT trigger s or x in ProbePage
    h.send('\x1bs');
    await h.settle(50);
    h.send('\x1bx');
    await h.settle(50);
    assert.equal(sCount, 0, 'Alt+s must NEVER trigger view s handler');
    assert.equal(xCount, 0, 'Alt+x must NEVER trigger view x handler');

    // Plain s and plain x MUST still work
    h.send('s');
    await h.settle(40);
    h.send('x');
    await h.settle(40);
    assert.equal(sCount, 1, 'Plain s must trigger view s handler');
    assert.equal(xCount, 1, 'Plain x must trigger view x handler');

    // Inside an opaque Modal, Alt+x must STILL be blocked by centralized KEY_LAYER_SYSTEM alt guard,
    // while plain x inside the Modal still reaches ProbeModalBody.
    h.send('M');
    await h.waitFor((s) => s.includes('MODAL_BODY'), 3000, 'ProbeModal open');
    h.send('\x1bx');
    await h.settle(50);
    assert.equal(modalXCount, 0, 'Alt+x must NEVER trigger modal x handler');
    h.send('x');
    await h.settle(40);
    assert.equal(modalXCount, 1, 'Plain x must still reach modal x handler');
    h.send('\x1b'); // Esc closes modal
    await h.waitFor((s) => s.includes('PROBE mode=view'), 3000, 'ProbeModal close');

    // TextInput Alt+Backspace (word delete) and Alt+Enter (newline when submitOnEnter=true) MUST STILL PASS THROUGH
    h.send('E');
    await h.waitFor((s) => s.includes('PROBE mode=input'), 3000, 'TextInput mode');
    h.send('hello world');
    await h.settle(50);
    assert.equal(latestText, 'hello world');
    h.send('\x1b\x7f'); // Alt+Backspace deletes "world"
    await h.settle(50);
    assert.equal(latestText, 'hello ', 'Alt+Backspace must still delete previous word in TextInput');
    h.send('\x1b\r'); // Alt+Enter inserts newline when submitOnEnter=true
    await h.settle(50);
    h.send('line2');
    await h.settle(50);
    assert.equal(latestText, 'hello \nline2', 'Alt+Enter must still insert newline in TextInput');
  });

  test('3. Real AppShell: global shortcut routing (?, \\, ], [, 2, Backspace, passive-dock Esc) & Alt+global neutrality', async (t) => {
    const prevState = useTuiStore.getState();
    let quitCalled = 0;
    useTuiStore.setState({
      page: 'library',
      history: [],
      showLaunchpad: false,
      commandPaletteOpen: false,
      helpOpen: false,
      coursePickerOpen: false,
      inboxOpen: false,
      notificationHistoryOpen: false,
      quitConfirmOpen: false,
      assistantOpen: false,
      assistantFocused: false,
      assistantFullscreen: false,
      inputCaptured: false,
      loading: false,
      snapshot: { revision: 1, decks: [{ id: 'd1', title: 'Demo', cardCount: 1 }], courses: [], sources: [], notes: [], drafts: [], jobs: [] },
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true, sidebarCollapsed: false },
      toasts: [],
    });
    t.after(() => useTuiStore.setState(prevState));

    const host = makeOfflineHost();
    const h = mountInk(
      React.createElement(AppShell, {
        host,
        autoLaunchpad: false,
        actions: {
          quit: () => {
            quitCalled += 1;
          },
        },
        renderPage: (page) => React.createElement(Text, null, `CURRENT_PAGE=${page}`),
      }),
      { cols: 120, rows: 32 },
    );
    t.after(() => h.cleanup());

    await h.waitFor((s) => s.includes('CURRENT_PAGE=library'), 4000, 'AppShell mount');

    // Alt+? / Alt+/ / Alt+q / Alt+2 must NOT trigger any global command
    h.send('\x1b?');
    h.send('\x1b/');
    h.send('\x1bq');
    h.send('\x1b2');
    await h.settle(80);
    assert.equal(useTuiStore.getState().helpOpen, false, 'Alt+? must not open HelpOverlay');
    assert.equal(useTuiStore.getState().commandPaletteOpen, false, 'Alt+/ must not open CommandPalette');
    assert.equal(quitCalled, 0, 'Alt+q must not request quit');
    assert.equal(useTuiStore.getState().page, 'library', 'Alt+2 must not jump page');

    // Plain global shortcuts route cleanly
    h.send('\\');
    await h.settle(40);
    assert.equal(useTuiStore.getState().preferences.sidebarCollapsed, true, '\\ must toggle sidebar');

    h.send('2');
    await h.waitFor((s) => s.includes('CURRENT_PAGE=sources'), 3000, 'page jump 2 -> sources');

    h.send('\x7f'); // Backspace -> goBack
    await h.waitFor((s) => s.includes('CURRENT_PAGE=library'), 3000, 'Backspace -> library');

    h.send(']');
    await h.settle(40);
    assert.notEqual(useTuiStore.getState().page, 'library', '] must advance to next page');
    h.send('[');
    await h.waitFor((s) => s.includes('CURRENT_PAGE=library'), 3000, '[ must cycle back to library');

    // Passive assistant dock + Esc fold
    useTuiStore.getState().openAssistant({ focused: false });
    await h.settle(50);
    assert.equal(useTuiStore.getState().assistantOpen, true);
    h.send('\x1b');
    await h.settle(60);
    assert.equal(useTuiStore.getState().assistantOpen, false, 'Esc must fold passive assistant dock');
  });

  test('4. Migrated standalone components (Launchpad, AppearanceTab, WorkspaceTab) guard Alt+s/Alt+x/Alt+l via useKeyScope', async (t) => {
    const prevState = useTuiStore.getState();
    useTuiStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true, theme: 'obsidian' },
      binding: { root: '/tmp/studyhub-p1-probe' },
      snapshot: { revision: 1, decks: [], courses: [], sources: [], notes: [], drafts: [], jobs: [] },
      toasts: [],
    });
    t.after(() => useTuiStore.setState(prevState));

    // (a) Standalone Launchpad: Alt+s ignored, plain s triggers loadSample
    let sampleLoaded = 0;
    const mockActions = {
      refresh: async () => {},
      loadSample: async () => {
        sampleLoaded += 1;
      },
      importSource: () => {},
      openModelSettings: () => {},
      selectCourse: async () => {},
      quit: () => {},
    };
    const hLaunch = mountInk(
      React.createElement(
        ShellActionsContext.Provider,
        { value: mockActions },
        React.createElement(Launchpad, { width: 90, height: 26, isActive: true }),
      ),
      { cols: 90, rows: 26 },
    );
    t.after(() => hLaunch.cleanup());
    await hLaunch.waitFor((s) => s.length > 0, 3000, 'Launchpad render');

    hLaunch.send('\x1bs'); // Alt+s must NOT load sample
    await hLaunch.settle(50);
    assert.equal(sampleLoaded, 0, 'Standalone Launchpad must ignore Alt+s');

    hLaunch.send('s'); // Plain s MUST load sample
    await hLaunch.settle(50);
    assert.equal(sampleLoaded, 1, 'Standalone Launchpad plain s must trigger loadSample');
    hLaunch.cleanup();

    // (b) Standalone AppearanceTab: Alt+l ignored, plain l cycles theme
    const host = makeOfflineHost();
    const hAppear = mountInk(
      React.createElement(AppearanceTab, { host, width: 90, height: 24, isActive: true }),
      { cols: 90, rows: 24 },
    );
    t.after(() => hAppear.cleanup());
    await hAppear.waitFor((s) => s.includes('配色主题'), 3000, 'AppearanceTab render');

    const themeBefore = useTuiStore.getState().preferences.theme;
    hAppear.send('\x1bl'); // Alt+l must NOT change theme
    await hAppear.settle(50);
    assert.equal(useTuiStore.getState().preferences.theme, themeBefore, 'AppearanceTab must ignore Alt+l');

    hAppear.send('l'); // Plain l MUST cycle theme
    await hAppear.settle(50);
    assert.notEqual(useTuiStore.getState().preferences.theme, themeBefore, 'AppearanceTab plain l must cycle theme');
    hAppear.cleanup();

    // (c) Standalone WorkspaceTab: Alt+s & Alt+x must NOT toggle sample or open export modal
    let sampleCallCount = 0;
    const wsHost = {
      ...makeOfflineHost(),
      call: async (action) => {
        if (action === 'sample.toggle' || action === 'sample.load') sampleCallCount += 1;
        return { ok: true, value: { points: [], providers: [], total: { calls: 0 } } };
      },
    };
    const hWs = mountInk(
      React.createElement(WorkspaceTab, { host: wsHost, width: 100, height: 26, isActive: true }),
      { cols: 100, rows: 26 },
    );
    t.after(() => hWs.cleanup());
    await hWs.waitFor((s) => s.length > 0, 3000, 'WorkspaceTab render');

    hWs.send('\x1bs');
    hWs.send('\x1bx');
    await hWs.settle(60);
    assert.equal(sampleCallCount, 0, 'WorkspaceTab must ignore Alt+s');
    assert.ok(!hWs.frame().includes('导出备份'), `WorkspaceTab must ignore Alt+x:\n${hWs.frame()}`);
    hWs.cleanup();
  });
});
