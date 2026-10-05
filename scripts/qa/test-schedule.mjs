/* How a full test run is planned: which files, in which order, with how many workers, and what the last run taught about how long
   each file takes. Used by scripts/test.mjs (arguments, workers) and scripts/qa/run-tests.mjs (files, order, durations). */
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
/** What the last run measured per file; a cache, never committed. */
export const durationsFile = () => process.env.STUDY_TEST_DURATIONS_FILE || join(repoRoot, 'node_modules', '.cache', 'studyhub-tests', 'durations.json');
/** The folder of test files (the runner's own tests point it at a fixture suite). */
export const suiteDir = () => process.env.STUDY_TEST_SUITE_DIR || join(repoRoot, 'tests');

// Options the ordered runner understands; their values are never file names. Anything else (or a file) stays with `node --test`.
const ORDERED_OPTIONS = new Set(['--test-reporter', '--test-reporter-destination', '--test-concurrency', '--test-name-pattern', '--test-skip-pattern']);
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

/** One test process per core starves the browser, ffmpeg and CLI-spawning tests on a many-core machine (and every other program on it): cap it. */
export function chooseConcurrency({ available }) {
  return Math.max(2, Math.min(available - 1, 12));
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

/** Milliseconds per test file from earlier runs; a missing or damaged cache is just empty. */
export async function readDurations(file = durationsFile()) {
  try {
    const recorded = JSON.parse(await readFile(file, 'utf8'));
    return Object.fromEntries(Object.entries(recorded).filter(([, ms]) => Number.isFinite(ms)));
  } catch { return {}; }
}

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
