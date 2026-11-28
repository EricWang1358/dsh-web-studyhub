// Unit & CLI integration tests for root test runner quarantine/isolation markers:
// node --test tests/run-tests-quarantine.test.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  classifyQuarantineFiles,
  parseQuarantineArgs,
  parseQuarantineMarker,
  parseTestArgs,
  quarantineWarningAnnotations,
  selectRootTestPlan,
} from '../scripts/qa/test-schedule.mjs';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const runnerScript = resolve(repoRoot, 'scripts', 'qa', 'run-tests.mjs');
const testEntryScript = resolve(repoRoot, 'scripts', 'test.mjs');

const tempDirs = [];
async function makeFixtureDir(label) {
  const dir = await mkdtemp(join(tmpdir(), `studyhub-root-quarantine-${label}-`));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function runCli(script, args, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  try {
    const res = await execFileAsync(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env,
      timeout: 20_000,
      windowsHide: true,
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

describe('root test runner quarantine marker parser & CLI flag validation', () => {
  test('parses valid @quarantine and @flaky header markers with reasons', () => {
    const q = parseQuarantineMarker(
      '#!/usr/bin/env node\n// Suite summary\n// @quarantine: host Chromium IPC stall (#1763)\nimport test from "node:test";\n',
    );
    assert.equal(q.quarantined, true);
    assert.equal(q.malformed, false);
    assert.equal(q.tag, 'quarantine');
    assert.equal(q.reason, 'host Chromium IPC stall (#1763)');
    assert.equal(q.line, 3);

    const f = parseQuarantineMarker(
      '// @flaky Windows timer quantization (#1763)\nimport assert from "node:assert/strict";\n',
    );
    assert.equal(f.quarantined, true);
    assert.equal(f.malformed, false);
    assert.equal(f.tag, 'flaky');
    assert.equal(f.reason, 'Windows timer quantization (#1763)');
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
      '// Normal header comment',
      'import test from "node:test";',
      '// @quarantine: comment inside code body must NOT quarantine the file',
      'const fixture = "// @flaky: string literal";',
    ].join('\n');
    const parsed = parseQuarantineMarker(code);
    assert.equal(parsed.quarantined, false);
    assert.equal(parsed.malformed, false);
  });

  test('accepts --quarantine and --include-quarantined as ordered flags and rejects conflicts', () => {
    assert.deepEqual(parseTestArgs(['--quarantine']), { files: false, ordered: true });
    assert.deepEqual(parseTestArgs(['--include-quarantined', '--shard=1/4', '--list']), { files: false, ordered: true });
    assert.equal(parseQuarantineArgs(['--quarantine']).error, null);
    assert.equal(parseQuarantineArgs(['--include-quarantined']).error, null);
    assert.match(
      parseQuarantineArgs(['--quarantine', '--include-quarantined']).error,
      /--quarantine and --include-quarantined/,
    );
  });
});

describe('root test runner quarantine isolation, concurrency=1, sharding, and CI annotations', () => {
  test('isolates quarantined suites by default, runs them isolated at concurrency=1 via --quarantine / --include-quarantined, and preserves sharding & --fast', async () => {
    const dir = await makeFixtureDir('isolation');
    const logFile = join(dir, 'concurrency.log');
    const slowFile = join(dir, 'slow-tests.json');
    const weightsFile = join(dir, 'weights.json');
    const durationsFile = join(dir, 'durations.json');
    const keyOf = (file) => file.replace(/\\/g, '/').split('/').slice(-1)[0];

    await Promise.all([
      writeFile(logFile, '', 'utf8'),
      writeFile(weightsFile, '{}', 'utf8'),
      writeFile(
        join(dir, 'alpha-active.test.mjs'),
        'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("alpha", () => assert.equal(1 + 1, 2));\n',
        'utf8',
      ),
      writeFile(
        join(dir, 'beta-active.test.mjs'),
        'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("beta", () => assert.equal(2 + 2, 4));\n',
        'utf8',
      ),
      writeFile(
        join(dir, 'gamma-quarantined.test.mjs'),
        [
          '// @quarantine: host GPU stall (#1763)',
          'import assert from "node:assert/strict";',
          'import { appendFileSync } from "node:fs";',
          'import { test } from "node:test";',
          `test("gamma", async () => {`,
          `  appendFileSync(${JSON.stringify(logFile)}, "gamma:start\\n");`,
          '  await new Promise(r => setTimeout(r, 40));',
          `  appendFileSync(${JSON.stringify(logFile)}, "gamma:end\\n");`,
          '  assert.equal(3 * 3, 9);',
          '});',
        ].join('\n'),
        'utf8',
      ),
      writeFile(
        join(dir, 'delta-flaky.test.mjs'),
        [
          '// @flaky: OS timer drift (#1763)',
          'import assert from "node:assert/strict";',
          'import { appendFileSync } from "node:fs";',
          'import { test } from "node:test";',
          `test("delta", async () => {`,
          `  appendFileSync(${JSON.stringify(logFile)}, "delta:start\\n");`,
          '  await new Promise(r => setTimeout(r, 40));',
          `  appendFileSync(${JSON.stringify(logFile)}, "delta:end\\n");`,
          '  assert.equal(4 * 4, 16);',
          '});',
        ].join('\n'),
        'utf8',
      ),
    ]);

    const files = [
      join(dir, 'alpha-active.test.mjs'),
      join(dir, 'beta-active.test.mjs'),
      join(dir, 'delta-flaky.test.mjs'),
      join(dir, 'gamma-quarantined.test.mjs'),
    ];
    const classified = await classifyQuarantineFiles(files, { keyOf });
    assert.equal(classified.malformedMarkers.length, 0);
    assert.deepEqual(classified.activeFiles.map((f) => f.key), ['alpha-active.test.mjs', 'beta-active.test.mjs']);
    assert.deepEqual(classified.quarantinedFiles.map((f) => f.key), ['delta-flaky.test.mjs', 'gamma-quarantined.test.mjs']);

    const defaultPlan = selectRootTestPlan({
      activeKeys: classified.activeFiles.map((f) => f.key),
      quarantinedFiles: classified.quarantinedFiles,
      weights: {},
      shard: null,
    });
    assert.deepEqual(defaultPlan.activeKeys, ['alpha-active.test.mjs', 'beta-active.test.mjs']);
    assert.deepEqual(defaultPlan.quarantinedKeys, []);
    assert.equal(defaultPlan.skippedQuarantined.length, 2);

    const env = {
      STUDY_TEST_SUITE_DIR: dir,
      STUDY_TEST_WEIGHTS_FILE: weightsFile,
      STUDY_TEST_DURATIONS_FILE: durationsFile,
      STUDY_TEST_SLOW_FILE: slowFile,
      STUDY_TEST_BATCH: '0',
      NODE_TEST_CONTEXT: undefined,
      GITHUB_ACTIONS: '',
    };

    // --list checks: default, --quarantine, --include-quarantined, --shard
    const defaultList = await runCli(runnerScript, ['--list'], env);
    assert.equal(defaultList.code, 0, defaultList.stderr);
    const defaultLines = defaultList.stdout.trim().split('\n').filter(Boolean);
    assert.equal(defaultLines.length, 2);
    assert.ok(defaultLines.some((l) => l.endsWith('alpha-active.test.mjs')));
    assert.ok(defaultLines.some((l) => l.endsWith('beta-active.test.mjs')));
    assert.ok(!defaultLines.some((l) => l.endsWith('gamma-quarantined.test.mjs')));

    const qList = await runCli(runnerScript, ['--quarantine', '--list'], env);
    assert.equal(qList.code, 0, qList.stderr);
    const qLines = qList.stdout.trim().split('\n').filter(Boolean);
    assert.equal(qLines.length, 2);
    assert.ok(qLines.some((l) => l.endsWith('gamma-quarantined.test.mjs')));
    assert.ok(qLines.some((l) => l.endsWith('delta-flaky.test.mjs')));

    const incList = await runCli(runnerScript, ['--include-quarantined', '--list'], env);
    assert.equal(incList.code, 0, incList.stderr);
    assert.equal(incList.stdout.trim().split('\n').filter(Boolean).length, 4);

    // --fast respects slow-tests.json for both default and --quarantine
    const betaKey = defaultLines.find((l) => l.endsWith('beta-active.test.mjs'));
    const gammaKey = qLines.find((l) => l.endsWith('gamma-quarantined.test.mjs'));
    await writeFile(slowFile, JSON.stringify({ browser: [gammaKey], cli: [betaKey], ffmpeg: [] }), 'utf8');

    const fastList = await runCli(runnerScript, ['--fast', '--list'], env);
    assert.equal(fastList.code, 0, fastList.stderr);
    assert.equal(fastList.stdout.trim().split('\n').filter(Boolean).length, 1);

    const fastQList = await runCli(runnerScript, ['--fast', '--quarantine', '--list'], env);
    assert.equal(fastQList.code, 0, fastQList.stderr);
    const fastQLines = fastQList.stdout.trim().split('\n').filter(Boolean);
    assert.equal(fastQLines.length, 1);
    assert.ok(fastQLines[0].endsWith('delta-flaky.test.mjs'));

    // Reset slow list and verify sharding covers active suites exactly once without leaking quarantined files
    await writeFile(slowFile, JSON.stringify({ browser: [], cli: [], ffmpeg: [] }), 'utf8');
    const shard1 = await runCli(runnerScript, ['--shard=1/2', '--list'], env);
    const shard2 = await runCli(runnerScript, ['--shard=2/2', '--list'], env);
    assert.equal(shard1.code, 0);
    assert.equal(shard2.code, 0);
    const combined = [
      ...shard1.stdout.trim().split('\n').filter(Boolean),
      ...shard2.stdout.trim().split('\n').filter(Boolean),
    ];
    assert.equal(combined.length, 2);
    assert.equal(new Set(combined).size, 2);

    // Actual execution: default run isolates quarantined suites and logs explicitly
    const defaultRun = await runCli(runnerScript, ['--test-concurrency=4', '--test-reporter=tap'], env);
    assert.equal(defaultRun.code, 0, defaultRun.stderr);
    assert.match(defaultRun.stdout, /# pass 2/);
    assert.match(defaultRun.stderr, /\[quarantine\] Isolated 2 quarantined suite\(s\)/);
    assert.match(defaultRun.stderr, /host GPU stall \(#1763\)/);
    assert.equal((await readFile(logFile, 'utf8')).trim(), '', 'quarantined suites never ran in default mode');

    // Actual execution: --quarantine runs ONLY quarantined suites strictly serially (concurrency=1 even if --test-concurrency=4 is passed)
    const qRun = await runCli(runnerScript, ['--quarantine', '--test-concurrency=4', '--test-reporter=tap'], env);
    assert.equal(qRun.code, 0, qRun.stderr);
    assert.match(qRun.stdout, /# pass 2/);
    assert.match(qRun.stderr, /\[quarantine\] Running 2 quarantined suite\(s\) \(isolated, concurrency=1\)/);
    const events = (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(events.length, 4);
    assert.equal(events[0].split(':')[0], events[1].split(':')[0], 'first quarantined suite finishes before second starts');
    assert.equal(events[2].split(':')[0], events[3].split(':')[0], 'second quarantined suite runs alone');
  });

  test('fails fast with exit code 2 on malformed bare quarantine markers and conflicting CLI flags', async () => {
    const dir = await makeFixtureDir('errors');
    await writeFile(
      join(dir, 'broken-marker.test.mjs'),
      '// @quarantine:\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("x", () => assert.equal(1, 1));\n',
      'utf8',
    );
    const env = { STUDY_TEST_SUITE_DIR: dir, NODE_TEST_CONTEXT: undefined };

    const badMarker = await runCli(runnerScript, ['--list'], env);
    assert.equal(badMarker.code, 2, `expected exit 2 for malformed marker, got ${badMarker.code}`);
    assert.match(badMarker.stderr, /Malformed @quarantine marker/);
    assert.match(badMarker.stderr, /non-empty reason/i);

    const conflictRunner = await runCli(runnerScript, ['--quarantine', '--include-quarantined', '--list'], env);
    assert.equal(conflictRunner.code, 2);
    assert.match(conflictRunner.stderr, /--quarantine and --include-quarantined/);

    const conflictEntry = await runCli(testEntryScript, ['--quarantine', '--include-quarantined', '--list'], {
      ...env,
      STUDY_TEST_NO_LOCK: '1',
    });
    assert.equal(conflictEntry.code, 2);
    assert.match(conflictEntry.stderr, /--quarantine and --include-quarantined/);
  });

  test('handles empty --quarantine selection cleanly and fails non-zero when a quarantined suite fails', async () => {
    const dir = await makeFixtureDir('failing');
    await writeFile(
      join(dir, 'ok.test.mjs'),
      'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("ok", () => assert.equal(1, 1));\n',
      'utf8',
    );
    const env = {
      STUDY_TEST_SUITE_DIR: dir,
      STUDY_TEST_DURATIONS_FILE: join(dir, 'durations.json'),
      STUDY_TEST_BATCH: '0',
      NODE_TEST_CONTEXT: undefined,
      GITHUB_ACTIONS: '',
    };

    const emptyList = await runCli(runnerScript, ['--quarantine', '--list'], env);
    assert.equal(emptyList.code, 0, emptyList.stderr);
    assert.equal(emptyList.stdout.trim(), '');

    const emptyRun = await runCli(runnerScript, ['--quarantine'], env);
    assert.equal(emptyRun.code, 0, emptyRun.stderr);
    assert.match(emptyRun.stderr, /\[quarantine\] No quarantined suites matched\./);

    await writeFile(
      join(dir, 'broken.test.mjs'),
      '// @quarantine: deliberate failing fixture (#1763)\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("broken", () => assert.equal(1, 2));\n',
      'utf8',
    );

    const qFail = await runCli(runnerScript, ['--quarantine', '--test-reporter=tap'], env);
    assert.notEqual(qFail.code, 0, 'failing quarantined suite must fail --quarantine');

    const incFail = await runCli(runnerScript, ['--include-quarantined', '--test-reporter=tap'], env);
    assert.notEqual(incFail.code, 0, 'failing quarantined suite must fail --include-quarantined');

    const defaultPass = await runCli(runnerScript, ['--test-reporter=tap'], env);
    assert.equal(defaultPass.code, 0, defaultPass.stderr);
    assert.match(defaultPass.stderr, /\[quarantine\] Isolated 1 quarantined suite\(s\)/);
  });

  test('emits GitHub Actions ::warning:: annotations only when GITHUB_ACTIONS=true and never on --list', async () => {
    const records = [
      { key: 'tests/a.test.mjs', quarantine: { tag: 'flaky', reason: 'timer drift (#1)' } },
      { key: 'tests/b.test.mjs', quarantine: { tag: 'quarantine', reason: '100% stall\nline2' } },
    ];
    const lines = quarantineWarningAnnotations(records, { GITHUB_ACTIONS: 'true' });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^::warning title=Quarantined test suite::tests\/a\.test\.mjs/);
    assert.ok(lines[1].includes('100%25 stall%0Aline2'));
    assert.deepEqual(quarantineWarningAnnotations(records, {}), []);

    const dir = await makeFixtureDir('annotations');
    await Promise.all([
      writeFile(
        join(dir, 'ok.test.mjs'),
        'import assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("ok", () => assert.equal(1, 1));\n',
        'utf8',
      ),
      writeFile(
        join(dir, 'parked.test.mjs'),
        '// @quarantine: parked annotation check (#1763)\nimport assert from "node:assert/strict";\nimport { test } from "node:test";\ntest("parked", () => assert.equal(1, 1));\n',
        'utf8',
      ),
    ]);
    const baseEnv = {
      STUDY_TEST_SUITE_DIR: dir,
      STUDY_TEST_DURATIONS_FILE: join(dir, 'durations.json'),
      STUDY_TEST_BATCH: '0',
      NODE_TEST_CONTEXT: undefined,
    };

    const ghaIsolated = await runCli(runnerScript, ['--test-reporter=tap'], { ...baseEnv, GITHUB_ACTIONS: 'true' });
    assert.equal(ghaIsolated.code, 0, ghaIsolated.stderr);
    assert.match(ghaIsolated.stdout, /^::warning title=Quarantined test suite::.*parked\.test\.mjs.*parked annotation check \(#1763\)/m);

    const ghaList = await runCli(runnerScript, ['--quarantine', '--list'], { ...baseEnv, GITHUB_ACTIONS: 'true' });
    assert.equal(ghaList.code, 0, ghaList.stderr);
    assert.doesNotMatch(ghaList.stdout, /::warning/);
  });
});
