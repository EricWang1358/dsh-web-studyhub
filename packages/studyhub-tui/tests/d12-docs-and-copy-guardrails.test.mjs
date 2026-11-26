// Automated D12 / D2 / D3 / D6 engineering guardrails (#1354):
// 1. D12 Docs-to-Code Parity: `docs/ARCHITECTURE.md` stays aligned with live `THEME_IDS`,
//    `MAX_TOAST_HISTORY`, P1 input scope stack (`src/input/`), shipped docs, and disk paths.
// 2. D2 Keybinding Vocabulary: `GLOBAL_KEYMAP_ENTRIES` covers every global route key and
//    `notification-history` tracks `MAX_TOAST_HISTORY` dynamically.
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
import ts from 'typescript';
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

async function waitForOutput(streams, predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cur = streams.latest();
    if (predicate(cur)) return cur;
    await new Promise((r) => setTimeout(r, 20));
  }
  return streams.latest();
}

async function waitForCondition(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return Boolean(predicate());
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

  test('ARCHITECTURE.md input layer and scope depth exports & numeric values match live src/input/dispatcher.ts', () => {
    const liveConstants = new Map(
      Object.entries(dispatcherMod).filter(
        ([k, v]) => (k.startsWith('KEY_LAYER_') || k.startsWith('KEY_SCOPE_DEPTH_')) && typeof v === 'number',
      ),
    );
    assert.ok(liveConstants.size >= 11, `Expected >= 11 KEY_LAYER_*/KEY_SCOPE_DEPTH_* constants, got ${liveConstants.size}`);

    // 1. Every KEY_LAYER_* or KEY_SCOPE_DEPTH_* constant mentioned in ARCHITECTURE.md must exist in dispatcher.ts.
    const mentioned = new Set();
    const identRe = /\b(KEY_(?:LAYER|SCOPE_DEPTH)_[A-Z0-9_]+)\b/g;
    let m;
    while ((m = identRe.exec(ARCHITECTURE_DOC))) {
      mentioned.add(m[1]);
    }
    const unknownInDoc = [...mentioned].filter((name) => !liveConstants.has(name));
    assert.deepEqual(
      unknownInDoc,
      [],
      `ARCHITECTURE.md mentions non-existent dispatcher constants: ${unknownInDoc.join(', ')}`,
    );

    // 2. Every live KEY_LAYER_* and KEY_SCOPE_DEPTH_* constant in dispatcher.ts must be documented.
    const undocumented = [...liveConstants.keys()].filter((name) => !mentioned.has(name));
    assert.deepEqual(
      undocumented,
      [],
      `ARCHITECTURE.md is missing live dispatcher constants: ${undocumented.join(', ')}`,
    );

    // 3. Every numeric priority/depth annotation next to a constant in ARCHITECTURE.md must match its live value.
    const numberedRe = /\b(KEY_(?:LAYER|SCOPE_DEPTH)_[A-Z0-9_]+)\s*\(?(\d+)\)?/g;
    const mismatches = [];
    let numberedCount = 0;
    while ((m = numberedRe.exec(ARCHITECTURE_DOC))) {
      numberedCount += 1;
      const name = m[1];
      const docVal = Number(m[2]);
      const liveVal = liveConstants.get(name);
      if (liveVal !== docVal) {
        mismatches.push(`${name}: doc=${docVal}, live=${liveVal}`);
      }
    }
    assert.ok(numberedCount >= liveConstants.size, `Expected numeric annotations for all ${liveConstants.size} constants, found ${numberedCount}`);
    assert.deepEqual(mismatches, [], `ARCHITECTURE.md priority/depth numbers drift from dispatcher.ts:\n${mismatches.join('\n')}`);

    // 4. ARCHITECTURE.md must not claim VirtualList/ScrollView still handle frames "via `useInput`".
    assert.equal(
      ARCHITECTURE_DOC.includes('frames via `useInput`'),
      false,
      'ARCHITECTURE.md must not claim widgets still handle frames via raw Ink `useInput`',
    );
  });
});

