/* Every test run has a fresh machine-settings home and no inherited provider credentials.
   node scripts/test.mjs [--fast] [node --test options] [test files]
   A plain full run starts the longest files first (scripts/qa/run-tests.mjs, which also limits how long one test or one file may take)
   and takes turns with other full runs on the machine
   (scripts/qa/test-lock.mjs; STUDY_TEST_NO_LOCK=1 skips the queue). --fast leaves out the browser, ffmpeg and program-starting
   files of tests/slow-tests.json. With file arguments it is `node --test` on those files, as ever. */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { availableParallelism, constants, tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPreview, sourceTreeDigest, UI_MODULE_EXTRA_FILES } from './build.mjs';
import { scrubSecrets } from './qa/env.mjs';
import { startTestChromium } from './qa/browser.mjs';
import { writeTestSources } from './qa/test-source-cache.mjs';
import { chooseConcurrency, listTestFiles, parseTestArgs, readSlowList, repoRoot } from './qa/test-schedule.mjs';
import { acquireFullRunLock, fullRunHolder, MAX_WAIT_MS, POLL_MS } from './qa/test-lock.mjs';

const fast = process.argv.includes('--fast');
const subset = fast || process.argv.some(arg => arg === '--core' || arg === '--smart' || arg === '--changed');
const args = process.argv.slice(2).filter(arg => arg !== '--fast');
// Only identify file arguments; all options and their values still go to Node unchanged.
const { files, ordered } = parseTestArgs(args);
const parent = resolve(tmpdir()), runDir = await mkdtemp(join(parent, 'study-tests-'));
const home = join(runDir, 'home');
const report = process.env.STUDY_TEST_NETWORK_REPORT === '1';
const reportFile = join(runDir, 'network-report.jsonl');
let child, receivedSignal, status, lock, stopTimer, browserServer;
const abort = new AbortController();
const forward = signal => {
  const again = !!receivedSignal;
  receivedSignal ||= signal;
  abort.abort();
  // The ordered runner is stopped by message, so it can still print which test files had not finished (on Windows a signal from here
  // ends it at once); a second signal, or a runner still there after 15 s, ends it.
  if (child?.connected && !again) {
    child.send({ stop: signal });
    stopTimer = setTimeout(() => child.kill(signal), 15_000);
  } else child?.kill(signal);
};
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const handlers = new Map(signals.map(signal => [signal, () => forward(signal)]));
for (const [signal, handler] of handlers) process.on(signal, handler);
try {
  await mkdir(home);
  // STUDY_NO_CALIBRATION: the estimate's learning is machine-wide (lib/estimate-calibration.js), and a test run makes many libraries in one DSH home;
  // letting the finished runs of one file change the estimate of the next would make the goldens depend on the shard order. The unit tests of the
  // calibration name a folder, so they still cover it.
  const env = { STUDY_QA_ACTION_TIMEOUT_MS: '120000', ...scrubSecrets(process.env), DSH_HOME: home, STUDY_NO_CALIBRATION: '1',
    ...(report ? { STUDY_TEST_NETWORK_REPORT_FILE: reportFile } : {}) };
  const guard = new URL('./qa/test-preload.mjs', import.meta.url).href;
  // Full runs queue behind each other; a targeted or fast run does not queue but takes fewer workers while a full run is going.
  let reduced = false;
  if (process.env.STUDY_TEST_NO_LOCK !== '1') {
    if (files || subset) reduced = !!await fullRunHolder();
    else {
      lock = await acquireFullRunLock({ signal: abort.signal, log: line => console.error(line),
        pollMs: Number(process.env.STUDY_TEST_LOCK_POLL_MS) || POLL_MS, maxWaitMs: Number(process.env.STUDY_TEST_LOCK_WAIT_MS) || MAX_WAIT_MS });
      reduced = lock?.reduced ?? false;
    }
  }
  if (!receivedSignal) {
    if (process.platform === 'win32' && ordered && !subset && !args.includes('--list') && !process.env.STUDY_TEST_SUITE_DIR) {
      // Without an available server, the existing per-test launch still reports missing browser or system dependencies.
      browserServer = await startTestChromium().catch(() => null);
      if (browserServer) env.STUDY_TEST_BROWSER_ENDPOINT = browserServer.wsEndpoint();
      if (env.STUDY_BUILD_CACHE !== '0') {
        const sourceCache = join(runDir, 'sources.bin');
        try {
          writeTestSources(join(repoRoot, 'lib'), sourceCache);
          env.STUDY_TEST_SOURCE_CACHE = sourceCache;
        } catch { /* A source can move while starting a run. Use the native loader for that run. */ }
      }
    }
    if (!process.env.STUDY_TEST_SUITE_DIR && process.env.STUDY_BUILD_CACHE !== '0') {
      const [srcDigest, uiDigest] = await Promise.all([
        env.STUDY_SOURCE_TREE_DIGEST || sourceTreeDigest(),
        env.STUDY_UI_TREE_DIGEST || sourceTreeDigest(UI_MODULE_EXTRA_FILES),
      ]);
      env.STUDY_SOURCE_TREE_DIGEST = srcDigest;
      env.STUDY_UI_TREE_DIGEST = uiDigest;
      if (ordered && (!subset || process.argv.includes('--include-slow'))) {
        const previewDir = join(runDir, 'test-preview', srcDigest);
        await buildPreview({ outdir: previewDir, sourceDigest: srcDigest });
        env.STUDY_TEST_PREVIEW_DIR = previewDir;
      }
    }
    const concurrency = args.some(arg => arg.startsWith('--test-concurrency')) ? [] : [`--test-concurrency=${chooseConcurrency({ available: availableParallelism(), reduced })}`];
    // The ordered runner takes the whole suite; node's own runner (sorting by name) takes explicit files and any option the runner does not know.
    const command = ordered ? [fileURLToPath(new URL('./qa/run-tests.mjs', import.meta.url)), ...(fast ? ['--fast'] : []), ...concurrency, ...args]
      : ['--import', guard, '--test', ...concurrency, ...args, ...(files ? [] : fast ? await fastFiles() : ['tests/*.test.mjs'])];
    child = spawn(process.execPath, command, { cwd: repoRoot, env, stdio: ordered ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit', windowsHide: true });
    status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    clearTimeout(stopTimer);
    if (report) {
      const lines = (await readFile(reportFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
      const attempts = lines.reduce((sum, line) => sum + JSON.parse(line).attempts, 0);
      console.error(lines.length ? `Test network: ${attempts} external connection attempts blocked (${lines.length} processes).`
        : 'Test network: no report data.');
    }
  }
} catch (error) { console.error(error.message); status = { code: 1 }; }
finally {
  await browserServer?.close().catch(error => { console.error('Could not close the test browser:', error.message); status = { code: 1 }; });
  await lock?.release();
  if (!resolve(runDir).startsWith(parent + sep)) throw new Error('Unexpected temporary test directory');
  await rm(runDir, { recursive: true, force: true, maxRetries: 3 });
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
}
const signal = receivedSignal || status.signal;
if (signal) {
  process.exitCode = 128 + (constants.signals[signal] || 1);
  try { process.kill(process.pid, signal); } catch { /* the mapped exit code is the platform fallback */ }
} else process.exitCode = status.code ?? 1;

/** The fast tier for node's own runner (options the ordered runner does not take): every test file but the slow ones. */
async function fastFiles() {
  const slow = await readSlowList();
  return (await listTestFiles()).map(file => relative(repoRoot, file).split(sep).join('/')).filter(file => !slow.has(file));
}
