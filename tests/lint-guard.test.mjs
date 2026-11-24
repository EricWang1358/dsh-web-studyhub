import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { walk, countLintDisables, ROOT } from '../scripts/qa/guardrail-baseline.mjs';

/* The lint rules switched on by the 2026-11 code audit stay on, and nobody steps around them (eslint.config.js, `cheapRules`).
   Two ways round a rule are closed here: switching it off in a comment, and lowering it in the config. The third place, ui/, has old
   disable comments of its own (react-hooks/exhaustive-deps): they are the lintDisable ratchet of tests/ui-guardrails.test.mjs, which may only fall. */
const rel = (abs) => abs.slice(ROOT.length).replace(/\\/g, '/').replace(/^\/+/, '');
// Built by `npm run build` or installed/compiled inside workspace packages, never written by hand.
const generated = (file) => /^lib\/client(\.|$)/.test(file) || /^packages\/[^/]+\/(?:node_modules|dist)\//.test(file);

test('no lint rule is switched off in a comment outside ui/', () => {
  const hits = [];
  for (const dir of ['lib', 'scripts', 'tests', 'packages']) {
    for (const abs of walk(join(ROOT, dir), ['.js', '.mjs', '.jsx', '.ts', '.tsx'])) {
      const file = rel(abs);
      if (generated(file)) continue;
      const count = countLintDisables(readFileSync(abs, 'utf8'));
      if (count) hits.push(`${file} (${count})`);
    }
  }
  assert.deepEqual(hits, [], 'fix what the rule points at; an exception that is really needed is a line in eslint.config.js with its reason, where a reviewer sees it');
});

const MUST_BE_ERRORS = ['no-unused-vars', 'no-undef', 'no-dupe-keys', 'no-empty', 'prefer-const', 'no-var', 'eqeqeq', 'no-useless-escape', 'no-useless-catch', 'no-unreachable',
  'no-unused-expressions', 'no-constant-condition', 'no-fallthrough', 'no-case-declarations', 'no-prototype-builtins', 'no-async-promise-executor', 'no-self-assign',
  'no-unsafe-optional-chaining', 'no-cond-assign', 'no-loss-of-precision', 'no-sparse-arrays', 'no-misleading-character-class'];
const UI_ERRORS = ['react-hooks/rules-of-hooks', 'react/jsx-key', 'react/no-unstable-nested-components', 'react/jsx-no-useless-fragment'];
const TUI_ERRORS = [
  ...MUST_BE_ERRORS.filter((r) => r !== 'no-undef'),
  'react-hooks/rules-of-hooks',
  'react/jsx-key',
  'no-restricted-imports',
];
const ERROR = 2;
const severityOf = (entry) => { const level = Array.isArray(entry) ? entry[0] : entry; return level === 'error' ? ERROR : level; };

test('the cheap correctness rules are errors for every kind of source file, and a leftover disable comment is one too', async () => {
  const eslint = new ESLint({ cwd: ROOT });
  const files = { 'lib/store.js': [], 'scripts/build.mjs': [], 'tests/lint-guard.test.mjs': [], 'ui/App.jsx': UI_ERRORS, 'ui/i18n.js': UI_ERRORS };
  for (const [file, extra] of Object.entries(files)) {
    const config = await eslint.calculateConfigForFile(join(ROOT, file));
    const lowered = [...MUST_BE_ERRORS, ...extra].filter((rule) => severityOf(config.rules?.[rule]) !== ERROR);
    assert.deepEqual(lowered, [], `${file}: these rules are no longer errors. They cost nothing to keep (the tree is clean), so fix the code, not the config`);
    assert.equal(severityOf(config.linterOptions?.reportUnusedDisableDirectives), ERROR, `${file}: a disable comment that silences nothing must be reported`);
  }

  // P1-b (#1354 D12): TUI TypeScript/TSX sources must also be linted with error-level correctness + key-routing rules.
  const tuiConfig = await eslint.calculateConfigForFile(join(ROOT, 'packages/studyhub-tui/src/shell/AppShell.tsx'));
  const loweredTui = TUI_ERRORS.filter((rule) => severityOf(tuiConfig.rules?.[rule]) !== ERROR);
  assert.deepEqual(loweredTui, [], 'packages/studyhub-tui/src/shell/AppShell.tsx: TUI ESLint rules lowered or missing');
  assert.equal(severityOf(tuiConfig.linterOptions?.reportUnusedDisableDirectives), ERROR);

  // Verify ESLint actively rejects raw ink useInput imports in TUI views.
  const [violation] = await eslint.lintText("import { useInput } from 'ink';\nexport const x = useInput;\n", {
    filePath: join(ROOT, 'packages/studyhub-tui/src/views/fake-view.tsx'),
  });
  assert.ok(
    violation.messages.some((m) => m.ruleId === 'no-restricted-imports'),
    'TUI ESLint config must reject raw ink useInput imports outside key-dispatcher.ts',
  );

  // P4 (#1354): Verify ESLint actively rejects raw ink useWindowSize imports outside components/resize.ts.
  const [winSizeViolation] = await eslint.lintText("import { useWindowSize } from 'ink';\nexport const w = useWindowSize;\n", {
    filePath: join(ROOT, 'packages/studyhub-tui/src/views/fake-view.tsx'),
  });
  assert.ok(
    winSizeViolation.messages.some((m) => m.ruleId === 'no-restricted-imports'),
    'TUI ESLint config must reject raw ink useWindowSize imports outside components/resize.ts',
  );

  // Verify CI tui-test job runs ESLint and typecheck on TUI sources.
  const verifyYml = readFileSync(join(ROOT, '.github/workflows/verify.yml'), 'utf8');
  assert.match(verifyYml, /tui-test:[\s\S]*?eslint packages\/studyhub-tui\/src/, 'tui-test CI job must run ESLint on TUI sources');
  assert.match(verifyYml, /tui-test:[\s\S]*?typecheck/, 'tui-test CI job must run TypeScript typecheck on TUI sources');
});

test('the scan counts the line, next-line and block forms, and nothing else', () => {
  const off = 'eslint-' + 'disable';
  assert.equal(countLintDisables(`a(); // ${off}-line no-empty\n// ${off}-next-line no-undef -- why\nb();\n/* ${off} no-var */\n/* eslint-enable no-var */`), 3);
  assert.equal(countLintDisables(`const text = '${off}'; assert.doesNotMatch(source, /${off}/); // the word ${off} inside a sentence`), 0);
});
