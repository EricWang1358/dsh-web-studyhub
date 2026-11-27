import test from 'node:test';
import { parse } from 'yaml';
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
const UI_ERRORS = ['react-hooks/rules-of-hooks', 'react-hooks/exhaustive-deps', 'react/jsx-key', 'react/no-unstable-nested-components', 'react/jsx-no-useless-fragment'];
const TUI_ERRORS = [
  ...MUST_BE_ERRORS.filter((r) => r !== 'no-undef'),
  'react-hooks/rules-of-hooks',
  'react-hooks/exhaustive-deps',
  'react/jsx-key',
  'react/no-unstable-nested-components',
  'react/jsx-no-useless-fragment',
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

  // P1-b (#1354 D12): Verify ESLint actively rejects raw fs rename and child_process exec/execSync in TUI sources.
  const [renameViolation] = await eslint.lintText("import { rename } from 'node:fs/promises';\nexport const r = rename;\n", {
    filePath: join(ROOT, 'packages/studyhub-tui/src/views/fake-view.tsx'),
  });
  assert.ok(
    renameViolation.messages.some((m) => m.ruleId === 'no-restricted-imports'),
    'TUI ESLint config must reject raw node:fs/promises rename outside host/atomic-write.ts',
  );
  // Built by concatenation so this file does not itself spell out a child_process import: the slow-test
  // guard in tests/slow-tests-list.test.mjs would otherwise flag this guard as launching a program.
  const childProcessMod = 'node:' + 'child_process';
  const [execViolation] = await eslint.lintText(`import { execSync } from '${childProcessMod}';\nexport const e = execSync;\n`, {
    filePath: join(ROOT, 'packages/studyhub-tui/src/views/fake-view.tsx'),
  });
  assert.ok(
    execViolation.messages.some((m) => m.ruleId === 'no-restricted-imports'),
    'TUI ESLint config must reject raw child_process execSync in TUI sources',
  );

  // Root lint enforces --max-warnings=0 across the repo (#1540); the TUI lint script enforces it too (packages/studyhub-tui/scripts/lint.mjs).
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.match(String(rootPkg.scripts?.lint || ''), /--max-warnings=0\b/, 'root package.json scripts.lint must enforce --max-warnings=0');
  const { jobs } = parse(readFileSync(join(ROOT, '.github/workflows/verify.yml'), 'utf8'));
  const commands = jobs.lint.steps.map(step => step.run);
  assert.ok(commands.includes('npm run lint'), 'lint CI job must run root npm run lint');
  assert.ok(commands.includes('npm --prefix packages/studyhub-tui run lint'));
  assert.ok(commands.includes('npm --prefix packages/studyhub-tui run typecheck'));
  assert.ok(jobs.verify.needs.includes('lint'));
});

test('P1 ESLint zero-warnings gate: no warn-severity rules remain in repo configs and ui/app/use-learning-navigation.js is warning-free', async () => {
  const eslint = new ESLint({ cwd: ROOT });

  // 1) No warning-level ESLint rule remains configured for any major source kind.
  const sampleFiles = [
    'lib/store.js',
    'scripts/build.mjs',
    'tests/lint-guard.test.mjs',
    'ui/App.jsx',
    'ui/app/use-learning-navigation.js',
    'packages/studyhub-tui/src/shell/AppShell.tsx',
    'packages/studyhub-desktop/domain/state.mjs',
  ];
  for (const file of sampleFiles) {
    const config = await eslint.calculateConfigForFile(join(ROOT, file));
    const warnRules = Object.entries(config.rules || {})
      .filter(([, entry]) => {
        const level = Array.isArray(entry) ? entry[0] : entry;
        return level === 1 || level === 'warn';
      })
      .map(([name]) => name);
    assert.deepEqual(warnRules, [], `${file}: ESLint config must not leave warning-only rules (${warnRules.join(', ')})`);
  }

  // 2) An unnecessary useMemo dependency in ui/ must fail as an error (severity 2), not a warning.
  const [depResult] = await eslint.lintText(
    [
      "import { useMemo, useState } from 'react';",
      'export function Demo({ value }) {',
      '  const [tick] = useState(0);',
      '  return useMemo(() => value * 2, [value, tick]);',
      '}',
    ].join('\n'),
    { filePath: join(ROOT, 'ui/app/fake-exhaustive-deps.js') },
  );
  const depMsg = depResult.messages.find((m) => m.ruleId === 'react-hooks/exhaustive-deps');
  assert.ok(depMsg, 'expected react-hooks/exhaustive-deps diagnostic on unnecessary useMemo dependency in ui/');
  assert.equal(depMsg.severity, ERROR, 'react-hooks/exhaustive-deps in ui/ must be enforced at error severity (2)');

  // 3) ui/app/use-learning-navigation.js (previously the last repo-wide lint warning) has 0 errors and 0 warnings.
  const [navResult] = await eslint.lintFiles([join(ROOT, 'ui/app/use-learning-navigation.js')]);
  assert.equal(navResult.errorCount + navResult.fatalErrorCount, 0, `unexpected lint errors: ${JSON.stringify(navResult.messages)}`);
  assert.equal(navResult.warningCount, 0, `unexpected lint warnings: ${JSON.stringify(navResult.messages)}`);
});

test('the scan counts the line, next-line and block forms, and nothing else', () => {
  const off = 'eslint-' + 'disable';
  assert.equal(countLintDisables(`a(); // ${off}-line no-empty\n// ${off}-next-line no-undef -- why\nb();\n/* ${off} no-var */\n/* eslint-enable no-var */`), 3);
  assert.equal(countLintDisables(`const text = '${off}'; assert.doesNotMatch(source, /${off}/); // the word ${off} inside a sentence`), 0);
});
