import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasGlobalSideEffects } from '../scripts/qa/test-batch.mjs';
import { readDurations, repoRoot } from '../scripts/qa/test-schedule.mjs';

const runner = fileURLToPath(new URL('../scripts/qa/run-tests.mjs', import.meta.url));
const keyOf = file => relative(repoRoot, file).split(sep).join('/');

async function makeTempSuite(t) {
  const dir = await mkdtemp(join(tmpdir(), 'study-batch-suite-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function runSuite(suite, { args = [], env = {} } = {}) {
  const durations = join(suite, 'durations.json');
  const log = join(suite, 'pids.log');
  const childEnv = {
    ...process.env,
    STUDY_TEST_SUITE_DIR: suite,
    STUDY_TEST_DURATIONS_FILE: durations,
    STUDY_TEST_WEIGHTS_FILE: join(suite, 'weights.json'),
    STUDY_TEST_SLOW_FILE: join(suite, 'slow.json'),
    STUDY_FIXTURE_LOG: log,
    ...env,
  };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [runner, '--test-concurrency=1', ...args], {
    env: childEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, out, err, durations, log }));
  });
}

test('hasGlobalSideEffects distinguishes side-effect-free files from env, hook, global, clock, and helper mutators', async t => {
  const dir = await makeTempSuite(t);
  const pureHelper = join(dir, 'pure-helper.mjs');
  const dirtyHelper = join(dir, 'dirty-helper.mjs');
  await writeFile(pureHelper, "export const flag = () => process.env.SOME_FLAG === '1' && typeof document !== 'undefined';\n", 'utf8');
  await writeFile(dirtyHelper, "export function touch() { process.env.MUTATED_BY_HELPER = '1'; }\n", 'utf8');

  const cleanFile = join(dir, 'clean.test.mjs');
  await writeFile(cleanFile, [
    "import test from 'node:test';",
    "import { flag } from './pure-helper.mjs';",
    "const snippet = `export { Panel } from './ui/Panel.jsx';`;",
    "test('pure', () => { flag(); return snippet; });",
  ].join('\n'), 'utf8');
  assert.equal(hasGlobalSideEffects(cleanFile, { suiteRoot: dir }), false);

  const cases = [
    ['env-assign.test.mjs', "import test from 'node:test';\nprocess.env.FOO = '1';\ntest('x', () => {});\n"],
    ['window-nullish.test.mjs', "import test from 'node:test';\nwindow ??= {};\ntest('x', () => {});\n"],
    ['root-hook.test.mjs', "import test, { beforeEach } from 'node:test';\nbeforeEach(() => {});\ntest('x', () => {});\n"],
    ['top-clock.test.mjs', "import test from 'node:test';\nconst now = Date.now();\ntest('x', () => now);\n"],
    ['via-helper.test.mjs', "import test from 'node:test';\nimport { touch } from './dirty-helper.mjs';\ntest('x', () => touch());\n"],
  ];
  for (const [name, source] of cases) {
    const file = join(dir, name);
    await writeFile(file, source, 'utf8');
    assert.equal(hasGlobalSideEffects(file, { suiteRoot: dir }), true, name);
  }
});

test('clean files share one batch worker process while env-mutating files stay isolated and durations are recorded per real file', async t => {
  const suite = await makeTempSuite(t);
  for (const name of ['clean-a', 'clean-b', 'clean-c']) {
    await writeFile(join(suite, `${name}.test.mjs`), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(process.env.STUDY_FIXTURE_LOG, \`${name}:\${process.pid}\\n\`);`,
      `test('${name}', async () => {`,
      "  assert.equal(process.env.STUDY_DIRTY_ENV, undefined);",
      '  await new Promise(resolve => setTimeout(resolve, 15));',
      '});',
    ].join('\n'), 'utf8');
  }
  await writeFile(join(suite, 'dirty-env.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { appendFileSync } from 'node:fs';",
    "process.env.STUDY_DIRTY_ENV = 'isolated';",
    "appendFileSync(process.env.STUDY_FIXTURE_LOG, `dirty:${process.pid}\\n`);",
    "test('dirty-env', () => { assert.equal(process.env.STUDY_DIRTY_ENV, 'isolated'); });",
  ].join('\n'), 'utf8');

  const { code, out, err, durations, log } = await runSuite(suite, {
    args: ['--test-reporter=tap'],
    env: { STUDY_TEST_BATCH: '1', STUDY_TEST_BATCH_SIZE: '10' },
  });
  assert.equal(code, 0, err + out);
  assert.match(out, /# pass 4/);

  const pids = Object.fromEntries(
    (await readFile(log, 'utf8')).trim().split('\n').map(line => line.split(':')),
  );
  assert.equal(pids['clean-a'], pids['clean-b'], 'clean-a and clean-b share one worker process');
  assert.equal(pids['clean-b'], pids['clean-c'], 'clean-b and clean-c share one worker process');
  assert.notEqual(pids.dirty, pids['clean-a'], 'dirty-env runs in its own isolated process');

  const recorded = await readDurations(durations);
  const expectedKeys = ['clean-a', 'clean-b', 'clean-c', 'dirty-env'].map(name => keyOf(join(suite, `${name}.test.mjs`))).sort();
  assert.deepEqual(Object.keys(recorded).sort(), expectedKeys, 'durations.json records real files, never synthetic batch containers');
});

test('a test timeout inside a batch names the real test file rather than the batch container', async t => {
  const suite = await makeTempSuite(t);
  await writeFile(join(suite, 'fast-ok.test.mjs'), "import test from 'node:test';\ntest('passes quickly', () => {});\n", 'utf8');
  await writeFile(join(suite, 'stalls.test.mjs'), [
    "import test from 'node:test';",
    "test('stalls inside batch', () => new Promise(resolve => setTimeout(resolve, 60_000)));",
  ].join('\n'), 'utf8');

  const { code, out, err } = await runSuite(suite, {
    args: ['--test-timeout=400', '--test-reporter=spec'],
    env: { STUDY_TEST_BATCH: '1', STUDY_TEST_BATCH_SIZE: '10', STUDY_TEST_FILE_TIMEOUT_MS: '3000' },
  });
  assert.equal(code, 1, err + out);
  assert.match(err, /stalls\.test\.mjs: TEST TIMEOUT: "stalls inside batch" was still running after 400 ms/);
  assert.match(err, /Timed out \(1\):\n {2}[^\n]*stalls\.test\.mjs: "stalls inside batch"/);
  assert.doesNotMatch(err, /batch-\d+\.test\.mjs/);
});

test('CI verification workflows cancel superseded main runs while release workflow never cancels in-flight releases', async () => {
  const verify = await readFile(join(repoRoot, '.github', 'workflows', 'verify.yml'), 'utf8');
  const smoke = await readFile(join(repoRoot, '.github', 'workflows', 'browser-smoke.yml'), 'utf8');
  const release = await readFile(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(verify, /cancel-in-progress:\s*true\b/);
  assert.match(smoke, /cancel-in-progress:\s*true\b/);
  assert.match(release, /cancel-in-progress:\s*false\b/);
});
