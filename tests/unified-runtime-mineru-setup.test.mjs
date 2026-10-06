import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StudyService } from '../lib/service.js';
import { LOCAL, LOCAL_MESSAGES } from '../lib/mineru-local.js';
import { MINERU_SETUP } from '../lib/mineru-setup.js';
import { SETUP_TEXT } from '../lib/mineru-setup-text.js';
import { observeLocalWith } from '../lib/contexts/audio/local-process-job.js';
import { assistantRefusal } from '../lib/assistant-boundary.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { patientCli, readJsonFile, until, writeJsonFile } from './helpers/wait.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* S5-4: the local MinerU setup (model download, switching the managed mode on) as a runtime job (runtime.pilot.mineruSetup). The CLI is a fake;
   nothing is downloaded. What the setup already does (order of steps, confirmation, failure, cancel) is pinned by mineru-local-service, which also
   runs on this switch (mineru-local-service.runtime.test.mjs). */

const FAKE = fileURLToPath(new URL('./helpers/fake-mineru-cli.mjs', import.meta.url));
const KIND = 'mineru-setup';
const consoleCode = await loadUi(`export { taskSummary } from './ui/tasks/task-summary.js'; export { tasksOf, runningTaskCount } from './ui/tasks/task-model.js';`);
const FRESH = { mode: 'disabled', tier: 'flash', running: false, modelsReady: false };

