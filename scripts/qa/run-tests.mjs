/* node scripts/qa/run-tests.mjs [--fast] [--shard=I/N [--list]] [--test-concurrency=N] [--test-timeout=MS] [--test-reporter=X [--test-reporter-destination=Y]]... [--test-name-pattern=P]... [--test-skip-pattern=P]...
   The whole suite, longest file first (started by scripts/test.mjs, which sets up the environment).

   `node --test` sorts its files by name, so the slowest ones start whenever their name comes up and the run ends with whatever is
   left of them. `run()` from node:test takes the files in the order given, so this runner lists them itself: files with no recorded
   time first, then the longest of the last run down to the shortest, and it records the times of this run for the next one
   (node_modules/.cache/studyhub-tests/durations.json, never committed). Reports are node's own: TAP when piped, spec on a terminal;
   any reporter node --test takes (spec, tap, dot, junit, lcov, a module) is wired the way node --test wires it.
   --fast leaves out the files of tests/slow-tests.json (browsers, ffmpeg, other programs).
   --shard=I/N runs shard I of N: the suite is cut by the committed weights of tests/test-weights.json (the same cut on every machine, shards of about equal weight),
   so N machines can each run one shard. --list prints the files that would run and stops. A fresh machine has no timings of its own and orders by the weights.

   Time limits, so that a hung test fails the run with its name instead of holding a CI machine until the job limit:
   - each test: TEST_TIMEOUT_MS below, or --test-timeout=MS / STUDY_TEST_TIMEOUT_MS (0: none). Set inside each file's process by
     scripts/qa/test-timeout.mjs, which names the test and ends that file;
   - each file: FILE_TIMEOUT_MS below, or STUDY_TEST_FILE_TIMEOUT_MS (0: none), passed to run({ timeout }), which times a whole file
     and stops its process (a hang outside any test: a hook, an import, a handle left open after the last test).
   When a limit trips, or the run is stopped (SIGINT, SIGTERM, or a { stop } message from scripts/test.mjs), the test files that had
   started and not finished are printed on stderr, with the tests in them that had started and not finished where they are known. */
