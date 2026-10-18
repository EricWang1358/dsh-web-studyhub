import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { MINERU_INSTALL, mineruInstallStatePath, mineruLayout } from '../lib/mineru-install.js';
import { MINERU_INSTALL_JOB_TEXT } from '../lib/mineru-install-text.js';
import { RuntimeConfig } from '../lib/runtime-config.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { installHarness } from './helpers/mineru-install-harness.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { until } from './helpers/wait.mjs';

/* The one-click MinerU install as a runtime Job (runtime.pilot.mineruInstall, which replaces mineruSetup): one job in the shared list with an observed
   local call per step (the steps that change the folder declared as side effects), no retry, cancel through the console, and a refusal in words, before
   any job or process, when there is no session to run in. A local index, a fake uv and the fake mineru: nothing is downloaded. */

const KIND = 'mineru-install';
const consoleCode = await loadUi(`export { taskSummary } from './ui/tasks/task-summary.js'; export { tasksOf, runningTaskCount } from './ui/tasks/task-model.js';`);
const exists = file => stat(file).then(() => true, () => false);

async function harness(t, options = {}, { runtime = {} } = {}) {
  const h = await installHarness(t, options);
  const bin = join(h.dir, 'bin'), before = { PATH: process.env.PATH, Path: process.env.Path };
  await mkdir(bin, { recursive: true });
  process.env.PATH = bin; if (process.env.Path !== undefined) process.env.Path = bin;
  const { starts: _starts, ...managed } = managedRuntimeOptions({ paths: ['mineruInstall'] });
  const service = new StudyService(join(h.dir, 'library'), { mineru: { install: h.seams }, ...managed, ...runtime });
  t.after(async () => {
    await service.call('mineru.install.cancel').catch(() => {});
    await until(async () => (await service.call('mineru.install.status')).status !== 'running', 'the install to end', { timeoutMs: 120_000 }).catch(() => {});
    await service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  const call = (name, args) => service.call(name, args);
  return { ...h, service, call, jobs: async () => (await call('snapshot')).jobs.filter(job => job.type === KIND),
    start: (args = {}) => call('mineru.install.start', { confirm: true, location: h.location, ...args }),
    ended: status => until(async () => { const view = await call('mineru.install.status'); return view.status === status && view; }, `the install to be ${status}`, { timeoutMs: 120_000 }) };
}

test('a config that still carries the old mineruSetup switch loads, and the new switch is off by default', () => {
  const config = RuntimeConfig({ pilot: { mineruSetup: true, pdfConvert: true } });
  assert.equal(config.pilot.mineruInstall, false);
  assert.equal(config.pilot.pdfConvert, true);
});

test('an install is one job in the shared list: titled, six steps, an observed local call per command, no retry, no legacy row', async t => {
  const h = await harness(t);
  assert.equal((await h.start()).status, 'running');
  await h.ended('complete');
  await until(async () => (await h.jobs())[0]?.contract.status === 'complete', 'the job to settle');
  const [job] = await h.jobs(), { contract } = job;
  assert.equal(contract.kind, KIND);
  assert.equal(contract.title, MINERU_INSTALL_JOB_TEXT.title);
  assert.deepEqual([contract.capabilities.retry, contract.capabilities.recoveryMode, contract.capabilities.pauseMode], [false, 'none', 'unsupported']);
  assert.equal(contract.progress.percent, 100);
  assert.deepEqual(contract.usage, { tokens: null, tokenUsage: null, calls: 0 });
  const kinds = new Set(contract.calls.map(item => item.kind));
  for (const stage of ['tools', 'python', 'package', 'models', 'enable']) assert.ok(kinds.has(stage), `${stage} has observed calls`);
  // The only calls that did not exit 0 are the read-only `models verify` probes that find no models yet (a non-zero exit is a failed call).
  assert.deepEqual(contract.calls.filter(item => item.status !== 'ok').map(item => item.kind), ['models', 'models'], JSON.stringify(contract.calls.map(item => [item.kind, item.status])));
  assert.equal((await h.call('snapshot')).jobs.filter(item => item.type === 'local-install').length, 0, 'the Job is the console row: no second one');
});

test('cancel goes through the Job; what was made stays for 继续安装 and uninstall; the console shows it stopped', async t => {
  const h = await harness(t, { uv: { delayPipMs: 5000 } });
  await h.start();
  await until(async () => (await h.call('mineru.install.status')).stage === 'package', 'the package stage');
  const data = await h.call('snapshot');
  assert.equal(consoleCode.runningTaskCount(data), 1);
  const running = consoleCode.taskSummary(consoleCode.tasksOf(data).find(task => task.type === KIND || task.kind === KIND) || consoleCode.tasksOf(data)[0]);
  assert.equal(running.title, MINERU_INSTALL_JOB_TEXT.title);
  await h.call('mineru.install.cancel');
  await h.ended('cancelled');
  await until(async () => (await h.jobs())[0]?.contract.status === 'cancelled', 'the job to settle');
  assert.equal(await exists(mineruLayout(h.location).sentinel), true);
  const [job] = await h.jobs();
  for (const [action, code] of [['retry', 'capability-unsupported'], ['resume', 'not-paused']]) await assert.rejects(h.call('job.control', { jobId: job.id, action }), { code }, action);
  assert.equal((await h.call('mineru.install.uninstall', { confirm: true })).removed, 1);
});

test('without a session to run in, the start is refused in words before any job, folder or process', async t => {
  const gone = { assertAvailable() { throw Object.assign(new Error('no agent'), { code: 'executor-unavailable' }); } };
  const h = await harness(t, {}, { runtime: { jobExecutor: gone } });
  await assert.rejects(h.start(), { code: 'needs-session' });
  assert.deepEqual(await h.jobs(), []);
  assert.equal(await exists(mineruInstallStatePath()), false);
  assert.equal(await exists(h.location), false);
  assert.deepEqual(await h.uvLog(), [], 'no process was started');
});

test('every sentence of the install job has its English form, and the steps that change the folder are the mutating ones', () => {
  for (const text of [MINERU_INSTALL_JOB_TEXT.title, MINERU_INSTALL_JOB_TEXT.done, MINERU_INSTALL_JOB_TEXT.cancelled, MINERU_INSTALL_JOB_TEXT.failed, MINERU_INSTALL_JOB_TEXT.stage(2, '准备 Python')])
    assert.notEqual(localizeAppMessage(text, 'en'), text, text);
  assert.deepEqual(MINERU_INSTALL.mutatingStages, ['tools', 'python', 'package', 'models', 'enable']);
});
