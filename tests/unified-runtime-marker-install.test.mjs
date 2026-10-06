import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { INSTALL_MESSAGES, MARKER_INSTALL, markerInstallStatePath, venvLayout } from '../lib/marker-install.js';
import { INSTALL_JOB_TEXT } from '../lib/marker-install-text.js';
import { observeLocalWith } from '../lib/contexts/audio/local-process-job.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { until } from './helpers/wait.mjs';
import { INSTALL_KIND, harness } from './helpers/marker-install-harness.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* S5-3: one-click Marker setup as a runtime job (runtime.pilot.markerInstall). A fake python stands in for python and pip; nothing is downloaded.
   The behaviour the install already has (stages, sentinel, folders, uninstall) is pinned by marker-install*, nonmodel-baseline-install, which
   also run on this switch (marker-install-service.runtime.test.mjs). */

const KIND = INSTALL_KIND;
const consoleCode = await loadUi(`export { taskSummary } from './ui/tasks/task-summary.js'; export { tasksOf, runningTaskCount } from './ui/tasks/task-model.js';`);
const exists = async file => stat(file).then(() => true, () => false);

test('an install is one job in the shared list: titled, staged, with an observed local call per step, and no retry button', async t => {
  const h = await harness(t);
  const started = await h.call('marker.install.start', { confirm: true });
  assert.equal(started.status, 'running');
  const done = await h.ended('complete');
  assert.equal(done.installed, true);
  const [job] = await h.jobs(), { contract } = job;
  await until(async () => (await h.jobs())[0].contract.status === 'complete', 'the job to settle');
  assert.equal(contract.contractVersion, 2); assert.equal(contract.kind, KIND);
  const settled = (await h.jobs())[0].contract;
  assert.equal(settled.title, INSTALL_JOB_TEXT.title);
  assert.deepEqual(settled.calls.map(call => [call.kind, call.status, call.observation]),
    ['find-python', 'create-venv', 'install', 'verify'].map(kind => [kind, 'ok', { boundary: 'local-process', requestCount: null }]));
  assert.deepEqual(settled.usage, { tokens: null, tokenUsage: null, calls: 0 });
  assert.deepEqual([settled.capabilities.retry, settled.capabilities.recoveryMode, settled.capabilities.pauseMode], [false, 'none', 'unsupported']);
  assert.equal(settled.progress.percent, 100);
  assert.equal(settled.stage.text, INSTALL_JOB_TEXT.stage.done);
});

test('every refusal comes before any job, folder or process: no confirm, python too old, an install already running', async t => {
  const h = await harness(t);
  for (const args of [{}, { confirm: 'yes' }]) await assert.rejects(h.call('marker.install.start', args), { code: 'need-confirm' });
  assert.deepEqual([await h.jobs(), await h.pyLog(), await exists(markerInstallStatePath())], [[], [], false]);
  await h.setPy({ version: '3.8.1' });
  await assert.rejects(h.call('marker.install.start', { confirm: true }), { code: 'python-too-old' });
  assert.deepEqual(await h.jobs(), []);
  await h.setPy({ delayPip: true });
  await h.call('marker.install.start', { confirm: true });
  await until(async () => (await h.call('marker.install.status')).log.some(line => /Collecting marker-pdf/.test(line)), 'pip to start', { timeoutMs: 240_000 });
  await assert.rejects(h.call('marker.install.start', { confirm: true }), { code: 'busy' });
  await assert.rejects(h.call('marker.install.uninstall', { confirm: true }), { code: 'busy' });
  assert.equal((await h.jobs()).length, 1, 'the refused second start created no job');
  await h.call('marker.install.cancel'); await h.ended('cancelled');
});

test('without a session to run in the start is refused in words, before any job or process', async t => {
  const gone = { assertAvailable() { throw Object.assign(new Error('no agent'), { code: 'executor-unavailable' }); } };
  const h = await harness(t, {}, { runtime: { jobExecutor: gone } });
  await assert.rejects(h.call('marker.install.start', { confirm: true }), { code: 'needs-session', message: INSTALL_JOB_TEXT.needsSession });
  assert.deepEqual([await h.jobs(), await exists(markerInstallStatePath())], [[], false]);
  assert.ok((await h.pyLog()).every(line => /--version|"-c"/.test(line)), 'only the read-only probes of the plan ran');
});

