import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTestFiles, parseShard, parseTestArgs, readWeights, repoRoot, shardKeys } from '../scripts/qa/test-schedule.mjs';
import { shareWithWrappers, wrapperMap } from '../scripts/qa/test-weights.mjs';

/* A suite can be cut into shards that run on several machines at once (CI does). The cut depends only on the file names and the committed
   weights of tests/test-weights.json, so every machine makes the same cut: together the shards hold every test file exactly once. */

const runner = fileURLToPath(new URL('../scripts/qa/run-tests.mjs', import.meta.url));
const suite = fileURLToPath(new URL('./fixtures/runner-suite/', import.meta.url));
const workflow = fileURLToPath(new URL('../.github/workflows/verify.yml', import.meta.url));
const keyOf = file => relative(repoRoot, file).split(sep).join('/');

test('a shard is written index/count, counted from 1, and nothing else is one', () => {
  assert.deepEqual(parseShard('2/5'), { index: 2, count: 5 });
  assert.deepEqual(parseShard(' 1/1 '), { index: 1, count: 1 });
  for (const bad of ['0/3', '4/3', '1/0', '1/65', 'a/b', '3', '', '1/2/3', '-1/3', undefined, null]) assert.equal(parseShard(bad), null, String(bad));
});

test('--shard is a runner option (its value is no file) and node\'s own --test-shard still is not', () => {
  assert.deepEqual(parseTestArgs(['--shard=2/5']), { files: false, ordered: true });
  assert.deepEqual(parseTestArgs(['--shard', '2/5', '--test-concurrency=3']), { files: false, ordered: true });
  assert.deepEqual(parseTestArgs(['--test-shard=1/2']), { files: false, ordered: false });
});

test('the heaviest files go first, each to the shard with the least weight so far', () => {
  const keys = ['f', 'e', 'd', 'c', 'b', 'a'];
  const weights = { a: 10, b: 9, c: 8, d: 3, e: 2, f: 1 };
  assert.deepEqual(shardKeys(keys, weights, { index: 1, count: 2 }), ['a', 'd', 'e', 'f']);
  assert.deepEqual(shardKeys(keys, weights, { index: 2, count: 2 }), ['b', 'c']);
  assert.deepEqual(shardKeys(keys, weights, { index: 1, count: 1 }), ['a', 'b', 'c', 'd', 'e', 'f'], 'one shard is the whole suite, by name');
});

test('the cut does not depend on the order the files are listed in, and equal weights are cut by name', () => {
  const keys = ['a', 'b', 'c', 'd', 'e'];
  for (const index of [1, 2, 3]) {
    assert.deepEqual(shardKeys([...keys].reverse(), {}, { index, count: 3 }), shardKeys(keys, {}, { index, count: 3 }));
  }
  assert.deepEqual([1, 2, 3].map(index => shardKeys(keys, {}, { index, count: 3 })), [['a', 'd'], ['b', 'e'], ['c']]);
});

