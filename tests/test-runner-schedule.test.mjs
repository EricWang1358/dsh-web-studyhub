import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { chooseConcurrency, listTestFiles, mergeDurations, orderLongestFirst, parseTestArgs, readDurations, readSlowList } from '../scripts/qa/test-schedule.mjs';

/* How a full run is scheduled: the longest files start first (node's own runner sorts files by name, so scripts/qa/run-tests.mjs
   hands them over in its own order), the durations come from the last run, and the fast tier leaves out tests/slow-tests.json. */

const runner = fileURLToPath(new URL('../scripts/qa/run-tests.mjs', import.meta.url));
const suite = fileURLToPath(new URL('./fixtures/runner-suite/', import.meta.url));

test('a timing file finishes alone and every success, failure and skip has one number in the combined report', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-quiet-phase-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const quiet = join(dir, 'quiet.test.mjs'), regular = join(dir, 'regular.test.mjs');
  const marker = JSON.stringify(join(dir, 'quiet.finished'));
  await writeFile(quiet, `import test from 'node:test'; import {writeFileSync} from 'node:fs';
    test('frame measurement', async () => { await new Promise(r => setTimeout(r, 50)); writeFileSync(${marker}, 'done'); });`);
  await writeFile(regular, `import test from 'node:test'; import {readFileSync} from 'node:fs'; import assert from 'node:assert/strict';
    test('after measurement', () => assert.equal(readFileSync(${marker}, 'utf8'), 'done'));
    test.skip('platform-specific', () => {}); test('deliberate failure', () => assert.fail('checked'));`);
  const driver = join(dir, 'driver.mjs');
  const helper = JSON.stringify(new URL('../scripts/qa/test-phases.mjs', import.meta.url).href);
  await writeFile(driver, `import { runWithTimingFiles } from ${helper};
    const records = []; const files = ${JSON.stringify([regular, quiet])};
    for await (const e of runWithTimingFiles({files, concurrency: 2}, [files[1]])) {
      if (['test:pass','test:fail','test:plan','test:summary'].includes(e.type)) records.push(e);
    }
    console.log(JSON.stringify(records));`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(process.execPath, [driver], { env, windowsHide: true });
  const events = JSON.parse(stdout);
  const results = events.filter(e => ['test:pass', 'test:fail'].includes(e.type) && e.data.nesting === 0);
  assert.deepEqual(results.map(e => [e.data.name, e.data.testNumber]), [
    ['frame measurement', 1], ['after measurement', 2], ['platform-specific', 3], ['deliberate failure', 4],
  ]);
  assert.deepEqual(events.filter(e => e.type === 'test:plan' && e.data.nesting === 0).map(e => e.data.count), [4]);
  const summaries = events.filter(e => e.type === 'test:summary' && !e.data.file);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].data.success, false);
  const { tests, passed, failed, skipped } = summaries[0].data.counts;
  assert.deepEqual({ tests, passed, failed, skipped }, { tests: 4, passed: 2, failed: 1, skipped: 1 });
});

test('relative ESM requests share native resolutions only for the same canonical library module', async () => {
  const { cacheLocalImports } = await import('../scripts/qa/test-preload.mjs');
  const sibling = new URL('../lib/host.js', import.meta.url).href;
  const resolveImport = cacheLocalImports(url => url === sibling ? Buffer.alloc(0) : undefined);
  const from = name => ({ parentURL: new URL(name, import.meta.url).href, conditions: ['node', 'import'] });
  let calls = 0;
  const delegate = (name, context) => {
    calls++;
    return { url: new URL(name, context.parentURL).href, format: 'module' };
  };
  const direct = resolveImport('../lib/service.js', from('./probe.mjs'), delegate);
  const indirect = resolveImport('./service.js', from('../lib/host.js'), delegate);
  assert.equal(indirect.url, direct.url);
  assert.equal(calls, 1);
  assert.equal(resolveImport('../lib/host.js', from('./probe.mjs'), delegate).url, sibling);
  assert.equal(calls, 1, 'a verified regular sibling uses the same directory format');
  for (let i = 0; i < 2; i++) {
    resolveImport('./fixture.js', from('./probe.mjs'), delegate);
    resolveImport('../lib/service.js', { ...from('./probe.mjs'), importAttributes: { type: 'json' } }, delegate);
  }
  assert.equal(calls, 5);
  const redirected = () => { calls++; return { ...direct, url: direct.url + '?loader-alias' }; };
  resolveImport('../lib/other.js', from('./probe.mjs'), redirected);
  resolveImport('../lib/other.js', from('./second.mjs'), redirected);
  assert.equal(calls, 7);
});

