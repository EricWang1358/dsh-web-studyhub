/* node scripts/qa/run-tests.mjs [--fast] [--test-concurrency=N] [--test-reporter=X [--test-reporter-destination=Y]]... [--test-name-pattern=P]... [--test-skip-pattern=P]...
   The whole suite, longest file first (started by scripts/test.mjs, which sets up the environment).

   `node --test` sorts its files by name, so the slowest ones start whenever their name comes up and the run ends with whatever is
   left of them. `run()` from node:test takes the files in the order given, so this runner lists them itself: files with no recorded
   time first, then the longest of the last run down to the shortest, and it records the times of this run for the next one
   (node_modules/.cache/studyhub-tests/durations.json, never committed). Reports are node's own: TAP when piped, spec on a terminal.
   --fast leaves out the files of tests/slow-tests.json (browsers, ffmpeg, other programs). */
import { run } from 'node:test';
import * as builtInReporters from 'node:test/reporters';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { durationsFile, listTestFiles, mergeDurations, orderLongestFirst, readDurations, readSlowList, repoRoot } from './test-schedule.mjs';

const args = process.argv.slice(2);
const fast = args.includes('--fast');
const values = name => args.flatMap((arg, i) => arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : arg === name && i + 1 < args.length ? [args[i + 1]] : []);
const concurrency = Number(values('--test-concurrency').at(-1)) || undefined;
const guard = new URL('./test-network.mjs', import.meta.url).href;
const keyOf = file => relative(repoRoot, file).split(sep).join('/');

const slow = fast ? await readSlowList() : new Set();
const durations = await readDurations();
const byKey = new Map((await listTestFiles()).map(file => [keyOf(file), file]).filter(([key]) => !slow.has(key)));
const files = orderLongestFirst([...byKey.keys()], durations).map(key => byKey.get(key));

/** A reporter from `--test-reporter`: one of node's own by name, or a module whose default export is a reporter. */
async function loadReporter(name) {
  const reporter = Object.hasOwn(builtInReporters, name) ? builtInReporters[name]
    : (await import(/^[a-z][a-z0-9+.-]+:/i.test(name) ? name : pathToFileURL(resolve(name)).href)).default;
  return reporter;
}
const isClass = reporter => /^class\b/.test(Function.prototype.toString.call(reporter));
const reporterNames = values('--test-reporter'), destinations = values('--test-reporter-destination');
if (!reporterNames.length) reporterNames.push(process.stdout.isTTY ? 'spec' : 'tap');
const sinks = await Promise.all(reporterNames.map(async (name, i) => {
  const reporter = await loadReporter(name), destination = destinations[i] || 'stdout';
  const input = new PassThrough({ objectMode: true });
  const output = isClass(reporter) ? input.pipe(new reporter()) : Readable.from(reporter(input));
  const target = destination === 'stdout' ? process.stdout : destination === 'stderr' ? process.stderr : createWriteStream(isAbsolute(destination) ? destination : resolve(destination));
  const standard = target === process.stdout || target === process.stderr;
  output.pipe(target, { end: !standard });
  return { input, done: standard ? once(output, 'end') : once(target, 'finish') };
}));

const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => abort.abort());
const stream = run({ files, concurrency, cwd: repoRoot, execArgv: ['--import', guard], signal: abort.signal,
  ...(values('--test-name-pattern').length ? { testNamePatterns: values('--test-name-pattern') } : {}),
  ...(values('--test-skip-pattern').length ? { testSkipPatterns: values('--test-skip-pattern') } : {}) });

const measured = {};
let failed = false;
for await (const event of stream) {
  for (const { input } of sinks) if (!input.write(event)) await once(input, 'drain');
  const { type, data } = event;
  if ((type === 'test:pass' || type === 'test:fail') && data.nesting === 0 && data.file) {
    // Every top-level test of a file, so the file's own time is their sum.
    const key = keyOf(data.file);
    measured[key] = (measured[key] || 0) + (data.details?.duration_ms || 0);
  }
  if (type === 'test:fail') failed = true;
}
for (const { input } of sinks) input.end();
await Promise.all(sinks.map(({ done }) => done));
if (!abort.signal.aborted) await mergeDurations(durationsFile(), Object.fromEntries(Object.entries(measured).map(([key, ms]) => [key, Math.round(ms)])));
process.exitCode = failed || abort.signal.aborted ? 1 : 0;
