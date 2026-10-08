/* node scripts/qa/test-weights.mjs [--write] [--sum] [--shards=3,5] <durations.json>...
   Folds the timings of earlier runs into tests/test-weights.json, the committed picture of how long each test file takes that lets every machine cut the suite into the
   same shards (scripts/qa/test-schedule.mjs shardKeys). Give it the node_modules/.cache/studyhub-tests/durations.json of a machine, or the `durations-*` files that the
   shards of ONE CI run upload (then add --sum: the shards each timed their own part, so the figures of a file add up; without --sum the files are separate runs and are averaged).
   It keeps only files that exist, rounds to 10 ms, and prints how even the shards would be. Without --write nothing is changed. A file with no weight is not an error:
   it counts as the median until the weights are refreshed.

   A thin wrapper (a few lines that set a switch and import another test file, like tests/audio-batch.runtime.test.mjs) runs the same tests again in a process of its own,
   but node reports those tests under the imported file, so the imported file carries the time of all its runs. The time is shared out equally between the file and its wrappers. */
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listTestFiles, parseShard, readWeights, repoRoot, shardKeys, weightsFile } from './test-schedule.mjs';

/** The test files that only import another test file: { wrapper key: imported key }. */
export async function wrapperMap(keys) {
  const map = new Map();
  for (const key of keys) {
    const text = await readFile(join(repoRoot, key), 'utf8');
    const imported = /await import\('\.\/([\w.-]+\.test\.mjs)'\)/.exec(text)?.[1];
    if (imported && text.length < 600 && keys.includes(`tests/${imported}`)) map.set(key, `tests/${imported}`);
  }
  return map;
}

/** Share the time recorded under an imported file equally between it and the wrappers that import it. */
export function shareWithWrappers(times, wrappers) {
  const out = { ...times };
  const byBase = new Map();
  for (const [wrapper, base] of wrappers) byBase.set(base, [...(byBase.get(base) || []), wrapper]);
  for (const [base, list] of byBase) {
    if (!Number.isFinite(times[base])) continue;
    const share = times[base] / (list.length + 1);
    out[base] = share;
    for (const wrapper of list) out[wrapper] = share;
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const write = args.includes('--write'), sum = args.includes('--sum');
  const counts = (args.find(arg => arg.startsWith('--shards='))?.slice('--shards='.length) || '3,5').split(',').map(Number).filter(n => n >= 1);
  const sources = args.filter(arg => !arg.startsWith('--'));
  if (!sources.length) { console.error('Give at least one durations.json (see the comment at the top of this file).'); process.exit(2); }

  const keys = (await listTestFiles()).map(file => relative(repoRoot, file).split(sep).join('/'));
  const exists = new Set(keys);
  const totals = new Map();
  for (const source of sources) {
    for (const [key, ms] of Object.entries(JSON.parse(await readFile(source, 'utf8')))) {
      if (!exists.has(key) || !Number.isFinite(ms)) continue;
      const seen = totals.get(key) || { total: 0, runs: 0 };
      totals.set(key, { total: seen.total + ms, runs: seen.runs + 1 });
    }
  }
  const measured = Object.fromEntries([...totals].map(([key, { total, runs }]) => [key, sum ? total : total / runs]));
  const shared = shareWithWrappers(measured, await wrapperMap(keys));
  const next = Object.fromEntries(Object.entries(shared).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, ms]) => [key, Math.max(10, Math.round(ms / 10) * 10)]));
  const before = await readWeights();
  console.log(`${Object.keys(next).length} of ${exists.size} test files have a weight (${Object.keys(before).length} before); ${keys.filter(key => !(key in next)).length} will count as the median.`);

  for (const count of counts) {
    const loads = Array.from({ length: count }, (_, at) => shardKeys(keys, next, parseShard(`${at + 1}/${count}`)).reduce((total, key) => total + (next[key] ?? 0), 0));
    const average = loads.reduce((a, b) => a + b, 0) / count;
    console.log(`${count} shards: ${loads.map(ms => `${(ms / 1000).toFixed(0)}s`).join(' ')} (heaviest ${(Math.max(...loads) / average * 100 - 100).toFixed(1)}% above the average)`);
  }
  if (write) {
    await writeFile(weightsFile(), `${JSON.stringify(next, null, 1)}\n`, 'utf8');
    console.log(`Wrote ${weightsFile()}`);
  } else console.log('Not written (add --write).');
}
