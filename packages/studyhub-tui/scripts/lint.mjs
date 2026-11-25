#!/usr/bin/env node
/**
 * Cross-platform StudyHub TUI ESLint runner (#1354 P1-b / D12).
 * Invokes ESLint with `cwd` anchored at the repository root so flat-config
 * `files` patterns (`packages/studyhub-tui/...`) match identically whether
 * launched via `npm --prefix packages/studyhub-tui run lint` or directly.
 * Enforces zero errors and zero warnings (`--max-warnings=0`).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '../..');

export const TUI_LINT_TARGETS = Object.freeze([
  'packages/studyhub-tui/src',
  'packages/studyhub-tui/tests',
  'packages/studyhub-tui/scripts',
  'packages/studyhub-tui/bin',
]);

async function main() {
  const cliArgs = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const targets = cliArgs.length > 0 ? cliArgs : [...TUI_LINT_TARGETS];
  const eslint = new ESLint({ cwd: repoRoot });
  const results = await eslint.lintFiles(targets);
  const formatter = await eslint.loadFormatter('stylish');
  const output = await formatter.format(results);
  if (output) process.stdout.write(`${output}\n`);

  const errorCount = results.reduce((sum, r) => sum + r.errorCount + r.fatalErrorCount, 0);
  const warningCount = results.reduce((sum, r) => sum + r.warningCount, 0);
  if (errorCount > 0 || warningCount > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
