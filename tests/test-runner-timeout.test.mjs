import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* A hung test fails the run quickly and by name instead of holding a CI machine until the job limit (scripts/qa/run-tests.mjs and
   scripts/qa/test-timeout.mjs); every reporter node --test takes is wired so that it prints and the run ends; a stopped run says which
   test files had started and not finished. */

const runner = fileURLToPath(new URL('../scripts/qa/run-tests.mjs', import.meta.url));
const testScript = fileURLToPath(new URL('../scripts/test.mjs', import.meta.url));
const hangSuite = fileURLToPath(new URL('./fixtures/runner-hang/', import.meta.url));
const passSuite = fileURLToPath(new URL('./fixtures/runner-suite/', import.meta.url));
const subtestSuite = fileURLToPath(new URL('./fixtures/runner-subtests/', import.meta.url));
const customReporter = fileURLToPath(new URL('./fixtures/runner-reporter.mjs', import.meta.url));

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'study-runner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Starts the runner over a fixture suite; `done` resolves with what it printed, its exit code and how long it took. */
function start(dir, { suite, args = [], env = {}, script = runner, ipc = false }) {
  const log = join(dir, 'fixture.log');
  const childEnv = { ...process.env, STUDY_TEST_SUITE_DIR: suite, STUDY_TEST_DURATIONS_FILE: join(dir, 'durations.json'), STUDY_FIXTURE_LOG: log, ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const began = Date.now();
  const child = spawn(process.execPath, [script, '--test-concurrency=1', ...args], { env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
  let out = '', err = '';
  child.stdout.on('data', part => { out += part; }); child.stderr.on('data', part => { err += part; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, out, err, ms: Date.now() - began }));
  });
  return { child, log, done };
}

async function waitForLine(file, text, ms = 20_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) {
    if ((await readFile(file, 'utf8').catch(() => '')).includes(text)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${file} never said "${text}"`);
}

test('a test that never settles fails at the per-test limit with its name and file; a file that never exits stops at the per-file limit', async t => {
  const dir = await tempDir(t);
  const { done } = start(dir, { suite: hangSuite, args: ['--test-timeout=1000', '--test-reporter=spec'], env: { STUDY_TEST_FILE_TIMEOUT_MS: '4000' } });
  const { code, out, err, ms } = await done;
  assert.equal(code, 1, err + out);
  assert.ok(ms < 30_000, `the run ended after ${ms} ms`);
  assert.match(err, /tests\/fixtures\/runner-hang\/hang\.test\.mjs: TEST TIMEOUT: "never settles" was still running after 1000 ms/);
  assert.match(err, /TEST FILE TIMEOUT: tests\/fixtures\/runner-hang\/stays-open\.test\.mjs was still running after 4000 ms and was stopped/);
  assert.match(err, /Timed out \(2\):\n {2}tests\/fixtures\/runner-hang\/hang\.test\.mjs: "never settles" was still running after 1000 ms[^\n]*\n {2}tests\/fixtures\/runner-hang\/stays-open\.test\.mjs: the whole file/);
  assert.match(out, /quick/, 'the other files still ran and were reported');
  assert.doesNotMatch(out + err, /never reached/, 'the rest of the hung file did not run');
});

test('the limit names the test that is over it, with the subtest running now; swapped or mocked timers do not trip it', async t => {
  const dir = await tempDir(t);
  const { done } = start(dir, { suite: subtestSuite, args: ['--test-timeout=1000', '--test-reporter=spec'], env: { STUDY_TEST_FILE_TIMEOUT_MS: '20000' } });
  const { code, out, err } = await done;
  assert.equal(code, 1, err + out);
  // Each subtest runs 700 ms; the parent's total crosses 1000 ms while "sub b" has run about 300 ms of it.
  assert.match(err, /slow-parent\.test\.mjs: TEST TIMEOUT: "slow parent" was still running after 1000 ms \(running now: "slow parent > sub b"\)/);
  assert.doesNotMatch(err, /fake-timers\.test\.mjs: TEST TIMEOUT/, 'a subtest started under a swapped or mocked setTimeout is timed with the real one');
  assert.match(err, /Timed out \(1\):\n {2}tests\/fixtures\/runner-subtests\/slow-parent\.test\.mjs: "slow parent"/);
  assert.match(out, /✔ runs under the swapped setTimeout/);
  assert.match(out, /✔ ticks the mocked clock/);
});

test('every reporter node --test takes prints its report and the run ends, piped or to a file', async t => {
  const dir = await tempDir(t);
  const cases = [
    ['spec', /✔ a .*\n[\s\S]*ℹ pass 3/],
    ['tap', /TAP version 13[\s\S]*# pass 3/],
    ['dot', /^\.\.\.\s*$/m],
    ['junit', /<testsuites>[\s\S]*<testcase name="b"/],
    [customReporter, /^custom reporter: 3 passed$/m],
  ];
  const runs = await Promise.all(cases.map(async ([reporter, expected], i) => {
    const { done } = start(dir, { suite: passSuite, args: [`--test-reporter=${reporter}`], env: { STUDY_TEST_DURATIONS_FILE: join(dir, `durations-${i}.json`) } });
    return { reporter, expected, ...(await done) };
  }));
  for (const { reporter, expected, code, out, err } of runs) {
    assert.equal(code, 0, `${reporter}: ${err}`);
    assert.match(out, expected, reporter);
  }
  // Two reporters at once, one of them into a file.
  const file = join(dir, 'report.xml');
  const both = await start(dir, { suite: passSuite, args: ['--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${file}`] }).done;
  assert.equal(both.code, 0, both.err);
  assert.match(both.out, /ℹ pass 3/);
  assert.match(await readFile(file, 'utf8'), /<testsuites>[\s\S]*<\/testsuites>/);
});

test('a run stopped by message prints the test files that had started and not finished (how scripts/test.mjs stops it)', async t => {
  const dir = await tempDir(t);
  const { child, log, done } = start(dir, { suite: hangSuite, args: ['--test-timeout=0'], env: { STUDY_TEST_FILE_TIMEOUT_MS: '0' }, ipc: true });
  await waitForLine(log, 'hang started');
  child.send({ stop: 'SIGTERM' });
  const { code, err, ms } = await done;
  assert.notEqual(code, 0);
  assert.match(err, /Test run stopped \(SIGTERM\)\.\nTest files that had started and not finished:\n {2}tests\/fixtures\/runner-hang\/hang\.test\.mjs/);
  assert.doesNotMatch(err, /stays-open/, 'a file that had not started is not listed');
  assert.ok(ms < 30_000);
});

test('a SIGTERM to the runner, or to scripts/test.mjs, prints the unfinished test files', { skip: process.platform === 'win32' && 'Windows has no SIGTERM between processes (kill() ends the process at once); the message path above is what scripts/test.mjs uses there' }, async t => {
  for (const script of [runner, testScript]) {
    const dir = await tempDir(t);
    const { child, log, done } = start(dir, { script, suite: hangSuite, args: ['--test-timeout=0'], env: { STUDY_TEST_FILE_TIMEOUT_MS: '0', STUDY_TEST_NO_LOCK: '1' } });
    await waitForLine(log, 'hang started');
    child.kill('SIGTERM');
    const { code, signal, err } = await done;
    assert.ok(code !== 0 || signal, script);
    assert.match(err, /Test run stopped \(SIGTERM\)\.\nTest files that had started and not finished:\n {2}tests\/fixtures\/runner-hang\/hang\.test\.mjs/, script);
  }
});
