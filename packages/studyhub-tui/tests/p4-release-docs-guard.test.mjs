// P4 Stabilization, Pre-release Package Audit & Documentation Parity Guardrail (#1354 P4).
// Ensures:
// 1. ZERO raw Ink `useWindowSize` imports outside `src/components/resize.ts` (prevents layout jitter & test flakes).
// 2. Pre-release `package.json` manifest lists all shipped docs (`docs/ASSISTANT-UX.md`, `docs/GUIDE.md`, `docs/KEYBINDINGS.md`)
//    with every path present on disk and `engines.node` aligned with the root workspace (`>=22.19.0`).
// 3. `README.md`, `docs/KEYBINDINGS.md`, `docs/GUIDE.md`, `docs/ASSISTANT-UX.md`, and `HelpOverlay.buildInAppGuideLines`
//    stay strictly synchronized with current keys, 6 WCAG themes, unified 2-step Esc, and `I` -> `h` toast history recall.
// Run: node --test tests/p4-release-docs-guard.test.mjs
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

function walkSourceFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkSourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(full);
  }
  return out;
}

const [
  { HelpOverlay, buildInAppGuideLines, globalShortcuts },
  { PAGE_REGISTRY },
  { GLOBAL_KEYMAP_ENTRIES },
  { LAYOUT_BP },
  { GRADE_PASS_LINE, GRADE_SEMANTICS },
  { useTuiStore, DEFAULT_PREFERENCES },
] = await Promise.all([
  import('../src/shell/HelpOverlay.tsx'),
  import('../src/types/contracts.ts'),
  import('../src/shell/global-keymap.ts'),
  import('../src/components/layout-tokens.ts'),
  import('../src/grade-scale.ts'),
  import('../src/state/store.ts'),
]);

async function renderHelpOverlayFrame({ cols = 120, rows = 36, lang = 'zh', asciiMode = true } = {}) {
  const prevState = useTuiStore.getState();
  useTuiStore.setState({
    page: 'library',
    helpOpen: true,
    helpTab: 'shortcuts',
    footerHints: [],
    preferences: { ...DEFAULT_PREFERENCES, language: lang, asciiMode },
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
  let resolveReady;
  const ready = new Promise((res) => {
    resolveReady = res;
  });
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    if (plain.trim().length > 0) {
      latest = plain;
      if (plain.includes('刷题复习') || plain.includes('Review')) resolveReady?.(plain);
    }
  });

  const inst = render(
    React.createElement(
      Box,
      { width: cols, height: rows },
      React.createElement(HelpOverlay, { isActive: false, onClose: () => {} }),
    ),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false, interactive: true },
  );
  let timer;
  try {
    await Promise.race([
      ready,
      new Promise((res) => {
        timer = setTimeout(() => res(latest), 1200);
      }),
    ]);
    return latest;
  } finally {
    clearTimeout(timer);
    inst.unmount();
    stdin.destroy();
    stdout.destroy();
    useTuiStore.setState({
      page: prevState.page,
      helpOpen: prevState.helpOpen,
      helpTab: prevState.helpTab,
      footerHints: prevState.footerHints,
      preferences: prevState.preferences,
    });
  }
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Expand a GLOBAL_KEYMAP_ENTRIES key spec (e.g. `Ctrl+D/U`, `Ctrl+K  /`, `1-9 0`) into canonical tokens. */
function expandGlobalKeyTokens(rawKey) {
  const tokens = [];
  for (const part of rawKey.trim().split(/\s+/)) {
    if (!part) continue;
    const ctrlPair = /^Ctrl\+([A-Za-z])\/([A-Za-z])$/.exec(part);
    if (ctrlPair) {
      tokens.push(`Ctrl+${ctrlPair[1]}`, `Ctrl+${ctrlPair[2]}`);
      continue;
    }
    const singlePair = /^([A-Za-z])\/([A-Za-z])$/.exec(part);
    if (singlePair) {
      tokens.push(singlePair[1], singlePair[2]);
      continue;
    }
    tokens.push(part);
  }
  return tokens;
}