test('a browser test that skips a failed launch still fails the required Chromium run', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-missing-browser-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'browser.test.mjs');
  const helper = new URL('../scripts/qa/browser.mjs', import.meta.url).href;
  await writeFile(file, [
    "import test from 'node:test';",
    `import { launchChromium } from ${JSON.stringify(helper)};`,
    "test('browser launch', async t => {",
    `  try { await launchChromium({ executablePath: ${JSON.stringify(join(dir, 'missing-chromium'))} }); }`,
    "  catch (error) { t.skip(error.message); }",
    "});",
  ].join('\n'));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = required => promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', file], {
    env: { ...env, STUDY_QA_REQUIRE_BROWSER: required }, windowsHide: true,
  });
  const optional = await run('0');
  assert.match(optional.stdout, /# skipped 1/);
  await assert.rejects(run('1'), error => error.code === 1 && error.stdout.includes('missing-chromium'));
});

test('a Windows test worker reads the original source and falls back for edits, deletions and generated chunks', async t => {
  const { readTestSources, writeTestSources } = await import('../scripts/qa/test-source-cache.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'study-source-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'example.js');
  const chunk = join(dir, 'client.chunk.js');
  const file = join(dir, 'sources.bin');
  await writeFile(path, 'export default "甲";');
  await writeFile(chunk, 'export default 12;');
  // Windows TEMP may use an 8.3 name or a junction. Node's default ESM resolution hands load() the canonical URL.
  const url = pathToFileURL(await realpath(path)).href;
  writeTestSources(dir, file);
  const sourceFor = readTestSources(file);
  assert.deepEqual(sourceFor(url), Buffer.from('export default "甲";'));
  const requested = pathToFileURL(path).href;
  if (requested !== url) assert.equal(sourceFor(requested), undefined);
  assert.equal(sourceFor(pathToFileURL(await realpath(chunk)).href), undefined);
  assert.equal(sourceFor(url + '?revision=two'), undefined);
  await writeFile(path, 'export default "乙";');
  assert.equal(sourceFor(url), undefined);
  await rm(path);
  assert.equal(sourceFor(url), undefined);
});

test('two browser fixtures get independent copies of the test runner preview', async t => {
  const { buildPreview } = await import('../scripts/build.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'study-preview-fixtures-'));
  const digest = 'fixture-source-revision';
  const prepared = join(dir, digest);
  const previous = Object.fromEntries(['STUDY_SOURCE_TREE_DIGEST', 'STUDY_TEST_PREVIEW_DIR', 'STUDY_BUILD_CACHE'].map(key => [key, process.env[key]]));
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(prepared);
  await writeFile(join(prepared, 'app.js'), 'original application');
  await writeFile(join(prepared, 'app.css'), '.test { color: green }');
  Object.assign(process.env, { STUDY_SOURCE_TREE_DIGEST: digest, STUDY_TEST_PREVIEW_DIR: prepared, STUDY_BUILD_CACHE: '1' });
  await buildPreview({ outdir: join(dir, 'one') });
  await writeFile(join(dir, 'one', 'app.js'), 'fixture edit');
  await buildPreview({ outdir: join(dir, 'two') });
  assert.equal(await readFile(join(dir, 'two', 'app.js'), 'utf8'), 'original application');
  assert.equal(await readFile(join(dir, 'two', 'app.css'), 'utf8'), '.test { color: green }');
});

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
  assert.deepEqual(parseTestArgs(['--test-timeout=5000']), { files: false, ordered: true }, 'the ordered runner takes a limit per test');
  assert.deepEqual(parseTestArgs(['--test-timeout', '5000', 'tests/groq.test.mjs']), { files: true, ordered: false });
  assert.deepEqual(parseTestArgs(['--test-shard=1/2']), { files: false, ordered: false });
  assert.deepEqual(parseTestArgs(['tests/groq.test.mjs']), { files: true, ordered: false });
  assert.deepEqual(parseTestArgs(['--test-name-pattern', 'x', 'tests/groq.test.mjs']), { files: true, ordered: false });
  assert.deepEqual(parseTestArgs(['--', 'tests/groq.test.mjs']), { files: true, ordered: false });
  assert.deepEqual(parseTestArgs(['--test-reporter', 'spec']), { files: false, ordered: true }, 'an option value is not a file');
  assert.deepEqual(parseTestArgs(['--core']), { files: false, ordered: true });
  assert.deepEqual(parseTestArgs(['--smart', '--since=v4.9.2', '--explain']), { files: false, ordered: true });
});

