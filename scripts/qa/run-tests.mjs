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
import { durationsFile, listTestFiles, mergeDurations, orderLongestFirst, parseShard, readDurations, readSlowList, readWeights, repoRoot, shardKeys, suiteDir } from './test-schedule.mjs';
import { planBatches } from './test-batch.mjs';
import { FILE_TIMEOUT_MARK, TIMEOUT_MARK } from './test-timeout.mjs';

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

const slowList = await readSlowList();
const slow = fast ? slowList : new Set();
const durations = await readDurations(), weights = await readWeights();
const all = new Map((await listTestFiles()).map(file => [keyOf(file), file]));
// A shard is cut from the whole suite, not from what --fast leaves, so a shard names the same files either way.
const mine = shard ? shardKeys([...all.keys()], weights, shard) : [...all.keys()];
const byKey = new Map(mine.filter(key => !slow.has(key)).map(key => [key, all.get(key)]));
// This machine's own timings first, else the committed weights: a fresh machine starts the longest files first too.
const timings = { ...weights, ...durations };
const files = orderLongestFirst([...byKey.keys()], timings).map(key => byKey.get(key));
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

const { runFiles, batchMembers, memberBatch, cleanup } = await planBatches(files, {
  keyOf, timings, weights, slow: slowList, suiteRoot: suiteDir(), concurrency,
});
const isBatchContainer = file => Boolean(file && batchMembers.has(resolve(file)));
const isBatchedMember = file => Boolean(file && memberBatch.has(resolve(file)));

/* What is running: a test file starts when node dequeues it and ends when it completes (both reported at once), and inside a file,
   a test has started from its dequeue until its pass or fail (reported in file order, so possibly only when the file ends). */
const isFileEvent = data => data.nesting === 0 && data.file && data.name === data.file;
const fileStates = new Map(); // key -> { started, done, enqueued, completed, tests: Set of `${nesting}\0${name}` }
const fileState = file => {
  const key = keyOf(file);
  if (!fileStates.has(key)) fileStates.set(key, { started: false, done: false, enqueued: 0, completed: 0, tests: new Set() });
  return fileStates.get(key);
};
function activeBatchFile(batchFile, hint = '') {
  const explicit = /\[batch-file=([^\]]+)\]/.exec(hint);
  if (explicit) return explicit[1];
  const members = batchMembers.get(resolve(batchFile));
  if (!members?.length) return batchFile;
  const quoted = /"([^"]+)"/.exec(hint)?.[1];
  if (quoted) {
    const rootName = quoted.split(' > ')[0];
    const byTest = members.find(member => fileStates.get(keyOf(member))?.tests.has(`0\0${rootName}`));
    if (byTest) return byTest;
  }
  return members.find(member => {
    const st = fileStates.get(keyOf(member));
    return st?.started && !st.done && st.tests.size > 0;
  }) || members.find(member => {
    const st = fileStates.get(keyOf(member));
    return st?.started && !st.done;
  }) || [...members].reverse().find(member => fileStates.get(keyOf(member))?.started) || members[0];
}
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

function noteFileTimeout(file) {
  const key = keyOf(file);
  if (timeouts.has(key) || abort.signal.aborted) return;
  timeouts.set(key, `the whole file was still running after ${fileMs} ms and was stopped`);
  say(`\nTEST FILE TIMEOUT: ${key} was still running after ${fileMs} ms and was stopped (limit per file: STUDY_TEST_FILE_TIMEOUT_MS).`);
  sayUnfinished('Test files still running now:', { always: false });
}

