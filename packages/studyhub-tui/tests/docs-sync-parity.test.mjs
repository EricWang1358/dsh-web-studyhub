// Automated cross-document & runtime drift-prevention guard for StudyHub TUI docs sync.
// Complements `keybindings-doc-parity.test.mjs`, `issue-1310-guide-sync.test.mjs`,
// `d12-docs-and-copy-guardrails.test.mjs`, and `p4-release-docs-guard.test.mjs` by verifying:
// 1. Live `buildPaletteItems()` slash commands & `parsePaletteScope()` prefixes against `docs/GUIDE.md` §5 & `docs/KEYBINDINGS.md` §3.
// 2. AST-extracted `parseCliArgs()` flags & runtime CLI parsing against `docs/GUIDE.md` §7 & `docs/KEYBINDINGS.md` CLI Launch Flags.
// 3. `packages/studyhub-tui/README.md` `## 常用快捷键` table covers all 16 `PAGE_REGISTRY` pages, global routes & system chords.
// 4. `docs/GUIDE.md` §4 (`全 16 个页面使用指南`) matches `PAGE_REGISTRY`, `GLOBAL_NAV_ORDER`, `GLOBAL_PAGE_SHORTCUTS`, and `RESERVED_GLOBAL_KEYS` 1:1.
// 5. `KEY_SCOPE_DEPTH_*` constants & live `SHELL_KEY_ROUTER` invariants match `docs/KEYBINDINGS.md` §0 & §1.
// 6. AST-verified `CourseSettingsModal` tab shortcuts match `docs/KEYBINDINGS.md` §4.1 (`C` course settings).
// 7. Live Ink render + AST check of `AppearanceTab` verifies dynamic `${THEME_IDS.length}` theme count in zh & en.
// 8. Root `README.md` / `README.zh-CN.md` carry no stale TUI claims or broken root-relative links.
// Run: node --test tests/docs-sync-parity.test.mjs
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
const REPO_ROOT = path.resolve(PKG_ROOT, '../..');
const SRC_ROOT = path.join(PKG_ROOT, 'src');

const GUIDE_DOC = fs.readFileSync(path.join(PKG_ROOT, 'docs/GUIDE.md'), 'utf8');
const KEYBINDINGS_DOC = fs.readFileSync(path.join(PKG_ROOT, 'docs/KEYBINDINGS.md'), 'utf8');
const TUI_README_DOC = fs.readFileSync(path.join(PKG_ROOT, 'README.md'), 'utf8');
const ROOT_README_EN = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
const ROOT_README_ZH = fs.readFileSync(path.join(REPO_ROOT, 'README.zh-CN.md'), 'utf8');

const [
  dispatcherMod,
  routerMod,
  contractsMod,
  focusMod,
  paletteMod,
  cliArgsMod,
  themeTokensMod,
  tuiPrefsMod,
  storeMod,
  appearanceTabMod,
] = await Promise.all([
  import('../src/input/dispatcher.ts'),
  import('../src/input/global-router.ts'),
  import('../src/types/contracts.ts'),
  import('../src/components/focus.ts'),
  import('../src/shell/CommandPalette.tsx'),
  import('../src/cli-args.ts'),
  import('../src/theme/tokens.ts'),
  import('../src/host/tui-prefs.ts'),
  import('../src/state/store.ts'),
  import('../src/views/settings/AppearanceTab.tsx'),
]);

