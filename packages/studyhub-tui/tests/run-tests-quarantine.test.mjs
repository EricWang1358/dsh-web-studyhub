// Unit & CLI integration tests for TUI test runner quarantine/isolation markers:
// node --test tests/run-tests-quarantine.test.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  classifyTestFiles,
  parseQuarantineMarker,
  parseRunnerArgs,
  quarantineWarningAnnotations,
  selectTestPlan,
} from '../scripts/run-tests.mjs';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const runnerScript = resolve(pkgRoot, 'scripts', 'run-tests.mjs');

const tempDirs = [];
async function makeFixtureDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `studyhub-tui-quarantine-${label}-`));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function runRunnerCli(args, envOverrides = {}) {
  // An override of `undefined` removes the variable (an empty string would still count as "set").
  const env = { ...process.env, ...envOverrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  try {
    const res = await execFileAsync(process.execPath, [runnerScript, ...args], {
      cwd: pkgRoot,
      env,
      timeout: 15_000,
    });
    return { code: 0, stdout: res.stdout, stderr: res.stderr };
  } catch (err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    };
  }
}

describe('run-tests.mjs quarantine marker parser & CLI argument validation', () => {
  test('parses valid @quarantine and @flaky header markers with reasons', () => {
    const q = parseQuarantineMarker(
      '#!/usr/bin/env node\n// Suite summary\n// @quarantine: host PTY resize race (#9999)\nimport test from "node:test";\n',
    );
    assert.equal(q.quarantined, true);
    assert.equal(q.malformed, false);
    assert.equal(q.tag, 'quarantine');
    assert.equal(q.reason, 'host PTY resize race (#9999)');
    assert.equal(q.line, 3);

    const f = parseQuarantineMarker(
      '// @flaky Windows ConPTY focus drop (#8888)\nimport assert from "node:assert/strict";\n',
    );
    assert.equal(f.quarantined, true);
    assert.equal(f.malformed, false);
    assert.equal(f.tag, 'flaky');
    assert.equal(f.reason, 'Windows ConPTY focus drop (#8888)');
    assert.equal(f.line, 1);
  });

  test('rejects bare/malformed @quarantine and @flaky markers missing a reason', () => {
    for (const sample of [
      '// @quarantine\nimport test from "node:test";\n',
      '// @quarantine:   \nimport test from "node:test";\n',
      '// @flaky:\nimport test from "node:test";\n',
      '// @flaky   \nimport test from "node:test";\n',
    ]) {
      const parsed = parseQuarantineMarker(sample);
      assert.equal(parsed.quarantined, false);
      assert.equal(parsed.malformed, true);
      assert.match(parsed.error, /non-empty reason/i);
    }
  });

  test('ignores @quarantine or @flaky mentions inside code or string literals below the header', () => {
    const code = [
      '// Normal test file header',
      'import test from "node:test";',
      '// @quarantine: comment inside code body must NOT quarantine the file',
      'const example = "// @flaky: fixture string";',
    ].join('\n');
    const parsed = parseQuarantineMarker(code);
    assert.equal(parsed.quarantined, false);
    assert.equal(parsed.malformed, false);
  });

  test('validates flag combinations and shard bounds', () => {
    assert.equal(parseRunnerArgs(['--shard=1/3', '--list'], {}).error, null);
    assert.equal(parseRunnerArgs(['--quarantine', '--e2e', '--timing'], {}).error, null);
    assert.equal(parseRunnerArgs(['--include-quarantined', '--shard=2/3'], {}).error, null);

    assert.match(parseRunnerArgs(['--shard=0/3'], {}).error, /--shard/);
    assert.match(parseRunnerArgs(['--shard=4/3'], {}).error, /--shard/);
    assert.match(parseRunnerArgs(['--unit', '--e2e'], {}).error, /--unit and --e2e/);
    assert.match(
      parseRunnerArgs(['--quarantine', '--include-quarantined'], {}).error,
      /--quarantine and --include-quarantined/,
    );
  });
});