test('a busy machine gets fewer workers, never fewer than two and never more than sixteen', () => {
  assert.equal(chooseConcurrency({ available: 32 }), 16);
  assert.equal(chooseConcurrency({ available: 8 }), 7);
  assert.equal(chooseConcurrency({ available: 2 }), 2);
  assert.equal(chooseConcurrency({ available: 32, reduced: true }), 5);
  assert.equal(chooseConcurrency({ available: 2, reduced: true }), 2);
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

test('the slow list is read as one set whatever the reasons are called', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-slow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'slow-tests.json');
  assert.deepEqual([...await readSlowList(file)], [], 'no list: nothing is slow');
  await writeFile(file, JSON.stringify({ browser: ['tests/a.test.mjs'], ffmpeg: ['tests/b.test.mjs', 'tests/a.test.mjs'], cli: [] }), 'utf8');
  assert.deepEqual([...await readSlowList(file)].sort(), ['tests/a.test.mjs', 'tests/b.test.mjs']);
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

const fixtureKey = name => `tests/fixtures/runner-suite/${name}.test.mjs`;
const fixtureName = key => key.slice('tests/fixtures/runner-suite/'.length, -'.test.mjs'.length);

/* What a file is recorded as taking includes starting its process, and on a busy machine that start can cost more than the fixtures
   differ by (a waits 60 ms, c 250 ms: a shared Windows runner once measured a above c). So no assertion here compares two measured
   files: a measurement is checked against the wait it must contain, and the order against the figures the run was given. */
test('the first run learns how long each file took and the next run starts in the order of those figures, longest first', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await runFixtures(dir);
  assert.equal(first.code, 0, first.err + first.out);
  assert.deepEqual(first.started, ['a', 'b', 'c'], 'nothing is known yet: by name');
  assert.match(first.out, /# pass 3/, 'node\'s usual TAP report and summary are still printed');
  const recorded = await readDurations(join(dir, 'durations.json'));
  assert.deepEqual(Object.keys(recorded).sort(), ['a', 'b', 'c'].map(fixtureKey));
  for (const [name, waited] of [['a', 60], ['b', 500], ['c', 250]]) {
    assert.ok(recorded[fixtureKey(name)] >= waited * 0.8, `${name} waits ${waited} ms and was recorded as ${recorded[fixtureKey(name)]} ms`);
  }
  const second = await runFixtures(dir);
  assert.equal(second.code, 0, second.err + second.out);
  assert.deepEqual(second.started, orderLongestFirst(Object.keys(recorded).sort(), recorded).map(fixtureName), 'what the first run recorded decides the order');
});

test('recorded figures decide the order, not the names and not how long the files really take', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'durations.json'), JSON.stringify({ [fixtureKey('a')]: 300, [fixtureKey('b')]: 5, [fixtureKey('c')]: 90_000 }), 'utf8');
  const run = await runFixtures(dir);
  assert.equal(run.code, 0, run.err + run.out);
  assert.deepEqual(run.started, ['c', 'a', 'b'], 'slowest recorded first, although b really takes longest');
});