const measured = {}, fileWall = {};
let failed = false;
try {
  const stream = run({ files: runFiles, concurrency, cwd: repoRoot, signal: abort.signal, ...(fileMs ? { timeout: fileMs } : {}),
    execArgv: ['--import', guard, ...((testMs || fileMs) ? ['--import', `${new URL('./test-timeout.mjs', import.meta.url).href}?ms=${testMs}&fileMs=${fileMs}`] : [])],
    ...(values('--test-name-pattern').length ? { testNamePatterns: values('--test-name-pattern') } : {}),
    ...(values('--test-skip-pattern').length ? { testSkipPatterns: values('--test-skip-pattern') } : {}) });

  for await (const event of stream) {
    for (const { input } of sinks) if (!input.write(event)) await once(input, 'drain');
    const { type, data } = event;
    const inContainer = isBatchContainer(data?.file);
    if ((type === 'test:pass' || type === 'test:fail') && data.nesting === 0 && data.file && !inContainer) {
      const key = keyOf(data.file), ms = data.details?.duration_ms || 0;
      // Sum top-level tests; if module evaluation or hooks add substantial wall time (or a thin wrapper delegates its tests), keep the file's own span.
      if (isFileEvent(data)) fileWall[key] = Math.max(fileWall[key] || 0, ms);
      else measured[key] = (measured[key] || 0) + ms;
    }
    if (type === 'test:fail') failed = true;
    if (!data?.file) continue;
    if (inContainer) {
      if (isFileEvent(data) && type === 'test:complete') {
        if (data.details?.error?.failureType === 'testTimeoutFailure') noteFileTimeout(activeBatchFile(data.file));
        else if (!data.details?.error) {
          for (const member of batchMembers.get(resolve(data.file)) || []) {
            const st = fileStates.get(keyOf(member));
            if (st?.started) st.done = true;
          }
        }
      } else if (type === 'test:stderr' && data.message?.includes(FILE_TIMEOUT_MARK)) {
        noteFileTimeout(activeBatchFile(data.file, data.message));
      } else if (type === 'test:stderr' && data.message?.includes(TIMEOUT_MARK)) {
        const target = activeBatchFile(data.file, data.message);
        const line = data.message.slice(data.message.indexOf(TIMEOUT_MARK)).trim();
        timeouts.set(keyOf(target), line.slice(TIMEOUT_MARK.length + 1).split(' Limit per test:')[0].trim());
        say(`\n${keyOf(target)}: ${line}`);
      }
      if (type === 'test:fail' && isFileEvent(data) && data.details?.error?.failureType === 'testTimeoutFailure') {
        const target = activeBatchFile(data.file);
        if (timeouts.has(keyOf(target))) {
          const tests = runningTests(fileState(target));
          if (tests.length) timeouts.set(keyOf(target), `${timeouts.get(keyOf(target))}; started and not finished in it: ${tests.join(', ')}`);
        }
      }
      continue;
    }
    const state = fileState(data.file), test = `${data.nesting}\0${data.name}`;
    if (isFileEvent(data)) {
      if (type === 'test:dequeue') state.started = true;
      if (type === 'test:complete') {
        state.done = true;
        if (data.details?.error?.failureType === 'testTimeoutFailure') noteFileTimeout(data.file);
      }
    } else if (isBatchedMember(data.file)) {
      if (type === 'test:enqueue' && data.nesting === 0) state.enqueued++;
      else if (type === 'test:dequeue') { state.started = true; state.tests.add(test); }
      else if (type === 'test:complete') {
        const failureType = data.details?.error?.failureType || '';
        if (!failureType.includes('Timeout') && failureType !== 'cancelledByParent') state.tests.delete(test);
        if (data.nesting === 0 && ++state.completed >= state.enqueued && state.enqueued > 0) state.done = true;
      } else if (type === 'test:pass' || type === 'test:fail') state.tests.delete(test);
    } else if (type === 'test:dequeue') state.tests.add(test);
    else if (type === 'test:pass' || type === 'test:fail') state.tests.delete(test);
    else if (type === 'test:stderr' && data.message?.includes(FILE_TIMEOUT_MARK)) {
      noteFileTimeout(data.file);
    } else if (type === 'test:stderr' && data.message?.includes(TIMEOUT_MARK)) {
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
} finally {
  await cleanup();
}
for (const { input } of sinks) input.end();
await Promise.all(sinks.map(({ done }) => done));
if (timeouts.size) say(`\nTimed out (${timeouts.size}):\n${[...timeouts].map(([key, what]) => `  ${key}: ${what}`).join('\n')}`);
for (const [key, wall] of Object.entries(fileWall)) {
  if (!(key in measured) || wall - measured[key] >= 400) measured[key] = wall;
}
if (!abort.signal.aborted) await mergeDurations(durationsFile(), Object.fromEntries(Object.entries(measured).map(([key, ms]) => [key, Math.round(ms)])));
process.exitCode = failed || timeouts.size || abort.signal.aborted ? 1 : 0;
