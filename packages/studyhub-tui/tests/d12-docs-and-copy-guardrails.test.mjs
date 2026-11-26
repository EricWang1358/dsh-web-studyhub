// Automated D12 / D2 / D3 / D6 engineering guardrails (#1354):
// 1. D12 Docs-to-Code Parity: `docs/ARCHITECTURE.md` stays aligned with live `THEME_IDS`,
//    `MAX_TOAST_HISTORY`, P1 input scope stack (`src/input/`), shipped docs, and disk paths.
// 2. D2 Keybinding Vocabulary: `GLOBAL_KEYMAP_ENTRIES` carries canonical `verb` tags,
//    `CANONICAL_ACTION_VOCABULARY` agrees with global routes, and `notification-history`
//    tracks `MAX_TOAST_HISTORY` dynamically.
// 3. D3 Shell Hint Consistency: `TopBar`, `Launchpad`, `resolveShellFooterHints`, and
//    `HelpOverlay.globalShortcuts` derive global shortcut copy from `global-keymap.ts`.
// 4. D6 Notification & Toast Copy Consistency: `NotificationHistoryModal` and `InboxModal`
//    share `toast-copy.ts` for tone labels, empty/cleared copy, dynamic `MAX_TOAST_HISTORY`,
//    accurate `toasts` search denominator, and `Ctrl+R` refresh parity.
// Run: node --test tests/d12-docs-and-copy-guardrails.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const ARCHITECTURE_DOC = fs.readFileSync(path.join(PKG_ROOT, 'docs/ARCHITECTURE.md'), 'utf8');

const [
  themeMod,
  storeMod,
  dispatcherMod,
  routerMod,
  globalKeymapMod,
  focusMod,
  helpMod,
  topBarMod,
  launchpadMod,
  notifModalMod,
  inboxModalMod,
  actionsMod,
  keyDispatcherMod,
] = await Promise.all([
  import('../src/theme/tokens.ts'),
  import('../src/state/store.ts'),
  import('../src/input/dispatcher.ts'),
  import('../src/input/global-router.ts'),
  import('../src/shell/global-keymap.ts'),
  import('../src/components/focus.ts'),
  import('../src/shell/HelpOverlay.tsx'),
  import('../src/shell/TopBar.tsx'),
  import('../src/shell/Launchpad.tsx'),
  import('../src/shell/NotificationHistoryModal.tsx'),
  import('../src/shell/InboxModal.tsx'),
  import('../src/shell/actions.ts'),
  import('../src/components/key-dispatcher.ts'),
]);

const { useTuiStore, DEFAULT_PREFERENCES, MAX_TOAST_HISTORY } = storeMod;

function createRenderStreams(cols = 120, rows = 36) {
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
  const allFrames = [];
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim().length > 0) {
      latest = plain;
      allFrames.push(plain);
    }
  });

  return {
    stdin,
    stdout,
    latest: () => latest,
    combined: () => allFrames.join('\n'),
    destroy: () => {
      stdin.destroy();
      stdout.destroy();
    },
  };
}

async function waitForOutput(streams, predicate, timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cur = streams.latest();
    if (predicate(cur)) return cur;
    await new Promise((r) => setTimeout(r, 25));
  }
  return streams.latest();
}