test('the fast tier leaves out what the slow list names', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'durations.json'), '{}', 'utf8');
  const slowList = join(dir, 'slow-tests.json');
  await writeFile(slowList, JSON.stringify({ cli: ['tests/fixtures/runner-suite/b.test.mjs'] }), 'utf8');
  const log = join(dir, 'started.log');
  await writeFile(log, '', 'utf8');
  const env = { ...process.env, STUDY_TEST_SUITE_DIR: suite, STUDY_TEST_SLOW_FILE: slowList, STUDY_TEST_DURATIONS_FILE: join(dir, 'durations.json'), STUDY_FIXTURE_LOG: log };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [runner, '--fast', '--test-concurrency=1'], { env, windowsHide: true, stdio: 'ignore' });
  assert.equal(await new Promise(resolve => child.once('close', resolve)), 0);
  assert.deepEqual((await readFile(log, 'utf8')).split('\n').filter(Boolean), ['a', 'c']);
});

test('a wrapper test file delegating to a helper records its own .test.mjs duration, not the helper path', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-wrapper-dur-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const customSuite = join(dir, 'suite');
  await (await import('node:fs/promises')).mkdir(customSuite, { recursive: true });
  await writeFile(join(customSuite, 'helper.mjs'), `import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
export function registerHelperTests() {
  describe('delegated', () => {
    test('waits briefly', async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.ok(true);
    });
  });
}
`, 'utf8');
  await writeFile(join(customSuite, 'wrapper.test.mjs'), `import { registerHelperTests } from './helper.mjs';
registerHelperTests();
`, 'utf8');
  const durationsPath = join(dir, 'durations.json');
  const env = { ...process.env, STUDY_TEST_SUITE_DIR: customSuite, STUDY_TEST_DURATIONS_FILE: durationsPath, STUDY_TEST_BATCH: '0' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [runner, '--test-concurrency=1'], { env, windowsHide: true });
  let err = '';
  child.stderr.on('data', part => { err += part; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, err);
  const recorded = await readDurations(durationsPath);
  const keys = Object.keys(recorded);
  assert.equal(keys.length, 1, `expected only wrapper test file key, got: ${JSON.stringify(recorded)}`);
  assert.ok(keys[0].endsWith('/wrapper.test.mjs'), keys[0]);
  assert.ok(recorded[keys[0]] >= 40, `expected wrapper duration >= 40ms, got ${recorded[keys[0]]}`);
  assert.equal(keys.some(key => key.includes('helper.mjs')), false);
});

test('a shard running a .runtime.test.mjs wrapper records only its own shard file and never pollutes the imported base file from another shard', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-shard-wrapper-dur-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const customSuite = join(dir, 'suite');
  await (await import('node:fs/promises')).mkdir(customSuite, { recursive: true });
  await writeFile(join(customSuite, 'alpha.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict';
test('base work', async () => {
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(true);
});
`, 'utf8');
  await writeFile(join(customSuite, 'alpha.runtime.test.mjs'), `await import('./alpha.test.mjs');\n`, 'utf8');
  const weightsPath = join(dir, 'weights.json');
  const alphaKey = `tests/fixtures/unused`; // let equal default weights split alphabetically: shard 1 gets alpha.runtime.test.mjs, shard 2 gets alpha.test.mjs
  void alphaKey;
  await writeFile(weightsPath, '{}', 'utf8');
  const durationsShard1 = join(dir, 'durations-1.json');
  const env = {
    ...process.env,
    STUDY_TEST_SUITE_DIR: customSuite,
    STUDY_TEST_WEIGHTS_FILE: weightsPath,
    STUDY_TEST_DURATIONS_FILE: durationsShard1,
    STUDY_TEST_BATCH: '0',
  };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [runner, '--shard=1/2', '--test-concurrency=1'], { env, windowsHide: true });
  let err = '';
  child.stderr.on('data', part => { err += part; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, err);
  const recorded = await readDurations(durationsShard1);
  const keys = Object.keys(recorded);
  assert.equal(keys.length, 1, `expected only shard 1 wrapper key, got: ${JSON.stringify(recorded)}`);
  assert.ok(keys[0].endsWith('/alpha.runtime.test.mjs'), keys[0]);
  assert.ok(recorded[keys[0]] >= 35, `expected wrapper wall duration >= 35ms, got ${recorded[keys[0]]}`);
  assert.equal(keys.some(key => key.endsWith('/alpha.test.mjs')), false, 'imported base file in shard 2 is not polluted');
});