import { run } from 'node:test';
import * as builtInReporters from 'node:test/reporters';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { compose, PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { durationsFile, listTestFiles, mergeDurations, orderLongestFirst, parseShard, readDurations, readSlowList, readWeights, repoRoot, shardKeys } from './test-schedule.mjs';
import { TIMEOUT_MARK } from './test-timeout.mjs';

/* Measured on a full local run on a busy machine (Windows, 12 workers next to other test runs, 2026-10-22; 11.5 minutes where CI's
   shards take 3.5 to 5): the longest top-level test took 128 s (a browser test failing at its own 120 s action limit; the longest passing
   one 96 s) and the longest file 237 s (tests/task-console-browser.test.mjs). A test gets well over twice that, and more than the browser
   action limit, so it fails by itself first; a file gets about twice the longest. Both stop a hang well before verify.yml's 15-minute job limit. */
const TEST_TIMEOUT_MS = 300_000;
const FILE_TIMEOUT_MS = 480_000;

const args = process.argv.slice(2);
const fast = args.includes('--fast');
const values = name => args.flatMap((arg, i) => arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : arg === name && i + 1 < args.length ? [args[i + 1]] : []);
const concurrency = Number(values('--test-concurrency').at(-1)) || undefined;
const guard = new URL('./test-network.mjs', import.meta.url).href;
const keyOf = file => relative(repoRoot, file).split(sep).join('/');

/** A limit in ms from the first of these that is set: a whole number, 0 for none. */
function limit(name, ...texts) {
  const text = texts.find(value => value !== undefined && value !== '');
  if (text === undefined) return null;
  const ms = Number(text);
  if (!Number.isInteger(ms) || ms < 0) { console.error(`${name} needs a whole number of milliseconds, 0 for no limit (got "${text}")`); process.exit(2); }
  return ms;
}
const testMs = limit('--test-timeout', values('--test-timeout').at(-1), process.env.STUDY_TEST_TIMEOUT_MS) ?? TEST_TIMEOUT_MS;
// A file takes at least as long as its longest test: a per-test limit raised past the file limit raises the file limit too.
const fileLimit = limit('STUDY_TEST_FILE_TIMEOUT_MS', process.env.STUDY_TEST_FILE_TIMEOUT_MS) ?? FILE_TIMEOUT_MS;
const fileMs = fileLimit && testMs ? Math.max(fileLimit, testMs) : fileLimit;

const shardText = values('--shard').at(-1), shard = shardText === undefined ? null : parseShard(shardText);
if (shardText !== undefined && !shard) { console.error(`--shard needs index/count, for example 2/5 (got "${shardText}")`); process.exit(2); }

const slow = fast ? await readSlowList() : new Set();
const durations = await readDurations(), weights = await readWeights();
const all = new Map((await listTestFiles()).map(file => [keyOf(file), file]));
// A shard is cut from the whole suite, not from what --fast leaves, so a shard names the same files either way.
const mine = shard ? shardKeys([...all.keys()], weights, shard) : [...all.keys()];
const byKey = new Map(mine.filter(key => !slow.has(key)).map(key => [key, all.get(key)]));
// This machine's own timings first, else the committed weights: a fresh machine starts the longest files first too.
const files = orderLongestFirst([...byKey.keys()], { ...weights, ...durations }).map(key => byKey.get(key));
if (args.includes('--list')) { console.log(files.map(keyOf).join('\n')); process.exit(0); }

/** A reporter from `--test-reporter`, read the way node --test reads one: node's own by name, else a module (a path, a URL or a package)
    whose default export is a reporter; a class (or node's spec, a factory) is constructed, a generator function or a stream is used as it is. */
async function loadReporter(name) {
  const path = isAbsolute(name) || /^\.\.?([\\/]|$)/.test(name);
  let reporter = Object.hasOwn(builtInReporters, name) ? builtInReporters[name] : await import(path ? pathToFileURL(resolve(name)).href : name);
  if (reporter?.default) reporter = reporter.default;
  if (reporter?.prototype && Object.getOwnPropertyDescriptor(reporter.prototype, 'constructor')) reporter = new reporter();
  if (!reporter) throw new Error(`--test-reporter ${name} is not a reporter`);
  return reporter;
}
const reporterNames = values('--test-reporter'), destinations = values('--test-reporter-destination');
if (!reporterNames.length) reporterNames.push(process.stdout.isTTY ? 'spec' : 'tap');
const sinks = await Promise.all(reporterNames.map(async (name, i) => {
  const reporter = await loadReporter(name), destination = destinations[i] || 'stdout';
  const input = new PassThrough({ objectMode: true });
  // compose() takes both kinds: a stream (spec is a Transform) is piped to, a generator function is fed. A stream made with
  // Readable.from(reporter(input)) never receives input when the reporter is a stream, so the first full buffer waited forever.
  const output = compose(input, reporter);
  const target = destination === 'stdout' ? process.stdout : destination === 'stderr' ? process.stderr : createWriteStream(isAbsolute(destination) ? destination : resolve(destination));
  const standard = target === process.stdout || target === process.stderr;
  output.pipe(target, { end: !standard });
  return { input, done: standard ? once(output, 'end') : once(target, 'finish') };
}));

/* What is running: a test file starts when node dequeues it and ends when it completes (both reported at once), and inside a file,
   a test has started from its dequeue until its pass or fail (reported in file order, so possibly only when the file ends). */
const isFileEvent = data => data.nesting === 0 && data.file && data.name === data.file;
const fileStates = new Map(); // key -> { started, done, tests: Set of `${nesting}\0${name}` }
const fileState = file => {
  const key = keyOf(file);
  if (!fileStates.has(key)) fileStates.set(key, { started: false, done: false, tests: new Set() });
  return fileStates.get(key);
};
const runningTests = state => [...state.tests].map(test => `"${test.split('\0')[1]}"`);
function unfinishedFiles() {
  return [...fileStates].filter(([, state]) => state.started && !state.done).map(([key, state]) => {
    const tests = runningTests(state);
    return `  ${key}${tests.length ? ` (started, not finished: ${tests.join(', ')})` : ''}`;
  });
}
const say = line => process.stderr.write(`${line}\n`);
function sayUnfinished(heading, { always = true } = {}) {
  const lines = unfinishedFiles();
  if (lines.length || always) say(lines.length ? `${heading}\n${lines.join('\n')}` : `${heading} none`);
}
const timeouts = new Map(); // key -> what tripped

const abort = new AbortController();
let stoppedBy = null, signals = 0;
function stop(signal, fromSignal = false) {
  // A second signal from the terminal ends the run at once; the same stop by message as well is no second one (a terminal's Ctrl+C
  // reaches scripts/test.mjs too, which passes it on).
  if (fromSignal && ++signals > 1) process.exit(1);
  if (stoppedBy) return;
  stoppedBy = signal;
  say(`\nTest run stopped (${signal}).`);
  sayUnfinished('Test files that had started and not finished:');
  abort.abort();
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal, true));
// scripts/test.mjs stops this run by message: on Windows a signal from another process ends it before it can say anything.
process.on('message', message => { if (message?.stop) stop(String(message.stop)); });
process.channel?.unref();

