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

const { buildInAppGuideLines } = await import('../src/shell/HelpOverlay.tsx');

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
});
