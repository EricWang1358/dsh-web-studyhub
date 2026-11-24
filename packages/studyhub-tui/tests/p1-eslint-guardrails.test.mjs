// P1-b (#1354 D12): Permanent ESLint convergence guardrails for StudyHub TUI.
// Verifies TypeScript/TSX parser fidelity, error-level React + Hooks + architectural
// import rules, CI enforcement (--max-warnings=0), and zero errors/warnings across TUI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TUI_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TUI_ROOT, '../..');

const eslint = new ESLint({ cwd: REPO_ROOT });

async function lintTuiText(code, relPath = 'packages/studyhub-tui/src/views/fake-guard-view.tsx') {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(REPO_ROOT, relPath),
  });
  return result.messages;
}

describe('P1-b (#1354 D12): TUI ESLint Convergence Guardrails', () => {
  test('TS/TSX parser preserves exact line/column numbers across erased TypeScript syntax', async () => {
    const sample = [
      "import type { ReactElement } from 'react';",
      "import React, { useState, type FC } from 'react';",
      'export interface DemoProps<T extends Record<string, unknown>> {',
      '  items: ReadonlyArray<T>;',
      '  renderItem?: (item: T) => ReactElement;',
      '}',
      'export type Alias = Map<string, Array<number>>;',
      'export function Demo<T extends Record<string, unknown>>(props: DemoProps<T>): ReactElement {',
      '  const [count, setCount] = useState<number>(0);',
      '  const map = new Map<string, Array<number>>();',
      '  const x = (props.items[0] as unknown as { id?: string })!;',
      '  var badVar = count + map.size + (x ? 1 : 0);',
      '  void setCount;',
      '  return React.createElement("box", null, String(badVar));',
      '}',
      'export const _unusedTypeCheck: FC | null = null;',
    ].join('\n');

    const msgs = await lintTuiText(sample);
    const noVar = msgs.find((m) => m.ruleId === 'no-var');
    assert.ok(noVar, `expected no-var error, got: ${JSON.stringify(msgs)}`);
    assert.equal(noVar.severity, 2);
    assert.equal(noVar.line, 12, 'line number must match original TSX source after type erasure');
    assert.equal(noVar.column, 3, 'column number must match original TSX source after type erasure');
    const parseErrors = msgs.filter((m) => m.fatal);
    assert.deepEqual(parseErrors, [], `unexpected parse errors: ${JSON.stringify(parseErrors)}`);
  });

  test('TS/TSX parser handles overloads, modifiers, satisfies, this-params, catch annotations, and JSX generics', async () => {
    const sample = [
      "import React from 'react';",
      'function format(x: string): string;',
      'function format(x: number): string;',
      'function format(x: string | number): string {',
      '  return String(x);',
      '}',
      'export class Helper {',
      '  public readonly tag: string = "ok";',
      '  private check(this: Helper, value: unknown): value is string {',
      '    try {',
      '      return typeof value === "string";',
      '    } catch (err: unknown) {',
      '      return Boolean(err);',
      '    }',
      '  }',
      '  public run(v: unknown) {',
      '    const cfg = { ok: true } satisfies { ok: boolean };',
      '    return this.check(v) ? format(v) : String(cfg.ok);',
      '  }',
      '}',
      'export function ListHost() {',
      '  const GenericList = <T,>(p: { item: T }) => <>{String(p.item)}{"!"}</>;',
      '  return <GenericList<number> item={42} />;',
      '}',
    ].join('\n');

    const msgs = await lintTuiText(sample);
    const fatal = msgs.filter((m) => m.fatal);
    assert.deepEqual(fatal, [], `parser failed on valid TS/TSX constructs: ${JSON.stringify(fatal)}`);
    // GenericList defined inside ListHost MUST be caught by react/no-unstable-nested-components!
    assert.ok(
      msgs.some((m) => m.ruleId === 'react/no-unstable-nested-components' && m.severity === 2),
      `expected react/no-unstable-nested-components error, got: ${JSON.stringify(msgs)}`,
    );
  });

  test('React Hooks rules (rules-of-hooks + exhaustive-deps) are enforced as errors on TUI TSX', async () => {
    const conditionalHook = [
      "import { useEffect } from 'react';",
      'export function BadHook({ on }: { on: boolean }) {',
      '  if (on) {',
      '    useEffect(() => {}, []);',
      '  }',
      '  return null;',
      '}',
    ].join('\n');
    const hookMsgs = await lintTuiText(conditionalHook);
    assert.ok(
      hookMsgs.some((m) => m.ruleId === 'react-hooks/rules-of-hooks' && m.severity === 2),
      `expected rules-of-hooks error, got: ${JSON.stringify(hookMsgs)}`,
    );

    const staleDep = [
      "import { useEffect } from 'react';",
      'export function StaleDep({ value, onLog }: { value: string; onLog: (v: string) => void }) {',
      '  useEffect(() => {',
      '    onLog(value);',
      '  }, [onLog]);',
      '  return null;',
      '}',
    ].join('\n');
    const depMsgs = await lintTuiText(staleDep);
    assert.ok(
      depMsgs.some((m) => m.ruleId === 'react-hooks/exhaustive-deps' && m.severity === 2),
      `expected exhaustive-deps ERROR (severity 2), got: ${JSON.stringify(depMsgs)}`,
    );
  });

  test('React component hygiene rules allow SplitPane left/right render props while rejecting nested components & useless fragments', async () => {
    const validSplitPane = [
      "import React from 'react';",
      "import { Box, Text } from 'ink';",
      "import { SplitPane } from '../components/SplitPane.js';",
      'export function GoodView() {',
      '  return (',
      '    <SplitPane',
      '      width={80}',
      '      height={20}',
      '      left={() => <Box><Text>L</Text></Box>}',
      '      right={() => <Box><Text>R</Text></Box>}',
      '    />',
      '  );',
      '}',
    ].join('\n');
    const splitMsgs = await lintTuiText(validSplitPane);
    assert.deepEqual(splitMsgs, [], `SplitPane left/right render props should be clean, got: ${JSON.stringify(splitMsgs)}`);

    const uselessFrag = [
      "import React from 'react';",
      "import { Text } from 'ink';",
      'export function FragView() {',
      '  return <><Text>only child</Text></>;',
      '}',
    ].join('\n');
    const fragMsgs = await lintTuiText(uselessFrag);
    assert.ok(
      fragMsgs.some((m) => m.ruleId === 'react/jsx-no-useless-fragment' && m.severity === 2),
      `expected react/jsx-no-useless-fragment error, got: ${JSON.stringify(fragMsgs)}`,
    );
  });

  test('Architectural no-restricted-imports boundaries enforce exemptions without weakening sibling bans', async () => {
    // Normal view: all four restricted imports rejected
    const badView = [
      "import { useInput, useWindowSize } from 'ink';",
      "import { rename } from 'node:fs/promises';",
      "import { execSync } from 'node:child_process';",
      'export const refs = [useInput, useWindowSize, rename, execSync];',
    ].join('\n');
    const viewMsgs = await lintTuiText(badView);
    const restricted = viewMsgs.filter((m) => m.ruleId === 'no-restricted-imports' && m.severity === 2);
    assert.ok(restricted.length >= 4, `expected >= 4 no-restricted-imports errors, got ${restricted.length}: ${JSON.stringify(restricted)}`);

    // host/atomic-write.ts: allowed to import rename, STILL forbidden from ink useInput/useWindowSize & execSync
    const atomicAllowed = "import { rename } from 'node:fs/promises';\nexport const r = rename;\n";
    assert.deepEqual(
      await lintTuiText(atomicAllowed, 'packages/studyhub-tui/src/host/atomic-write.ts'),
      [],
      'host/atomic-write.ts must be allowed to import rename',
    );
    const atomicBad = "import { useInput } from 'ink';\nexport const u = useInput;\n";
    assert.ok(
      (await lintTuiText(atomicBad, 'packages/studyhub-tui/src/host/atomic-write.ts')).some(
        (m) => m.ruleId === 'no-restricted-imports',
      ),
      'host/atomic-write.ts must still forbid raw ink useInput',
    );

    // input/hooks.ts: allowed to import useInput, STILL forbidden from rename & useWindowSize
    const hooksBad = "import { rename } from 'node:fs/promises';\nexport const r = rename;\n";
    assert.ok(
      (await lintTuiText(hooksBad, 'packages/studyhub-tui/src/input/hooks.ts')).some(
        (m) => m.ruleId === 'no-restricted-imports',
      ),
      'input/hooks.ts must still forbid raw fs rename',
    );

    // components/resize.ts: allowed to import useWindowSize, STILL forbidden from useInput & rename
    const resizeBad = "import { rename } from 'node:fs/promises';\nexport const r = rename;\n";
    assert.ok(
      (await lintTuiText(resizeBad, 'packages/studyhub-tui/src/components/resize.ts')).some(
        (m) => m.ruleId === 'no-restricted-imports',
      ),
      'components/resize.ts must still forbid raw fs rename',
    );
  });

  test('package.json lint script and scripts/lint.mjs enforce zero-warning lint across all TUI targets', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(TUI_ROOT, 'package.json'), 'utf8'));
    assert.equal(
      pkg.scripts?.lint,
      'node scripts/lint.mjs',
      'packages/studyhub-tui/package.json scripts.lint must invoke cross-platform scripts/lint.mjs',
    );
    const { TUI_LINT_TARGETS } = await import('../scripts/lint.mjs');
    for (const dir of ['src', 'tests', 'scripts', 'bin']) {
      assert.ok(
        TUI_LINT_TARGETS.includes(`packages/studyhub-tui/${dir}`),
        `scripts/lint.mjs TUI_LINT_TARGETS must include packages/studyhub-tui/${dir}`,
      );
    }
  });

  test('all TUI sources, tests, scripts, and bin pass ESLint with 0 errors and 0 warnings', async () => {
    const results = await eslint.lintFiles([
      'packages/studyhub-tui/src',
      'packages/studyhub-tui/tests',
      'packages/studyhub-tui/scripts',
      'packages/studyhub-tui/bin',
    ]);
    const problems = [];
    for (const res of results) {
      for (const msg of res.messages) {
        const rel = path.relative(TUI_ROOT, res.filePath).replace(/\\/g, '/');
        problems.push(`${rel}:${msg.line}:${msg.column} [${msg.severity === 2 ? 'error' : 'warn'}] ${msg.ruleId}: ${msg.message}`);
      }
    }
    assert.deepEqual(
      problems,
      [],
      `Expected 0 ESLint errors and 0 warnings across StudyHub TUI, found ${problems.length}:\n${problems.slice(0, 40).join('\n')}`,
    );
  });
});