describe('#1354 D12 Docs-to-Code Parity (ARCHITECTURE.md)', () => {
  test('ARCHITECTURE.md documents exact live theme count, shipped docs, P1 input stack, toastHistory, and lint checklist', () => {
    const liveThemeCount = themeMod.THEME_IDS.length;
    const themeMatch = ARCHITECTURE_DOC.match(/(\d+)\s+WCAG\s+palettes/);
    assert.ok(themeMatch, 'ARCHITECTURE.md must state the WCAG palette count');
    assert.equal(
      Number(themeMatch[1]),
      liveThemeCount,
      `ARCHITECTURE.md theme count (${themeMatch[1]}) must match live THEME_IDS.length (${liveThemeCount})`,
    );
    assert.equal(
      ARCHITECTURE_DOC.includes('4 WCAG palettes'),
      false,
      'ARCHITECTURE.md must not contain stale "4 WCAG palettes" text',
    );

    for (const requiredRef of [
      'GUIDE.md',
      'ASSISTANT-UX.md',
      'src/input/dispatcher.ts',
      'src/input/global-router.ts',
      'SHELL_KEY_ROUTER',
      'KEY_LAYER_SYSTEM',
      'KEY_SCOPE_DEPTH_SHELL_OVERLAY',
      'global-keymap.ts',
      'toast-copy.ts',
      'NotificationHistoryModal',
      `toastHistory (${MAX_TOAST_HISTORY})`,
      'npm run lint',
    ]) {
      assert.ok(
        ARCHITECTURE_DOC.includes(requiredRef),
        `ARCHITECTURE.md missing up-to-date architectural reference "${requiredRef}"`,
      );
    }

    // Old pre-P1 ConfirmDialog rule must be replaced by the P1 scope stack description.
    assert.equal(
      ARCHITECTURE_DOC.includes('ConfirmDialog gates !shellOverlay'),
      false,
      'ARCHITECTURE.md Section 3 must document the P1 scope stack instead of legacy ConfirmDialog !shellOverlay gating',
    );
  });

  test('Every backticked src/... or docs/... file path referenced in ARCHITECTURE.md exists on disk', () => {
    const missing = [];
    const seen = new Set();
    const pathRe = new RegExp('`((?:src|docs|scripts|bin|tests)/[A-Za-z0-9._/-]+\\.(?:ts|tsx|mjs|md))`', 'g');
    let match;
    while ((match = pathRe.exec(ARCHITECTURE_DOC))) {
      const rel = match[1];
      if (rel.includes('*') || seen.has(rel)) continue;
      seen.add(rel);
      if (!fs.existsSync(path.join(PKG_ROOT, rel))) {
        missing.push(rel);
      }
    }
    assert.ok(seen.size >= 15, `Expected at least 15 explicit repo paths in ARCHITECTURE.md, found ${seen.size}`);
    assert.deepEqual(
      missing,
      [],
      `ARCHITECTURE.md references non-existent files: ${missing.join(', ')}`,
    );
  });

  test('ARCHITECTURE.md input layer exports match live src/input/dispatcher.ts exports', () => {
    const liveLayerNames = Object.keys(dispatcherMod).filter((k) => k.startsWith('KEY_LAYER_'));
    assert.ok(liveLayerNames.length >= 8);
    assert.ok(ARCHITECTURE_DOC.includes('KEY_LAYER_SYSTEM'));
    assert.ok(ARCHITECTURE_DOC.includes('KEY_LAYER_GLOBAL'));
    assert.ok(ARCHITECTURE_DOC.includes('KEY_LAYER_MODAL'));
  });
});

