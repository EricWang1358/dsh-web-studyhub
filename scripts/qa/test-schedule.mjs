/* How a full test run is planned: which files, in which order, with how many workers, and what the last run taught about how long
   each file takes. Used by scripts/test.mjs (arguments, workers) and scripts/qa/run-tests.mjs (files, order, durations). */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
/** The tests the fast tier skips: tests/slow-tests.json (browser, ffmpeg and program-starting files; tests/slow-tests-list.test.mjs keeps it honest). */
export const slowListFile = () => process.env.STUDY_TEST_SLOW_FILE || join(repoRoot, 'tests', 'slow-tests.json');
/** What the last run measured per file; a cache, never committed. */
export const durationsFile = () => process.env.STUDY_TEST_DURATIONS_FILE || join(repoRoot, 'node_modules', '.cache', 'studyhub-tests', 'durations.json');
/** How long each file takes, roughly; committed, so that every machine cuts a run into the same shards (see shardKeys). `node scripts/qa/test-weights.mjs` refreshes it. */
export const weightsFile = () => process.env.STUDY_TEST_WEIGHTS_FILE || join(repoRoot, 'tests', 'test-weights.json');
/** The folder of test files (the runner's own tests point it at a fixture suite). */
export const suiteDir = () => process.env.STUDY_TEST_SUITE_DIR || join(repoRoot, 'tests');

// Options the ordered runner understands; their values are never file names. Anything else (or a file) stays with `node --test`.
const ORDERED_OPTIONS = new Set(['--test-reporter', '--test-reporter-destination', '--test-concurrency', '--test-name-pattern', '--test-skip-pattern', '--shard']);
// Every Node test option that takes a value, so that the value is not taken for a file.
const VALUE_OPTIONS = new Set([...ORDERED_OPTIONS, '--test-timeout', '--test-shard', '--test-coverage-exclude', '--test-coverage-include',
  '--test-coverage-lines', '--test-coverage-branches', '--test-coverage-functions', '--experimental-test-isolation', '--import', '--require', '-r']);

/** Whether the arguments name test files, and whether a plain full run with them can be scheduled by us. */
export function parseTestArgs(args) {
  let files = false, ordered = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { files = i + 1 < args.length; break; }
    const name = args[i].split('=')[0];
    if (VALUE_OPTIONS.has(name)) { if (!args[i].includes('=')) i++; }
    else if (!args[i].startsWith('-')) files = true;
    if (!ORDERED_OPTIONS.has(name)) ordered = false;
  }
  return { files, ordered: ordered && !files };
}

/** One test process per core starves the browser, ffmpeg and CLI-spawning tests on a many-core machine (and every other program on it): cap it, and take fewer while another full run holds the machine. */
export function chooseConcurrency({ available, reduced = false }) {
  const full = Math.max(2, Math.min(available - 1, 12));
  return reduced ? Math.max(2, Math.floor(full / 3)) : full;
}

/** "2/5" is shard 2 of 5 (counted from 1); anything else is null. */
export function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const index = Number(match[1]), count = Number(match[2]);
  return count >= 1 && count <= 64 && index >= 1 && index <= count ? { index, count } : null;
}

/**
 * The files of shard `index` of `count` (counted from 1), so that one suite can run on several machines at once. The split depends only on the file names and on
 * `weights` (the committed tests/test-weights.json, never this machine's own timings), so every machine computes the same split and the shards together hold every file once.
 * The heaviest files go first, each to the shard with the least weight so far (ties: the lower shard); a file with no weight counts as the median of the known ones.
 */
export function shardKeys(keys, weights, { index, count }) {
  const known = keys.map(key => weights[key]).filter(Number.isFinite).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = key => (Number.isFinite(weights[key]) ? weights[key] : fallback);
  const loads = Array.from({ length: count }, () => 0), shards = loads.map(() => []);
  for (const key of [...keys].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    const at = loads.indexOf(Math.min(...loads));
    loads[at] += weight(key);
    shards[at].push(key);
  }
  return shards[index - 1].sort();
}

/** `keys` with the files nobody has timed first (by name), then the longest recorded file down to the shortest. Does not change `keys`. */
export function orderLongestFirst(keys, durations) {
  const known = keys.filter(key => Number.isFinite(durations[key]));
  return [...keys.filter(key => !Number.isFinite(durations[key])), ...known.sort((a, b) => durations[b] - durations[a])];
}

/** The absolute paths of the *.test.mjs files of `dir`, by name. */
export async function listTestFiles(dir = suiteDir()) {
  return (await readdir(dir)).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(dir, name));
}

/** The files named in the slow list, whatever its reasons are called; no list means nothing is slow. */
export async function readSlowList(file = slowListFile()) {
  try {
    const list = JSON.parse(await readFile(file, 'utf8'));
    return new Set(Object.values(list).flat().filter(name => typeof name === 'string'));
  } catch { return new Set(); }
}

/** Milliseconds per test file from earlier runs; a missing or damaged cache is just empty. */
export async function readDurations(file = durationsFile()) {
  try {
    const recorded = JSON.parse(await readFile(file, 'utf8'));
    return Object.fromEntries(Object.entries(recorded).filter(([, ms]) => Number.isFinite(ms)));
  } catch { return {}; }
}

/** The committed weights of tests/test-weights.json (a missing or damaged file is just empty, and every file then weighs the same). */
export const readWeights = (file = weightsFile()) => readDurations(file);

/** Add `update` to the recorded durations (files not in it keep their old figure). Never throws: this is only a cache. */
export async function mergeDurations(file, update) {
  try {
    const merged = { ...await readDurations(file), ...update };
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(merged, null, 1), 'utf8');
    await rename(temporary, file);
  } catch { /* a read-only checkout just does not learn */ }
}