async function harness(t, { state = {}, noCli = false, runtime = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'runtime-setup-home-')), root = await mkdtemp(join(tmpdir(), 'runtime-setup-lib-')), work = await mkdtemp(join(tmpdir(), 'runtime-setup-fake-'));
  const before = { DSH_HOME: process.env.DSH_HOME, MINERU_API_KEY: process.env.MINERU_API_KEY, MINERU_BIN: process.env.MINERU_BIN };
  process.env.DSH_HOME = home; delete process.env.MINERU_API_KEY; delete process.env.MINERU_BIN;
  const statePath = join(work, 'state.json'), logPath = join(work, 'log.jsonl');
  await writeFile(statePath, JSON.stringify({ version: '4.0.10', mode: 'managed', tier: 'basic', running: true, total: 120, modelsReady: true, ...state })); await writeFile(logPath, '');
  const env = { FAKE_MINERU_STATE: statePath, FAKE_MINERU_LOG: logPath };
  const { starts: _starts, ...managed } = managedRuntimeOptions({ paths: ['mineruSetup'] });
  const service = new StudyService(root, { ...managed, ...runtime, mineru: { local: { cli: noCli ? null : patientCli({ file: process.execPath, prefix: [FAKE], env }), home: work,
    modelsCli: patientCli({ file: process.execPath, prefix: [FAKE], env }) } } });
  t.after(async () => {
    await service.call('mineru.local.setup.cancel').catch(() => {});
    await until(async () => (await service.call('mineru.local.setup.status')).status !== 'running', 'the setup to end', { timeoutMs: 120_000 }).catch(() => {});
    await service.dispose();
    for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    for (const dir of [home, root, work]) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const log = async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  return { service, call: (name, args) => service.call(name, args), log, calls: async () => (await log()).map(entry => entry.argv.join(' ')),
    set: async patch => writeJsonFile(statePath, { ...await readJsonFile(statePath), ...patch }), state: () => readJsonFile(statePath),
    jobs: async () => (await service.call('snapshot')).jobs.filter(job => job.type === KIND),
    ended: status => until(async () => { const run = await service.call('mineru.local.setup.status'); return run.status === status && run; }, `the setup to be ${status}`, { timeoutMs: 120_000 }) };
}

test('a setup is one job in the shared list: titled, observed step by step, with no retry button and no invented usage', async t => {
  const h = await harness(t, { state: FRESH });
  const started = await h.call('mineru.local.setup', { tier: 'basic', confirm: true });
  assert.deepEqual([started.status, started.tier, started.modelsMb], ['running', 'basic', LOCAL.modelsMb.basic]);
  const done = await h.ended('complete');
  assert.equal(done.state.state, 'ready');
  const [job] = await h.jobs();
  await until(async () => (await h.jobs())[0].contract.status === 'complete', 'the job to settle');
  const { contract } = (await h.jobs())[0];
  assert.deepEqual([job.id, contract.kind, contract.title], [started.id, KIND, SETUP_TEXT.title('basic')]);
  assert.deepEqual(contract.calls.map(call => [call.kind, call.status, call.observation.boundary, call.observation.requestCount]),
    ['start', 'detect', 'download', 'configure', 'configure', 'start', 'detect'].map(kind => [kind, 'ok', 'local-process', null]));
  assert.deepEqual(contract.usage, { tokens: null, tokenUsage: null, calls: 0 });
  assert.deepEqual([contract.capabilities.retry, contract.capabilities.recoveryMode, contract.capabilities.pauseMode], [false, 'none', 'unsupported']);
  const calls = await h.calls(), tier = calls.findIndex(call => call.includes('managed_tier basic')), mode = calls.findIndex(call => call.includes('local.mode managed'));
  assert.ok(calls.findIndex(call => call.startsWith('--tier basic')) < tier && tier < mode, 'models, then the tier, then the mode');
});

test('every refusal comes before any job or process: no confirm, a tier that does not exist, no mineru, no way to download the models', async t => {
  const h = await harness(t, { state: FRESH });
  await assert.rejects(h.call('mineru.local.setup', { tier: 'basic' }), error => error.message === SETUP_TEXT.needConfirm(LOCAL.modelsMb.basic));
  await assert.rejects(h.call('mineru.local.setup', { tier: 'giant', confirm: true }), error => error.message === LOCAL_MESSAGES.badTier);
  assert.deepEqual([await h.jobs(), await h.log()], [[], []], 'nothing ran, not even a read-only probe');
  const none = await harness(t, { state: FRESH, noCli: true });
  await assert.rejects(none.call('mineru.local.setup', { tier: 'basic', confirm: true }), { code: 'not-installed' });
  assert.deepEqual(await none.jobs(), []);
});

test('without a session to run in the start is refused in words, before any job or process', async t => {
  const gone = { assertAvailable() { throw Object.assign(new Error('no agent'), { code: 'executor-unavailable' }); } };
  const h = await harness(t, { state: FRESH, runtime: { jobExecutor: gone } });
  await assert.rejects(h.call('mineru.local.setup', { tier: 'basic', confirm: true }), { code: 'setup-needs-session', message: SETUP_TEXT.needsSession });
  assert.deepEqual(await h.jobs(), []);
  assert.equal((await h.calls()).some(call => call.startsWith('--tier') || call.includes('config set')), false, 'nothing was downloaded or configured');
});

test('one setup per library: a second start joins nothing and creates no job', async t => {
  const h = await harness(t, { state: { ...FRESH, downloadDelayMs: 60_000 } });
  await h.call('mineru.local.setup', { tier: 'basic', confirm: true });
  await until(async () => (await h.log()).some(entry => entry.argv[0] === '--tier'), 'the download to start');
  await assert.rejects(h.call('mineru.local.setup', { tier: 'standard', confirm: true }), { code: 'setup-busy' });
  assert.equal((await h.jobs()).length, 1);
  await h.call('mineru.local.setup.cancel'); await h.ended('cancelled');
});

test('a failed download changes nothing, says why, and the console cannot start the setup again by retry, resume or pause', async t => {
  const h = await harness(t, { state: { ...FRESH, downloadFails: true } });
  await h.call('mineru.local.setup', { tier: 'standard', confirm: true });
  const failed = await h.ended('failed');
  assert.match(failed.error, /模型没能下载/);
  assert.deepEqual([(await h.state()).mode, (await h.state()).tier], ['disabled', 'flash']);
  await until(async () => (await h.jobs())[0].contract.status === 'failed', 'the job to settle');
  const [job] = await h.jobs(), logged = (await h.log()).length;
  for (const [action, code] of [['retry', 'capability-unsupported'], ['resume', 'not-paused'], ['pause', 'job-ended']]) await assert.rejects(h.call('job.control', { jobId: job.id, action }), { code }, action);
  assert.equal((await h.log()).length, logged, 'no process was started');
});

test('cancel stops the download; the job ends only after the process is gone and nothing was configured', async t => {
  const h = await harness(t, { state: { ...FRESH, downloadDelayMs: 60_000 } });
  await h.call('mineru.local.setup', { tier: 'basic', confirm: true });
  await until(async () => (await h.log()).some(entry => entry.argv[0] === '--tier'), 'the download to start');
  assert.equal((await h.call('mineru.local.setup.cancel')).status, 'running', 'the receipt is not the end');
  await h.ended('cancelled');
  await until(async () => (await h.jobs())[0].contract.status === 'cancelled', 'the job to settle');
  assert.equal((await h.state()).mode, 'disabled');
  assert.equal((await h.calls()).some(call => call.includes('config set')), false);
});

test('the 任务 console lists the setup with its own words while it runs and shows it stopped afterwards', async t => {
  const h = await harness(t, { state: { ...FRESH, downloadDelayMs: 60_000 } });
  await h.call('mineru.local.setup', { tier: 'basic', confirm: true });
  await until(async () => (await h.call('mineru.local.setup.status')).step === 'download', 'the download step');
  const data = await h.call('snapshot');
  assert.equal(consoleCode.runningTaskCount(data), 1);
  const running = consoleCode.taskSummary(consoleCode.tasksOf(data)[0]);
  assert.deepEqual([running.kind, running.state, running.title, running.line], ['extension', 'run', SETUP_TEXT.title('basic'), SETUP_TEXT.stage('download', { modelsMb: LOCAL.modelsMb.basic })]);
  await h.call('mineru.local.setup.cancel'); await h.ended('cancelled');
  await until(async () => consoleCode.runningTaskCount(await h.call('snapshot')) === 0, 'the console count to drop');
  assert.equal(consoleCode.taskSummary(consoleCode.tasksOf(await h.call('snapshot'))[0]).state, 'stopped');
});

test('the steps that change the learner\'s mineru are declared as side effects, the probes and service runs are not, and a non-zero exit is a failed call', async () => {
  const seen = [];
  const gateway = { step: key => ({ run: operation => operation(), observe: async (meta, work) => { const result = await work(new AbortController().signal); seen.push([key, meta.boundary, meta.sideEffect, result.status ?? null]); return result.value; } }) };
  const observe = observeLocalWith(gateway, 'setup', 'mineru');
  for (const kind of ['start', 'detect', 'download', 'configure']) await observe(kind, async () => ({ code: kind === 'configure' ? 2 : 0 }), { sideEffect: MINERU_SETUP.mutatingSteps.includes(kind) });
  assert.deepEqual(seen.map(([, boundary, effect, status]) => [boundary, effect, status]),
    [['local-process', false, null], ['local-process', false, null], ['local-process', true, null], ['local-process', true, 500]]);
  assert.equal(new Set(seen.map(([key]) => key)).size, 4, 'every step has its own key');
});

test('the Settings-only boundary still holds, and every sentence of the setup has its English form', () => {
  assert.match(assistantRefusal('mineru.local.setup'), /is not available to the assistant/);
  assert.equal(assistantRefusal('mineru.local.setup.status'), null);
  const texts = [SETUP_TEXT.title('basic'), SETUP_TEXT.needsSession, SETUP_TEXT.needConfirm(LOCAL.modelsMb.basic), ...['start', 'download', 'configure', 'done', 'cancelled', 'failed'].map(step => SETUP_TEXT.stage(step, { modelsMb: LOCAL.modelsMb.basic }))];
  for (const text of texts) assert.notEqual(localizeAppMessage(text), text, text);
});