describe('#1354 D2 & D3 Global Keybinding Vocabulary & Shell Hint Single Source', () => {
  test('GLOBAL_KEYMAP_ENTRIES defines canonical verbs and covers every GLOBAL_SINGLE_KEY_ROUTES action', () => {
    assert.equal(typeof globalKeymapMod.formatGlobalKeyHint, 'function', 'global-keymap must export formatGlobalKeyHint');
    assert.ok(
      Array.isArray(globalKeymapMod.CANONICAL_ACTION_VOCABULARY) && globalKeymapMod.CANONICAL_ACTION_VOCABULARY.length >= 8,
      'global-keymap must export CANONICAL_ACTION_VOCABULARY with at least 8 canonical verbs',
    );

    const verbs = new Set();
    for (const entry of globalKeymapMod.GLOBAL_KEYMAP_ENTRIES) {
      assert.ok(
        typeof entry.verb === 'string' && entry.verb.trim().length > 0,
        `GLOBAL_KEYMAP_ENTRIES "${entry.id}" must declare a non-empty canonical verb`,
      );
      assert.equal(verbs.has(entry.verb), false, `Duplicate verb "${entry.verb}" in GLOBAL_KEYMAP_ENTRIES`);
      verbs.add(entry.verb);
      assert.ok(entry.helpZh.trim().length > 0 && entry.helpEn.trim().length > 0);
    }

    // Every canonical vocabulary verb must have unique id, key, zh & en labels.
    const vocabVerbs = new Set();
    for (const item of globalKeymapMod.CANONICAL_ACTION_VOCABULARY) {
      assert.equal(vocabVerbs.has(item.verb), false, `Duplicate canonical action verb "${item.verb}"`);
      vocabVerbs.add(item.verb);
      assert.ok(item.key.trim().length > 0 && item.labelZh.trim().length > 0 && item.labelEn.trim().length > 0);
    }

    // Overlapping global routes in CANONICAL_ACTION_VOCABULARY must match GLOBAL_KEYMAP_ENTRIES keys.
    const byVerb = new Map(globalKeymapMod.GLOBAL_KEYMAP_ENTRIES.map((e) => [e.verb, e]));
    for (const item of globalKeymapMod.CANONICAL_ACTION_VOCABULARY) {
      const globalEntry = byVerb.get(item.verb);
      if (!globalEntry) continue;
      const entryKey = globalEntry.footerKey ?? globalEntry.helpKey;
      assert.equal(
        entryKey,
        item.key,
        `Canonical verb "${item.verb}" key "${item.key}" must match GLOBAL_KEYMAP_ENTRIES "${entryKey}"`,
      );
    }

    // Every single-key global route in global-router.ts must be represented in GLOBAL_KEYMAP_ENTRIES.
    const allKeyTokens = globalKeymapMod.GLOBAL_KEYMAP_ENTRIES.map((e) => `${e.helpKey} ${e.footerKey ?? ''}`).join(' ');
    for (const routeKey of Object.keys(routerMod.GLOBAL_SINGLE_KEY_ROUTES)) {
      assert.ok(
        allKeyTokens.includes(routeKey),
        `Global route key "${routeKey}" from GLOBAL_SINGLE_KEY_ROUTES is missing from GLOBAL_KEYMAP_ENTRIES`,
      );
    }

    // Notification history description dynamically tracks MAX_TOAST_HISTORY.
    const notifEntry = globalKeymapMod.GLOBAL_KEYMAP_ENTRIES.find((e) => e.id === 'notification-history');
    assert.ok(notifEntry);
    assert.ok(notifEntry.helpZh.includes(String(MAX_TOAST_HISTORY)));
    assert.ok(notifEntry.helpEn.includes(String(MAX_TOAST_HISTORY)));
  });

  test('TopBar and Launchpad render global shortcut copy derived from global-keymap.ts in zh and en', async () => {
    const prev = useTuiStore.getState();
    const shellActions = actionsMod.createDefaultShellActions(
      {
        call: async () => ({ ok: true, data: {} }),
        onEvent: () => () => {},
        dispose: async () => {},
      },
      () => {},
    );

    try {
      for (const lang of ['zh', 'en']) {
        useTuiStore.setState({
          page: 'library',
          snapshot: { root: '/tmp/lib', decks: [], sources: [], courses: [], inbox: [] },
          desktopConfig: null,
          binding: null,
          practiceStack: [],
          preferences: { ...DEFAULT_PREFERENCES, language: lang, asciiMode: true },
        });

        const expectedHelp = globalKeymapMod.formatGlobalKeyHint('help', lang, true);
        const expectedCmd = globalKeymapMod.formatGlobalKeyHint('command-palette', lang, true);
        const expectedQuit = globalKeymapMod.formatGlobalKeyHint('quit', lang, true);

        const topStreams = createRenderStreams(140, 4);
        const topInst = render(React.createElement(topBarMod.TopBar, { width: 140 }), {
          stdin: topStreams.stdin,
          stdout: topStreams.stdout,
          interactive: true,
          exitOnCtrlC: false,
          debug: true,
        });
        try {
          const out = await waitForOutput(topStreams, (s) => s.includes(expectedHelp.label));
          assert.ok(out.includes(`[${expectedHelp.key}] ${expectedHelp.label}`), `TopBar (${lang}) must show help hint: ${out}`);
          assert.ok(out.includes(expectedCmd.label), `TopBar (${lang}) must show command label: ${out}`);
        } finally {
          topInst.unmount();
          topStreams.destroy();
        }

        const lpStreams = createRenderStreams(100, 26);
        const lpInst = render(
          React.createElement(
            actionsMod.ShellActionsContext.Provider,
            { value: shellActions },
            React.createElement(launchpadMod.Launchpad, { width: 98, height: 24, isActive: false }),
          ),
          {
            stdin: lpStreams.stdin,
            stdout: lpStreams.stdout,
            interactive: true,
            exitOnCtrlC: false,
            debug: true,
          },
        );
        try {
          const out = await waitForOutput(lpStreams, (s) => s.includes(expectedQuit.label));
          assert.ok(out.includes(expectedCmd.key), `Launchpad (${lang}) must show palette key "${expectedCmd.key}": ${out}`);
          assert.ok(out.includes(expectedHelp.key) && out.includes(expectedHelp.label), `Launchpad (${lang}) must show help hint: ${out}`);
          assert.ok(out.includes(expectedQuit.key) && out.includes(expectedQuit.label), `Launchpad (${lang}) must show quit hint: ${out}`);
        } finally {
          lpInst.unmount();
          lpStreams.destroy();
        }

        // Cross-check resolveShellFooterHints and HelpOverlay globalShortcuts match global-keymap builders directly.
        const defaultHints = focusMod.resolveShellFooterHints({
          modalHints: null,
          footerHints: [],
          inputCaptured: false,
          overlayOpen: false,
          compactMode: false,
          practiceReturnLabel: null,
          lang,
        });
        assert.deepEqual(
          defaultHints,
          [
            ...globalKeymapMod.buildDefaultFooterHints(lang),
            ...globalKeymapMod.buildFooterTailHints(lang, false),
          ],
          `resolveShellFooterHints (${lang}) must derive directly from global-keymap builders`,
        );
        assert.deepEqual(
          helpMod.globalShortcuts(lang, true),
          globalKeymapMod.buildGlobalHelpShortcuts(lang, true),
          `HelpOverlay.globalShortcuts (${lang}) must derive directly from buildGlobalHelpShortcuts`,
        );
      }
    } finally {
      useTuiStore.setState({
        page: prev.page,
        snapshot: prev.snapshot,
        desktopConfig: prev.desktopConfig,
        binding: prev.binding,
        practiceStack: prev.practiceStack,
        preferences: prev.preferences,
      });
    }
  });
});