describe('#1354 D12 KEYBINDINGS.md inbox rows', () => {
  const keybindingsDoc = fs.readFileSync(path.join(PKG_ROOT, 'docs/KEYBINDINGS.md'), 'utf8');
  const rowFor = (needle) => keybindingsDoc.split(/\r?\n/).find((line) => line.startsWith(needle)) ?? '';

  test('inbox and Ctrl+O rows do not hard-code the history cap and the inbox row documents Ctrl+R and toasts-tab no-ops', () => {
    const inboxRow = rowFor('| `I` |');
    const historyRow = rowFor('| `Ctrl+O` |');
    assert.ok(inboxRow.length > 0 && historyRow.length > 0, 'KEYBINDINGS.md must keep the inbox and Ctrl+O rows');
    for (const row of [inboxRow, historyRow]) {
      assert.equal(
        new RegExp(`\b${MAX_TOAST_HISTORY}\b`).test(row),
        false,
        `KEYBINDINGS.md must reference MAX_TOAST_HISTORY instead of hard-coding ${MAX_TOAST_HISTORY}: ${row}`,
      );
      assert.ok(row.includes('MAX_TOAST_HISTORY'), `row must name the MAX_TOAST_HISTORY cap: ${row}`);
    }
    assert.ok(inboxRow.includes('Ctrl+R'), 'inbox row must document Ctrl+R (reload inbox)');
    assert.match(inboxRow, /toasts tab[^|]*do nothing/, 'inbox row must say e / m / M / Enter do nothing on the toasts tab');
  });
});

