import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseConcurrency, listTestFiles, mergeDurations, orderLongestFirst, parseTestArgs, readDurations } from '../scripts/qa/test-schedule.mjs';

/* How a full run is scheduled: the longest files start first (node's own runner sorts files by name, so scripts/qa/run-tests.mjs
   hands them over in its own order), the durations come from the last run. */

const runner = fileURLToPath(new URL('../scripts/qa/run-tests.mjs', import.meta.url));
const suite = fileURLToPath(new URL('./fixtures/runner-suite/', import.meta.url));

test('files nobody has timed start first, then the longest known file down to the shortest', () => {
  const keys = ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/c.test.mjs', 'tests/d.test.mjs', 'tests/e.test.mjs'];
  const durations = { 'tests/a.test.mjs': 5, 'tests/c.test.mjs': 90_000, 'tests/e.test.mjs': 2_000, 'tests/gone.test.mjs': 1e9 };
  assert.deepEqual(orderLongestFirst(keys, durations), ['tests/b.test.mjs', 'tests/d.test.mjs', 'tests/c.test.mjs', 'tests/e.test.mjs', 'tests/a.test.mjs']);
  assert.deepEqual(orderLongestFirst(keys, {}), keys, 'with nothing recorded the order stays alphabetical');
  assert.deepEqual(keys, ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/c.test.mjs', 'tests/d.test.mjs', 'tests/e.test.mjs'], 'the input is not reordered in place');
});

test('only a plain full run is scheduled by us; file arguments and unknown options keep node\'s own runner', () => {
  assert.deepEqual(parseTestArgs([]), { files: false, ordered: true });
  assert.deepEqual(parseTestArgs(['--test-concurrency=4', '--test-reporter=spec', '--test-reporter-destination', 'stdout']), { files: false, ordered: true });
  assert.deepEqual(parseTestArgs(['--test-name-pattern', 'groq', '--test-skip-pattern=slow']), { files: false, ordered: true });
  assert.deepEqual(parseTestArgs(['--test-timeout=5000']), { files: false, ordered: false });
  assert.deepEqual(parseTestArgs(['--test-shard=1/2']), { files: false, ordered: false });
  assert.deepEqual(parseTestArgs(['tests/groq.test.mjs']), { files: true, ordered: false });
  assert.deepEqual(parseTestArgs(['--test-name-pattern', 'x', 'tests/groq.test.mjs']), { files: true, ordered: false });
  assert.deepEqual(parseTestArgs(['--', 'tests/groq.test.mjs']), { files: true, ordered: false });
  assert.deepEqual(parseTestArgs(['--test-reporter', 'spec']), { files: false, ordered: true }, 'an option value is not a file');
});

test('there are never fewer than two workers nor more than twelve', () => {
  assert.equal(chooseConcurrency({ available: 32 }), 12);
  assert.equal(chooseConcurrency({ available: 8 }), 7);
  assert.equal(chooseConcurrency({ available: 2 }), 2);
});

test('recorded durations survive a missing or damaged file and are merged, not replaced', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-durations-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'cache', 'durations.json');
  assert.deepEqual(await readDurations(file), {});
  await mergeDurations(file, { 'tests/a.test.mjs': 10, 'tests/b.test.mjs': 20 });
  await mergeDurations(file, { 'tests/b.test.mjs': 30 });
  assert.deepEqual(await readDurations(file), { 'tests/a.test.mjs': 10, 'tests/b.test.mjs': 30 });
  await writeFile(file, '{ not json', 'utf8');
  assert.deepEqual(await readDurations(file), {});
  await writeFile(file, JSON.stringify({ 'tests/a.test.mjs': 'slow', 'tests/b.test.mjs': 7 }), 'utf8');
  assert.deepEqual(await readDurations(file), { 'tests/b.test.mjs': 7 }, 'only numbers count');
});

test('the test files of a folder are its *.test.mjs files, by name', async () => {
  const files = await listTestFiles(suite);
  assert.deepEqual(files.map(file => file.slice(-'a.test.mjs'.length)), ['a.test.mjs', 'b.test.mjs', 'c.test.mjs']);
  assert.ok(files.every(file => file.startsWith(suite.replace(/[\\/]$/, ''))), 'absolute paths');
});

/** Run the ordered runner over the fixture suite; resolves with what it printed and the order the files started in. */
async function runFixtures(dir, args = []) {
  const log = join(dir, 'started.log');
  await writeFile(log, '', 'utf8');
  const env = { ...process.env, STUDY_TEST_SUITE_DIR: suite, STUDY_TEST_DURATIONS_FILE: join(dir, 'durations.json'), STUDY_FIXTURE_LOG: log };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [runner, '--test-concurrency=1', ...args], { env, windowsHide: true });
  let out = '', err = '';
  child.stdout.on('data', part => { out += part; }); child.stderr.on('data', part => { err += part; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, out, err, started: (await readFile(log, 'utf8')).split('\n').filter(Boolean) };
}

test('the first run learns how long each file took and the next run starts the slowest first', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await runFixtures(dir);
  assert.equal(first.code, 0, first.err + first.out);
  assert.deepEqual(first.started, ['a', 'b', 'c'], 'nothing is known yet: by name');
  assert.match(first.out, /# pass 3/, 'node\'s usual TAP report and summary are still printed');
  const recorded = await readDurations(join(dir, 'durations.json'));
  assert.deepEqual(Object.keys(recorded).sort(), ['a', 'b', 'c'].map(name => `tests/fixtures/runner-suite/${name}.test.mjs`));
  assert.ok(recorded['tests/fixtures/runner-suite/b.test.mjs'] > recorded['tests/fixtures/runner-suite/a.test.mjs']);
  const second = await runFixtures(dir);
  assert.equal(second.code, 0, second.err + second.out);
  assert.deepEqual(second.started, ['b', 'c', 'a'], 'slowest first');
});