const { PAGE_REGISTRY } = contractsMod;
const { RESERVED_GLOBAL_KEYS } = focusMod;
const { GLOBAL_NAV_ORDER, GLOBAL_PAGE_SHORTCUTS, GLOBAL_SINGLE_KEY_ROUTES, SHELL_KEY_ROUTER } = routerMod;
const { buildPaletteItems, parsePaletteScope } = paletteMod;
const { buildDoctorReport, cliHelpText, parseCliArgs } = cliArgsMod;
const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;
const { AppearanceTab } = appearanceTabMod;

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

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractH2Section(doc, headingPrefix, docLabel) {
  const start = doc.indexOf(headingPrefix);
  assert.notEqual(start, -1, `Missing section "${headingPrefix}" in ${docLabel}`);
  const rest = doc.slice(start + headingPrefix.length);
  const nextHeading = rest.search(/\n## /);
  return nextHeading === -1 ? doc.slice(start) : doc.slice(start, start + headingPrefix.length + nextHeading);
}

function parseMarkdownTableRows(sectionText) {
  const rows = [];
  for (const rawLine of sectionText.split(/\r?\n/)) {
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

/** Extract every `--<flag>` compared with `token === ...` or `flag === ...` inside `parseCliArgs()`. */
function extractCliLongFlagsFromAst(sf) {
  let parseFn = null;
  function findFn(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'parseCliArgs') {
      parseFn = node;
      return;
    }
    ts.forEachChild(node, findFn);
  }
  findFn(sf);
  assert.ok(parseFn, 'Expected function declaration parseCliArgs in src/cli-args.ts');

  const flags = new Set();
  function walk(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      const checkPair = (identNode, litNode) => {
        if (
          ts.isIdentifier(identNode) &&
          (identNode.text === 'token' || identNode.text === 'flag') &&
          ts.isStringLiteral(litNode) &&
          litNode.text.startsWith('--')
        ) {
          flags.add(litNode.text);
        }
      };
      checkPair(node.left, node.right);
      checkPair(node.right, node.left);
    }
    ts.forEachChild(node, walk);
  }
  walk(parseFn);
  return [...flags].sort();
}

/** Extract `{ [tabName]: Set<key> }` from `if (tab === '<name>')` blocks in CourseSettingsModal.tsx. */
function extractCourseSettingsTabKeysFromAst(sf) {
  const tabKeys = new Map();
  function collectInputLiterals(node, out) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      if (ts.isIdentifier(node.left) && node.left.text === 'input' && ts.isStringLiteral(node.right)) {
        out.add(node.right.text);
      } else if (ts.isIdentifier(node.right) && node.right.text === 'input' && ts.isStringLiteral(node.left)) {
        out.add(node.left.text);
      }
    }
    ts.forEachChild(node, (child) => collectInputLiterals(child, out));
  }

  function visit(node) {
    if (
      ts.isIfStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
      ts.isIdentifier(node.expression.left) &&
      node.expression.left.text === 'tab' &&
      ts.isStringLiteral(node.expression.right)
    ) {
      const tabName = node.expression.right.text;
      const keys = tabKeys.get(tabName) ?? new Set();
      collectInputLiterals(node.thenStatement, keys);
      tabKeys.set(tabName, keys);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return tabKeys;
}

/** Render AppearanceTab in an isolated Ink stream and clean up deterministically. */
async function renderAppearanceTabFrame({ lang, cols = 100, rows = 28 }) {
  const prevState = useTuiStore.getState();
  useTuiStore.setState({
    preferences: { ...DEFAULT_PREFERENCES, language: lang, asciiMode: true },
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

  const dummyHost = {
    call: async () => ({ ok: true, value: {} }),
    subscribeEvents: () => () => {},
    getLibraryRoot: () => '/tmp/studyhub-docs-sync-test',
    getConfig: () => null,
    dispose: async () => {},
  };

  let latest = '';
  let resolveReady;
  const ready = new Promise((res) => {
    resolveReady = res;
  });
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim().length > 0) {
      latest = plain;
      if (plain.includes('Color Theme') || plain.includes('配色主题')) {
        resolveReady?.(plain);
      }
    }
  });

  const inst = render(
    React.createElement(
      Box,
      { width: cols, height: rows },
      React.createElement(AppearanceTab, { host: dummyHost, width: cols, height: rows, isActive: false }),
    ),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true },
  );

  let timer;
  try {
    await Promise.race([
      ready,
      new Promise((res) => {
        timer = setTimeout(() => res(latest), 1500);
      }),
    ]);
    return latest;
  } finally {
    clearTimeout(timer);
    inst.unmount();
    stdin.destroy();
    stdout.destroy();
    useTuiStore.setState({ preferences: prevState.preferences });
  }
}