test('the console cannot start an install again by retry, resume or pause: only the Settings start action does, and it asks for confirm', async t => {
  const h = await harness(t, { failPip: true });
  await h.call('marker.install.start', { confirm: true }); await h.ended('failed');
  const [job] = await h.jobs(), logged = (await h.pyLog()).length;
  await until(async () => (await h.jobs())[0].contract.status === 'failed', 'the job to settle');
  assert.equal((await h.jobs())[0].contract.error.code, 'network');
  for (const [action, code] of [['retry', 'capability-unsupported'], ['resume', 'not-paused'], ['pause', 'job-ended']]) await assert.rejects(h.call('job.control', { jobId: job.id, action }), { code }, action);
  assert.equal((await h.pyLog()).length, logged, 'no process was started');
  assert.equal((await h.jobs()).length, 1);
});

test('cancel stops the install, the job ends after the process is gone, and the owned partial folder stays for uninstall', async t => {
  const h = await harness(t, { delayPip: true });
  await h.call('marker.install.start', { confirm: true });
  await until(async () => (await h.call('marker.install.status')).log.some(line => /Collecting marker-pip|Collecting marker-pdf/.test(line)), 'pip to start', { timeoutMs: 240_000 });
  const receipt = await h.call('marker.install.cancel');
  assert.equal(receipt.status, 'running', 'the receipt is not the end');
  await h.ended('cancelled');
  await until(async () => (await h.jobs())[0].contract.status === 'cancelled', 'the job to settle');
  const folder = (await h.call('marker.install.status')).folder;
  assert.equal(await exists(venvLayout(folder).sentinel), true);
  const removed = await h.call('marker.install.uninstall', { confirm: true });
  assert.equal(removed.removed, 1);
  assert.equal(await exists(folder), false);
});

test('the 任务 console lists the install with its own words while it runs and after it is done', async t => {
  const h = await harness(t, { delayPip: true });
  await h.call('marker.install.start', { confirm: true });
  await until(async () => (await h.call('marker.install.status')).stage === 'install', 'the install stage', { timeoutMs: 240_000 });
  const data = await h.call('snapshot');
  assert.equal(consoleCode.runningTaskCount(data), 1);
  const running = consoleCode.taskSummary(consoleCode.tasksOf(data)[0]);
  assert.deepEqual([running.kind, running.state, running.title, running.line], ['extension', 'run', INSTALL_JOB_TEXT.title, INSTALL_JOB_TEXT.stage.install]);
  await h.call('marker.install.cancel'); await h.ended('cancelled');
  await until(async () => consoleCode.runningTaskCount(await h.call('snapshot')) === 0, 'the console count to drop');
  assert.equal(consoleCode.taskSummary(consoleCode.tasksOf(await h.call('snapshot'))[0]).state, 'stopped');
});

test('every sentence of the install job has its English form', () => {
  for (const text of [INSTALL_JOB_TEXT.title, INSTALL_JOB_TEXT.needsSession, ...Object.values(INSTALL_JOB_TEXT.stage)]) assert.notEqual(localizeAppMessage(text), text, text);
  assert.deepEqual(MARKER_INSTALL.mutatingStages, ['create-venv', 'install']);
  assert.ok(INSTALL_MESSAGES.needConfirm);
});

test('the steps that change the install folder are declared as side effects, the probes are not, and a non-zero exit is a failed call', async () => {
  const seen = [];
  const gateway = { step: key => ({ run: operation => operation(), observe: async (meta, work) => { const result = await work(new AbortController().signal); seen.push([key, meta.boundary, meta.sideEffect, result.status ?? null]); return result.value; } }) };
  const observe = observeLocalWith(gateway, 'install', 'marker');
  for (const kind of ['find-python', 'create-venv', 'install', 'verify']) await observe(kind, async () => ({ code: kind === 'install' ? 1 : 0 }), { sideEffect: MARKER_INSTALL.mutatingStages.includes(kind) });
  assert.deepEqual(seen, [['install:1:find-python', 'local-process', false, null], ['install:2:create-venv', 'local-process', true, null],
    ['install:3:install', 'local-process', true, 500], ['install:4:verify', 'local-process', false, null]]);
});