test('a file with no weight counts as the median of the known ones', () => {
  const weights = { a: 100, b: 100, c: 100, d: 1 };
  // e has no weight: it weighs 100 (the median), so it is cut like a, b and c and d (1) fills in where it is lightest.
  const shards = [1, 2, 3].map(index => shardKeys(['a', 'b', 'c', 'd', 'e'], weights, { index, count: 3 }));
  assert.deepEqual(shards.flat().sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.ok(shards.every(shard => shard.length >= 1), 'no shard is left empty');
});

test('the shards of the real suite hold every test file exactly once and are about equally heavy', async () => {
  const keys = (await listTestFiles()).map(keyOf);
  const weights = await readWeights();
  assert.ok(Object.keys(weights).length > keys.length / 2, 'tests/test-weights.json knows most files (node scripts/qa/test-weights.mjs refreshes it)');
  for (let count = 1; count <= 9; count++) {
    const shards = Array.from({ length: count }, (_, at) => shardKeys(keys, weights, { index: at + 1, count }));
    assert.deepEqual(shards.flat().sort(), [...keys].sort(), `${count} shards: every file once`);
    assert.ok(shards.every(shard => shard.length > 0), `${count} shards: none empty`);
    if (count === 1) continue;
    const median = [...Object.values(weights)].sort((a, b) => a - b)[Math.floor(Object.keys(weights).length / 2)];
    const weight = key => weights[key] ?? median;
    const loads = shards.map(shard => shard.reduce((total, key) => total + weight(key), 0));
    const heaviest = Math.max(...keys.map(weight));
    // The classic bound of cutting heaviest-first: no shard is more than the heaviest single file above the average.
    assert.ok(Math.max(...loads) <= loads.reduce((a, b) => a + b, 0) / count + heaviest, `${count} shards: ${loads.map(Math.round)}`);
  }
});

test('the committed weights are plain numbers', async () => {
  const raw = JSON.parse(await readFile(join(repoRoot, 'tests', 'test-weights.json'), 'utf8'));
  assert.ok(Object.entries(raw).every(([key, ms]) => /^tests\/[^/]+\.test\.mjs$/.test(key) && Number.isFinite(ms) && ms >= 10), 'file name -> milliseconds');
});

/** The ordered runner over the fixture suite with its own weights; resolves with the exit code and what it printed. */
async function listFixtures(dir, weights, ...args) {
  const file = join(dir, 'weights.json');
  await writeFile(file, JSON.stringify(weights), 'utf8');
  const env = { ...process.env, STUDY_TEST_SUITE_DIR: suite, STUDY_TEST_WEIGHTS_FILE: file, STUDY_TEST_DURATIONS_FILE: join(dir, 'durations.json') };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [runner, '--list', ...args], { env, windowsHide: true });
  let out = '', err = '';
  child.stdout.on('data', part => { out += part; }); child.stderr.on('data', part => { err += part; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, files: out.split('\n').map(line => line.trim()).filter(Boolean), err };
}
const fixture = name => `tests/fixtures/runner-suite/${name}.test.mjs`;

test('the runner runs one shard, longest file first, and says which files with --list', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-shard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const weights = { [fixture('a')]: 100, [fixture('b')]: 10, [fixture('c')]: 20 };
  assert.deepEqual((await listFixtures(dir, weights, '--shard=1/2')).files, [fixture('a')]);
  assert.deepEqual((await listFixtures(dir, weights, '--shard=2/2')).files, [fixture('c'), fixture('b')], 'the heavier c starts before b');
  assert.deepEqual((await listFixtures(dir, weights)).files, [fixture('a'), fixture('c'), fixture('b')], 'no shard: the whole suite, heaviest first');
  assert.deepEqual((await listFixtures(dir, weights, '--shard', '1/1')).files, [fixture('a'), fixture('c'), fixture('b')]);
});

test('a shard that is not index/count stops the runner before anything runs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-shard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const bad of ['--shard=3/2', '--shard=x', '--shard=0/2']) {
    const result = await listFixtures(dir, {}, bad);
    assert.equal(result.code, 2, bad);
    assert.match(result.err, /--shard needs index\/count/);
    assert.deepEqual(result.files, []);
  }
});

test('a thin wrapper that imports another test file shares that file\'s recorded time with it', async () => {
  assert.deepEqual(shareWithWrappers({ base: 300, other: 50 }, new Map([['w1', 'base'], ['w2', 'base']])), { base: 100, other: 50, w1: 100, w2: 100 });
  assert.deepEqual(shareWithWrappers({ other: 50 }, new Map([['w1', 'base']])), { other: 50 }, 'nothing recorded for the base: nothing to share');
  const keys = (await listTestFiles()).map(keyOf);
  const wrappers = await wrapperMap(keys);
  assert.equal(wrappers.get('tests/audio-batch.runtime.test.mjs'), 'tests/audio-batch.test.mjs');
  assert.equal(wrappers.has('tests/audio-batch.test.mjs'), false, 'a real test file is no wrapper');
  assert.ok(wrappers.size >= 20, `${wrappers.size} wrappers`);
});

test('the CI workflow runs every shard of each system exactly once and its gate waits for lint and the shards', async () => {
  const text = await readFile(workflow, 'utf8');
  const entries = [...text.matchAll(/\{\s*os:\s*([\w-]+),\s*shard:\s*(\d+),\s*shards:\s*(\d+)\s*\}/g)].map(([, os, shard, shards]) => ({ os, shard: Number(shard), shards: Number(shards) }));
  const systems = new Set(entries.map(entry => entry.os));
  assert.deepEqual([...systems].sort(), ['ubuntu-latest', 'windows-latest'], 'both systems are tested');
  for (const os of systems) {
    const mine = entries.filter(entry => entry.os === os);
    const shards = mine[0].shards;
    assert.ok(mine.every(entry => entry.shards === shards), `${os}: one shard count`);
    assert.deepEqual(mine.map(entry => entry.shard).sort((a, b) => a - b), Array.from({ length: shards }, (_, at) => at + 1), `${os}: shards 1..${shards}, each once`);
  }
  assert.match(text, /node scripts\/test\.mjs --shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ matrix\.shards \}\}/, 'each job runs its own shard');
  assert.match(text, /needs:\s*\[lint,\s*test\]/, 'the gate waits for lint and every shard');
  assert.match(text, /fail-fast:\s*false/, 'one failing shard does not hide the others');
});