describe('Cross-Doc & Runtime Docs-Sync Parity Guard', () => {
  test('1. Live buildPaletteItems() slash commands, parsePaletteScope() prefixes & THEME_IDS stay synced in GUIDE.md §5, KEYBINDINGS.md §3 & README.md', () => {
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

    const items = buildPaletteItems(useTuiStore.getState(), shellActions);
    const slashCommands = items.filter((item) => item.id.startsWith('cmd:') && item.label.startsWith('/'));
    assert.ok(slashCommands.length >= 30, `Expected >= 30 live slash commands, got ${slashCommands.length}`);

    const guidePaletteSection = extractH2Section(GUIDE_DOC, '## 5. 命令面板', 'docs/GUIDE.md');
    const missingInGuide = [];
    for (const cmd of slashCommands) {
      if (cmd.id.startsWith('cmd:theme:')) continue; // parameterized `/theme <id>` variants covered by `/theme` + THEME_IDS parity
      if (!guidePaletteSection.includes(`\`${cmd.label}\``)) {
        missingInGuide.push(cmd.label);
      }
    }
    assert.deepEqual(
      missingInGuide,
      [],
      `Live buildPaletteItems() slash commands missing from docs/GUIDE.md §5: ${missingInGuide.join(', ')}`,
    );

    // Live parsePaletteScope() prefixes must match both GUIDE.md §5 and KEYBINDINGS.md §3 tables 1:1
    const expectedScopes = [
      ['/', 'cmd'],
      ['#', 'card'],
      ['?', 'passage'],
      ['@', 'course'],
      [':', 'page'],
    ];
    for (const [prefix, scope] of expectedScopes) {
      assert.deepEqual(
        parsePaletteScope(`${prefix}query`),
        { scope, term: 'query' },
        `parsePaletteScope("${prefix}query") must resolve to scope "${scope}"`,
      );
    }

    const expectedPrefixes = expectedScopes.map(([prefix]) => prefix);
    const guidePrefixes = parseMarkdownTableRows(guidePaletteSection).map((cells) => stripBackticks(cells[0]));
    const kbPaletteSection = extractH2Section(KEYBINDINGS_DOC, '## 3. Command Palette v3 Scoped Prefixes', 'docs/KEYBINDINGS.md');
    const kbPrefixes = parseMarkdownTableRows(kbPaletteSection).map((cells) => stripBackticks(cells[0]));

    assert.deepEqual(guidePrefixes, expectedPrefixes, 'docs/GUIDE.md §5 prefix table must match live CommandPalette scopes 1:1');
    assert.deepEqual(kbPrefixes, expectedPrefixes, 'docs/KEYBINDINGS.md §3 prefix table must match live CommandPalette scopes 1:1');

    // THEME_IDS single-source consistency across tokens, tui-prefs, --doctor, --theme parser, and README.md
    const tokenThemes = [...themeTokensMod.THEME_IDS];
    const prefThemes = [...tuiPrefsMod.THEME_IDS];
    const doctorThemes = [...buildDoctorReport({ isTty: false }).terminal.availableThemes];
    assert.deepEqual(prefThemes, tokenThemes, 'src/host/tui-prefs.ts THEME_IDS must match src/theme/tokens.ts');
    assert.deepEqual(doctorThemes, tokenThemes, 'buildDoctorReport().terminal.availableThemes must match THEME_IDS');
    for (const themeId of tokenThemes) {
      const parsed = parseCliArgs(['--theme', themeId]);
      assert.equal(parsed.error, undefined, `parseCliArgs must accept live theme "${themeId}"`);
      assert.equal(parsed.theme, themeId);
      assert.ok(TUI_README_DOC.includes(`\`${themeId}\``), `packages/studyhub-tui/README.md missing theme \`${themeId}\``);
    }
    assert.ok(parseCliArgs(['--theme', 'nonexistent-theme']).error, 'parseCliArgs must reject unknown --theme');
  });

  test('2. AST-extracted parseCliArgs() flags & runtime CLI behavior match docs/GUIDE.md §7 and docs/KEYBINDINGS.md CLI Launch Flags', () => {
    const cliArgsSf = parseAst('cli-args.ts');
    const astFlags = extractCliLongFlagsFromAst(cliArgsSf);
    assert.ok(astFlags.length >= 20, `Expected >= 20 long CLI flags in parseCliArgs(), got ${astFlags.length}`);

    const helpText = cliHelpText('1.0.0');
    assert.ok(helpText.includes('--help') && helpText.includes('--version'), 'cliHelpText() must document --help and --version');
    assert.equal(parseCliArgs(['--help']).help, true);
    assert.equal(parseCliArgs(['--version']).version, true);

    const sampleArgvForFlag = {
      '--root': ['--root', '/tmp/lib'],
      '--library': ['--library', '/tmp/lib'],
      '--page': ['--page', 'review'],
      '--theme': ['--theme', 'dsh-dark'],
      '--lang': ['--lang', 'en'],
      '--mouse-alt': ['--mouse-alt=0'],
      '--export': ['--export', 'backup.json'],
      '--search': ['--search', 'fsrs'],
      '--limit': ['--limit', '15'],
      '--course': ['--course', 'Algorithms'],
    };

    const guideCliSection = extractH2Section(GUIDE_DOC, '## 7. 命令行参数', 'docs/GUIDE.md');
    const kbCliMatch = KEYBINDINGS_DOC.match(/> \*\*CLI Launch Flags\*\*:[^\n]+/);
    assert.ok(kbCliMatch, 'docs/KEYBINDINGS.md missing "> **CLI Launch Flags**:" line');
    const kbCliLine = kbCliMatch[0];

    const missingInGuide = [];
    const missingInKb = [];
    for (const flag of astFlags) {
      const sampleArgv = sampleArgvForFlag[flag] ?? [flag];
      const parsed = parseCliArgs(sampleArgv);
      assert.equal(parsed.error, undefined, `parseCliArgs(${JSON.stringify(sampleArgv)}) unexpectedly failed: ${parsed.error}`);

      if (flag === '--help' || flag === '--version') continue;
      if (!guideCliSection.includes(flag)) missingInGuide.push(flag);
      if (!kbCliLine.includes(flag)) missingInKb.push(flag);
    }

    assert.deepEqual(
      missingInGuide,
      [],
      `CLI flags from src/cli-args.ts missing from docs/GUIDE.md §7: ${missingInGuide.join(', ')}`,
    );
    assert.deepEqual(
      missingInKb,
      [],
      `CLI flags from src/cli-args.ts missing from docs/KEYBINDINGS.md CLI Launch Flags: ${missingInKb.join(', ')}`,
    );

    // DM-03 regression guard: `--due` row in GUIDE.md §7 must document both `--course` and `--limit`
    const guideCliRows = parseMarkdownTableRows(guideCliSection);
    const dueRow = guideCliRows.find((cells) => cells[0].includes('--due'));
    assert.ok(dueRow, 'docs/GUIDE.md §7 table must include a --due row');
    assert.ok(
      dueRow[0].includes('--course') && dueRow[0].includes('--limit'),
      `docs/GUIDE.md §7 --due row must document both --course and --limit (got: ${dueRow[0]})`,
    );

    const parsedDue = parseCliArgs(['--due', '--course', 'Algo', '--limit', '15']);
    assert.equal(parsedDue.error, undefined);
    assert.equal(parsedDue.due, true);
    assert.equal(parsedDue.course, 'Algo');
    assert.equal(parsedDue.searchLimit, 15);

    // Every PAGE_REGISTRY page id must be accepted by `--page`
    for (const page of PAGE_REGISTRY) {
      const parsed = parseCliArgs(['--page', page.id]);
      assert.equal(parsed.error, undefined, `--page ${page.id} must be accepted by parseCliArgs()`);
      assert.equal(parsed.initialPage, page.id);
    }
    assert.ok(parseCliArgs(['--page', 'does-not-exist']).error, 'parseCliArgs must reject unknown --page id');
  });

  test('3. packages/studyhub-tui/README.md ## 常用快捷键 table covers all 16 PAGE_REGISTRY pages, global routes & system chords (DM-02)', () => {
    const shortcutsSection = extractH2Section(TUI_README_DOC, '## 常用快捷键', 'packages/studyhub-tui/README.md');
    const rows = parseMarkdownTableRows(shortcutsSection);
    assert.ok(rows.length >= 25, `Expected >= 25 rows in README.md ## 常用快捷键 table, got ${rows.length}`);

    // Extract per-page shortcut rows whose scope column ends with (`<shortcut>`)
    const docPageShortcuts = [];
    for (const [scopeCol] of rows) {
      const m = /\(`([^`]+)`\)\s*$/.exec(scopeCol);
      if (m) docPageShortcuts.push(m[1]);
    }

    // Must have no duplicate per-page rows
    assert.equal(
      new Set(docPageShortcuts).size,
      docPageShortcuts.length,
      `Duplicate page shortcut rows in README.md ## 常用快捷键: ${docPageShortcuts.join(', ')}`,
    );

    const runtimeShortcuts = PAGE_REGISTRY.map((p) => p.shortcut);
    const docShortcutSet = new Set(docPageShortcuts);
    const missingPages = PAGE_REGISTRY.filter((p) => !docShortcutSet.has(p.shortcut)).map((p) => `${p.shortcut} (${p.id} / ${p.labelZh})`);
    const unknownPages = docPageShortcuts.filter((s) => !runtimeShortcuts.includes(s));

    assert.deepEqual(
      missingPages,
      [],
      `packages/studyhub-tui/README.md ## 常用快捷键 table missing PAGE_REGISTRY page rows: ${missingPages.join(', ')}`,
    );
    assert.deepEqual(
      unknownPages,
      [],
      `packages/studyhub-tui/README.md ## 常用快捷键 table has unknown page shortcuts: ${unknownPages.join(', ')}`,
    );

    // Global rows must cover every GLOBAL_SINGLE_KEY_ROUTES key and every KEY_LAYER_SYSTEM Ctrl chord
    const globalKeyCells = rows
      .filter(([scope]) => scope === '全局')
      .map(([, keys]) => keys)
      .join(' ');
    for (const routeKey of Object.keys(GLOBAL_SINGLE_KEY_ROUTES)) {
      assert.ok(
        globalKeyCells.includes(`\`${routeKey}\``),
        `README.md ## 常用快捷键 Global rows missing GLOBAL_SINGLE_KEY_ROUTES key \`${routeKey}\``,
      );
    }
    for (const sysChord of ['Ctrl+K', 'Ctrl+Space', 'Ctrl+G', 'Ctrl+O', 'Ctrl+R', 'Ctrl+C']) {
      assert.ok(
        globalKeyCells.includes(sysChord),
        `README.md ## 常用快捷键 Global rows missing system shortcut "${sysChord}"`,
      );
    }
    assert.ok(
      rows.some(([scope, keys]) => scope === '多行输入' && keys.includes('Ctrl+S')),
      'README.md ## 常用快捷键 must document Ctrl+S multiline submit',
    );
  });

  test('4. docs/GUIDE.md §4 covers all 16 PAGE_REGISTRY pages 1:1 and aligns with GLOBAL_NAV_ORDER, GLOBAL_PAGE_SHORTCUTS & RESERVED_GLOBAL_KEYS', () => {
    const guidePagesSection = extractH2Section(GUIDE_DOC, '## 4. 全 16 个页面使用指南', 'docs/GUIDE.md');
    const headingRe = /^### 4\.\d+\s+`([^`]+)`\s+(.+)$/gm;
    const foundShortcuts = [];
    let match;
    while ((match = headingRe.exec(guidePagesSection))) {
      foundShortcuts.push(match[1]);
    }

    assert.equal(
      foundShortcuts.length,
      PAGE_REGISTRY.length,
      `docs/GUIDE.md §4 must have exactly ${PAGE_REGISTRY.length} page subsections (found ${foundShortcuts.length})`,
    );
    assert.equal(new Set(foundShortcuts).size, foundShortcuts.length, 'Duplicate page shortcut subsections in docs/GUIDE.md §4');

    for (const page of PAGE_REGISTRY) {
      assert.equal(
        GLOBAL_PAGE_SHORTCUTS.get(page.shortcut),
        page.id,
        `GLOBAL_PAGE_SHORTCUTS must map "${page.shortcut}" -> "${page.id}"`,
      );
      assert.ok(
        foundShortcuts.includes(page.shortcut),
        `docs/GUIDE.md §4 missing subsection for \`${page.shortcut}\` (${page.id} / ${page.labelZh})`,
      );
    }

    // Main nav page count (`group !== null`) matches GLOBAL_NAV_ORDER across docs
    const expectedNavCount = PAGE_REGISTRY.filter((p) => p.group !== null).length;
    assert.equal(GLOBAL_NAV_ORDER.length, expectedNavCount);
    assert.ok(GUIDE_DOC.includes(`共 ${expectedNavCount} 页`), `docs/GUIDE.md must state ${expectedNavCount} main SideNav pages`);
    assert.ok(
      KEYBINDINGS_DOC.includes(`${expectedNavCount} main nav pages`),
      `docs/KEYBINDINGS.md must state ${expectedNavCount} main nav pages`,
    );

    const guideIntroSection = extractH2Section(GUIDE_DOC, '## 1. 第一次打开', 'docs/GUIDE.md');
    for (const reservedKey of RESERVED_GLOBAL_KEYS) {
      assert.ok(
        guideIntroSection.includes(`\`${reservedKey}\``),
        `docs/GUIDE.md §1 must document reserved global key \`${reservedKey}\``,
      );
    }
  });

  test('5. KEY_SCOPE_DEPTH_* constants & live SHELL_KEY_ROUTER invariants stay synced with docs/KEYBINDINGS.md §0 & §1', () => {
    const liveDepths = Object.entries(dispatcherMod)
      .filter(([name, value]) => name.startsWith('KEY_SCOPE_DEPTH_') && typeof value === 'number')
      .sort((a, b) => a[1] - b[1]);
    assert.ok(liveDepths.length >= 3, `Expected >= 3 KEY_SCOPE_DEPTH_* constants, got ${liveDepths.length}`);

    const scopeSection = extractH2Section(KEYBINDINGS_DOC, '## 0. Scope Stack & Priority Layers', 'docs/KEYBINDINGS.md');
    let prevPos = -1;
    for (const [name, value] of liveDepths) {
      const exactPattern = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*${value}\\b`);
      const m = exactPattern.exec(scopeSection);
      assert.ok(m, `docs/KEYBINDINGS.md §0 must document \`${name} = ${value}\``);
      assert.ok(m.index > prevPos, `docs/KEYBINDINGS.md §0 must list KEY_SCOPE_DEPTH_* in ascending order (${name})`);
      prevPos = m.index;
    }

    // Live SHELL_KEY_ROUTER verification against documented §0 & §1 rules
    const baseSysCtx = {
      blockedByScope: false,
      tooSmall: false,
      quitConfirmOpen: false,
      commandPaletteOpen: false,
      assistantOpen: false,
      assistantFocused: false,
      assistantFullscreen: false,
    };

    // Documented rule: Alt+Ctrl+C is consumed as an unhandled Alt chord and does NOT quit
    assert.equal(SHELL_KEY_ROUTER.resolveAltChord('c', { ...EMPTY_KEY, ctrl: true, meta: true }).kind, 'consume-unhandled-alt');
    assert.equal(SHELL_KEY_ROUTER.resolveSystem('c', { ...EMPTY_KEY, ctrl: true, meta: true }, baseSysCtx), null);

    // Ctrl+C triggers quit-request normally, quit-force when ConfirmDialog is already open
    assert.deepEqual(SHELL_KEY_ROUTER.resolveSystem('c', { ...EMPTY_KEY, ctrl: true }, baseSysCtx), {
      action: 'quit-request',
      consume: true,
    });
    assert.deepEqual(
      SHELL_KEY_ROUTER.resolveSystem('c', { ...EMPTY_KEY, ctrl: true }, { ...baseSysCtx, quitConfirmOpen: true }),
      { action: 'quit-force', consume: true },
    );

    // Documented Alt editing chords pass through; double Esc passes through; unhandled Alt+<char> is consumed
    for (const editKey of [
      { ...EMPTY_KEY, meta: true, return: true },
      { ...EMPTY_KEY, meta: true, leftArrow: true },
      { ...EMPTY_KEY, meta: true, rightArrow: true },
      { ...EMPTY_KEY, meta: true, backspace: true },
      { ...EMPTY_KEY, meta: true, delete: true },
      { ...EMPTY_KEY, meta: true, escape: true },
    ]) {
      assert.equal(SHELL_KEY_ROUTER.resolveAltChord('', editKey).kind, 'pass');
    }
    assert.equal(SHELL_KEY_ROUTER.resolveAltChord('s', { ...EMPTY_KEY, meta: true }).kind, 'consume-unhandled-alt');
    assert.equal(SHELL_KEY_ROUTER.resolveAltChord('q', { ...EMPTY_KEY, meta: true }).kind, 'consume-unhandled-alt');

    // Every GLOBAL_SINGLE_KEY_ROUTES & PAGE_REGISTRY route resolves accurately via SHELL_KEY_ROUTER.resolveGlobal
    const baseGlobalCtx = {
      overlayOpen: false,
      inputCaptured: false,
      showLaunchpad: false,
      page: 'library',
      passiveAssistantOpen: false,
      isKeyClaimed: () => false,
    };
    for (const [k, action] of Object.entries(GLOBAL_SINGLE_KEY_ROUTES)) {
      assert.deepEqual(SHELL_KEY_ROUTER.resolveGlobal(k, EMPTY_KEY, baseGlobalCtx), { action });
    }
    for (const page of PAGE_REGISTRY) {
      const res = SHELL_KEY_ROUTER.resolveGlobal(page.shortcut, EMPTY_KEY, baseGlobalCtx);
      const expected = page.id === 'review' ? { action: 'navigate-review' } : { action: 'navigate-page', page: page.id };
      assert.deepEqual(res, expected, `resolveGlobal("${page.shortcut}") must route to ${page.id}`);
    }
  });

  test('6. CourseSettingsModal AST tab shortcuts match docs/KEYBINDINGS.md §4.1 (DM-04)', () => {
    const sf = parseAst('views/library/CourseSettingsModal.tsx');
    const tabKeys = extractCourseSettingsTabKeysFromAst(sf);

    assert.deepEqual([...tabKeys.keys()].sort(), ['align', 'info', 'method', 'terms']);
    for (const k of ['m', 'e', 't', 'r']) assert.ok(tabKeys.get('method').has(k), `CourseSettingsModal method tab missing key "${k}"`);
    for (const k of ['n', 'd', 'm', 'a']) assert.ok(tabKeys.get('info').has(k), `CourseSettingsModal info tab missing key "${k}"`);
    for (const k of ['/', 'f', 'x', ' ', 'a', 'C']) assert.ok(tabKeys.get('terms').has(k), `CourseSettingsModal terms tab missing key "${k}"`);
    for (const k of ['a', 'u', 'p']) assert.ok(tabKeys.get('align').has(k), `CourseSettingsModal align tab missing key "${k}"`);

    const librarySection = extractH2Section(KEYBINDINGS_DOC, '## 4. Per-View Power Shortcuts', 'docs/KEYBINDINGS.md');
    const courseSettingsMatch = librarySection.match(/`C` course settings \([^)]+\)/);
    assert.ok(courseSettingsMatch, 'docs/KEYBINDINGS.md §4.1 must contain `C` course settings (...) description');
    const clause = courseSettingsMatch[0];

    for (const requiredFragment of [
      'Tab `1` Method',
      'Tab `2` Info',
      '`m` merge course',
      '`a` activate/deactivate',
      'Tab `3` Terms',
      '`Space` toggle term mark',
      '`x` clear',
      'Tab `4` Exam Align',
      '`u` restore',
      '`p` practise weak focus',
    ]) {
      assert.ok(
        clause.includes(requiredFragment),
        `docs/KEYBINDINGS.md §4.1 CourseSettingsModal clause missing "${requiredFragment}": ${clause}`,
      );
    }
  });

  test('7. AppearanceTab uses dynamic THEME_IDS.length (AST + live Ink render in zh & en, DM-01)', async () => {
    const sf = parseAst('views/settings/AppearanceTab.tsx');
    let sawThemeRow = false;
    let usesThemeIdsLength = false;
    let hardcodedFour = false;

    function inspectHintNode(node) {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'THEME_IDS' &&
        node.name.text === 'length'
      ) {
        usesThemeIdsLength = true;
      }
      if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isStringLiteral(node)) {
        if (/4\s*套|cycle\s+4\s+themes/i.test(node.text)) {
          hardcodedFour = true;
        }
      }
      ts.forEachChild(node, inspectHintNode);
    }

    function visit(node) {
      if (ts.isObjectLiteralExpression(node)) {
        let isThemeRow = false;
        let hintProp = null;
        for (const prop of node.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
          if (prop.name.text === 'key') {
            const init = ts.isAsExpression(prop.initializer) ? prop.initializer.expression : prop.initializer;
            if (ts.isStringLiteral(init) && init.text === 'theme') isThemeRow = true;
          }
          if (prop.name.text === 'hint') hintProp = prop.initializer;
        }
        if (isThemeRow && hintProp) {
          sawThemeRow = true;
          inspectHintNode(hintProp);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);

    assert.ok(sawThemeRow, 'AppearanceTab.tsx must define the theme row spec');
    assert.equal(usesThemeIdsLength, true, 'AppearanceTab.tsx theme hint must derive theme count from THEME_IDS.length');
    assert.equal(hardcodedFour, false, 'AppearanceTab.tsx theme hint must not hardcode 4 themes');

    const expectedCount = themeTokensMod.THEME_IDS.length;
    const zhFrame = await renderAppearanceTabFrame({ lang: 'zh' });
    assert.ok(
      zhFrame.includes(`${expectedCount} 套终端主题`),
      `Rendered AppearanceTab (zh) must show "${expectedCount} 套终端主题". Got:\n${zhFrame}`,
    );
    assert.equal(zhFrame.includes('4 套终端主题'), false, 'Rendered AppearanceTab (zh) must not show stale "4 套终端主题"');

    const enFrame = await renderAppearanceTabFrame({ lang: 'en' });
    assert.ok(
      enFrame.includes(`cycle ${expectedCount} themes`),
      `Rendered AppearanceTab (en) must show "cycle ${expectedCount} themes". Got:\n${enFrame}`,
    );
    assert.equal(enFrame.includes('cycle 4 themes'), false, 'Rendered AppearanceTab (en) must not show stale "cycle 4 themes"');
  });

  test('8. Root README.md and README.zh-CN.md contain no stale TUI claims or broken root-level KEYBINDINGS links', () => {
    for (const [label, doc] of [
      ['README.md', ROOT_README_EN],
      ['README.zh-CN.md', ROOT_README_ZH],
    ]) {
      assert.equal(doc.includes('4 套终端主题'), false, `${label} must not contain stale "4 套终端主题"`);
      assert.equal(doc.includes('columns < 100'), false, `${label} must not contain stale "columns < 100"`);
      assert.equal(
        doc.includes('(docs/KEYBINDINGS.md)') || doc.includes('(./docs/KEYBINDINGS.md)'),
        false,
        `${label} must not link to non-existent root docs/KEYBINDINGS.md (TUI keybindings live at packages/studyhub-tui/docs/KEYBINDINGS.md)`,
      );
    }
  });
});