describe('run-tests.mjs classification, sharding & CLI isolation behavior', () => {
  test('isolates quarantined suites by default, runs them via --quarantine / --include-quarantined, and preserves sharding', async () => {
    const dir = await makeFixtureDir('isolation');
    const e2eMarkerToken = ['create', 'Virtual', 'Tty'].join('');
    await Promise.all([
      writeFile(
        join(dir, 'alpha-unit.test.mjs'),
        'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("alpha", () => assert.equal(1 + 1, 2));\n',
        'utf8',
      ),
      writeFile(
        join(dir, 'beta-e2e.test.mjs'),
        `// Uses ${e2eMarkerToken} marker\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\nconst marker = "${e2eMarkerToken}";\ntest("beta", () => assert.equal(marker, "${e2eMarkerToken}"));\n`,
        'utf8',
      ),
      writeFile(
        join(dir, 'gamma-quarantined-e2e.test.mjs'),
        `// @quarantine: host PTY timing flake (#12345)\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\nconst marker = "${e2eMarkerToken}";\ntest("gamma", () => assert.equal(marker, "${e2eMarkerToken}"));\n`,
        'utf8',
      ),
      writeFile(
        join(dir, 'delta-flaky-unit.test.mjs'),
        '// @flaky: external timer drift (#12346)\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("delta", () => assert.equal(2 * 2, 4));\n',
        'utf8',
      ),
    ]);

    const classified = await classifyTestFiles(dir, { baseRoot: dir });
    assert.equal(classified.malformedMarkers.length, 0);
    assert.deepEqual(classified.activeFiles.map((f) => f.name), ['alpha-unit.test.mjs', 'beta-e2e.test.mjs']);
    assert.deepEqual(
      classified.quarantinedFiles.map((f) => f.name),
      ['delta-flaky-unit.test.mjs', 'gamma-quarantined-e2e.test.mjs'],
    );

    const defaultPlan = selectTestPlan(classified, parseRunnerArgs([], {}));
    assert.deepEqual(defaultPlan.unitFiles.map((f) => f.name), ['alpha-unit.test.mjs']);
    assert.deepEqual(defaultPlan.e2eFiles.map((f) => f.name), ['beta-e2e.test.mjs']);
    assert.equal(defaultPlan.quarantineFiles.length, 0);
    assert.equal(defaultPlan.skippedQuarantined.length, 2);

    // Real CLI --list checks
    const defaultList = await runRunnerCli(['--list'], { STUDYHUB_TESTS_DIR: dir });
    assert.equal(defaultList.code, 0, defaultList.stderr);
    const defaultLines = defaultList.stdout.trim().split('\n').filter(Boolean);
    assert.equal(defaultLines.length, 2);
    assert.ok(defaultLines.some((l) => l.endsWith('alpha-unit.test.mjs')));
    assert.ok(defaultLines.some((l) => l.endsWith('beta-e2e.test.mjs')));
    assert.ok(!defaultLines.some((l) => l.endsWith('gamma-quarantined-e2e.test.mjs')));

    const quarantineOnlyList = await runRunnerCli(['--quarantine', '--list'], { STUDYHUB_TESTS_DIR: dir });
    assert.equal(quarantineOnlyList.code, 0, quarantineOnlyList.stderr);
    const qLines = quarantineOnlyList.stdout.trim().split('\n').filter(Boolean);
    assert.equal(qLines.length, 2);
    assert.ok(qLines.some((l) => l.endsWith('gamma-quarantined-e2e.test.mjs')));
    assert.ok(qLines.some((l) => l.endsWith('delta-flaky-unit.test.mjs')));

    const quarantineE2eList = await runRunnerCli(['--quarantine', '--e2e', '--list'], { STUDYHUB_TESTS_DIR: dir });
    assert.equal(quarantineE2eList.code, 0, quarantineE2eList.stderr);
    const qE2eLines = quarantineE2eList.stdout.trim().split('\n').filter(Boolean);
    assert.equal(qE2eLines.length, 1);
    assert.ok(qE2eLines[0].endsWith('gamma-quarantined-e2e.test.mjs'));

    const includeList = await runRunnerCli(['--include-quarantined', '--list'], { STUDYHUB_TESTS_DIR: dir });
    assert.equal(includeList.code, 0, includeList.stderr);
    const incLines = includeList.stdout.trim().split('\n').filter(Boolean);
    assert.equal(incLines.length, 4);

    // Shards across default active files cover every active file exactly once without leaking quarantined suites
    const shard1 = await runRunnerCli(['--shard=1/2', '--list'], { STUDYHUB_TESTS_DIR: dir });
    const shard2 = await runRunnerCli(['--shard=2/2', '--list'], { STUDYHUB_TESTS_DIR: dir });
    assert.equal(shard1.code, 0);
    assert.equal(shard2.code, 0);
    const combined = [
      ...shard1.stdout.trim().split('\n').filter(Boolean),
      ...shard2.stdout.trim().split('\n').filter(Boolean),
    ];
    assert.equal(combined.length, 2);
    assert.equal(new Set(combined).size, 2);

    // Actual execution: default run isolates quarantined suites and logs them explicitly
    const defaultRun = await runRunnerCli(['--timing'], { STUDYHUB_TESTS_DIR: dir });
    assert.equal(defaultRun.code, 0, defaultRun.stderr);
    assert.match(defaultRun.stdout, /\[tier:quarantine\] Isolated 2 quarantined suite\(s\)/);
    assert.match(defaultRun.stdout, /host PTY timing flake \(#12345\)/);

    // Actual execution: --quarantine runs ONLY [tier:quarantine]
    const qRun = await runRunnerCli(['--quarantine', '--timing'], { STUDYHUB_TESTS_DIR: dir });
    assert.equal(qRun.code, 0, qRun.stderr);
    assert.match(qRun.stdout, /\[tier:quarantine\] Running 2 quarantined suite\(s\)/);
    assert.match(qRun.stdout, /quarantine:PASS\(2\)/);
    assert.doesNotMatch(qRun.stdout, /\[tier:unit\] Running/);
    assert.doesNotMatch(qRun.stdout, /\[tier:e2e\] Running/);
  });

  test('fails fast with exit code 2 when a test file contains a malformed bare quarantine marker', async () => {
    const dir = await makeFixtureDir('malformed');
    await writeFile(
      join(dir, 'broken-marker.test.mjs'),
      '// @quarantine:\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("x", () => assert.equal(1, 1));\n',
      'utf8',
    );

    const res = await runRunnerCli(['--list'], { STUDYHUB_TESTS_DIR: dir });
    assert.equal(res.code, 2, `expected exit code 2 for malformed marker, got ${res.code}`);
    assert.match(res.stderr, /Malformed @quarantine marker/);
    assert.match(res.stderr, /non-empty reason/i);
  });

  test('fails fast with exit code 2 on conflicting CLI flags', async () => {
    const dir = await makeFixtureDir('flags');
    const conflictA = await runRunnerCli(['--unit', '--e2e', '--list'], { STUDYHUB_TESTS_DIR: dir });
    assert.equal(conflictA.code, 2);
    assert.match(conflictA.stderr, /--unit and --e2e/);

    const conflictB = await runRunnerCli(['--quarantine', '--include-quarantined', '--list'], {
      STUDYHUB_TESTS_DIR: dir,
    });
    assert.equal(conflictB.code, 2);
    assert.match(conflictB.stderr, /--quarantine and --include-quarantined/);
  });
});

describe('run-tests.mjs GitHub Actions quarantine annotations', () => {
  const records = [
    { rel: 'tests/a-flaky.test.mjs', quarantine: { tag: 'flaky', reason: 'timer drift (#1)' } },
    { rel: 'tests/b-quarantined.test.mjs', quarantine: { tag: 'quarantine', reason: '100% PTY race\nsecond line' } },
  ];

  test('prints one ::warning:: per quarantined file naming it, with the reason escaped, only when GITHUB_ACTIONS=true', () => {
    const lines = quarantineWarningAnnotations(records, { GITHUB_ACTIONS: 'true' });
    assert.equal(lines.length, 2);
    for (const line of lines) assert.match(line, /^::warning title=Quarantined TUI test suite::/);
    assert.ok(lines[0].includes('tests/a-flaky.test.mjs'));
    assert.ok(lines[0].includes('@flaky: timer drift (#1)'));
    assert.ok(lines[1].includes('tests/b-quarantined.test.mjs'));
    assert.ok(lines[1].includes('100%25 PTY race%0Asecond line'), 'percent and newline are workflow-command escaped');
    for (const line of lines) assert.ok(!/[\r\n]/.test(line), 'each annotation stays on one line');

    assert.deepEqual(quarantineWarningAnnotations(records, {}), []);
    assert.deepEqual(quarantineWarningAnnotations(records, { GITHUB_ACTIONS: 'false' }), []);
    assert.deepEqual(quarantineWarningAnnotations([], { GITHUB_ACTIONS: 'true' }), []);
  });

  test('the runner prints the annotation for isolated and for run quarantined suites in GitHub Actions, and never locally', async () => {
    const dir = await makeFixtureDir('annotations');
    await Promise.all([
      writeFile(
        join(dir, 'ok-unit.test.mjs'),
        'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("ok", () => assert.equal(1, 1));\n',
        'utf8',
      ),
      writeFile(
        join(dir, 'parked.test.mjs'),
        '// @quarantine: parked for annotation test (#4242)\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("parked", () => assert.equal(1, 1));\n',
        'utf8',
      ),
    ]);

    const isolated = await runRunnerCli([], { STUDYHUB_TESTS_DIR: dir, GITHUB_ACTIONS: 'true' });
    assert.equal(isolated.code, 0, isolated.stderr);
    assert.match(isolated.stdout, /^::warning title=Quarantined TUI test suite::.*parked\.test\.mjs.*parked for annotation test \(#4242\)/m);

    const ran = await runRunnerCli(['--quarantine'], { STUDYHUB_TESTS_DIR: dir, GITHUB_ACTIONS: 'true' });
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^::warning title=Quarantined TUI test suite::.*parked\.test\.mjs/m);

    const local = await runRunnerCli([], { STUDYHUB_TESTS_DIR: dir, GITHUB_ACTIONS: '' });
    assert.equal(local.code, 0, local.stderr);
    assert.doesNotMatch(local.stdout, /::warning/);
    assert.match(local.stdout, /Isolated 1 quarantined suite/);

    const listed = await runRunnerCli(['--quarantine', '--list'], { STUDYHUB_TESTS_DIR: dir, GITHUB_ACTIONS: 'true' });
    assert.equal(listed.code, 0, listed.stderr);
    assert.doesNotMatch(listed.stdout, /::warning/, '--list output stays one path per line');
  });

  test('a failing quarantined suite makes --quarantine exit non-zero, while a default run still isolates it', async () => {
    const dir = await makeFixtureDir('failing');
    await Promise.all([
      writeFile(
        join(dir, 'ok-unit.test.mjs'),
        'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("ok", () => assert.equal(1, 1));\n',
        'utf8',
      ),
      writeFile(
        join(dir, 'broken.test.mjs'),
        '// @quarantine: deliberately failing fixture (#4243)\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("broken", () => assert.equal(1, 2));\n',
        'utf8',
      ),
    ]);
    // The nested `node --test` must not think it is a child of this test run.
    const env = { STUDYHUB_TESTS_DIR: dir, NODE_TEST_CONTEXT: undefined };

    const qRun = await runRunnerCli(['--quarantine'], env);
    assert.notEqual(qRun.code, 0, `a failing quarantined suite must fail --quarantine\n${qRun.stdout}`);
    assert.match(qRun.stdout, /quarantine:FAIL\(1\)/);

    const withAll = await runRunnerCli(['--include-quarantined'], env);
    assert.notEqual(withAll.code, 0, '--include-quarantined also surfaces the failure');
    assert.match(withAll.stdout, /quarantine:FAIL\(1\)/);

    const defaultRun = await runRunnerCli([], env);
    assert.equal(defaultRun.code, 0, `default runs isolate quarantined suites\n${defaultRun.stdout}`);
    assert.match(defaultRun.stdout, /Isolated 1 quarantined suite/);
  });
});