describe('#1354 D2 & D3 Global Keybinding Vocabulary & Shell Hint Single Source', () => {
  test('GLOBAL_KEYMAP_ENTRIES has unique ids and covers every GLOBAL_SINGLE_KEY_ROUTES action', () => {
    assert.equal(typeof globalKeymapMod.formatGlobalKeyHint, 'function', 'global-keymap must export formatGlobalKeyHint');
    const ids = new Set();
    for (const entry of globalKeymapMod.GLOBAL_KEYMAP_ENTRIES) {
      assert.equal(ids.has(entry.id), false, `Duplicate id "${entry.id}" in GLOBAL_KEYMAP_ENTRIES`);
      ids.add(entry.id);
      assert.ok(entry.helpZh.trim().length > 0 && entry.helpEn.trim().length > 0);
    }

    // Every single-key global route in global-router.ts must appear as an exact key token (never substring of 'Esc' or 'j/k').
    const keyTokenSet = new Set();
    for (const entry of globalKeymapMod.GLOBAL_KEYMAP_ENTRIES) {
      for (const field of [entry.helpKey, entry.helpKeyAscii, entry.footerKey]) {
        if (!field) continue;
        for (const tok of field.split(/\s+/)) {
          if (tok) keyTokenSet.add(tok);
        }
      }
    }
    for (const routeKey of Object.keys(routerMod.GLOBAL_SINGLE_KEY_ROUTES)) {
      assert.ok(
        keyTokenSet.has(routeKey),
        `Global route key "${routeKey}" from GLOBAL_SINGLE_KEY_ROUTES is missing as an exact token in GLOBAL_KEYMAP_ENTRIES`,
      );
    }

    // Notification history description dynamically tracks MAX_TOAST_HISTORY.
    const notifEntry = globalKeymapMod.GLOBAL_KEYMAP_ENTRIES.find((e) => e.id === 'notification-history');
    assert.ok(notifEntry);
    assert.ok(notifEntry.helpZh.includes(String(MAX_TOAST_HISTORY)));
    assert.ok(notifEntry.helpEn.includes(String(MAX_TOAST_HISTORY)));
  });

  test('TopBar and Launchpad render global shortcut copy derived from global-keymap.ts in zh and en without hardcoded duplicates', async () => {
    // AST verification: TopBar.tsx must not hardcode [?]/Help/Cmd/[I]/[c] in JSX outside formatGlobalKeyHint.
    const topBarPath = path.join(PKG_ROOT, 'src/shell/TopBar.tsx');
    const topBarSf = ts.createSourceFile(
      topBarPath,
      fs.readFileSync(topBarPath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const hardcodedViolations = [];
    const visitTopBar = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
        const args = node.arguments.map((a) => (ts.isStringLiteral(a) ? a.text : null));
        if (
          (args[1] === '帮助' && args[2] === 'Help') ||
          (args[1] === '命令' && args[2] === 'Cmd')
        ) {
          hardcodedViolations.push(`hardcoded t(lang, '${args[1]}', '${args[2]}') in TopBar.tsx`);
        }
      }
      if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isStringLiteral(node)) {
        const text = node.text;
        if (text.includes('[?]') || text.includes('[I]') || text.includes('[c]')) {
          hardcodedViolations.push(`hardcoded shortcut literal "${text}" in TopBar.tsx`);
        }
      }
      ts.forEachChild(node, visitTopBar);
    };
    visitTopBar(topBarSf);
    assert.deepEqual(
      hardcodedViolations,
      [],
      `TopBar.tsx must render global shortcut keys/labels from formatGlobalKeyHint:\n${hardcodedViolations.join('\n')}`,
    );

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
          snapshot: { root: '/tmp/lib', decks: [], sources: [], courses: [], inbox: [{ id: 'm1', read: false }] },
          desktopConfig: null,
          binding: null,
          practiceStack: [],
          preferences: { ...DEFAULT_PREFERENCES, language: lang, asciiMode: true },
        });

        const expectedHelp = globalKeymapMod.formatGlobalKeyHint('help', lang, true);
        const expectedCmd = globalKeymapMod.formatGlobalKeyHint('command-palette', lang, true);
        const expectedQuit = globalKeymapMod.formatGlobalKeyHint('quit', lang, true);
        const expectedInbox = globalKeymapMod.formatGlobalKeyHint('inbox', lang, true);
        const expectedCourse = globalKeymapMod.formatGlobalKeyHint('course-picker', lang, true);

        const releaseClaim = focusMod.claimKeys(['/']);
        const topStreams = createRenderStreams(160, 4);
        const topInst = render(React.createElement(topBarMod.TopBar, { width: 160 }), {
          stdin: topStreams.stdin,
          stdout: topStreams.stdout,
          interactive: true,
          exitOnCtrlC: false,
          debug: true,
        });
        try {
          const out = await waitForOutput(
            topStreams,
            (s) => s.includes(`[${expectedHelp.key}] ${expectedHelp.label}`) && s.includes(`[${expectedCmd.key}] ${expectedCmd.label}`),
          );
          assert.ok(out.includes(`[${expectedHelp.key}] ${expectedHelp.label}`), `TopBar (${lang}) must show help hint: ${out}`);
          assert.ok(out.includes(`[${expectedCmd.key}] ${expectedCmd.label}`), `TopBar (${lang}) must show overridden palette hint: ${out}`);
          assert.ok(out.includes(`[${expectedInbox.key}]`), `TopBar (${lang}) must show inbox key: ${out}`);
          assert.ok(out.includes(`[${expectedCourse.key}]`), `TopBar (${lang}) must show course key: ${out}`);
        } finally {
          topInst.unmount();
          topStreams.destroy();
          releaseClaim();
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
          const out = await waitForOutput(lpStreams, (s) => s.includes(`${expectedQuit.key} ${expectedQuit.label}`));
          // Launchpad has room, so it uses the un-abbreviated palette label from the same keymap entry.
          const launchpadCmd = globalKeymapMod.formatGlobalKeyHint('command-palette', lang, true, true);
          assert.ok(
            out.includes(`${launchpadCmd.key} ${launchpadCmd.label}`),
            `Launchpad (${lang}) must show derived palette hint "${launchpadCmd.key} ${launchpadCmd.label}": ${out}`,
          );
          assert.equal(out.includes('Cmd'), false, `Launchpad (${lang}) must not abbreviate the palette as "Cmd": ${out}`);
          if (lang === 'en') {
            assert.ok(out.includes('Ctrl+K Commands'), `Launchpad (en) must spell out "Commands": ${out}`);
          }
          assert.ok(out.includes(`${expectedHelp.key} ${expectedHelp.label}`), `Launchpad (${lang}) must show help hint: ${out}`);
          assert.ok(out.includes(`${expectedQuit.key} ${expectedQuit.label}`), `Launchpad (${lang}) must show quit hint: ${out}`);
        } finally {
          lpInst.unmount();
          lpStreams.destroy();
        }
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

describe('#1354 D3 TopBar help chip width budget', () => {
  // Narrowest widths at which the [?] Help / [/] Cmd chips fit on the TopBar before the keymap wiring (empty library).
  const MIN_WIDTH_WITH_HELP_CHIPS = [
    { lang: 'zh', asciiMode: true, width: 82 },
    { lang: 'zh', asciiMode: false, width: 80 },
    { lang: 'en', asciiMode: true, width: 84 },
    { lang: 'en', asciiMode: false, width: 82 },
  ];

  for (const { lang, asciiMode, width } of MIN_WIDTH_WITH_HELP_CHIPS) {
    test(`TopBar keeps the help and palette chips at ${width} cols (${lang}, ascii=${asciiMode})`, async () => {
      const prev = useTuiStore.getState();
      useTuiStore.setState({
        page: 'library',
        snapshot: { root: '/tmp/lib', decks: [], sources: [], courses: [], inbox: [] },
        desktopConfig: null,
        binding: null,
        practiceStack: [],
        preferences: { ...DEFAULT_PREFERENCES, language: lang, asciiMode },
      });
      const help = globalKeymapMod.formatGlobalKeyHint('help', lang, asciiMode);
      const cmd = globalKeymapMod.formatGlobalKeyHint('command-palette', lang, asciiMode);
      const streams = createRenderStreams(width, 4);
      const inst = render(React.createElement(topBarMod.TopBar, { width }), {
        stdin: streams.stdin,
        stdout: streams.stdout,
        interactive: true,
        exitOnCtrlC: false,
        debug: true,
      });
      try {
        const out = await waitForOutput(streams, (s) => s.includes(`[${help.key}] ${help.label}`));
        assert.ok(out.includes(`[${help.key}] ${help.label}`), `help chip must fit at ${width} cols:
${out}`);
        assert.ok(out.includes(`${cmd.label}`), `palette chip must fit at ${width} cols:
${out}`);
      } finally {
        inst.unmount();
        streams.destroy();
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
  }
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
    assert.equal('footerHintLabel' in zhCopy, false, 'tabLabel is the single label for the inbox tab and its footer hint');
    assert.equal(toastCopyMod.formatToastClipboardPayload.length, 2, 'formatToastClipboardPayload takes (item, now?) only');

    const payload = toastCopyMod.formatToastClipboardPayload(
      {
        id: 't-1',
        text: 'Line 1: Save failed\nLine 2: Disk full',
        tone: 'error',
        source: 'export',
        createdAt: Date.now(),
      },
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
      const ctrlRSettled = await waitForCondition(() => inboxListCalls > beforeCtrlR);
      assert.equal(ctrlRSettled, true, 'Ctrl+R inside InboxModal must reload the inbox');
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(
        refreshCalls,
        0,
        'InboxModal must not call actions.refresh() itself: the system layer already refreshes the snapshot on Ctrl+R',
      );

      // Press `h` to switch to the toast history tab
      streams.stdin.write('h');
      const toastFrame = await waitForOutput(streams, (s) => s.includes('网络超时：请稍后重试'));
      assert.ok(toastFrame.includes('导出成功：讲义 A'), 'Both toasts must appear on the toasts tab');

      // Filter with `/` -> type "网络" -> search denominator must be 1/2 (NOT 1/0 when inbox items=[]!)
      streams.stdin.write('/');
      await waitForOutput(streams, (s) => s.includes('应用') || s.includes('Apply'));
      streams.stdin.write('网络');
      const filteredFrame = await waitForOutput(streams, (s) => s.includes('1/2'));
      assert.ok(filteredFrame.includes('1/2'), `Expected filtered toast counter "1/2", got:\n${filteredFrame}`);
      assert.equal(filteredFrame.includes('1/0'), false, 'Toasts tab search must never divide by 0 inbox items');

      // Esc clears search query and exits search focus; then `C` clears toast history and shows canonical empty hint
      streams.stdin.write('\u001b');
      await waitForOutput(streams, (s) => !s.includes('1/2') && s.includes('导出成功：讲义 A'));
      streams.stdin.write('C');
      const clearedFrame = await waitForOutput(
        streams,
        (s) => s.includes(zhCopy.emptyTitle) && s.includes(zhCopy.clearedStatus),
      );
      assert.equal(useTuiStore.getState().toastHistory.length, 0, 'C must clear toastHistory without adding a new toast');
      assert.ok(clearedFrame.includes(zhCopy.emptyTitle), `Cleared toasts tab must show canonical emptyTitle: ${clearedFrame}`);
      assert.ok(clearedFrame.includes(zhCopy.clearedStatus), `Cleared toasts tab must show canonical clearedStatus: ${clearedFrame}`);
      assert.ok(
        clearedFrame.includes(zhCopy.emptyHint),
        `Empty toasts tab must show the shared toastHistoryCopy emptyHint "${zhCopy.emptyHint}": ${clearedFrame}`,
      );
      assert.equal(
        clearedFrame.includes('后台任务或陪学回复完成后会投递到这里'),
        false,
        `Empty toasts tab must not show the inbox's own empty hint: ${clearedFrame}`,
      );

      // When a new toast arrives after clearing, stale clearedStatus must disappear immediately.
      useTuiStore.getState().notify('新到达的状态提示', 'info', 'shell');
      const arrivedFrame = await waitForOutput(
        streams,
        (s) => s.includes('新到达的状态提示') && !s.includes(zhCopy.clearedStatus),
      );
      assert.ok(arrivedFrame.includes('新到达的状态提示'), 'Newly arrived toast must appear on toasts tab');
      assert.equal(
        arrivedFrame.includes(zhCopy.clearedStatus),
        false,
        `Stale clearedStatus must clear once a new toast arrives:\n${arrivedFrame}`,
      );
      // Toast preview pane must not duplicate the single-line text twice or show bogus inbox "已读" state.
      const occurrences = arrivedFrame.split('新到达的状态提示').length - 1;
      assert.equal(
        occurrences,
        2,
        `Expected "新到达的状态提示" once in list and once in preview (total 2, not duplicated 3x):\n${arrivedFrame}`,
      );
      assert.equal(
        arrivedFrame.includes('[状态提示] 已读'),
        false,
        `Toasts preview header must not show bogus inbox read badge:\n${arrivedFrame}`,
      );
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

  test('AppShell: one Ctrl+R inside the open inbox reloads the inbox once and fetches the snapshot once', async () => {
    const { AppShell } = await import('../src/shell/AppShell.tsx');
    const prev = useTuiStore.getState();
    const calls = { snapshot: 0, inbox: 0 };
    const snapshot = {
      revision: 1,
      courses: [],
      decks: [],
      focus: {},
      stats: { totalCards: 0, dueToday: 0, reviewedToday: 0 },
      sources: [],
      tasks: [],
      wrongBook: [],
      notes: [],
      modelReady: false,
    };
    const host = {
      getSnapshot: async () => snapshot,
      runAction: async () => ({ ok: true, value: {} }),
      call: async (action) => {
        if (action === 'snapshot') {
          calls.snapshot += 1;
          return { ok: true, value: snapshot };
        }
        if (action === 'inbox') {
          calls.inbox += 1;
          return { ok: true, value: { items: [] } };
        }
        return { ok: true, value: {} };
      },
      onEvent: () => () => {},
      subscribe: () => () => {},
      dispose: async () => {},
    };
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
      inboxOpen: true,
      notificationHistoryOpen: false,
      quitConfirmOpen: false,
      assistantOpen: false,
      assistantFocused: false,
      assistantFullscreen: false,
      practiceStack: [],
      toasts: [],
      toastHistory: [],
      snapshot,
      preferences: { ...DEFAULT_PREFERENCES, language: 'en', asciiMode: true },
    });
    const streams = createRenderStreams(120, 36);
    const inst = render(
      React.createElement(AppShell, {
        host,
        autoLaunchpad: false,
        renderPage: () => React.createElement(Box, null),
      }),
      { stdin: streams.stdin, stdout: streams.stdout, interactive: true, exitOnCtrlC: false, debug: true },
    );
    try {
      await waitForCondition(() => calls.inbox >= 1);
      await new Promise((r) => setTimeout(r, 300));
      const before = { ...calls };
      streams.stdin.write('\u0012');
      await waitForCondition(() => calls.inbox > before.inbox && calls.snapshot > before.snapshot);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(calls.inbox - before.inbox, 1, 'one Ctrl+R must reload the inbox exactly once');
      assert.equal(calls.snapshot - before.snapshot, 1, 'one Ctrl+R must fetch the snapshot exactly once');
    } finally {
      inst.unmount();
      streams.destroy();
      useTuiStore.setState({
        inboxOpen: prev.inboxOpen,
        snapshot: prev.snapshot,
        preferences: prev.preferences,
        page: prev.page,
        toasts: prev.toasts,
        toastHistory: prev.toastHistory,
      });
    }
  });

  test('InboxModal guards unread/read search denominator, blocks bogus m RPC on toasts tab, shows truthful narrow toasts hints, and survives invalid createdAt', async () => {
    const toastCopyMod = await import('../src/shell/toast-copy.ts');
    const prev = useTuiStore.getState();
    const hostCalls = [];
    const sampleItems = [
      { id: 'in-1', kind: 'note', label: '笔记', prompt: 'Alpha unread item', detail: 'd1', read: false, count: 1, at: '2026-11-26T10:00:00Z' },
      { id: 'in-2', kind: 'grade', label: '批改', prompt: 'Beta read item', detail: 'd2', read: true, count: 1, at: '2026-11-26T09:00:00Z' },
      { id: 'in-3', kind: 'grade', label: '批改', prompt: 'Gamma read item', detail: 'd3', read: true, count: 1, at: '2026-11-26T08:00:00Z' },
    ];
    const fakeHost = {
      call: async (action, payload) => {
        hostCalls.push({ action, payload });
        if (action === 'inbox') return { ok: true, value: { items: sampleItems } };
        return { ok: true, value: {} };
      },
      onEvent: () => () => {},
      dispose: async () => {},
    };
    const shellActions = actionsMod.createDefaultShellActions(fakeHost, () => {});

    useTuiStore.setState({
      toasts: [],
      toastHistory: [
        { id: 'toast-nan', text: 'Invalid timestamp toast', tone: 'warning', createdAt: Number.NaN },
        { id: 'toast-ok', text: 'Valid toast message', tone: 'info', createdAt: Date.now() },
      ],
      preferences: { ...DEFAULT_PREFERENCES, language: 'en', asciiMode: true },
    });

    // Narrow viewport (68x24 -> !sideBySide) to also verify narrow-mode toasts hints
    const streams = createRenderStreams(68, 24);
    const inst = render(
      React.createElement(
        keyDispatcherMod.KeyScopeProvider,
        null,
        React.createElement(
          actionsMod.ShellActionsContext.Provider,
          { value: shellActions },
          React.createElement(
            Box,
            { width: 68, height: 24 },
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
      const enCopy = toastCopyMod.toastHistoryCopy('en');
      await waitForOutput(streams, (s) => s.includes('All (3)') && s.includes('Unread (1)'));

      // Tab -> unread tab (1 item), search "Alpha" -> denominator MUST be 1/1 (NOT 1/3!)
      streams.stdin.write('\t');
      await waitForOutput(streams, (s) => s.includes('Alpha unread item') && !s.includes('Beta read item'));
      streams.stdin.write('/');
      await waitForOutput(streams, (s) => s.includes('Apply'));
      streams.stdin.write('Alpha');
      const unreadSearchFrame = await waitForOutput(streams, (s) => s.includes('1/1'));
      assert.ok(unreadSearchFrame.includes('1/1'), `Expected unread search counter "1/1", got:\n${unreadSearchFrame}`);
      assert.equal(unreadSearchFrame.includes('1/3'), false, 'Unread tab search must divide by unreadCount (1), not items.length (3)');

      // Exit search -> switch to toasts tab via `h` (also verifies NaN createdAt does not crash render)
      streams.stdin.write('\u001b');
      await waitForOutput(streams, (s) => !s.includes('1/1'));
      streams.stdin.write('h');
      const narrowToastsFrame = await waitForOutput(
        streams,
        (s) => s.includes('Valid toast message') && s.includes('Invalid timestamp toast'),
      );
      assert.ok(narrowToastsFrame.includes('Invalid timestamp toast'), 'Toast with NaN createdAt must render safely');
      assert.ok(narrowToastsFrame.includes('C Clear'), `Narrow toasts tab must advertise "C Clear":\n${narrowToastsFrame}`);
      assert.equal(narrowToastsFrame.includes('m Read'), false, `Toasts tab must not advertise bogus "m Read":\n${narrowToastsFrame}`);

      // Pressing `m` on toasts tab must NEVER invoke inbox.read or inbox.unread RPCs!
      const callsBeforeM = hostCalls.length;
      streams.stdin.write('m');
      await new Promise((r) => setTimeout(r, 80));
      const readToggleCalls = hostCalls.slice(callsBeforeM).filter((c) => c.action === 'inbox.read' || c.action === 'inbox.unread');
      assert.deepEqual(readToggleCalls, [], 'Pressing m on toasts tab must not fire inbox.read/inbox.unread RPC');

      // Clear with `C`, switch away via `Tab` and back via `h`, then press `C` on already-empty history -> must NOT falsely claim clearedStatus
      streams.stdin.write('C');
      await waitForOutput(streams, (s) => s.includes(enCopy.clearedStatus));
      streams.stdin.write('\t');
      await waitForOutput(streams, (s) => s.includes('Alpha unread item'));
      streams.stdin.write('h');
      await waitForOutput(streams, (s) => s.includes(enCopy.emptyTitle) && !s.includes(enCopy.clearedStatus));
      streams.stdin.write('C');
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(
        streams.latest().includes(enCopy.clearedStatus),
        false,
        `Pressing C on already-empty toasts tab must not falsely show "${enCopy.clearedStatus}"`,
      );
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
