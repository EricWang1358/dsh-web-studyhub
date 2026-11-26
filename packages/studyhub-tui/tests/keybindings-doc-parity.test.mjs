// Automated parity guard between `docs/KEYBINDINGS.md`, runtime key scope stack (`KEY_LAYER_*`),
// `PAGE_REGISTRY`, `GLOBAL_KEYMAP_ENTRIES`, `RESERVED_GLOBAL_KEYS`, live `buildPaletteItems()`,
// TypeScript AST overlay guards, and `dispatchToHub()` priority/consumption invariants.
// Run: node --test tests/keybindings-doc-parity.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(PKG_ROOT, 'src');
const KEYBINDINGS_DOC = fs.readFileSync(path.join(PKG_ROOT, 'docs/KEYBINDINGS.md'), 'utf8');

const dispatcherMod = await import('../src/input/dispatcher.ts');
const contractsMod = await import('../src/types/contracts.ts');
const layoutTokensMod = await import('../src/components/layout-tokens.ts');
const globalKeymapMod = await import('../src/shell/global-keymap.ts');
const focusMod = await import('../src/components/focus.ts');
const paletteMod = await import('../src/shell/CommandPalette.tsx');
const storeMod = await import('../src/state/store.ts');

const EMPTY_KEY = {
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
};

