/* Every test run has a fresh machine-settings home and no inherited provider credentials. */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { availableParallelism, constants, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubSecrets } from './qa/env.mjs';

const args = process.argv.slice(2);
// Only identify file arguments; all options and their values still go to Node unchanged.
const valueOptions = new Set(['--test-name-pattern', '--test-skip-pattern', '--test-concurrency', '--test-reporter',
  '--test-reporter-destination', '--test-shard', '--test-timeout', '--test-coverage-exclude', '--test-coverage-include',
  '--test-coverage-lines', '--test-coverage-branches', '--test-coverage-functions', '--experimental-test-isolation',
  '--import', '--require', '-r']);
let files = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--') { files = i + 1 < args.length; break; }
  if (valueOptions.has(args[i])) i++;
  else if (!args[i].startsWith('-')) files = true;
}
const parent = resolve(tmpdir()), home = await mkdtemp(join(parent, 'study-tests-'));
const report = process.env.STUDY_TEST_NETWORK_REPORT === '1';
const reportFile = join(home, 'network-report.jsonl');
let child, receivedSignal, status;
const forward = signal => { receivedSignal ||= signal; child?.kill(signal); };
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const handlers = new Map(signals.map(signal => [signal, () => forward(signal)]));
try {
  const env = { STUDY_QA_ACTION_TIMEOUT_MS: '120000', ...scrubSecrets(process.env), DSH_HOME: home,
    ...(report ? { STUDY_TEST_NETWORK_REPORT_FILE: reportFile } : {}) };
  const guard = new URL('./qa/test-network.mjs', import.meta.url).href;
  // One test process per core starves the browser, ffmpeg and CLI-spawning tests on a many-core machine (and every other program on it): cap it.
  const concurrency = args.some(arg => arg.startsWith('--test-concurrency')) ? [] : [`--test-concurrency=${Math.max(2, Math.min(availableParallelism() - 1, 12))}`];
  child = spawn(process.execPath, ['--import', guard, '--test', ...concurrency, ...args, ...(files ? [] : ['tests/*.test.mjs'])],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, stdio: 'inherit', windowsHide: true });
  for (const [signal, handler] of handlers) process.on(signal, handler);
  status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  if (report) {
    const lines = (await readFile(reportFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    const attempts = lines.reduce((sum, line) => sum + JSON.parse(line).attempts, 0);
    console.error(lines.length ? `Test network: ${attempts} external connection attempts blocked (${lines.length} processes).`
      : 'Test network: no report data.');
  }
} catch (error) { console.error(error.message); status = { code: 1 }; }
finally {
  if (!resolve(home).startsWith(parent + sep)) throw new Error('Unexpected temporary test home');
  await rm(home, { recursive: true, force: true, maxRetries: 3 });
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
}
const signal = receivedSignal || status.signal;
if (signal) {
  process.exitCode = 128 + (constants.signals[signal] || 1);
  try { process.kill(process.pid, signal); } catch { /* the mapped exit code is the platform fallback */ }
} else process.exitCode = status.code ?? 1;