describe('P4 Stabilization, Pre-release Audit & Docs Sync Guardrail (#1354)', () => {
  test('1. Static AST guardrail: ZERO raw ink useWindowSize imports outside components/resize.ts', () => {
    const ALLOWED = new Set(['components/resize.ts']);
    const violations = [];
    for (const file of walkSourceFiles(SRC_ROOT).sort()) {
      const rel = path.relative(SRC_ROOT, file).replace(/\\/g, '/');
      if (ALLOWED.has(rel)) continue;
      const code = fs.readFileSync(file, 'utf8');
      const sf = ts.createSourceFile(
        file,
        code,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      for (const stmt of sf.statements) {
        if (
          ts.isImportDeclaration(stmt) &&
          ts.isStringLiteral(stmt.moduleSpecifier) &&
          stmt.moduleSpecifier.text === 'ink' &&
          stmt.importClause?.namedBindings &&
          ts.isNamedImports(stmt.importClause.namedBindings)
        ) {
          for (const spec of stmt.importClause.namedBindings.elements) {
            const imported = (spec.propertyName ?? spec.name).text;
            if (imported === 'useWindowSize') {
              const line = sf.getLineAndCharacterOfPosition(spec.getStart(sf)).line + 1;
              violations.push(`${rel}:${line} imports raw useWindowSize from 'ink' (use useStableWindowSize from components/resize.js)`);
            }
          }
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Found raw Ink useWindowSize imports outside components/resize.ts:\n${violations.join('\n')}`,
    );
  });

  test('2. Pre-release package manifest audit: files list, disk presence, engines.node alignment, and required scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

    for (const requiredFile of ['bin/', 'dist/', 'README.md', 'docs/GUIDE.md', 'docs/KEYBINDINGS.md', 'docs/ASSISTANT-UX.md']) {
      assert.ok(
        Array.isArray(pkg.files) && pkg.files.includes(requiredFile),
        `packages/studyhub-tui/package.json "files" must include "${requiredFile}"`,
      );
      assert.ok(
        fs.existsSync(path.join(PKG_ROOT, requiredFile)),
        `packages/studyhub-tui/package.json "files" entry "${requiredFile}" does not exist on disk`,
      );
    }

    assert.equal(
      pkg.engines?.node,
      rootPkg.engines?.node ?? '>=22.19.0',
      'packages/studyhub-tui engines.node must align with root package.json (>=22.19.0)',
    );

    for (const script of ['build', 'lint', 'typecheck', 'test', 'bench']) {
      assert.equal(typeof pkg.scripts?.[script], 'string', `package.json missing script "${script}"`);
    }
  });

  test('3. Docs & README parity: no stale shortcuts/theme counts, documents 6 themes, Ctrl+Space/Ctrl+G, unified 2-step Esc, and I -> h toast history', () => {
    const readme = fs.readFileSync(path.join(PKG_ROOT, 'README.md'), 'utf8');
    const keybindings = fs.readFileSync(path.join(PKG_ROOT, 'docs/KEYBINDINGS.md'), 'utf8');
    const guide = fs.readFileSync(path.join(PKG_ROOT, 'docs/GUIDE.md'), 'utf8');
    const assistantUx = fs.readFileSync(path.join(PKG_ROOT, 'docs/ASSISTANT-UX.md'), 'utf8');

    // README stale items must be gone
    assert.ok(!readme.includes('`T` 翻译') && !readme.includes('/ `T` /'), 'README.md must not map T to Translate (use W)');
    assert.ok(!readme.includes('`q` 二次确认结束本轮'), 'README.md must not map q to end-round (use X)');
    assert.ok(!/4 套[^\n]*主题/.test(readme), 'README.md must reflect 6 WCAG themes, not 4');

    // README required current docs
    for (const token of ['docs/ASSISTANT-UX.md', '6 套', 'warm-amber', 'soft-sage', 'Ctrl+Space', 'Ctrl+G', '`W`', '`X`', '近期提示', 'npm run lint', 'npm run typecheck']) {
      assert.ok(readme.includes(token), `README.md missing updated reference "${token}"`);
    }

    // KEYBINDINGS.md updated inbox toast history + unified Esc
    assert.ok(keybindings.includes('近期提示') || keybindings.includes('toast history'), 'docs/KEYBINDINGS.md must document I -> h recent toast history');
    assert.ok(keybindings.includes('`h`') && keybindings.includes('50'), 'docs/KEYBINDINGS.md must mention h tab and 50-item toast history');

    // ASSISTANT-UX.md & GUIDE.md: unified 2-step Esc across ALL docked pages (no longer "only on practice page")
    assert.ok(!assistantUx.includes('刷题页多一步'), 'docs/ASSISTANT-UX.md must reflect unified 2-step Esc on all docked pages, not only practice page');
    assert.ok(!guide.includes('在刷题页则是把键盘还给题目'), 'docs/GUIDE.md must reflect unified 2-step Esc on all docked pages, not only practice page');
    assert.ok(assistantUx.includes('先把键盘还给页面') || assistantUx.includes('所有停靠页面'), 'docs/ASSISTANT-UX.md must document unified 2-step Esc across all docked pages');
    assert.ok(guide.includes('近期提示') && guide.includes('`h`'), 'docs/GUIDE.md must document I -> h recent multi-line toast history recall');

    // In-app guide parity (zh & en)
    const zhGuide = buildInAppGuideLines('zh', 120, false).join('\n');
    const enGuide = buildInAppGuideLines('en', 120, true).join('\n');
    assert.ok(zhGuide.includes('近期提示'), 'HelpOverlay zh in-app guide must mention recent toast history (I -> h)');
    assert.ok(enGuide.includes('toast history') || enGuide.includes('recent notices'), 'HelpOverlay en in-app guide must mention recent toast history (I -> h)');
  });

  test('4. Dynamic doc-to-code parity: PAGE_REGISTRY, GLOBAL_KEYMAP_ENTRIES, layout breakpoints & 0-5 grade scale stay synchronized across KEYBINDINGS, HelpOverlay, GUIDE & README', async () => {
    const readme = fs.readFileSync(path.join(PKG_ROOT, 'README.md'), 'utf8');
    const keybindings = fs.readFileSync(path.join(PKG_ROOT, 'docs/KEYBINDINGS.md'), 'utf8');
    const guide = fs.readFileSync(path.join(PKG_ROOT, 'docs/GUIDE.md'), 'utf8');
    const helpFrame = await renderHelpOverlayFrame({ cols: 120, rows: 36, lang: 'zh', asciiMode: true });

    // 4a. PAGE_REGISTRY: every page shortcut & id must appear in docs/KEYBINDINGS.md table, docs/GUIDE.md, README.md, and rendered HelpOverlay
    assert.ok(helpFrame.includes('Ctrl+O'), 'Rendered HelpOverlay missing Ctrl+O notification history shortcut');
    const seenShortcuts = new Set();
    for (const page of PAGE_REGISTRY) {
      assert.ok(!seenShortcuts.has(page.shortcut), `Duplicate PAGE_REGISTRY shortcut "${page.shortcut}"`);
      seenShortcuts.add(page.shortcut);

      assert.ok(
        helpFrame.includes(page.labelZh),
        `Rendered HelpOverlay missing PAGE_REGISTRY page "${page.labelZh}" (${page.id})`,
      );
      const kbRowRe = new RegExp(`\\|\\s*\`${escapeRegExp(page.shortcut)}\`\\s*\\|\\s*\`${escapeRegExp(page.id)}\`\\s*\\|`);
      assert.match(
        keybindings,
        kbRowRe,
        `docs/KEYBINDINGS.md Page Jump Shortcuts table missing row for \`${page.shortcut}\` -> \`${page.id}\``,
      );
      assert.ok(
        guide.includes(`\`${page.shortcut}\``) && guide.includes(page.labelZh),
        `docs/GUIDE.md missing shortcut \`${page.shortcut}\` or label "${page.labelZh}" for page ${page.id}`,
      );
      const readmeHasShortcut =
        readme.includes(`\`${page.shortcut}\``) ||
        (/^[1-9]$/.test(page.shortcut) && (readme.includes('1–9') || readme.includes('1-9')));
      assert.ok(
        readmeHasShortcut && readme.includes(page.labelZh),
        `README.md missing shortcut/label for page ${page.id} (${page.shortcut} / ${page.labelZh})`,
      );
    }

    // 4b. GLOBAL_KEYMAP_ENTRIES: every binding in global-keymap.ts must appear in HelpOverlay.globalShortcuts AND docs/KEYBINDINGS.md
    for (const lang of ['zh', 'en']) {
      for (const ascii of [false, true]) {
        const helpItems = globalShortcuts(lang, ascii);
        assert.equal(
          helpItems.length,
          GLOBAL_KEYMAP_ENTRIES.length,
          `HelpOverlay.globalShortcuts(${lang}, ascii=${ascii}) count must match GLOBAL_KEYMAP_ENTRIES`,
        );
        const helpKeySet = new Set(helpItems.map((h) => h.key));
        for (const entry of GLOBAL_KEYMAP_ENTRIES) {
          let expectedKey = ascii && entry.helpKeyAscii ? entry.helpKeyAscii : entry.helpKey;
          if (entry.id === 'mouse' && !ascii && lang === 'en') expectedKey = 'Alt+Click';
          assert.ok(
            helpKeySet.has(expectedKey),
            `HelpOverlay.globalShortcuts(${lang}, ascii=${ascii}) missing "${expectedKey}" for global keymap entry "${entry.id}"`,
          );
        }
      }
    }

    for (const entry of GLOBAL_KEYMAP_ENTRIES) {
      const canonical = entry.helpKeyAscii ?? entry.helpKey;
      const tokens = expandGlobalKeyTokens(canonical);
      assert.ok(tokens.length > 0, `GLOBAL_KEYMAP_ENTRIES "${entry.id}" produced no key tokens`);
      for (const token of tokens) {
        assert.ok(
          keybindings.includes(token),
          `docs/KEYBINDINGS.md missing global key token "${token}" from GLOBAL_KEYMAP_ENTRIES "${entry.id}"`,
        );
      }
    }

    // 4c. Runtime behavior parity in GUIDE.md & README.md (#1452, #1467, #1475, LAYOUT_BP)
    const collapseBp = String(LAYOUT_BP.SIDENAV_AUTO_COLLAPSE);
    const minCols = String(LAYOUT_BP.MIN_VIEWPORT_COLS);
    const minRows = String(LAYOUT_BP.MIN_VIEWPORT_ROWS);
    const viewportRe = new RegExp(`${minCols}[×x]${minRows}`);

    for (const [name, doc] of [
      ['docs/GUIDE.md', guide],
      ['README.md', readme],
    ]) {
      assert.ok(doc.includes('Ctrl+O'), `${name} must document Ctrl+O standalone notification history (#1475)`);
      assert.ok(doc.includes(collapseBp), `${name} must document SideNav auto-collapse breakpoint ${collapseBp}`);
      assert.ok(
        !/<\s*100\s*列?自动折叠/.test(doc),
        `${name} still has stale "< 100" SideNav auto-collapse breakpoint (actual: ${collapseBp})`,
      );
      assert.match(doc, viewportRe, `${name} must document < ${minCols}x${minRows} too-small viewport notice (#1452)`);
      assert.ok(doc.includes('?+N') && doc.includes('+N'), `${name} must document compact +N / ?+N footer overflow indicator`);
    }

    assert.ok(!guide.includes('按?看全部'), 'docs/GUIDE.md must not document stale "按?看全部" footer overflow wording (now +N / ?+N)');
    assert.ok(!guide.includes('（g / Tab）'), 'docs/GUIDE.md must not claim "g" switches HelpOverlay to Guide tab (actual: Tab / 2)');
    assert.ok(
      guide.includes(`≥ ${GRADE_PASS_LINE}`) || guide.includes(`>= ${GRADE_PASS_LINE}`),
      `docs/GUIDE.md must document the grade >= ${GRADE_PASS_LINE} pass line (#1467)`,
    );
    for (const spec of GRADE_SEMANTICS) {
      assert.ok(
        guide.includes(spec.labelZh),
        `docs/GUIDE.md missing #1467 grade ${spec.grade} semantic label "${spec.labelZh}"`,
      );
    }
  });
});