function parseAst(relPath) {
  const fullPath = path.join(SRC_ROOT, relPath);
  const kind = fullPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(fullPath, fs.readFileSync(fullPath, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}

function extractSection(doc, headingPrefix) {
  const start = doc.indexOf(headingPrefix);
  assert.notEqual(start, -1, `Missing section "${headingPrefix}" in docs/KEYBINDINGS.md`);
  const rest = doc.slice(start + headingPrefix.length);
  const nextHeading = rest.search(/\n## /);
  return nextHeading === -1 ? doc.slice(start) : doc.slice(start, start + headingPrefix.length + nextHeading);
}

function parseMarkdownTableRows(sectionText) {
  const rows = [];
  for (const rawLine of sectionText.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    const cells = line
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    rows.push(cells);
  }
  return rows.slice(1); // skip header row
}

function stripBackticks(cell) {
  return cell.replace(/^`+|`+$/g, '').trim();
}

function collectIdentifiers(node, out = new Set()) {
  if (!node) return out;
  if (ts.isIdentifier(node)) out.add(node.text);
  ts.forEachChild(node, (child) => {
    collectIdentifiers(child, out);
  });
  return out;
}

describe('KEYBINDINGS.md vs Key Scope Stack Parity Guard', () => {
  test('Scope stack table in KEYBINDINGS.md matches every KEY_LAYER_* export with exact descending priorities', () => {
    const runtimeLayers = Object.entries(dispatcherMod)
      .filter(([name, value]) => name.startsWith('KEY_LAYER_') && typeof value === 'number')
      .sort((a, b) => b[1] - a[1]);

    assert.ok(runtimeLayers.length >= 8, 'Expected at least 8 exported KEY_LAYER_* constants');

    const section = extractSection(KEYBINDINGS_DOC, '## 0. Scope Stack & Priority Layers');
    const rows = parseMarkdownTableRows(section);
    const docLayers = rows.map((cells) => [stripBackticks(cells[0]), Number(stripBackticks(cells[1]))]);

    assert.deepEqual(
      docLayers,
      runtimeLayers,
      'KEYBINDINGS.md Scope Stack table must match runtime KEY_LAYER_* exports in strict descending order',
    );
  });

  test('Page Jump Shortcuts table in KEYBINDINGS.md matches live PAGE_REGISTRY 1:1', () => {
    const sectionStart = KEYBINDINGS_DOC.indexOf('### Page Jump Shortcuts (`PAGE_REGISTRY`)');
    assert.notEqual(sectionStart, -1, 'Missing Page Jump Shortcuts table in KEYBINDINGS.md');
    const nextRule = KEYBINDINGS_DOC.indexOf('\n---', sectionStart);
    const tableSection = nextRule === -1 ? KEYBINDINGS_DOC.slice(sectionStart) : KEYBINDINGS_DOC.slice(sectionStart, nextRule);

    const groupNormalize = (groupLabel) => {
      const lowered = groupLabel.toLowerCase();
      return lowered === 'practice' ? null : lowered;
    };

    const docPages = parseMarkdownTableRows(tableSection).map((cells) => ({
      shortcut: stripBackticks(cells[0]),
      id: stripBackticks(cells[1]),
      group: groupNormalize(cells[3]),
    }));

    const runtimePages = contractsMod.PAGE_REGISTRY.map((page) => ({
      shortcut: page.shortcut,
      id: page.id,
      group: page.group,
    }));

    assert.deepEqual(
      docPages,
      runtimePages,
      'Page Jump Shortcuts table in KEYBINDINGS.md must match live PAGE_REGISTRY 1:1 (shortcut, id, group)',
    );
  });

  test('KEYBINDINGS.md aligns with LAYOUT_BP.SIDENAV_AUTO_COLLAPSE, RESERVED_GLOBAL_KEYS, and GLOBAL_KEYMAP_ENTRIES', () => {
    const expectedCollapse = layoutTokensMod.LAYOUT_BP.SIDENAV_AUTO_COLLAPSE;
    const collapseMatch = KEYBINDINGS_DOC.match(/columns\s*<\s*(\d+)/);
    assert.ok(collapseMatch, 'KEYBINDINGS.md must state the SideNav auto-collapse column breakpoint');
    assert.equal(
      Number(collapseMatch[1]),
      expectedCollapse,
      `KEYBINDINGS.md sidebar breakpoint (${collapseMatch[1]}) must match LAYOUT_BP.SIDENAV_AUTO_COLLAPSE (${expectedCollapse})`,
    );
    assert.equal(
      KEYBINDINGS_DOC.includes('columns < 100'),
      false,
      'Stale columns < 100 sidebar breakpoint must not reappear in KEYBINDINGS.md',
    );

    const globalSection = extractSection(KEYBINDINGS_DOC, '## 1. Global Navigation & Overlays');

    for (const reservedKey of focusMod.RESERVED_GLOBAL_KEYS) {
      assert.ok(
        KEYBINDINGS_DOC.includes(`\`${reservedKey}\``),
        `Reserved global key "${reservedKey}" must be documented in KEYBINDINGS.md`,
      );
    }

    const entryTokenMap = {
      'command-palette': ['Ctrl+K', '/'],
      'assistant-dock': ['Ctrl+Space', 'Ctrl+G'],
      help: ['?'],
      'course-picker': ['c'],
      inbox: ['I'],
      'notification-history': ['Ctrl+O'],
      'page-jump': ['1-9', '0'],
      'page-cycle': ['[', ']'],
      back: ['Backspace', 'Bksp'],
      sidebar: ['\\'],
      refresh: ['Ctrl+R'],
      quit: ['q', 'Ctrl+C'],
      move: ['j', 'k'],
      'half-page': ['Ctrl+D', 'Ctrl+U'],
      'full-page': ['Ctrl+F', 'Ctrl+B'],
      'top-bottom': ['Home', 'End', 'g', 'G'],
      close: ['Esc'],
      submit: ['Ctrl+S'],
      mouse: ['Alt+Click'],
    };

    for (const entry of globalKeymapMod.GLOBAL_KEYMAP_ENTRIES) {
      const expectedTokens = entryTokenMap[entry.id];
      assert.ok(
        Array.isArray(expectedTokens) && expectedTokens.length > 0,
        `New GLOBAL_KEYMAP_ENTRIES id "${entry.id}" must be mapped in keybindings-doc-parity.test.mjs`,
      );
      const searchCorpus = entry.id === 'submit' ? KEYBINDINGS_DOC : globalSection;
      for (const token of expectedTokens) {
        assert.ok(
          searchCorpus.includes(token),
          `GLOBAL_KEYMAP_ENTRIES "${entry.id}" token "${token}" missing from docs/KEYBINDINGS.md`,
        );
      }
    }
  });

  test('Live buildPaletteItems() slash commands are documented and advertise only valid global shortcuts', () => {
    const noopAsync = async () => {};
    const noop = () => {};
    const shellActions = {
      refresh: noopAsync,
      loadSample: noopAsync,
      importSource: noop,
      openModelSettings: noop,
      setCourse: noopAsync,
      createCourse: noopAsync,
      quit: noop,
    };

    const items = paletteMod.buildPaletteItems(storeMod.useTuiStore.getState(), shellActions);
    const slashCommands = items.filter((item) => item.id.startsWith('cmd:') && item.label.startsWith('/'));
    assert.ok(slashCommands.length >= 30, 'Expected live buildPaletteItems() to return built-in slash commands');

    const paletteSection = extractSection(KEYBINDINGS_DOC, '## 3. Command Palette v3 Scoped Prefixes');
    const missingSlashCommands = [];
    for (const cmd of slashCommands) {
      if (cmd.id.startsWith('cmd:theme:')) continue; // parameterized `/theme <id>` variants covered by `/theme`
      if (!paletteSection.includes(`\`${cmd.label}\``)) {
        missingSlashCommands.push(cmd.label);
      }
    }
    assert.deepEqual(
      missingSlashCommands,
      [],
      `Slash commands emitted by buildPaletteItems() missing from KEYBINDINGS.md: ${missingSlashCommands.join(', ')}`,
    );

    const validNonPageShortcuts = new Set(['?', 'Ctrl+Space', 'I', 'Ctrl+R', 'c', '\\', '⌫', 'Bksp', 'q']);
    const invalidShortcuts = [];
    for (const cmd of slashCommands) {
      if (cmd.id.startsWith('cmd:page:')) continue;
      if (cmd.shortcut !== undefined && !validNonPageShortcuts.has(cmd.shortcut)) {
        invalidShortcuts.push(`${cmd.id} (${cmd.label}) -> "${cmd.shortcut}"`);
      }
    }
    assert.deepEqual(
      invalidShortcuts,
      [],
      `Non-page palette commands advertise nonexistent global shortcuts: ${invalidShortcuts.join(', ')}`,
    );

    const guidedCmd = slashCommands.find((cmd) => cmd.id === 'cmd:guided');
    assert.ok(guidedCmd, 'cmd:guided must exist in buildPaletteItems()');
    assert.equal(guidedCmd.shortcut, undefined, 'cmd:guided must not advertise nonexistent global shortcut');
  });

  test('AST guard: notificationHistoryOpen is checked in all 5 overlay guards and CommandPalette drops dead Ctrl+K up-nav', () => {
    const shellOverlayTargets = [
      'components/ConfirmDialog.tsx',
      'views/generate/GenerateView.tsx',
      'views/review/RoundSummary.tsx',
      'views/review/CoachNudgeModal.tsx',
    ];

    for (const relPath of shellOverlayTargets) {
      const sf = parseAst(relPath);
      let checkedGuard = false;
      function visitOverlay(node) {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'shellOverlay' && node.initializer) {
          checkedGuard = true;
          const ids = collectIdentifiers(node.initializer);
          assert.ok(
            ids.has('notificationHistoryOpen'),
            `${relPath}: shellOverlay selector must include notificationHistoryOpen`,
          );
        }
        ts.forEachChild(node, visitOverlay);
      }
      visitOverlay(sf);
      assert.ok(checkedGuard, `${relPath}: expected shellOverlay declaration`);
    }

    // AppShell.tsx: voiceOverlay JSX conditional must exclude notificationHistoryOpen
    const appShellSf = parseAst('shell/AppShell.tsx');
    let checkedVoiceOverlay = false;
    function visitAppShell(node) {
      if (ts.isConditionalExpression(node)) {
        const condIds = collectIdentifiers(node.condition);
        if (condIds.has('voiceOverlay') && condIds.has('renderVoicePack')) {
          checkedVoiceOverlay = true;
          assert.ok(
            condIds.has('notificationHistoryOpen'),
            'shell/AppShell.tsx: voiceOverlay render guard must exclude notificationHistoryOpen',
          );
        }
      }
      ts.forEachChild(node, visitAppShell);
    }
    visitAppShell(appShellSf);
    assert.ok(checkedVoiceOverlay, 'shell/AppShell.tsx: expected voiceOverlay conditional render guard');

    // CommandPalette.tsx: no dead `input === 'k'` up-nav branch in useInput handler, and returns true on consumed keys
    const paletteSf = parseAst('shell/CommandPalette.tsx');
    let paletteInputChecked = false;
    let paletteReturnsTrueCount = 0;
    function visitPalette(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useInput' && node.arguments[0]) {
        paletteInputChecked = true;
        function inspectCallback(n) {
          if (
            ts.isBinaryExpression(n) &&
            n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
            ts.isIdentifier(n.left) &&
            n.left.text === 'input' &&
            ts.isStringLiteral(n.right) &&
            n.right.text === 'k'
          ) {
            assert.fail("shell/CommandPalette.tsx: dead Ctrl+K up-navigation branch (`input === 'k'`) must not exist");
          }
          if (ts.isReturnStatement(n) && n.expression?.kind === ts.SyntaxKind.TrueKeyword) {
            paletteReturnsTrueCount += 1;
          }
          ts.forEachChild(n, inspectCallback);
        }
        inspectCallback(node.arguments[0]);
      }
      ts.forEachChild(node, visitPalette);
    }
    visitPalette(paletteSf);
    assert.ok(paletteInputChecked, 'shell/CommandPalette.tsx: expected useInput handler');
    assert.ok(paletteReturnsTrueCount >= 4, 'shell/CommandPalette.tsx: consumed key branches must return true');

    // HelpOverlay.tsx and InboxModal.tsx must return true on consumed branches
    for (const modalFile of ['shell/HelpOverlay.tsx', 'shell/InboxModal.tsx']) {
      const sf = parseAst(modalFile);
      let trueReturns = 0;
      let sawHandler = false;
      function visitModal(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useInput' && node.arguments[0]) {
          sawHandler = true;
          function inspect(n) {
            if (ts.isReturnStatement(n) && n.expression?.kind === ts.SyntaxKind.TrueKeyword) {
              trueReturns += 1;
            }
            ts.forEachChild(n, inspect);
          }
          inspect(node.arguments[0]);
        }
        ts.forEachChild(node, visitModal);
      }
      visitModal(sf);
      assert.ok(sawHandler, `${modalFile}: expected useInput handler`);
      assert.ok(trueReturns >= 3, `${modalFile}: consumed key branches must return true`);
    }
  });

  test('Runtime dispatchToHub: KEY_LAYER_SYSTEM Ctrl+K preempts TextInput/View and return true blocks KEY_LAYER_GLOBAL', () => {
    const {
      KEY_LAYER_GLOBAL,
      KEY_LAYER_MODAL,
      KEY_LAYER_SYSTEM,
      KEY_LAYER_TEXT_INPUT,
      KEY_LAYER_VIEW,
      createTestKeyHub,
      dispatchToHub,
      pushTestOpaqueScope,
      registerTestHandler,
    } = dispatcherMod;

    const hub = createTestKeyHub();
    const trace = [];

    registerTestHandler(
      hub,
      (input, key) => {
        if (key.ctrl && input === 'k') {
          trace.push('system:ctrl+k');
          return true;
        }
        return false;
      },
      { layer: KEY_LAYER_SYSTEM, depth: 0, id: 'AppShell:system' },
    );
    registerTestHandler(
      hub,
      (input) => {
        trace.push(`global:${input}`);
        return true;
      },
      { layer: KEY_LAYER_GLOBAL, depth: 0, id: 'AppShell:global' },
    );
    registerTestHandler(
      hub,
      (input) => {
        trace.push(`view:${input}`);
        return input === 'p';
      },
      { layer: KEY_LAYER_VIEW, depth: 0, id: 'View:main' },
    );

    // Push an opaque modal scope containing a TextInput (500) + Modal handler (400)
    const popScope = pushTestOpaqueScope(hub, { depth: 1, scopeId: 11, label: 'CommandPalette' });
    const unregText = registerTestHandler(
      hub,
      (input, key) => {
        trace.push(`text:${key.ctrl ? 'ctrl+' : ''}${input}`);
        return true;
      },
      { layer: KEY_LAYER_TEXT_INPUT, depth: 1, scopeId: 11, id: 'TextInput' },
    );
    const unregModal = registerTestHandler(
      hub,
      (input) => {
        trace.push(`modal:${input}`);
        return input === 'm';
      },
      { layer: KEY_LAYER_MODAL, depth: 1, scopeId: 11, id: 'Modal:body' },
    );

    // 1. Ctrl+K hits KEY_LAYER_SYSTEM (600) first even inside an opaque modal with TextInput (500), and stops propagation
    const ctrlKConsumed = dispatchToHub(hub, 'k', { ...EMPTY_KEY, ctrl: true });
    assert.equal(ctrlKConsumed, true);
    assert.deepEqual(trace, ['system:ctrl+k']);

    // 2. Pop modal scope -> root view handler returning true stops propagation to KEY_LAYER_GLOBAL
    unregModal();
    unregText();
    popScope();
    trace.length = 0;

    const viewConsumed = dispatchToHub(hub, 'p', EMPTY_KEY);
    assert.equal(viewConsumed, true);
    assert.deepEqual(trace, ['view:p']);

    // 3. Unhandled key in view falls through cleanly to KEY_LAYER_GLOBAL
    trace.length = 0;
    const globalConsumed = dispatchToHub(hub, '?', EMPTY_KEY);
    assert.equal(globalConsumed, true);
    assert.deepEqual(trace, ['view:?', 'global:?']);
  });
});