describe('#1354 D6 Single-Source Toast & Notification History Copy Consistency', () => {
  test('toast-copy.ts provides canonical labels, timestamps, clipboard payload, and dynamic MAX_TOAST_HISTORY copy', async () => {
    const toastCopyMod = await import('../src/shell/toast-copy.ts');
    assert.equal(typeof toastCopyMod.toastToneLabel, 'function');
    assert.equal(typeof toastCopyMod.toastToneBadge, 'function');
    assert.equal(typeof toastCopyMod.toastHistoryCopy, 'function');
    assert.equal(typeof toastCopyMod.formatToastClock, 'function');
    assert.equal(typeof toastCopyMod.formatToastClipboardPayload, 'function');

    for (const tone of ['info', 'success', 'warning', 'error']) {
      assert.ok(toastCopyMod.toastToneBadge(tone).length > 0);
      assert.ok(toastCopyMod.toastToneLabel(tone, 'zh').length > 0);
      assert.ok(toastCopyMod.toastToneLabel(tone, 'en').length > 0);
    }

    const zhCopy = toastCopyMod.toastHistoryCopy('zh');
    const enCopy = toastCopyMod.toastHistoryCopy('en');
    assert.ok(zhCopy.emptyHint.includes(String(MAX_TOAST_HISTORY)));
    assert.ok(enCopy.emptyHint.includes(String(MAX_TOAST_HISTORY)));
    assert.equal(zhCopy.tabLabel, zhCopy.footerHintLabel, 'Inbox tab label and footer hint label must match in zh');
    assert.equal(enCopy.tabLabel, enCopy.footerHintLabel, 'Inbox tab label and footer hint label must match in en');

    const payload = toastCopyMod.formatToastClipboardPayload(
      {
        id: 't-1',
        text: 'Line 1: Save failed\nLine 2: Disk full',
        tone: 'error',
        source: 'export',
        createdAt: Date.now(),
      },
      'en',
    );
    assert.ok(payload.includes('[error]'));
    assert.ok(payload.includes('[export]'));
    assert.ok(payload.includes('Line 1: Save failed\nLine 2: Disk full'));
  });

  test('InboxModal toasts tab uses shared empty hint, accurate search denominator, clear feedback, and Ctrl+R reload', async () => {
    const toastCopyMod = await import('../src/shell/toast-copy.ts');
    const prev = useTuiStore.getState();
    let inboxListCalls = 0;
    let refreshCalls = 0;

    const fakeHost = {
      call: async (action) => {
        if (action === 'inbox') {
          inboxListCalls += 1;
          return { ok: true, value: { items: [] } };
        }
        return { ok: true, value: {} };
      },
      onEvent: () => () => {},
      dispose: async () => {},
    };
    const shellActions = {
      ...actionsMod.createDefaultShellActions(fakeHost, () => {}),
      refresh: async () => {
        refreshCalls += 1;
      },
    };

    useTuiStore.setState({
      toasts: [],
      toastHistory: [],
      preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: true },
    });
    useTuiStore.getState().notify('导出成功：讲义 A', 'success', 'sources');
    useTuiStore.getState().notify('网络超时：请稍后重试', 'error', 'review');

    const streams = createRenderStreams(110, 28);
    const inst = render(
      React.createElement(
        keyDispatcherMod.KeyScopeProvider,
        null,
        React.createElement(
          actionsMod.ShellActionsContext.Provider,
          { value: shellActions },
          React.createElement(
            Box,
            { width: 110, height: 28 },
            React.createElement(inboxModalMod.InboxModal, {
              host: fakeHost,
              isActive: true,
              onClose: () => {},
            }),
          ),
        ),
      ),
      {
        stdin: streams.stdin,
        stdout: streams.stdout,
        interactive: true,
        exitOnCtrlC: false,
        debug: true,
      },
    );

    try {
      const zhCopy = toastCopyMod.toastHistoryCopy('zh');
      // Wait for initial load
      await waitForOutput(streams, (s) => s.includes(zhCopy.tabLabel));
      const beforeCtrlR = inboxListCalls;

      // Ctrl+R reloads inbox just like r (D2 canonical refresh key)
      streams.stdin.write('\u0012');
      await new Promise((r) => setTimeout(r, 120));
      assert.ok(inboxListCalls > beforeCtrlR, 'Ctrl+R inside InboxModal must reload inbox.list');
      assert.ok(refreshCalls >= 1, 'Ctrl+R inside InboxModal must invoke actions.refresh()');

      // Press `h` to switch to the toast history tab
      streams.stdin.write('h');
      const toastFrame = await waitForOutput(streams, (s) => s.includes('网络超时：请稍后重试'));
      assert.ok(toastFrame.includes('导出成功：讲义 A'), 'Both toasts must appear on the toasts tab');

      // Filter with `/` -> type "网络" -> search denominator must be 1/2 (NOT 1/0 when inbox items=[]!)
      streams.stdin.write('/');
      await new Promise((r) => setTimeout(r, 80));
      streams.stdin.write('网络');
      const filteredFrame = await waitForOutput(streams, (s) => s.includes('1/2'));
      assert.ok(filteredFrame.includes('1/2'), `Expected filtered toast counter "1/2", got:\n${filteredFrame}`);
      assert.equal(filteredFrame.includes('1/0'), false, 'Toasts tab search must never divide by 0 inbox items');

      // Esc clears search query and exits search focus; then `C` clears toast history and shows canonical empty hint
      streams.stdin.write('\u001b');
      await new Promise((r) => setTimeout(r, 100));
      streams.stdin.write('C');
      const clearedFrame = await waitForOutput(
        streams,
        (s) => s.includes(zhCopy.emptyTitle) && s.includes(zhCopy.clearedStatus),
      );
      assert.equal(useTuiStore.getState().toastHistory.length, 0, 'C must clear toastHistory without adding a new toast');
      assert.ok(clearedFrame.includes(zhCopy.emptyTitle), `Cleared toasts tab must show canonical emptyTitle: ${clearedFrame}`);
      assert.ok(clearedFrame.includes(zhCopy.clearedStatus), `Cleared toasts tab must show canonical clearedStatus: ${clearedFrame}`);
    } finally {
      inst.unmount();
      streams.destroy();
      useTuiStore.setState({
        toasts: prev.toasts,
        toastHistory: prev.toastHistory,
        preferences: prev.preferences,
      });
    }
  });

  test('NotificationHistoryModal renders shared empty/cleared copy and dynamic MAX_TOAST_HISTORY in en', async () => {
    const toastCopyMod = await import('../src/shell/toast-copy.ts');
    const prev = useTuiStore.getState();
    useTuiStore.setState({
      toasts: [],
      toastHistory: [],
      preferences: { ...DEFAULT_PREFERENCES, language: 'en', asciiMode: true },
    });

    const streams = createRenderStreams(110, 26);
    const inst = render(
      React.createElement(
        Box,
        { width: 110, height: 26 },
        React.createElement(notifModalMod.NotificationHistoryModal, { isActive: true, onClose: () => {} }),
      ),
      {
        stdin: streams.stdin,
        stdout: streams.stdout,
        interactive: true,
        exitOnCtrlC: false,
        debug: true,
      },
    );
    try {
      const enCopy = toastCopyMod.toastHistoryCopy('en');
      const frame = await waitForOutput(streams, (s) => s.includes(enCopy.emptyTitle));
      assert.ok(frame.includes(enCopy.title), `Expected NotificationHistoryModal title "${enCopy.title}"`);
      assert.ok(frame.includes(enCopy.emptyTitle), `Expected shared emptyTitle "${enCopy.emptyTitle}"`);
      assert.ok(frame.includes(String(MAX_TOAST_HISTORY)), `Expected dynamic MAX_TOAST_HISTORY (${MAX_TOAST_HISTORY}) in empty hint`);
    } finally {
      inst.unmount();
      streams.destroy();
      useTuiStore.setState({
        toasts: prev.toasts,
        toastHistory: prev.toastHistory,
        preferences: prev.preferences,
      });
    }
  });
});