const stream = run({ files, concurrency, cwd: repoRoot, signal: abort.signal, ...(fileMs ? { timeout: fileMs } : {}),
  execArgv: ['--import', guard, ...(testMs ? ['--import', `${new URL('./test-timeout.mjs', import.meta.url).href}?ms=${testMs}`] : [])],
  ...(values('--test-name-pattern').length ? { testNamePatterns: values('--test-name-pattern') } : {}),
  ...(values('--test-skip-pattern').length ? { testSkipPatterns: values('--test-skip-pattern') } : {}) });

const measured = {};
let failed = false;
for await (const event of stream) {
  for (const { input } of sinks) if (!input.write(event)) await once(input, 'drain');
  const { type, data } = event;
  if ((type === 'test:pass' || type === 'test:fail') && data.nesting === 0 && data.file && !isFileEvent(data)) {
    // Every top-level test of a file, so the file's own time is their sum.
    const key = keyOf(data.file);
    measured[key] = (measured[key] || 0) + (data.details?.duration_ms || 0);
  }
  if (type === 'test:fail') failed = true;
  if (!data?.file) continue;
  const state = fileState(data.file), test = `${data.nesting}\0${data.name}`;
  if (isFileEvent(data)) {
    if (type === 'test:dequeue') state.started = true;
    if (type === 'test:complete') {
      state.done = true;
      if (data.details?.error?.failureType === 'testTimeoutFailure' && !abort.signal.aborted) {
        timeouts.set(keyOf(data.file), `the whole file was still running after ${fileMs} ms and was stopped`);
        say(`\nTEST FILE TIMEOUT: ${keyOf(data.file)} was still running after ${fileMs} ms and was stopped (limit per file: STUDY_TEST_FILE_TIMEOUT_MS).`);
        sayUnfinished('Test files still running now:', { always: false });
      }
    }
  } else if (type === 'test:dequeue') state.tests.add(test);
  else if (type === 'test:pass' || type === 'test:fail') state.tests.delete(test);
  else if (type === 'test:stderr' && data.message?.includes(TIMEOUT_MARK)) {
    const line = data.message.slice(data.message.indexOf(TIMEOUT_MARK)).trim();
    timeouts.set(keyOf(data.file), line.slice(TIMEOUT_MARK.length + 1).split(' Limit per test:')[0].trim());
    say(`\n${keyOf(data.file)}: ${line}`);
  }
  if (type === 'test:fail' && isFileEvent(data) && data.details?.error?.failureType === 'testTimeoutFailure' && timeouts.has(keyOf(data.file))) {
    // A file's own report comes after its tests' (node holds them back until it is the file's turn): now they are known.
    const tests = runningTests(state);
    if (tests.length) timeouts.set(keyOf(data.file), `${timeouts.get(keyOf(data.file))}; started and not finished in it: ${tests.join(', ')}`);
  }
}
for (const { input } of sinks) input.end();
await Promise.all(sinks.map(({ done }) => done));
if (timeouts.size) say(`\nTimed out (${timeouts.size}):\n${[...timeouts].map(([key, what]) => `  ${key}: ${what}`).join('\n')}`);
if (!abort.signal.aborted) await mergeDurations(durationsFile(), Object.fromEntries(Object.entries(measured).map(([key, ms]) => [key, Math.round(ms)])));
process.exitCode = failed || timeouts.size || abort.signal.aborted ? 1 : 0;
