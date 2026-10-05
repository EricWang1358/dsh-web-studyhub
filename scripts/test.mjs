/* Every test run has a fresh machine-settings home and no inherited provider credentials.
   A plain full run starts the longest files first (scripts/qa/run-tests.mjs) and takes turns with other full runs on the machine
   (scripts/qa/test-lock.mjs; STUDY_TEST_NO_LOCK=1 skips the queue). With file arguments it is `node --test` on those files, as ever. */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { availableParallelism, constants, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubSecrets } from './qa/env.mjs';
import { chooseConcurrency, parseTestArgs, repoRoot } from './qa/test-schedule.mjs';
import { acquireFullRunLock, fullRunHolder, MAX_WAIT_MS, POLL_MS } from './qa/test-lock.mjs';

const args = process.argv.slice(2);
// Only identify file arguments; all options and their values still go to Node unchanged.
const { files, ordered } = parseTestArgs(args);
const parent = resolve(tmpdir()), home = await mkdtemp(join(parent, 'study-tests-'));
const report = process.env.STUDY_TEST_NETWORK_REPORT === '1';
const reportFile = join(home, 'network-report.jsonl');
let child, receivedSignal, status, lock;
const abort = new AbortController();
const forward = signal => { receivedSignal ||= signal; abort.abort(); child?.kill(signal); };
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const handlers = new Map(signals.map(signal => [signal, () => forward(signal)]));
for (const [signal, handler] of handlers) process.on(signal, handler);
try {
  const env = { STUDY_QA_ACTION_TIMEOUT_MS: '120000', ...scrubSecrets(process.env), DSH_HOME: home,
    ...(report ? { STUDY_TEST_NETWORK_REPORT_FILE: reportFile } : {}) };
  const guard = new URL('./qa/test-network.mjs', import.meta.url).href;
  // Full runs queue behind each other; a run with file arguments does not queue but takes fewer workers while a full run is going.
  let reduced = false;
  if (process.env.STUDY_TEST_NO_LOCK !== '1') {
    if (files) reduced = !!await fullRunHolder();
    else {
      lock = await acquireFullRunLock({ signal: abort.signal, log: line => console.error(line),
        pollMs: Number(process.env.STUDY_TEST_LOCK_POLL_MS) || POLL_MS, maxWaitMs: Number(process.env.STUDY_TEST_LOCK_WAIT_MS) || MAX_WAIT_MS });
      reduced = lock?.reduced ?? false;
    }
  }
  if (!receivedSignal) {
    const concurrency = args.some(arg => arg.startsWith('--test-concurrency')) ? [] : [`--test-concurrency=${chooseConcurrency({ available: availableParallelism(), reduced })}`];
    // The ordered runner takes the whole suite; node's own runner (sorting by name) takes explicit files and any option the runner does not know.
    const command = ordered ? [fileURLToPath(new URL('./qa/run-tests.mjs', import.meta.url)), ...concurrency, ...args]
      : ['--import', guard, '--test', ...concurrency, ...args, ...(files ? [] : ['tests/*.test.mjs'])];
    child = spawn(process.execPath, command, { cwd: repoRoot, env, stdio: 'inherit', windowsHide: true });
    status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    if (report) {
      const lines = (await readFile(reportFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
      const attempts = lines.reduce((sum, line) => sum + JSON.parse(line).attempts, 0);
      console.error(lines.length ? `Test network: ${attempts} external connection attempts blocked (${lines.length} processes).`
        : 'Test network: no report data.');
    }
  }
} catch (error) { console.error(error.message); status = { code: 1 }; }
finally {
  await lock?.release();
  if (!resolve(home).startsWith(parent + sep)) throw new Error('Unexpected temporary test home');
  await rm(home, { recursive: true, force: true, maxRetries: 3 });
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
}
const signal = receivedSignal || status.signal;
if (signal) {
  process.exitCode = 128 + (constants.signals[signal] || 1);
  try { process.kill(process.pid, signal); } catch { /* the mapped exit code is the platform fallback */ }
} else process.exitCode = status.code ?? 1;
